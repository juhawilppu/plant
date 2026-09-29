// Change data capture: streams every row inserted into Postgres's readings
// table into ClickHouse, for the long-range views (roadmap 4.4).
//
// Why the replication log and not a poll. "select where id > last_id" looks
// like it works and silently loses rows: ids come from a sequence when a
// transaction starts writing, not when it commits, so a slow transaction can
// commit id 101 after id 102 is already copied and the watermark has moved
// past it. Logical decoding hands over transactions in commit order, from a
// position Postgres keeps for us (the replication slot), so nothing is skipped.
//
// Delivery is at-least-once, and the order of the steps is what makes it so:
//   1. rows arrive from the slot and wait in memory, per committed transaction
//   2. a batch is inserted into ClickHouse
//   3. only then is Postgres told the batch's position is done (confirmed)
// A crash between 2 and 3 replays the batch on restart, and ClickHouse's
// ReplacingMergeTree folds the duplicate away (eventually - see the schema).
// A crash before 2 loses nothing either, since nothing was confirmed.
//
// The cost of a slot is that Postgres keeps every WAL segment the slot has not
// confirmed. A consumer that is down, or stuck, fills the disk. Postgres caps
// that with max_slot_wal_keep_size (docker-compose.yml) by giving up on the
// slot, and when that happens this starts over: a new slot and a full copy.
//
// One instance only. A slot takes one consumer at a time, and a second copy of
// this would fail to attach and restart until the first one died - which is a
// working, if accidental, standby.

import pg from 'pg';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';
import { clickhouse } from './clickhouse.js';

const DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:55433/plant_vitals';
const SLOT = 'clickhouse_readings';
const PUBLICATION = 'readings_cdc';

// Readings arrive one a minute. Batching them costs up to this much lag in
// ClickHouse and saves it a part (a directory on disk, later merged) per row.
const FLUSH_MS = Number(process.env.CDC_FLUSH_MS) || 60_000;
// Postgres drops a replication connection that has said nothing for
// wal_sender_timeout (60 s by default), so the position is re-sent well within it.
const STATUS_MS = 10_000;
// How many rows may wait for ClickHouse before this gives up and restarts. A
// day at one a minute is 1,440; past this, memory matters more than the rows,
// which are still in Postgres and come back from the slot on restart.
const MAX_PENDING = 20_000;
const BACKFILL_PAGE = 5_000;

const COLUMNS = [
    'id', 'device_id', 'recorded_at', 'soil_raw', 'air_temp_c', 'humidity_pct',
    'pressure_hpa', 'lux', 'rssi', 'uptime_s', 'msg_id',
];

const insertRows = (rows) =>
    clickhouse(`insert into readings (${COLUMNS.join(', ')}) format JSONEachRow`, {
        body: rows.map((r) => JSON.stringify(r)).join('\n'),
    });

const pick = (row) => Object.fromEntries(COLUMNS.map((c) => [c, row[c] ?? null]));

// --- LSNs --------------------------------------------------------------------

// 'XXXXXXXX/YYYYYYYY', two hex halves of a 64-bit WAL position.
const lsnValue = (lsn) => {
    const [hi, lo] = lsn.split('/');
    return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
};
const maxLsn = (a, b) => (lsnValue(a) >= lsnValue(b) ? a : b);

// --- Setup -------------------------------------------------------------------

