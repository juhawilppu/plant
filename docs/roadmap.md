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
- [ ] **8.3 Offline-first PWA.** `sw.js` caches nothing on purpose today. Show
  the last known state offline, clearly labelled as old, without ever passing
  off stale data as live.
- [ ] **8.4 Time zones and DST.** Daily buckets in `/api/history` around a DST
  change, and when the viewer's zone differs from the plant's.
- [ ] **8.5 Accessibility audit.** Screen-reader output for the charts, reduced
  motion, keyboard navigation. Test with a real screen reader.
- [ ] **8.6 Watering events.** Log when the plant was watered (a button, or
  detected from a jump in soil moisture) and annotate the charts with it.
  *Hard part:* reliable change-point detection on a noisy sensor.

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
