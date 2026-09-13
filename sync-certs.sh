#!/bin/sh
# Copies the broker's certificate out of Caddy's data volume into a place
# Mosquitto can read, then tells Mosquitto to reload it.
#
# Caddy renews automatically but keeps its keys root-only inside its own volume,
# and Mosquitto runs as uid 1883 - hence the copy and the chown rather than a
# shared mount. Run by deploy.sh and by a nightly cron, so a renewal reaches the
# broker instead of silently expiring after 90 days.
#
# Idempotent: safe to run when nothing has changed.
set -e

DOMAIN=${MQTT_DOMAIN:-mqtt.juhawilppu.com}
ROOT=$(cd "$(dirname "$0")" && pwd)
CERTDIR="$ROOT/mosquitto/certs"
SRC="/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/$DOMAIN"

if ! docker exec plant-vitals-caddy test -f "$SRC/$DOMAIN.crt" 2>/dev/null; then
    echo "sync-certs: no certificate for $DOMAIN in Caddy yet - skipping"
    exit 0
fi

mkdir -p "$CERTDIR"
docker exec plant-vitals-caddy cat "$SRC/$DOMAIN.crt" > "$CERTDIR/fullchain.pem.new"
docker exec plant-vitals-caddy cat "$SRC/$DOMAIN.key" > "$CERTDIR/privkey.pem.new"

# Only disturb the broker if the certificate actually changed.
if cmp -s "$CERTDIR/fullchain.pem.new" "$CERTDIR/fullchain.pem" 2>/dev/null; then
    rm -f "$CERTDIR/fullchain.pem.new" "$CERTDIR/privkey.pem.new"
    echo "sync-certs: certificate unchanged"
    exit 0
fi

mv "$CERTDIR/fullchain.pem.new" "$CERTDIR/fullchain.pem"
mv "$CERTDIR/privkey.pem.new" "$CERTDIR/privkey.pem"
chown 1883:1883 "$CERTDIR/fullchain.pem" "$CERTDIR/privkey.pem"
chmod 644 "$CERTDIR/fullchain.pem"
chmod 600 "$CERTDIR/privkey.pem"
echo "sync-certs: certificate updated for $DOMAIN"

# Mosquitto 2 reloads its certificate files on SIGHUP, no restart and no dropped
# connections.
if docker ps --format '{{.Names}}' | grep -q '^plant-vitals-mosquitto$'; then
    docker kill -s HUP plant-vitals-mosquitto >/dev/null 2>&1 || true
    echo "sync-certs: sent SIGHUP to mosquitto"
fi
