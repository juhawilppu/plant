#!/bin/sh
# Deploy to the plant server.
#
# The React bundle is built HERE, not there: the box has 961 MB and no swap, and
# a vite build plus its node_modules is the one step likely to be OOM-killed on
# it. Everything else builds fine in Docker on the server.
#
#   ./deploy.sh
set -e
cd "$(dirname "$0")"

SERVER=${SERVER:-root@185.14.186.98}
REMOTE=/opt/plant-vitals

echo "==> building the dashboard locally"
(cd web && npm install --silent && npm run build)

echo "==> syncing to $SERVER:$REMOTE"
# --delete keeps the remote a mirror, but .env and the mosquitto password file
# live only on the server and must survive it.
rsync -az --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude 'mosquitto/config/passwd' \
    ./ "$SERVER:$REMOTE/"

# The broker refuses to start without its password file, and that file holds
# hashes so it is generated on the server and never synced or committed.
echo "==> ensuring the mosquitto password file exists"
ssh "$SERVER" "set -e
cd $REMOTE
if [ ! -f mosquitto/config/passwd ]; then
    . ./.env
    docker run --rm -v $REMOTE/mosquitto/config:/mosquitto/config eclipse-mosquitto:2 \
        mosquitto_passwd -c -b /mosquitto/config/passwd plantnode "\$MQTT_NODE_PASSWORD"
    docker run --rm -v $REMOTE/mosquitto/config:/mosquitto/config eclipse-mosquitto:2 \
        mosquitto_passwd -b /mosquitto/config/passwd bridge "\$MQTT_BRIDGE_PASSWORD"
    # Readable by the broker's own uid (1883) and nobody else.
    chown 1883:1883 mosquitto/config/passwd
    chmod 0600 mosquitto/config/passwd
    echo 'created mosquitto/config/passwd'
else
    echo 'mosquitto/config/passwd already present, left alone'
fi"

echo "==> bringing the stack up"
ssh "$SERVER" "cd $REMOTE && docker compose --profile server up -d --build"

# The published port comes from the server's own .env (80 there, 8090 locally),
# so the check has to read it rather than assume the container-internal 8090.
# Mosquitto's TLS listener is written only once the certificate exists, so the
# first deploy brings Caddy up, obtains it, and then enables 8883.
echo "==> syncing the broker certificate out of Caddy"
ssh "$SERVER" "cd $REMOTE && ./sync-certs.sh"
ssh "$SERVER" "set -e
cd $REMOTE
if [ -f mosquitto/certs/fullchain.pem ] && [ ! -f mosquitto/config/conf.d/tls.conf ]; then
    cat > mosquitto/config/conf.d/tls.conf <<'CONF'
# MQTT over TLS. Username/password still authenticates and the ACL still
# authorises; TLS is what stops both from crossing the internet in the clear.
listener 8883
protocol mqtt
certfile /mosquitto/certs/fullchain.pem
keyfile /mosquitto/certs/privkey.pem
CONF
    echo 'wrote conf.d/tls.conf'
    docker compose --profile server restart mosquitto
fi"

# A renewal is useless if the broker never picks it up.
echo "==> installing the renewal cron"
ssh "$SERVER" "cd $REMOTE && (crontab -l 2>/dev/null | grep -v sync-certs.sh; echo '17 4 * * * cd $REMOTE && ./sync-certs.sh >> /var/log/plant-sync-certs.log 2>&1') | crontab -"

echo "==> health"
ssh "$SERVER" "sleep 4; cd $REMOTE && . ./.env && curl -fsS localhost:\${WEB_PORT:-8090}/health && echo"
