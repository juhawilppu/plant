// Tells this instance about every reading stored by ANY instance, so each one
// can push it to the dashboards connected to it.
//
// Two instances of the API run side by side, and a reading is stored by
// whichever one wins the insert - both MQTT bridges receive every message, and
// the dedup index lets exactly one of them write it. Pushing from the instance
// that did the insert would therefore reach only the dashboards connected to
// that instance, which is about half of them. So ingest() raises a Postgres
// NOTIFY in the same statement as the insert, and every instance LISTENs.
// NOTIFY is delivered only when the transaction commits, which keeps the
// original rule by construction: the socket never shows anything the database
// does not hold.
//
// The payload is only the row's id. The listener reads the row back through
// the same code path as everything else, so a pushed reading is serialised
// exactly like a fetched one - dates included, which matters because the
// dashboard compares timestamps as strings.
//
// A notification sent while this connection is down is gone for good. So
// losing the connection is reported through onDown, and the caller is expected
// to close its sockets, making those dashboards re-fetch from the database.

import pg from 'pg';

export const CHANNEL = 'readings';

const RETRY_MS = 2000;

export function listenForReadings(connectionString, { onReading, onUp, onDown }) {
    async function connect() {
        const c = new pg.Client({ connectionString, keepAlive: true });
        let lost = false;

        // 'error' and 'end' can both fire for one failure, so only the first
        // one counts.
        const lose = (why) => {
            if (lost) return;
            lost = true;
            c.removeAllListeners('notification');
            c.end().catch(() => {});
            onDown(why);
            setTimeout(connect, RETRY_MS);
        };
        c.on('error', (err) => lose(err.message));
        c.on('end', () => lose('connection ended'));
        c.on('notification', (n) => onReading(n.payload));

        try {
            await c.connect();
            await c.query(`listen ${CHANNEL}`);
        } catch (err) {
            lose(err.message);
            return;
        }
        if (!lost) onUp();
    }

    connect();
}
