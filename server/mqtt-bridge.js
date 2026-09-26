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
// Topics:
//   plants/<device>/reading   JSON body, QoS 1
//   plants/<device>/status    "online" / "offline", retained, set as the node's
//                             Last Will so the broker announces a dead node on
//                             its behalf - absence of data is a weaker signal.

import mqtt from 'mqtt';

const READING_RE = /^plants\/([^/]+)\/reading$/;
const STATUS_RE = /^plants\/([^/]+)\/status$/;

export function startMqttBridge(ingest, url, options = {}) {
    const client = mqtt.connect(url, {
        clientId: `plant-bridge-${Math.random().toString(16).slice(2, 10)}`,
        username: options.username,
        password: options.password,
        reconnectPeriod: 5000,
        clean: true,
    });

    client.on('connect', () => {
        console.log(`mqtt: connected to ${url}`);
        // QoS 1 on the subscribe as well as the publish: at-least-once end to
        // end. The duplicate that buys is handled below.
        client.subscribe(['plants/+/reading', 'plants/+/status'], { qos: 1 }, (err) => {
            if (err) console.error('mqtt: subscribe failed', err.message);
        });
    });

    client.on('reconnect', () => console.log('mqtt: reconnecting'));
    client.on('error', (err) => console.error('mqtt: error', err.message));

    client.on('message', async (topic, payload) => {
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
            if (err.code === '23503') {
                console.error(`mqtt: unknown device_id ${device}, dropped`);
            } else {
                console.error('mqtt: insert failed', err.message);
            }
        }
    });

    return client;
}
