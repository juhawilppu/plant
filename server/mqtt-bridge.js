// Subscribes to the nodes' MQTT topics and hands each reading to ingest(), which
// writes it to Postgres and announces it to every instance's open dashboards.
//
// Runs INSIDE the API process rather than as its own container. On a 1 GB box,
// a separate Node runtime costs ~60 MB for no benefit: it would share this
// process's database pool anyway, and mqtt.js reconnects on its own, so the
// failure it would isolate us from does not exist. Kept in its own file so the
// separation is still legible.
//
// Both API instances run a bridge, and both subscribe to everything, so every
// reading is delivered twice and both race to insert it. That is deliberate:
// the dedup index turns the loser's insert into a no-op, and it means a reading
// is still stored while either instance is dead. A shared subscription would
// halve the work and lose exactly that. Which instance wins does not matter to
// the dashboards - they hear about the row through Postgres, see feed.js.
//
// At-least-once end to end, not just to the broker. The node keeps a reading
// until the broker acks it, and the broker keeps it until a bridge acks it, and
// a bridge acks only once the row is in Postgres. Two things make the second
// half true:
//   - a persistent session (clean: false) under a client id stable across
//     restarts, so the broker queues readings for an instance while it is down
//     and hands them over when it is back
//   - the PUBACK waits for the insert (handleMessage below). mqtt.js sends it
//     only when handleMessage calls back without an error
//
// Topics:
//   plants/<device>/reading   JSON body, QoS 1
//   plants/<device>/status    "online" / "offline", retained, set as the node's
//                             Last Will so the broker announces a dead node on
//                             its behalf - absence of data is a weaker signal.

import mqtt from 'mqtt';

const READING_RE = /^plants\/([^/]+)\/reading$/;
const STATUS_RE = /^plants\/([^/]+)\/status$/;

// Postgres error classes that retrying cannot fix: 22 is bad data (a string
// where a number goes), 23 is a broken constraint (an unknown device_id). A
// reading like that is dropped and acked, or the broker would redeliver it
// forever. Anything else - the database restarting, a lost connection - is
// worth another try.
const isPermanent = (err) => /^2[23]/.test(err.code ?? '');

export function startMqttBridge(ingest, url, options = {}) {
    const client = mqtt.connect(url, {
        // One id per instance, the same across restarts: the broker finds the
        // session, and the readings queued in it, by this id. Two instances
        // sharing an id would keep kicking each other off.
        clientId: options.clientId,
        username: options.username,
        password: options.password,
        reconnectPeriod: 5000,
        clean: false,
    });

    client.on('connect', ({ sessionPresent }) => {
        console.log(`mqtt: connected to ${url}${sessionPresent ? ', session resumed' : ''}`);
        // QoS 1 on the subscribe as well as the publish: at-least-once end to
        // end. The duplicate that buys is handled by the dedup index.
        client.subscribe(['plants/+/reading', 'plants/+/status'], { qos: 1 }, (err) => {
            if (err) console.error('mqtt: subscribe failed', err.message);
        });
    });

    client.on('reconnect', () => console.log('mqtt: reconnecting'));
    client.on('error', (err) => console.error('mqtt: error', err.message));

    // Called one message at a time, and for QoS 1 the PUBACK goes out only when
    // done() is called without an error.
    client.handleMessage = (packet, done) => {
        handle(packet.topic, packet.payload).then(
            () => done(),
            (err) => {
                console.error('mqtt: insert failed, will be redelivered:', err.message || err.code);
                done(err);
                // The broker redelivers an unacked message only when the
                // session resumes, so drop the connection to make that happen.
                // mqtt.js reconnects on its own after reconnectPeriod.
                client.stream.destroy();
            },
        );
    };

    // Resolves when the message is dealt with, stored or deliberately dropped.
    // Rejects only when it is worth delivering again.
    async function handle(topic, payload) {
        const statusMatch = STATUS_RE.exec(topic);
        if (statusMatch) {
            console.log(`mqtt: ${statusMatch[1]} is ${payload.toString()}`);
            return;
        }

        const match = READING_RE.exec(topic);
        if (!match) return;
        const topicDevice = match[1];

        let body;
        try {
            body = JSON.parse(payload.toString());
        } catch {
            console.error(`mqtt: ${topic} payload is not JSON, dropped`);
            return;
        }

        // The topic is authoritative for identity, not the payload: the ACL is
        // written in terms of topics, so trusting a device_id field would let a
        // node write history for another device.
        const device = topicDevice;

        try {
            await ingest(device, body);
        } catch (err) {
            if (!isPermanent(err)) throw err;
            if (err.code === '23503') {
                console.error(`mqtt: unknown device_id ${device}, dropped`);
            } else {
                console.error(`mqtt: ${topic} rejected by the database, dropped:`, err.message);
            }
        }
    }

    return client;
}
