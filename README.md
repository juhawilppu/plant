# Plant vitals

Soil moisture, light, air temperature and humidity from a houseplant, measured by
an ESP32 on the windowsill, stored in Postgres on the droplet, read on a React
dashboard.

Hardware, parts list and wiring: **`docs/hardware.md`**.

---

## The shape of it

```
ESP32 (firmware/plant_node)
  every 5 min: read 3 sensors, publish JSON at QoS 1
        |
        |  plants/<device>/reading    the measurement
        |  plants/<device>/status     online / offline, retained, set as the
        |                             node's Last Will
        v
Mosquitto (mosquitto/config)   authenticated, per-role ACL
        |
        v
server/mqtt-bridge.js   subscribes plants/+/reading, writes to Postgres
        |               runs inside the API process, not its own container
        v
Postgres          devices  one row per node, holds the soil calibration
                  readings append-only log, deduplicated on (device_id, msg_id)
        ^
        |
server/index.js   Express: GET /api/readings, GET /api/devices,
        |         POST /api/readings (kept for curl and as a fallback),
        |         and serves the built dashboard
        v
web/              Vite + React, hand-rolled SVG charts
```

### Why MQTT, given the volume does not need it

288 rows a day does not justify a broker on operational grounds, and the HTTP
endpoint that predates this still works. MQTT is here for what it makes possible
rather than what it relieves:

- **Fan-out.** The node publishes to a topic and does not know its consumers, so
  a second one - Home Assistant, a phone, a `mosquitto_sub` in a terminal - costs
  nothing and needs no firmware change.
- **Last Will.** The broker publishes `offline` on the node's behalf when its
  connection dies, so the system reports its own death instead of the dashboard
  inferring it from missing rows.
- **Retained messages.** Whatever subscribes at 3am gets the last value at once
  rather than waiting up to five minutes.
- **One persistent connection** with keepalives, instead of a fresh TLS handshake
  every cycle - which is the expensive part, and would decide battery life.

QoS 1 is at-least-once, so the broker may redeliver and the same reading can
arrive twice. That is what `msg_id` and the unique index on
`(device_id, msg_id)` are for: the insert is idempotent, and a duplicate is a
no-op rather than a second row. `server/fake-node.js --duplicate` exercises it.

The bridge trusts the **topic** for device identity, not the `device_id` in the
payload, because the ACL is written in terms of topics - trusting the body would
let one node write history for another.

### Calibration lives in the database, not the firmware

The node sends the **raw 12-bit ADC value** and the server converts it to a
percentage using `soil_raw_air` and `soil_raw_water` on the device row. Two
consequences, both wanted: recalibrating a probe is an `UPDATE` rather than a
reflash, and a recalibration fixes the **whole history** retroactively rather
than leaving a discontinuity on the day it changed.

Until those two columns are filled, the API returns `soil_pct: null` and the
dashboard says so instead of showing a fabricated number. An uncalibrated
capacitive reading genuinely does not mean anything.

---

## Running it locally

```sh
cp .env.example .env          # then: openssl rand -hex 24  -> INGEST_TOKEN
docker compose up -d postgres # schema applied on first boot

cd server && npm install && cd ..
node server/seed-demo.js      # a week of plausible fake readings, for the UI

set -a; . ./.env; set +a
node server/index.js          # API on :8090

cd web && npm install && npm run dev   # dashboard on :5173, proxies /api to 8090
```

For a production-shaped run instead, `npm run build` in `web/` and the API serves
the built dashboard itself at `http://localhost:8090/`.

### Faking a node

`server/fake-node.js` publishes to MQTT exactly as the firmware will - same
topics, same QoS 1, same Last Will, same `msg_id` counter - so the whole path can
be tested with no hardware:

```sh
export MQTT_NODE_PASSWORD=$(ssh root@185.14.186.98 \
    'grep ^MQTT_NODE_PASSWORD /opt/plant-vitals/.env | cut -d= -f2')

H=mqtts://mqtt.juhawilppu.com:8883
node server/fake-node.js --host $H                  # one reading
node server/fake-node.js --host $H --interval 5     # every 5s until Ctrl-C
node server/fake-node.js --host $H --burst 288      # a day of readings, fast
node server/fake-node.js --host $H --duplicate      # each sent twice with the
                                                    # same msg_id: proves the dedup
```

Watching the live stream, which is the debugging ergonomics MQTT buys:

```sh
ssh root@185.14.186.98 "docker exec plant-vitals-mosquitto \
    mosquitto_sub -t 'plants/#' -v -u bridge -P \"\$MQTT_BRIDGE_PASSWORD\""
```

Posting a reading by hand over the HTTP fallback:

```sh
curl -X POST localhost:8090/api/readings \
  -H 'Content-Type: application/json' \
  -H "X-Device-Token: $INGEST_TOKEN" \
  -d '{"device_id":"plant-01","soil_raw":2450,"air_temp_c":21.4,
       "humidity_pct":38.2,"pressure_hpa":1014.6,"lux":812.5,"rssi":-58}'
```

Clearing the demo rows once the real node is posting:

```sh
docker exec plant-vitals-postgres psql -U postgres -d plant_vitals -c 'truncate readings;'
```

---

## The server

