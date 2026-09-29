-- ClickHouse copy of the readings, fed from Postgres by server/cdc.js.
--
-- Applied by the image's entrypoint on the data volume's first boot only, like
-- db/schema.sql for Postgres. To re-apply: drop the plant-vitals-chdata volume.
-- cdc.js then copies the whole history across again (see cdc_backfill).

create table if not exists plant_vitals.readings
(
    -- Postgres's primary key. Unique, so it is what tells a duplicate apart.
    id            UInt64,
    device_id     LowCardinality(String),
    recorded_at   DateTime64(3, 'UTC'),
    soil_raw      Nullable(Int32),
    air_temp_c    Nullable(Float32),
    humidity_pct  Nullable(Float32),
    pressure_hpa  Nullable(Float32),
    lux           Nullable(Float32),
    rssi          Nullable(Int32),
    uptime_s      Nullable(Int64),
    msg_id        Nullable(Int64),
    -- When the row reached ClickHouse. recorded_at minus this is the pipeline's lag.
    synced_at     DateTime64(3, 'UTC') default now64(3)
)
-- The CDC is at-least-once: after a crash it replays from the last position it
-- confirmed, and the first backfill overlaps the stream. ReplacingMergeTree
-- keeps one row per sorting key, but only once the parts holding the copies
-- have merged, which happens in the background at a time of its choosing.
-- Until then both copies are visible, so a query that must not count one twice
-- says FINAL (or groups by id). That is the price of exactly-once here.
engine = ReplacingMergeTree
partition by toYYYYMM(recorded_at)
order by (device_id, recorded_at, id);

-- Whether the history before the replication slot has been copied across.
-- cdc.js empties this when it creates a new slot and writes a row once the copy
-- is complete, so a copy interrupted halfway is started again on the next run.
create table if not exists plant_vitals.cdc_backfill
(
    slot          String,
    completed_at  DateTime default now(),
    rows          UInt64
)
engine = MergeTree
order by slot;
