# Roadmap

This project is a place to practise hard software engineering problems, from
UX to backend to infra. The plant only has to stay alive. Each item names the
problem and the hard part, which is the reason to do it.

Where to start: **1.1–1.3** (they fix data that is actually being lost today),
then **2.1–2.2**, then **3.1**.

---

## 1. Data correctness at the edge

- [x] **1.1 Make the delivery guarantee true.** The README says QoS 1, but
  `plant_node.ino` publishes at QoS 0 (PubSubClient does not track PUBACKs), so
  delivery is at-most-once. Switch clients or libraries, or implement an
  application-level ack. *Hard part:* making the guarantee in the docs match
  the one that actually runs. Also fix the leftover "five-minute" comments.
- [x] **1.2 Buffer on the node while offline.** Readings taken while WiFi or the
  broker is down are lost. Queue them in RTC memory or flash and replay them on
  reconnect. *Hard part:* limited memory, a buffer that survives a reboot, a
  replay order, and a policy for what to drop when the buffer is full.
  *Done:* a day in RAM, oldest first, oldest dropped when full. It does not
  survive a reboot yet.
- [ ] **1.3 Timestamp on the device.** Replayed readings make `recorded_at`
  (the arrival time) wrong. Add NTP and a `measured_at` column, and keep both.
  *Hard part:* clocks: drift, readings taken before the first sync, a reboot
  mid-buffer, and a node clock that disagrees with the server.
  *Partly done another way:* the node sends each reading's age (`age_ms`) and
  the server backdates by it. That needs no NTP, but only works within one
  boot, so a buffer that survives a reboot still needs real timestamps.
- [ ] **1.4 Late and out-of-order data end to end.** A replayed hour arrives
  all at once. The live stream, the snapshot, the charts and the "seconds since
  last reading" counter all assume data arrives in order. *Hard part:* choosing
  the semantics (event time or arrival time, and which one the UI shows).
- [x] **1.5 msg_id across reboots.** It was seeded from the RNG below 100,000,
  which would eventually land on ids already used, and the dedup index would
  silently drop those readings. *Done:* a boot count in NVS in the high 32
  bits, a per-boot sequence in the low 32.

## 2. Failure, beyond a process crashing

- [ ] **2.1 Network faults in the chaos monkey.** Use `tc netem` for latency,
  loss and reordering, and `iptables` for partitions (an instance that can
  reach Caddy but not Postgres, or not Mosquitto). *Hard part:* partial
  failure, where something looks healthy and isn't.
- [ ] **2.2 Kill the single points of failure.** Take down Postgres and
  Mosquitto, not just the API. What do the node, the bridges and the dashboard
  each do while the broker is down for 10 minutes? *Hard part:* choosing a
  degraded mode on purpose instead of getting one by accident.
- [ ] **2.3 Half-open connections.** The broker thinks the node is connected
  and it isn't, or the other way round. Check keepalive tuning and how long the
  Last Will takes to fire.
- [ ] **2.4 Resource exhaustion.** The box has 961 MB. Fill the disk, exhaust
  the Postgres connections, leak memory in one instance. *Hard part:* the
  failure shows up somewhere other than where it started.
- [ ] **2.5 Deterministic simulation test.** Run the ingest → notify → socket
  pipeline under a simulated clock and network, so the check.mjs invariants
  are tested across thousands of seeded failure schedules instead of one live
  run.

## 3. Real distribution

- [ ] **3.1 A second machine.** Move one API instance (and eventually
  everything) to another box. The two instances now stop failing together.
- [ ] **3.2 Postgres replication and failover.** Streaming replica, then
  automatic promotion (Patroni or similar). *Hard part:* split brain, writes
  lost at failover, and what "committed" means to the node.
- [ ] **3.3 Broker redundancy.** A bridged or clustered MQTT broker, with the
  node failing over between them. *Hard part:* duplicates and ordering across
  brokers, and retained state that disagrees between them.
- [ ] **3.4 Multi-region reads.** Serve the dashboard from a second region with
  replica lag, and show that lag honestly in the UI.

