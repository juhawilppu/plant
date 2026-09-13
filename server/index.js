// Plant vitals server: accepts readings from the ESP32 node, stores them in
// Postgres, and serves them back to the dashboard.
//
// Deliberately NOT behind a queue. A single node posting every five minutes is
// 288 rows a day; a broker would be one more daemon to run, secure and monitor
// for no benefit at that volume. The node retries on failure and a missed plant
// reading is worthless anyway. If this ever grows to many nodes, or needs to
// buffer through server downtime, MQTT goes in front of this file and nothing
// else changes.

import express from 'express';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startMqttBridge } from './mqtt-bridge.js';

const PORT = process.env.PORT || 8090;

// The shared secret the node sends in X-Device-Token. No per-device keys: one
// household, a handful of nodes, and rotating a single token means reflashing
// only as many boards as exist.
const INGEST_TOKEN = process.env.INGEST_TOKEN;
if (!INGEST_TOKEN) {
    console.error('INGEST_TOKEN is not set - refusing to start an open ingest endpoint');
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString:
        process.env.DATABASE_URL ||
        'postgres://postgres:postgres@localhost:55433/plant_vitals',
});

const app = express();
app.use(express.json({ limit: '8kb' }));

// Converts a raw ADC value to a percentage using the device's two calibration
// points. Capacitive probes read higher in air than in water, so the scale runs
// backwards: raw == soil_raw_air means 0% wet, raw == soil_raw_water means 100%.
// Returns null when the probe has not been calibrated yet, which is honest -
// an uncalibrated capacitive reading genuinely does not mean anything.
function soilPercent(raw, air, water) {
    if (raw == null || air == null || water == null || air === water) return null;
    const pct = ((air - raw) / (air - water)) * 100;
    // Clamped because soil wetter than the calibration water point, or a probe
    // lifted clear of the pot, would otherwise report beyond 0-100.
    return Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10;
}

app.get('/health', async (_req, res) => {
    try {
        await pool.query('select 1');
        res.json({ ok: true });
    } catch (err) {
        res.status(503).json({ ok: false, error: err.message });
    }
});

// The node's only write. Every field except device_id is optional, so a single
// failed sensor still lets the rest of the reading through rather than throwing
// the whole sample away.
app.post('/api/readings', async (req, res) => {
    if (req.get('X-Device-Token') !== INGEST_TOKEN) {
        return res.status(401).json({ error: 'bad token' });
    }

    const b = req.body ?? {};
    if (!b.device_id) return res.status(400).json({ error: 'device_id required' });

    try {
        const { rows } = await pool.query(
            `insert into readings
               (device_id, soil_raw, air_temp_c, humidity_pct, pressure_hpa, lux, rssi, uptime_s, msg_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (device_id, msg_id) do nothing
             returning id, recorded_at`,
            [
                b.device_id,
                b.soil_raw ?? null,
                b.air_temp_c ?? null,
                b.humidity_pct ?? null,
                b.pressure_hpa ?? null,
                b.lux ?? null,
                b.rssi ?? null,
                b.uptime_s ?? null,
                b.msg_id ?? null,
            ],
        );
        // No row returned means the dedup index swallowed a repeat. That is a
        // success from the publisher's point of view, not an error.
        if (!rows.length) return res.status(200).json({ duplicate: true });
        res.status(201).json({ id: rows[0].id, recorded_at: rows[0].recorded_at });
    } catch (err) {
        // An unknown device_id trips the foreign key. That is a real error worth
        // surfacing plainly rather than silently creating a device row, so a
        // typo in the firmware cannot quietly start a second history.
        if (err.code === '23503') {
            return res.status(400).json({ error: `unknown device_id: ${b.device_id}` });
        }
        console.error('insert failed', err);
        res.status(500).json({ error: 'insert failed' });
    }
});

app.get('/api/devices', async (_req, res) => {
    const { rows } = await pool.query(
        `select d.*,
                (select recorded_at from readings r
                  where r.device_id = d.device_id
                  order by recorded_at desc limit 1) as last_seen
           from devices d order by d.device_id`,
    );
    res.json(rows);
});

app.get('/api/readings', async (req, res) => {
    const device = req.query.device || 'plant-01';
    // Clamped so a stray ?hours=999999 cannot ask Postgres for everything.
    const hours = Math.min(Math.max(parseInt(req.query.hours ?? '24', 10) || 24, 1), 24 * 90);

    const dev = await pool.query(
        'select soil_raw_air, soil_raw_water from devices where device_id = $1',
        [device],
    );
    if (dev.rowCount === 0) return res.status(404).json({ error: 'unknown device' });
    const { soil_raw_air, soil_raw_water } = dev.rows[0];

    const { rows } = await pool.query(
        `select recorded_at, soil_raw, air_temp_c, humidity_pct, pressure_hpa, lux, rssi
           from readings
          where device_id = $1
            and recorded_at > now() - ($2 || ' hours')::interval
          order by recorded_at`,
        [device, hours],
    );

    res.json({
        device,
        hours,
        calibrated: soil_raw_air != null && soil_raw_water != null,
        readings: rows.map((r) => ({
            ...r,
            soil_pct: soilPercent(r.soil_raw, soil_raw_air, soil_raw_water),
        })),
    });
});

// In production the built dashboard is served by this same process, so there is
// one container and no CORS. In development Vite serves it on 5173 and proxies
// /api here instead, so this directory simply does not exist yet.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
app.use(express.static(webDist));

app.listen(PORT, () => console.log(`plant-vitals server listening on :${PORT}`));

// MQTT is the node's real path in; the HTTP endpoint above stays for curl, for
// bring-up before the broker is trusted, and as a fallback if the broker is
// down. Without MQTT_URL the process is simply HTTP-only, which is how it runs
// on a laptop.
if (process.env.MQTT_URL) {
    startMqttBridge(pool, process.env.MQTT_URL, {
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
    });
} else {
    console.log('mqtt: MQTT_URL not set, running HTTP-only');
}
