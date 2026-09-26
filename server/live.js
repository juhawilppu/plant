// Pushes each new reading to every open dashboard over a WebSocket, so the page
// changes the moment a reading lands instead of on its next poll. Polling every
// minute would have been plenty for a plant; this project is over-engineered on
// purpose, and this is one of the places it shows.
//
// One-way by design: the server talks and clients only listen, so anything a
// client sends is ignored. A dashboard still loads its history over
// GET /api/readings and uses this only for what comes after.
//
// Messages, all JSON:
//   { type: 'hello', instance }            first, naming the API instance
//   { type: 'reading', device, reading }   same shape as a GET /api/readings row
//   { type: 'heartbeat' }                  every HEARTBEAT_MS
//
// Two instances run behind Caddy, and the hello says which one this socket
// landed on. Dashboards ignore it; chaos/check.mjs uses it to show that a
// socket killed along with one instance came back on the other.
//
// An instance that cannot currently hear about new readings (see feed.js)
// refuses the upgrade with a 503 rather than accepting a socket it would leave
// silent. Refused before it opens, so the browser backs off as it would for
// any failed connect. /health fails for the same reason, so by the time the
// browser retries, Caddy has taken this instance out of rotation.
//
// After the hello the server sends the latest stored reading per device. A
// dashboard fetches its history and opens this socket at about the same time,
// and a reading that lands between the two would otherwise be in neither. The
// gap is far shorter than the node's one-minute cadence, so the latest reading
// is the only one that can fall into it.

import { WebSocketServer } from 'ws';

// Two jobs, one timer. The protocol-level ping finds clients that vanished
// without closing (a phone that lost signal) so their sockets get freed. The
// heartbeat message is for the browser, which cannot see pings: a client that
// hears nothing for a while knows its socket is dead and reconnects. It also
// keeps the connection under Cloudflare's 100-second idle timeout when the
// node is offline and there are no readings to send.
const HEARTBEAT_MS = 30 * 1000;

// Public and read-only, on a 1 GB box. Far above any real audience.
const MAX_CLIENTS = 100;

export function startLiveHub(server, { path, instance, latest, ready }) {
    const wss = new WebSocketServer({
        server,
        path,
        // Tiny because nothing legitimate is ever sent this way.
        maxPayload: 1024,
        verifyClient: (_info, done) =>
            ready() ? done(true) : done(false, 503, 'not hearing new readings'),
    });

    wss.on('connection', async (ws) => {
        if (wss.clients.size > MAX_CLIENTS) {
            ws.close(1013, 'too many connections');
            return;
        }
        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });
        // An unhandled 'error' event would take the whole process down with it.
        ws.on('error', (err) => console.error('live: socket error', err.message));

        send(ws, { type: 'hello', instance });
        try {
            for (const message of await latest()) send(ws, message);
        } catch (err) {
            console.error('live: could not send latest readings', err.message);
        }
    });

    const heartbeat = JSON.stringify({ type: 'heartbeat' });
    const timer = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
            ws.send(heartbeat);
        }
    }, HEARTBEAT_MS);
    wss.on('close', () => clearInterval(timer));

    return {
        broadcast(message) {
            const data = JSON.stringify(message);
            for (const ws of wss.clients) send(ws, data);
        },
        // Every open dashboard reconnects - to this instance or the other one -
        // and re-fetches its snapshot on the way.
        closeAll(code, reason) {
            for (const ws of wss.clients) ws.close(code, reason);
        },
    };
}

function send(ws, message) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(typeof message === 'string' ? message : JSON.stringify(message));
}
