#!/usr/bin/env node
// Watches the live socket the way a dashboard does, while the chaos monkey is
// out, and checks afterwards that it missed nothing.
//
//   node chaos/check.mjs https://plant.juhawilppu.com --minutes 60
//   node chaos/check.mjs http://localhost:8090          # until Ctrl-C
//
// Watching the dashboard itself would prove nothing: it re-fetches its snapshot
// on every reconnect, and every kill forces a reconnect, so the re-fetch
// quietly fills in whatever the socket failed to deliver. This checks the
// socket alone, and compares what it delivered against the database.
//
// Each stored reading falls in one of three places:
//
//   arrived        it came over the socket
//   between        it was stored while no socket was open, during a
//                  reconnect. Expected; the dashboard's re-fetch covers it
//   missed         it was stored between two readings that one connection did
//                  receive, so that connection was open and should have had
//                  it. This is the failure that matters, and it must stay 0
//
// Deciding "missed" this way needs no clock shared with the server: a
// connection that received readings A and C was open while B was stored.
// Anything arriving over the socket that the database does not hold is a
// failure too. Exits 1 if either happened, or if nothing arrived to judge.
import { parseArgs } from 'node:util';

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        device: { type: 'string', default: 'plant-01' },
        minutes: { type: 'string' },
        every: { type: 'string', default: '5' },
    },
});

const base = new URL(positionals[0] ?? 'http://localhost:8090');
const wsUrl = new URL('/api/live', base);
wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';

// The same numbers the dashboard uses (web/src/useLive.js), so this sees what
// a real tab would.
const HEARTBEAT_TIMEOUT_MS = 75 * 1000;
const MAX_BACKOFF_MS = 30 * 1000;

const started = Date.now();
const conns = [];
let attempt = 0;
let refused = 0;
let duplicates = 0;
let lastClose = null;
const reconnectMs = [];

const clock = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${clock()}  ${msg}`);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

function connect() {
    const ws = new WebSocket(wsUrl);
    const conn = { n: conns.length + 1, instance: '?', seen: new Set(), lo: null, hi: null, took: undefined };
    let opened = false;
    let watchdog = null;

    const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
            log(`#${conn.n} silent for ${secs(HEARTBEAT_TIMEOUT_MS)}, dropping it`);
            ws.close();
            closed(4000, 'watchdog');
        }, HEARTBEAT_TIMEOUT_MS);
    };

    let done = false;
    function closed(code, reason) {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        if (opened) {
            lastClose = { at: Date.now(), instance: conn.instance };
            const why = code === 1006 ? 'dropped, no close frame' : `${code} ${reason}`.trim();
            log(`#${conn.n} on ${conn.instance} closed: ${why}`);
        } else {
            refused++;
        }
        const delay =
            Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
        attempt++;
        setTimeout(connect, delay);
    }

    ws.onopen = () => {
        opened = true;
        attempt = 0;
        conns.push(conn);
        if (lastClose) {
            conn.took = Date.now() - lastClose.at;
            reconnectMs.push(conn.took);
        }
        arm();
    };
    ws.onmessage = (event) => {
        arm();
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch {
            return;
        }
        if (msg.type === 'hello') {
            conn.instance = msg.instance;
            if (conn.took === undefined) {
                log(`#${conn.n} open on ${msg.instance}`);
            } else {
                const hop =
                    lastClose.instance === msg.instance ? 'same instance' : `from ${lastClose.instance}`;
                log(`#${conn.n} open on ${msg.instance} after ${secs(conn.took)} (${hop})`);
            }
            return;
        }
        if (msg.type !== 'reading' || msg.device !== opts.device) return;
        const t = msg.reading.recorded_at;
        if (conn.seen.has(t)) {
            // The on-connect replay racing a push for the same reading. The
            // dashboard drops the second copy, so this is noted, not failed.
            duplicates++;
            return;
        }
        conn.seen.add(t);
        if (conn.lo === null || t < conn.lo) conn.lo = t;
        if (conn.hi === null || t > conn.hi) conn.hi = t;
        log(`  reading ${t} via ${conn.instance}`);
    };
    ws.onclose = (event) => closed(event.code, event.reason);
}

async function report(final) {
    const hours = Math.min(168, Math.ceil((Date.now() - started) / 3600e3) + 1);
    const url = new URL('/api/readings', base);
    url.search = new URLSearchParams({ device: opts.device, hours }).toString();
    let stored;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        stored = (await res.json()).readings.map((r) => r.recorded_at);
    } catch (err) {
        log(`report skipped: could not fetch ${url.pathname} (${err.message})`);
        return null;
    }
    const inDb = new Set(stored);
    const watched = conns.filter((c) => c.lo !== null);
    if (!watched.length) {
        log('report skipped: no reading has arrived over the socket yet');
        return null;
    }

    // Judged: from the first reading any connection received to the newest.
    // Past the newest, a reading may simply not have been pushed yet.
    const from = watched[0].lo;
    const to = watched.reduce((hi, c) => (c.hi > hi ? c.hi : hi), from);
    const seenAnywhere = new Set(watched.flatMap((c) => [...c.seen]));

    let arrived = 0;
    let between = 0;
    const missed = [];
    for (const t of stored) {
        if (t < from || t > to) continue;
        if (seenAnywhere.has(t)) arrived++;
        else if (watched.some((c) => t > c.lo && t < c.hi)) missed.push(t);
        else between++;
    }
    // Only readings inside the fetched window can be looked for. ISO strings
    // in UTC compare in time order.
    const floor = new Date(Date.now() - hours * 3600e3).toISOString();
    const phantoms = [...seenAnywhere].filter((t) => t >= floor && !inDb.has(t));

    const sorted = [...reconnectMs].sort((a, b) => a - b);
    const median = sorted.length ? secs(sorted[Math.floor(sorted.length / 2)]) : '-';
    const max = sorted.length ? secs(sorted[sorted.length - 1]) : '-';
    const instances = [...new Set(watched.map((c) => c.instance))].sort().join(', ');
    const ok = missed.length === 0 && phantoms.length === 0;
    const mins = Math.round((Date.now() - started) / 60e3);

    console.log(`
── ${final ? 'final report' : 'report'} after ${mins} min ${'─'.repeat(30)}
connections       ${conns.length}, on instance(s) ${instances}
reconnects        ${reconnectMs.length}, median ${median}, slowest ${max}; ${refused} attempt(s) refused
readings stored   ${arrived + between + missed.length} while watching
  arrived         ${arrived}
  between         ${between}   stored during a reconnect; the dashboard's re-fetch covers these
  missed          ${missed.length}   must be 0${missed.length ? ': ' + missed.join(', ') : ''}
not in database   ${phantoms.length}   must be 0${phantoms.length ? ': ' + phantoms.join(', ') : ''}
duplicate pushes  ${duplicates}   replay racing a push; the dashboard drops them
verdict           ${ok ? 'PASS' : 'FAIL'}
`);
    return ok;
}

log(`watching ${wsUrl} for ${opts.device}`);
connect();

const every = Number(opts.every) * 60e3;
setInterval(() => report(false), every).unref();

// A run that could not be judged - nothing ever arrived - is not a pass.
async function finish() {
    process.exit((await report(true)) ? 0 : 1);
}
process.once('SIGINT', finish);
if (opts.minutes) setTimeout(finish, Number(opts.minutes) * 60e3);
