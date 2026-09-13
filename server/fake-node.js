// Pretends to be the ESP32, so the whole MQTT path can be tested before any
// hardware exists. Publishes the same topics, with the same QoS, the same
// Last Will and the same msg_id counter as firmware/plant_node.
//
//   node server/fake-node.js                       # one reading, then exit
//   node server/fake-node.js --interval 5          # every 5s until Ctrl-C
//   node server/fake-node.js --burst 288           # a day of history, fast
//   node server/fake-node.js --duplicate           # send each twice, same
//                                                  # msg_id: proves the dedup
//   node server/fake-node.js --host mqtt://1.2.3.4:1883
//
// Credentials come from the environment (set -a; . ./.env; set +a), matching
// how the server itself is configured:
//   MQTT_URL (or --host), MQTT_NODE_PASSWORD

import mqtt from 'mqtt';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
}

const URL = arg('host', process.env.MQTT_URL || 'mqtt://localhost:1883');
const DEVICE = arg('device', 'plant-01');
const INTERVAL = Number(arg('interval', 0));
const BURST = Number(arg('burst', 0));
const DUPLICATE = Boolean(arg('duplicate', false));

const READING_TOPIC = `plants/${DEVICE}/reading`;
const STATUS_TOPIC = `plants/${DEVICE}/status`;

// A slow random walk rather than pure noise, so the dashboard's charts look
// like a plant rather than like static. Capacitive probes read HIGHER as the
// soil dries, so wetness and raw move in opposite directions.
let wetness = 0.62;
let msgId = Date.now() % 100000;

function reading() {
    wetness = Math.max(0.05, Math.min(1, wetness - 0.004 + Math.random() * 0.002));
    if (wetness < 0.2) wetness = 0.95; // "someone watered it"

    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    const daylight = hour > 7 && hour < 20 ? Math.sin(((hour - 7) / 13) * Math.PI) : 0;

    return {
        // device_id is sent for parity with the HTTP path, but the bridge
        // ignores it and trusts the topic - see mqtt-bridge.js.
        device_id: DEVICE,
        msg_id: ++msgId,
        soil_raw: Math.round(3000 - wetness * 1700 + (Math.random() - 0.5) * 20),
        air_temp_c: +(21.3 + 1.8 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + (Math.random() - 0.5) * 0.3).toFixed(2),
        humidity_pct: +(40 - 4 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + (Math.random() - 0.5) * 1.5).toFixed(2),
        pressure_hpa: +(1012 + (Math.random() - 0.5) * 3).toFixed(2),
        lux: +Math.max(0, daylight * 1100 + (Math.random() - 0.5) * 40).toFixed(1),
        rssi: Math.round(-58 + (Math.random() - 0.5) * 8),
        uptime_s: Math.round(process.uptime()),
    };
}

const client = mqtt.connect(URL, {
    clientId: `fake-${DEVICE}-${Math.random().toString(16).slice(2, 8)}`,
    username: 'plantnode',
    password: process.env.MQTT_NODE_PASSWORD,
    // The broker publishes this for us if the connection drops without a clean
    // disconnect - the node announcing its own death.
    will: { topic: STATUS_TOPIC, payload: 'offline', qos: 1, retain: true },
});

client.on('error', (err) => {
    console.error('mqtt error:', err.message);
    process.exit(1);
});

client.on('connect', async () => {
    console.log(`connected to ${URL} as plantnode`);
    // Retained, so anything that subscribes later immediately learns the node
    // is up without waiting for the next cycle.
    client.publish(STATUS_TOPIC, 'online', { qos: 1, retain: true });

    const publish = (r) =>
        new Promise((resolve) => client.publish(READING_TOPIC, JSON.stringify(r), { qos: 1 }, resolve));

    const send = async () => {
        const r = reading();
        await publish(r);
        if (DUPLICATE) {
            // Same msg_id twice, which is exactly what QoS 1 redelivery looks
            // like. The dedup index should keep the second one out.
            await publish(r);
        }
        console.log(
            `${READING_TOPIC} msg_id=${r.msg_id} soil_raw=${r.soil_raw} ` +
                `temp=${r.air_temp_c} lux=${r.lux}${DUPLICATE ? ' (sent twice)' : ''}`,
        );
    };

    if (BURST) {
        for (let i = 0; i < BURST; i++) await send();
        console.log(`published ${BURST} readings${DUPLICATE ? ' (each twice)' : ''}`);
        client.end();
        return;
    }

    await send();

    if (!INTERVAL) {
        client.end();
        return;
    }

    console.log(`publishing every ${INTERVAL}s - Ctrl-C to stop`);
    setInterval(send, INTERVAL * 1000);
});

process.on('SIGINT', () => {
    console.log('\ngoing offline cleanly');
    client.publish(STATUS_TOPIC, 'offline', { qos: 1, retain: true }, () => {
        client.end(() => process.exit(0));
    });
});