## 4. Scale and performance

- [ ] **4.1 Load test with fake nodes.** 1,000 simulated devices at 1 Hz, not
  the real ESP32. Find the first thing that breaks. *Hard part:* backpressure,
  batching inserts, NOTIFY throughput, and WebSocket fan-out.
- [ ] **4.2 Many dashboards.** 10k concurrent sockets. Memory per connection,
  and the reconnect storm when an instance dies with 5k clients on it (jitter,
  backoff, admission control).
- [ ] **4.3 Time-series storage.** A year is about 525k rows per device.
  Partitioning, retention, continuous rollups (TimescaleDB or hand-rolled), and
  keeping `/api/history` fast as the data grows.
- [ ] **4.4 A separate analytics store.** Serve the "All time" view from
  ClickHouse, fed from Postgres by CDC (logical replication) or by the bridge
  writing to both, while the live view stays on Postgres. Do 4.3 in plain
  Postgres first, so there is a baseline to compare against. Speed is not the
  reason: Postgres already buckets a year in milliseconds. *Hard part:* two
  stores that must agree. That means deciding what happens when one write
  lands and the other doesn't; accepting that `ReplacingMergeTree` dedups
  `msg_id` only when parts merge, so duplicates stay visible until then
  (unless you pay for `FINAL`); building rollups (`AggregatingMergeTree`)
  that stay correct when a replayed hour arrives late (1.4); showing
  honestly in the UI (8.1) that the two views disagree about the last few
  minutes; and backfilling or rebuilding a rollup without downtime. All of it
  runs on the same 961 MB box, with no added memory: ClickHouse expects a
  gigabyte or more to itself, so making it fit beside everything else
  (memory limits, smaller caches, turning off its system log tables) is part
  of the work, and so is what fails first when it doesn't fit (2.4).
  *Partly done:* the pipeline runs, but nothing reads from it yet.
  `server/cdc.js` reads a pgoutput replication slot and confirms a batch only
  after ClickHouse has stored it. It copies the history that predates the
  slot (from after the slot exists, so the copy overlaps the stream instead
  of leaving a gap) and starts over if Postgres drops the slot at the 1 GB
  WAL cap. Tested locally: `kill -9` with rows held (replayed), ClickHouse
  down (rows wait), and an interrupted copy (duplicates until merge, `FINAL`
  exact). ClickHouse idles at about 85 MB on the server under a 256 MB
  limit. With the default 80% ceiling, its first boot failed on its own
  memory limit, so the ceiling is 90%. The replication library's keepalive
  confirms the newest position *received*, which would drop unstored rows
  after a crash, so it is turned off in favour of our own. `/api/history`
  now reads ClickHouse (`FINAL`, so a replayed row never counts twice) and
  falls back to Postgres when ClickHouse errors or takes over 3 s. The
  response says which store answered (`source`). Locally both stores give
  identical buckets for every range, even with every row duplicated. Left
  open: rollups (materialized views) instead of `FINAL` over raw rows; a
  circuit breaker, since while ClickHouse hangs every request waits out the
  3 s first; showing on the page when the answer came from the fallback or
  trails the live view; a check that the two stores agree; and a
  least-privilege replication role instead of the `postgres` superuser (6.x).

## 5. Data lifecycle

- [ ] **5.1 Backups and a restore drill.** There are none today. A backup you
  have never restored from is only a hope. Time the restore.
- [ ] **5.2 Zero-downtime schema migrations.** Adding `measured_at` (1.3) is
  the first real one: expand/contract, with both instances running different
  versions during a rolling deploy.
- [ ] **5.3 Payload versioning.** Old firmware and new firmware publishing at
  the same time. Keep the schema compatible in both directions.

## 6. Security

- [ ] **6.1 Per-device identity.** Client certificates (mTLS) per node instead
  of a shared password. Provisioning, rotation and revocation.
- [ ] **6.2 Signed OTA with rollback.** A node that bricks itself on a bad
  update, with no one near it. Signed images, A/B partitions, automatic
  rollback when the new firmware fails its health check.
