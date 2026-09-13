-- Plant vitals schema.
--
-- Two tables: devices holds one row per sensor node and carries its soil
-- calibration; readings is the append-only measurement log.
--
-- Applied automatically by docker-compose on the Postgres volume's first boot.
-- To re-apply after editing: docker compose down -v && docker compose up -d

create table if not exists devices (
    device_id       text primary key,
    label           text not null,
    plant           text,

    -- Soil calibration, captured once per probe with the two-point method:
    -- the raw ADC value in air (dry end) and submerged in water (wet end).
    -- Deliberately stored here rather than compiled into the firmware, so
    -- recalibrating a probe is an UPDATE and never a reflash. A capacitive
    -- probe reads HIGHER in air than in water, hence air > water.
    soil_raw_air    integer,
    soil_raw_water  integer,

    created_at      timestamptz not null default now()
);

create table if not exists readings (
    id            bigserial primary key,
    device_id     text not null references devices (device_id),

    -- When the server accepted the reading. The ESP32 has no battery-backed
    -- clock and would have to fetch NTP to know the time, so the server
    -- timestamps instead. Fine at a 5-minute cadence.
    recorded_at   timestamptz not null default now(),

    -- Raw 12-bit ADC value, 0-4095. Converted to a percentage at read time
    -- using the device's calibration, never stored pre-converted: that way a
    -- recalibration retroactively fixes the whole history.
    soil_raw      integer,

    air_temp_c    real,
    humidity_pct  real,
    pressure_hpa  real,
    lux           real,

    -- Diagnostics. rssi earns its place: "the readings stopped" is usually a
    -- WiFi placement problem, and this is what tells you that.
    rssi          integer,
    uptime_s      bigint,

    -- A counter the node increments per reading. MQTT QoS 1 is at-least-once,
    -- which means the broker is allowed to redeliver, so the same reading can
    -- arrive twice. This is what makes the insert idempotent. Null is allowed
    -- and never conflicts (Postgres treats nulls as distinct), so a publisher
    -- that sends no id simply gets no deduplication rather than an error.
    msg_id        bigint
);

-- Backs the bridge's "on conflict (device_id, msg_id) do nothing".
create unique index if not exists readings_dedup_idx
    on readings (device_id, msg_id);

-- Every dashboard query is "latest N for this device", so this is the index
-- that matters.
create index if not exists readings_device_time_idx
    on readings (device_id, recorded_at desc);

-- The plant this project starts with. Calibration is null until the probe is
-- measured in air and water; the API returns soil_pct as null until then.
insert into devices (device_id, label, plant)
values ('plant-01', 'Living room window', 'unknown')
on conflict (device_id) do nothing;
