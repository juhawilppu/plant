#!/bin/sh
# The chaos monkey: kills one of the API instances at random, now and then, to
# prove that a dashboard does not notice. Runs as the `chaos` compose service.
#
# Rules it keeps, because breaking them tests nothing useful:
#   - it strikes only while every instance is healthy, so it never kills the
#     last one standing - that would be an outage test, not a failover test
#   - it brings its victim back itself: Docker counts `docker kill` as a manual
#     stop, so the restart policy would leave the instance down for good
#   - it waits for the victim to be healthy again before the next round
#
# Half the time it sends SIGKILL, a crash: sockets simply drop. The other half,
# SIGTERM, a clean stop: the instance tells its dashboards it is restarting.
# Both paths have to end with every dashboard live on the other instance.
set -eu

MIN_S=${CHAOS_MIN_S:-120}
MAX_S=${CHAOS_MAX_S:-600}
DOWN_S=${CHAOS_DOWN_S:-20}

log() { echo "$(date -u +%FT%TZ) chaos: $*"; }

# Targets are this compose project's containers labelled for it, so a second
# copy of the stack on the same Docker host is never touched. The container's
# hostname is its own id, which is how it learns its project.
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$(hostname)")
targets() {
    docker ps -a \
        --filter "label=com.docker.compose.project=$project" \
        --filter label=plant-vitals.chaos=target \
        --format '{{.Names}}'
}
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1"; }

log "loose in project '$project', every ${MIN_S}-${MAX_S}s, victims down for ${DOWN_S}s"

while :; do
    sleep "$(shuf -i "$MIN_S-$MAX_S" -n 1)"

    # shellcheck disable=SC2046 # one container name per word is the intent
    set -- $(targets)
    if [ $# -lt 2 ]; then
        log "only $# target(s) found, holding off"
        continue
    fi
    sick=
    for t; do
        [ "$(health "$t")" = healthy ] || sick="$sick $t"
    done
    if [ -n "$sick" ]; then
        log "not everyone is healthy (${sick# }), holding off"
        continue
    fi

    victim=$(printf '%s\n' "$@" | shuf -n 1)
    signal=$(printf 'KILL\nTERM\n' | shuf -n 1)
    log "SIG$signal -> $victim"
    docker kill --signal "$signal" "$victim" >/dev/null

    sleep "$DOWN_S"
    docker start "$victim" >/dev/null
    until [ "$(health "$victim")" = healthy ]; do sleep 2; done
    log "$victim is back and healthy"
done
