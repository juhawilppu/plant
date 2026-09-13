#!/bin/sh
# Publishes one fake reading. One reading per invocation rather than
# --interval, because the scheduler owns the cadence: a crash then costs one
# reading instead of silently ending the stream.
#
# A scheduled job runs with a minimal environment - no ssh-agent, and PATH is
# roughly /usr/bin:/bin - so node is called by absolute path and the credentials
# come from a file rather than over ssh.
#
# This file is the SOURCE. It is not executed from the repo: macOS TCC refuses
# any scheduled job read access to ~/Documents, under launchd exactly as under
# cron. install-agent.sh copies it, fake-node.js and node_modules into
# ~/Library/Application Support/plant-vitals (which TCC does not guard) and
# points the LaunchAgent at the copy. Re-run install-agent.sh after editing.
#
#     installed by install-agent.sh; see README
set -e

ENV_FILE="$HOME/.config/plant-vitals/env"
NODE=/usr/local/bin/node
LOG="$HOME/Library/Logs/plant-vitals-fake-node.log"

cd "$(dirname "$0")"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" >> "$LOG"; }

[ -f "$ENV_FILE" ] || { log "FATAL missing $ENV_FILE"; exit 1; }
[ -x "$NODE" ] || { log "FATAL node not found at $NODE"; exit 1; }

set -a
. "$ENV_FILE"
set +a

# Keep the log from growing without bound; 288 runs a day adds up.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if out=$("$NODE" server/fake-node.js 2>&1); then
    log "ok $(echo "$out" | tail -1)"
else
    log "FAILED $(echo "$out" | tr '\n' ' ')"
    exit 1
fi
