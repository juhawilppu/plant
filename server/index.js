// Plant vitals server: accepts readings from the ESP32 node, stores them in
// Postgres, and serves them back to the dashboard.
//
// The node publishes over MQTT and mqtt-bridge.js writes those readings; the
// HTTP POST below is kept for curl and as a fallback. A single node posting
// every minute is 1,440 rows a day, so there is no queue in front of Postgres:
// a missed plant reading is worthless anyway.

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
    // soil_raw_water is calibrated from the wettest soil actually observed, not
    // a glass of water - soil never gets as saturated as full submersion, so
    // pinning 100% there would compress the whole real range toward the dry
    // end. A reading wetter than anything seen so far (right after watering)
    // is real and allowed to show past 100%, rather than being clamped away.
    // The dry end still floors at 0: nothing is drier than "no water at all".
    return Math.round(Math.max(0, pct) * 10) / 10;
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

// The long-term view asks for months at a time, and months of one-minute
// samples are the one thing this API cannot just hand over: a year is ~525,000
// rows, far more than the wire wants to carry and far more than a chart a
// thousand pixels wide can draw. So the server buckets, and sends back the
// average of each bucket together with its low and high - the spread is the
// part a mean would quietly destroy, and over a day it is most of the story.
const BUCKET_LADDER_S = [
    300, // 5 min - the finest step, five of the node's readings each
    900,
    1800,
    3600,
    3 * 3600,
    6 * 3600,
    12 * 3600,
    86400,
    2 * 86400,
    3 * 86400,
    7 * 86400,
];

// Few enough marks that the smallest of the three cards, about 340px of plot,
// still has room between them. Overshoot this and neighbouring marks land on
// the same pixel column, which is where a line stops being a line.
const MAX_BUCKETS = 200;

// Any bucket shorter than a day still straddles the day/night cycle, so the
// line keeps swinging from mark to mark - and once the marks are a pixel apart
// that swing fills in solid and the trend underneath it disappears. Past a
// couple of weeks the bucket therefore snaps to whole days: the line becomes
// the daily mean, which is smooth and actually trends, and the swing it used to
// draw moves into the band, which is what the band is for.
const DAY_BUCKET_FLOOR_S = 14 * 86400;

const HISTORY_RANGES = { '1m': 30, '3m': 91, '6m': 182, '12m': 365, all: null };

function bucketFor(spanSeconds) {
    const ladder =
        spanSeconds > DAY_BUCKET_FLOOR_S
            ? BUCKET_LADDER_S.filter((s) => s >= 86400)
            : BUCKET_LADDER_S;
    return (
        ladder.find((s) => spanSeconds / s <= MAX_BUCKETS) ?? ladder[ladder.length - 1]
    );
}

app.get('/api/history', async (req, res) => {
    const device = req.query.device || 'plant-01';
    const range = String(req.query.range ?? '3m');
    if (!(range in HISTORY_RANGES)) {
        return res.status(400).json({ error: `unknown range: ${range}` });
    }

    const dev = await pool.query(
        'select soil_raw_air, soil_raw_water from devices where device_id = $1',
        [device],
    );
    if (dev.rowCount === 0) return res.status(404).json({ error: 'unknown device' });
    const { soil_raw_air, soil_raw_water } = dev.rows[0];

    // "All time" cannot pick a bucket until it knows how far back the history
    // actually goes, so the bounds are fetched first. The fixed ranges want the
    // same row anyway, to tell the dashboard when recording started.
    const bounds = await pool.query(
        'select min(recorded_at) as first from readings where device_id = $1',
        [device],
    );
    const firstReading = bounds.rows[0].first;

    const to = new Date();
    const days = HISTORY_RANGES[range];
    const from =
        range === 'all'
            ? (firstReading ?? to)
            : new Date(to.getTime() - days * 86400 * 1000);

    // A brand-new device has no span at all; one bucket's worth keeps the
    // ladder from dividing by zero.
    const spanSeconds = Math.max(300, (to.getTime() - new Date(from).getTime()) / 1000);
    const bucketSeconds = bucketFor(spanSeconds);

    const { rows } = await pool.query(
        `select to_timestamp(floor(extract(epoch from recorded_at) / $3) * $3) as t,
                count(*)::int                as n,
                avg(soil_raw)::float8        as soil_raw_avg,
                min(soil_raw)                as soil_raw_min,
                max(soil_raw)                as soil_raw_max,
                avg(air_temp_c)::float8      as air_temp_c_avg,
                min(air_temp_c)              as air_temp_c_min,
                max(air_temp_c)              as air_temp_c_max,
                avg(humidity_pct)::float8    as humidity_pct_avg,
                min(humidity_pct)            as humidity_pct_min,
                max(humidity_pct)            as humidity_pct_max,
                avg(lux)::float8             as lux_avg,
                min(lux)                     as lux_min,
                max(lux)                     as lux_max
           from readings
          where device_id = $1
            and recorded_at >= $2
          group by 1
          order by 1`,
        [device, from, bucketSeconds],
    );

    res.json({
        device,
        range,
        bucketSeconds,
        from,
        to,
        firstReading,
        calibrated: soil_raw_air != null && soil_raw_water != null,
        buckets: rows.map((r) => ({
            t: r.t,
            n: r.n,
            // The raw soil scale runs backwards - a capacitive probe reads lower
            // the wetter it gets - so the bucket's driest sample is its highest
            // raw value, and min and max swap places on the way through.
            soil_pct_avg: soilPercent(r.soil_raw_avg, soil_raw_air, soil_raw_water),
            soil_pct_min: soilPercent(r.soil_raw_max, soil_raw_air, soil_raw_water),
            soil_pct_max: soilPercent(r.soil_raw_min, soil_raw_air, soil_raw_water),
            air_temp_c_avg: r.air_temp_c_avg,
            air_temp_c_min: r.air_temp_c_min,
            air_temp_c_max: r.air_temp_c_max,
            humidity_pct_avg: r.humidity_pct_avg,
            humidity_pct_min: r.humidity_pct_min,
            humidity_pct_max: r.humidity_pct_max,
            lux_avg: r.lux_avg,
            lux_min: r.lux_min,
            lux_max: r.lux_max,
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