- [ ] **6.3 Secrets management.** `.env` on the box. Rotate `INGEST_TOKEN` and
  the MQTT passwords without downtime.
- [ ] **6.4 Threat model.** Write it down: what an attacker on the LAN, on the
  internet, or with the device in hand can do. The Docker socket in the chaos
  container is already one entry.

## 7. Observability

- [ ] **7.1 Metrics and dashboards.** Prometheus and Grafana: ingest rate,
  dedup hits, NOTIFY lag, socket count, reconnects, node RSSI and uptime.
- [ ] **7.2 SLOs and alerting.** Define "the reading reaches the screen within
  N seconds, 99.9% of the time" and measure it end to end. Alert on burn rate,
  not on thresholds. *Hard part:* alert fatigue on a one-person system.
- [ ] **7.3 Tracing a reading.** Carry one trace id from the node through
  MQTT, the bridge, Postgres and NOTIFY to the socket, and see where the
  milliseconds go.

## 8. UX

- [ ] **8.1 Show uncertainty honestly.** Stale, late, backfilled, gapped and
  uncalibrated data each look different, and none of them looks like a normal
  value. *Hard part:* doing it without clutter.
- [ ] **8.2 A notification that is worth having.** "Water me," without false
  alarms: hysteresis, a trend rather than a threshold, quiet hours, one
  notification rather than twenty. Web Push through the service worker.
- [x] **8.3 Offline-first PWA.** `sw.js` caches nothing on purpose today. Show
  the last known state offline, clearly labelled as old, without ever passing
  off stale data as live. *Plan:* keep the last data every view received
  (the live snapshot plus whatever the socket appended, and each history
  range) in the Cache API. On load, draw the saved copy at once, then fetch
  and replace it: stale-while-revalidate for data. The header says "Updating…"
  or "Offline" instead of "Live" while a saved copy is on screen, and the
  error card says when it was saved. Refetch on the `online` event. Seed the
  server clock offset from the saved copy. Skip a saved copy whose newest
  reading has aged out of the window, since it would claim "nothing in 48
  hours". *Hard part:* never writing a saved copy back as if it were fresh,
  a saved copy that arrives after the network answer, and doing all this
  without adding flicker (see 8.7).
  *Done:* as planned, with `web/src/savedCopy.js` holding the saved copies
  and `sw.js` caching the shell. The header says "Refreshing", "Not updating"
  or "Offline" before the age, and the dot goes grey. Left open: a new deploy
  shows up one visit late (the cached page is served while the new one
  downloads), and the shell cache keeps every old build's hashed files, since
  nothing prunes it yet.
- [ ] **8.4 Time zones and DST.** Daily buckets in `/api/history` around a DST
  change, and when the viewer's zone differs from the plant's.
- [ ] **8.5 Accessibility audit.** Screen-reader output for the charts, reduced
  motion, keyboard navigation. Test with a real screen reader.
- [ ] **8.6 Watering events.** Log when the plant was watered (a button, or
  detected from a jump in soil moisture) and annotate the charts with it.
  *Hard part:* reliable change-point detection on a noisy sensor.
- [x] **8.7 A header that holds still.** "Last reading N seconds ago" jumps
  every time the number gains a digit (9 → 10, 99 → 100): `tabular-nums`
  makes digits equal width, but not the count of digits, so the pill resizes
  and its neighbours shift. "Live" also flickers on page load, appearing and
  disappearing while the first fetch and the socket settle. *Hard part:*
  layout stability (reserve the width, or animate it) and not showing "Live"
  until the socket state is actually known, without slowing the first paint.
  *Done:* "Live" is gone, since the dot already says the node is alive. The
  pill reserves the width of the widest text it can show, by laying invisible
  copies of it in the same grid cell, so it no longer resizes as it counts.
- [ ] **8.8 Load the photo and static assets instantly.** The Monstera photo
  and the rest of the static shell load from the network on every visit.
  Preload the right photo size, and cache the hashed static assets in `sw.js`
  (cache-first is safe for files whose name changes with their content), while
  sensor data stays network-only. A first step towards 8.3. *Hard part:* a
  service worker that caches the shell but can never serve stale readings, and
  that updates cleanly when a new build ships.
  *Mostly done by 8.3:* the shell is cached. The photo is not preloaded yet.
