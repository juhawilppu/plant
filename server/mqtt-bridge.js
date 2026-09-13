// Subscribes to the nodes' MQTT topics and writes each reading into Postgres.
//
// Runs INSIDE the API process rather than as its own container. On a 1 GB box
// with no swap, a second Node runtime costs ~60 MB for no benefit: it would
// share this pg pool's job anyway, and mqtt.js reconnects on its own, so the
// failure it would isolate us from does not exist. Kept in its own file so the
// separation is still legible, and so moving it out later is a one-line change.
//
// Topics:
//   plants/<device>/reading   JSON body, QoS 1
//   plants/<device>/status    "online" / "offline", retained, set as the node's
//                             Last Will so the broker announces a dead node on
//                             its behalf - absence of data is a weaker signal.

import mqtt from 'mqtt';

const READING_RE = /^plants\/([^/]+)\/reading$/;
const STATUS_RE = /^plants\/([^/]+)\/status$/;

export function startMqttBridge(pool, url, options = {}) {
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
            await pool.query(
                `insert into readings
                   (device_id, soil_raw, air_temp_c, humidity_pct, pressure_hpa, lux, rssi, uptime_s, msg_id)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 on conflict (device_id, msg_id) do nothing`,
                [
                    device,
                    body.soil_raw ?? null,
                    body.air_temp_c ?? null,
                    body.humidity_pct ?? null,
                    body.pressure_hpa ?? null,
                    body.lux ?? null,
                    body.rssi ?? null,
                    body.uptime_s ?? null,
                    body.msg_id ?? null,
                ],
            );
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