async function waitForClickhouse() {
    for (let attempt = 1; ; attempt++) {
        try {
            await clickhouse('select 1');
            return;
        } catch (err) {
            if (attempt === 1 || attempt % 10 === 0) console.log(`cdc: waiting for clickhouse (${err.message})`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}

// The publication and the slot are made here rather than in db/schema.sql,
// which only runs on an empty volume: the server's database predates them.
// Returns the position the slot has confirmed so far.
async function ensureSlot(db) {
    const pub = await db.query('select 1 from pg_publication where pubname = $1', [PUBLICATION]);
    if (pub.rowCount === 0) {
        // Inserts only. Readings are append-only; an update or delete here
        // would not reach ClickHouse, and would need its own design.
        await db.query(`create publication ${PUBLICATION} for table readings with (publish = 'insert')`);
        console.log(`cdc: created publication ${PUBLICATION}`);
    }

    const slot = await db.query(
        'select confirmed_flush_lsn, wal_status from pg_replication_slots where slot_name = $1',
        [SLOT],
    );
    if (slot.rowCount === 1 && slot.rows[0].wal_status !== 'lost') {
        return { confirmed: slot.rows[0].confirmed_flush_lsn, created: false };
    }
    if (slot.rowCount === 1) {
        // Postgres let go of WAL the slot still needed (max_slot_wal_keep_size),
        // so the stream has a hole in it. The only way back is a fresh copy.
        console.error(`cdc: slot ${SLOT} lost the WAL it needed, dropping it and copying everything again`);
        await db.query('select pg_drop_replication_slot($1)', [SLOT]);
    }
    // Returns once every transaction running at this moment has finished, so
    // any row not committed by then is certain to come through the slot.
    const created = await db.query(
        `select lsn from pg_create_logical_replication_slot($1, 'pgoutput')`,
        [SLOT],
    );
    console.log(`cdc: created slot ${SLOT} at ${created.rows[0].lsn}`);
    return { confirmed: created.rows[0].lsn, created: true };
}

// Everything committed before the slot existed never passes through it, so it
// is copied directly. The copy starts after the slot was created, so it and
// the stream overlap rather than leave a gap; the overlap is duplicates, which
// ClickHouse folds away.
async function backfill(db, slotCreated) {
    if (slotCreated) await clickhouse('truncate table cdc_backfill');
    const done = await clickhouse('select count() from cdc_backfill where slot = {slot:String}', {
        params: { slot: SLOT },
    });
    if (Number(done.trim()) > 0) return;

    console.log('cdc: copying the existing history');
    let last = 0;
    let total = 0;
    for (;;) {
        const { rows } = await db.query(
            `select ${COLUMNS.join(', ')} from readings where id > $1 order by id limit $2`,
            [last, BACKFILL_PAGE],
        );
        if (rows.length === 0) break;
        await insertRows(rows.map(pick));
        last = rows[rows.length - 1].id;
        total += rows.length;
    }
    await clickhouse('insert into cdc_backfill (slot, rows) format JSONEachRow', {
        body: JSON.stringify({ slot: SLOT, rows: total }),
    });
    console.log(`cdc: copied ${total} rows`);
}

// --- Streaming ---------------------------------------------------------------

async function main() {
    await waitForClickhouse();

    const db = new pg.Client({ connectionString: DATABASE_URL });
    await db.connect();
    const { confirmed: startLsn, created } = await ensureSlot(db);
    await backfill(db, created);
    await db.end();

    // The last position ClickHouse has, and so the only one ever confirmed.
    let confirmed = startLsn;
    // Rows of committed transactions, not yet in ClickHouse, and the position
    // that confirming all of them would reach.
    let pending = [];
    let pendingLsn = null;
    // Rows of the transaction being received. They join `pending` at its
    // commit, so a batch never ends halfway through a transaction.
    let open = null;

    const service = new LogicalReplicationService(
        { connectionString: DATABASE_URL },
        // Manual acknowledgement, and the library's own keepalive OFF: that
        // timer confirms the newest position *received*, not the newest one
        // stored, which would quietly throw away whatever had not reached
        // ClickHouse yet if this process died. The keepalive is ours, below.
        { acknowledge: { auto: false, timeoutSeconds: 0 } },
    );
    const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [PUBLICATION] });

    service.on('data', (_lsn, msg) => {
        switch (msg.tag) {
            case 'begin':
                open = [];
                break;
            case 'insert':
                if (msg.relation.name === 'readings') open?.push(pick(msg.new));
                break;
            case 'commit':
                if (open?.length) {
                    pending.push(...open);
                    pendingLsn = msg.commitEndLsn;
                }
                open = null;
                break;
        }
    });

    // Postgres's keepalive carries its current WAL end. With nothing held back
    // and no transaction half-received, everything before it has been dealt
    // with, so the slot can move up to it. Without this, a quiet table would
    // pin WAL that other tables' writes keep producing.
    service.on('heartbeat', (lsn, _ts, shouldRespond) => {
        if (pending.length === 0 && open === null) confirmed = maxLsn(confirmed, lsn);
        if (shouldRespond) service.acknowledge(confirmed);
    });

    service.on('error', (err) => {
        console.error('cdc: replication error:', err.message);
        process.exit(1);
    });

    let flushing = false;
    async function flush() {
        if (flushing || pending.length === 0) return;
        flushing = true;
        // Captured before the await: more rows can arrive while it runs, and
        // they are not part of what this insert confirms.
        const batch = pending.slice();
        const lsn = pendingLsn;
        try {
            await insertRows(batch);
            pending = pending.slice(batch.length);
            if (pending.length === 0) pendingLsn = null;
            confirmed = maxLsn(confirmed, lsn);
            await service.acknowledge(confirmed);
            console.log(`cdc: ${batch.length} row(s) to clickhouse, confirmed ${confirmed}`);
        } catch (err) {
            console.error(`cdc: insert failed, ${pending.length} row(s) waiting:`, err.message);
            if (pending.length > MAX_PENDING) {
                console.error('cdc: too much waiting for clickhouse, restarting to replay from the slot');
                process.exit(1);
            }
        } finally {
            flushing = false;
        }
    }

    setInterval(flush, FLUSH_MS);
    setInterval(() => service.acknowledge(confirmed), STATUS_MS);

    // `docker stop`: store what is held and confirm it, so a deploy does not
    // replay the last minute's rows as duplicates.
    const shutdown = async (signal) => {
        console.log(`cdc: ${signal}, flushing ${pending.length} row(s)`);
        await flush();
        await service.stop();
        process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    console.log(`cdc: streaming slot ${SLOT} from ${confirmed}`);
    // Resolves only when the stream ends. The slot, not this argument, decides
    // where streaming starts; Postgres resumes from its confirmed position.
    await service.subscribe(plugin, SLOT, confirmed);
    console.error('cdc: replication stream ended');
    process.exit(1);
}

main().catch((err) => {
    console.error('cdc: failed:', err.message);
    process.exit(1);
});
