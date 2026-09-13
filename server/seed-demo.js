// Generates a week of plausible readings so the dashboard can be built and
// judged before the hardware arrives. Not part of the running system: delete
// the rows with
//   docker exec plant-vitals-postgres psql -U postgres -d plant_vitals \
//     -c 'truncate readings;'
// once the real node is posting.
//
//   node server/seed-demo.js

import pg from 'pg';

const pool = new pg.Pool({
    connectionString:
        process.env.DATABASE_URL ||
        'postgres://postgres:postgres@localhost:55433/plant_vitals',
});

const DEVICE = 'plant-01';
const DAYS = 7;
const STEP_MIN = 5;

// Matches the calibration on the device row, so the generated raw values land
// in a realistic 0-100% band once converted.
const RAW_AIR = 3000;
const RAW_WATER = 1300;

const rows = [];
const now = Date.now();
const total = (DAYS * 24 * 60) / STEP_MIN;

// Watering events: the pot gets watered roughly every three days, which is what
// makes the soil trace a sawtooth rather than a slow slide to zero.
let wetness = 0.55; // 0 = bone dry, 1 = just watered

for (let i = total; i >= 0; i--) {
    const t = new Date(now - i * STEP_MIN * 60 * 1000);
    const hour = t.getHours() + t.getMinutes() / 60;
    const dayProgress = (total - i) / total;

    // Dry-down, plus a watering every ~3 days.
    wetness -= 0.0009 + Math.random() * 0.0002;
    const wateredNow = wetness < 0.28 && Math.random() < 0.08;
    if (wateredNow) wetness = 0.92;
    wetness = Math.max(0.05, Math.min(1, wetness));
    const soilRaw = Math.round(RAW_AIR - wetness * (RAW_AIR - RAW_WATER) + (Math.random() - 0.5) * 18);

    // Daylight: a smooth bell between 07:00 and 20:00, zero at night, with some
    // cloud. Peaks around 1100 lux, which is what a bright but not south-facing
    // window actually gives.
    const daylight = hour > 7 && hour < 20 ? Math.sin(((hour - 7) / 13) * Math.PI) : 0;
    const cloud = 0.72 + 0.28 * Math.sin(dayProgress * 9.1);
    const lux = Math.max(0, daylight * 1150 * cloud + (Math.random() - 0.5) * 40);

    // Indoor diurnal swing, warmest late afternoon.
    const temp = 21.2 + 1.9 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + (Math.random() - 0.5) * 0.25;
    // Humidity runs opposite temperature, and jumps right after watering.
    const humidity = 41 - 4.5 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) + (wateredNow ? 6 : 0) + (Math.random() - 0.5) * 1.2;
    const pressure = 1009 + 7 * Math.sin(dayProgress * 5.2) + (Math.random() - 0.5) * 0.6;
    const rssi = Math.round(-59 + (Math.random() - 0.5) * 7);

    rows.push([
        DEVICE,
        t.toISOString(),
        soilRaw,
        +temp.toFixed(2),
        +humidity.toFixed(2),
        +pressure.toFixed(2),
        +lux.toFixed(1),
        rssi,
        (total - i) * STEP_MIN * 60,
    ]);
}

const values = rows
    .map((_, i) => {
        const b = i * 9;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    })
    .join(',');

await pool.query('truncate readings');
await pool.query(
    `insert into readings
       (device_id, recorded_at, soil_raw, air_temp_c, humidity_pct, pressure_hpa, lux, rssi, uptime_s)
     values ${values}`,
    rows.flat(),
);

console.log(`seeded ${rows.length} demo readings over ${DAYS} days`);
await pool.end();