Deployed and running on **185.14.186.98** (Ubuntu 24.04, 961 MB, no swap).

| What | Where |
|---|---|
| Dashboard + API | **https://plant.juhawilppu.com** - via Cloudflare |
| MQTT over TLS | **mqtts://mqtt.juhawilppu.com:8883** |
| MQTT plaintext | 1883, **compose network only** - not published to the host |
| Postgres | **loopback only**, `127.0.0.1:55433` |
| API direct | `127.0.0.1:8090` on the box; Caddy is the only public route in |
| Project root | `/opt/plant-vitals` |
| Secrets | `/opt/plant-vitals/.env`, mode 600, generated on the box |

### DNS and TLS

Two records in Cloudflare, with deliberately different proxy states:

| Record | Proxy | Why |
|---|---|---|
| `plant` A 185.14.186.98 | **on** (orange) | Dashboard. Cloudflare terminates TLS for browsers, absorbs traffic, hides the origin. |
| `mqtt` A 185.14.186.98 | **off** (grey) | The proxy only carries HTTP/HTTPS on a fixed port list, and 8883 is not on it. A proxied name resolves to Cloudflare's anycast IPs, so an MQTT client would be dialling a port Cloudflare does not answer. Grey resolves straight here. |

Hostnames do not carry port numbers, so one grey record could serve both. Two
records exist so the dashboard can keep the proxy while MQTT bypasses it.

Caddy obtains and renews both certificates automatically, and the two names take
different ACME paths for a reason worth remembering:

- `mqtt` is direct, so **TLS-ALPN-01** works.
- `plant` is proxied, and TLS-ALPN-01 **cannot** work through it - Cloudflare
  terminates the TLS handshake, so the `acme-tls/1` protocol never reaches the
  origin. Caddy falls back to **HTTP-01**, which Cloudflare does forward. This is
  visible in the logs on first issuance: one failed ALPN attempt, then success.

Caddy runs with `auto_https disable_redirects`. An origin that force-redirects
HTTP to HTTPS breaks a Cloudflare zone set to Flexible, because Cloudflare
fetches over HTTP and follows the redirect straight back to itself. Without the
redirect the origin answers whichever protocol Cloudflare uses, so the zone's SSL
mode can change without breaking the site. Currently Cloudflare reaches the
origin over TLS (confirmed in Caddy's access log), so the zone is on Full or Full
(strict).

Mosquitto cannot read Caddy's key - Caddy keeps it root-only in its own volume
and Mosquitto runs as uid 1883 - so `sync-certs.sh` copies the certificate out,
chowns it, and sends Mosquitto a SIGHUP to reload without dropping connections.
`deploy.sh` runs it and installs a nightly cron, because a renewal the broker
never picks up would fail silently 90 days later.

Redeploy with `./deploy.sh`. The React bundle is built **locally** and rsynced:
a vite build is the one step likely to be OOM-killed on a 1 GB box with no swap.
Everything else builds in Docker on the server. `.env` and the broker's
`passwd` are excluded from the sync so they survive `--delete`.

Two MQTT accounts, with deliberately asymmetric rights (`mosquitto/config/acl`):

| User | Rights | Used by |
|---|---|---|
| `plantnode` | publish to `plants/#` only | the ESP32, and `fake-node.js` |
| `bridge` | subscribe to `plants/#` only | the API process |

Verified on the live broker: anonymous connections are refused, and `plantnode`
receives **nothing** when it subscribes even though the SUBACK says success -
Mosquitto grants the subscription and filters at delivery, so test the behaviour
rather than the return code.

### What is still open

1. **The firmware still speaks HTTP**, not MQTT. It needs `PubSubClient`, the
   two topics, the Last Will and the `msg_id` counter that `fake-node.js`
   already demonstrates, pointed at `mqtt.juhawilppu.com:8883` with the
   Let's Encrypt root pinned via `setCACert()`.
2. **Confirm Cloudflare's SSL/TLS mode is Full (strict), not Full.** Plain
   *Full* encrypts the Cloudflare-to-origin leg but accepts any certificate,
   including a self-signed or expired one, which leaves that leg
   impersonable. The origin now has a real Let's Encrypt certificate, so strict
   costs nothing.
3. **ufw is inactive** and no swap file exists. Neither is blocking; a 512 MB
   swapfile is cheap insurance on a 961 MB box.
4. **The read API and dashboard are public.** Only plant telemetry, but readable
   by anyone with the URL.

---

## The dashboard

Four measures, four single-series charts, one hero number. Deliberate choices
worth not undoing:

- **No dual-axis charts.** Temperature and humidity are different scales, so they
  are different charts. Two y-axes on one plot is the single most misleading
  thing a monitoring dashboard can do.
- **One hero figure**, soil moisture, because it is the only reading that implies
  an action. The verdict beside it ships an icon *and* words, never colour alone.
- **A table view is always one click away**, and every chart carries a direct
  end-label. The light-mode aqua and yellow sit below 3:1 against the surface, so
  that relief is required rather than decorative.
- **Charts hold their previous render at reduced opacity while refetching** - no
  skeleton flash, no layout jump.
- Colours are the first four slots of a validated categorical palette, fixed per
  metric so a filter can never repaint them. Worst adjacent CVD separation 9.1
  light / 8.4 dark.