- [ ] **8.9 Sparklines you can read.** The small charts on the live page are
  confusing. Nothing on them says they cover the last 48 hours: the only
  mention is a footer line far below them. They also show no values: hovering
  or tapping a point does nothing, so there is no way to see what a bump was
  or when it happened without going to the history page. Label the time range
  on or next to the charts, and show the value and time of the point under
  the pointer or finger. *Hard part:* touch has no hover, so it needs tap or
  drag instead; the charts are `aria-hidden` today, so the new detail has to
  reach screen readers too (see 8.5); and all this has to fit without turning
  a small trend line into a cluttered chart.

## 9. Product scope

- [ ] **9.1 More than one plant.** Most of the code assumes `plant-01`. Device
  onboarding (WiFi provisioning with no keyboard) and a fleet view.
- [ ] **9.2 Users and sharing.** Auth, and a read-only link for someone else,
  with permissions per plant.

## 10. Delivery

- [ ] **10.1 Tests and CI.** There are none today. Unit tests for `ingest()`
  and the history bucketing, check.mjs against a local stack in CI, and a
  firmware build in CI.
- [ ] **10.2 Infrastructure as code.** The droplet is set up by hand plus
  `deploy.sh`. Rebuild it from nothing with Terraform/Ansible, and time how
  long that takes.
- [ ] **10.3 Canary and automatic rollback.** Deploy to one instance, compare
  its error rate with the other's, and roll back without a human.
- [ ] **10.4 Firmware in the loop.** Run the real firmware in an emulator
  (Wokwi or QEMU) against the real stack in CI.

## 11. Calibration and reading the numbers

- [x] **11.1 Re-calibrate soil moisture.** On the current scale the plant only
  needs water below about 5%, but the verdict in `App.jsx` says "Needs water"
  below 20% and "Getting dry" below 40%, so it cries wolf. Re-take the
  air/water points on the device row, or calibrate against the plant's own
  dry and just-watered soil, and move the thresholds to match. *Hard part:*
  where thresholds live (per device, next to `soil_raw_air`/`soil_raw_water`,
  not hard-coded in the UI), and whether old readings are re-computed or keep
  the calibration they were taken under.
  *Done:* "Needs water" below 5%, "Getting dry" below 15%, and a watering is
  now a rise of 30 points or more (real ones are 50–80), not 5. The values
  live in `App.jsx`, which is right while there is one device (see 9.1).
- [x] **11.2 Air temperature reads 1–2 °C high.** The dashboard shows 23.9 °C
  where the room is likely 22–23 °C. Probably self-heating: the AHT20 sits near
  the ESP32 and its WiFi radio. Check against a reference thermometer, then fix
  it physically (distance, sleep between readings) or with a stored offset.
  *Hard part:* keeping the raw value alongside the corrected one, and knowing
  whether the error is a constant offset or depends on duty cycle and ambient
  temperature.
  *Done, nothing to fix:* against a reference thermometer the sensor read
  23.6 °C where the reference read 24.0 °C, so it is 0.4 °C low, not high, and
  within the AHT20's own ±0.3 °C tolerance plus the reference's. No offset is
  stored and the raw value is what is shown.
- [x] **11.3 Say whether the WiFi signal is good.** The RSSI tile shows a bare
  dBm number. Annotate it in words, for example better than −60 good, −60 to
  −70 fair, −70 to −80 weak, worse than −80 poor. *Hard part:* same as the
  moisture verdict: words and an icon, not colour alone, and bands that don't
  flicker when the value sits on a boundary.
  *Done, for temperature and humidity too* (`web/src/bands.js`): each tile
  has a word and an icon under its number. A band changes only once the value
  is clear of its edge by a margin (3 dB, 0.5 °C, 2 points), replayed over the
  readings on screen so the same data always gives the same word.
