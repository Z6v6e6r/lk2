#!/bin/sh

set -eu

cd /opt/phub

communities_env=/opt/phub/staging.communities.env

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

service_is_healthy() {
  container_id="$(compose ps -q "$1")"
  test -n "$container_id" &&
    test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy
}

wait_for_service() {
  service="$1"
  attempt=0
  while test "$attempt" -lt 36; do
    if service_is_healthy "$service"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  compose ps -a
  compose logs --no-color --tail=160 "$service"
  return 1
}

stop_and_verify() {
  service="$1"
  compose stop "$service"
  test -z "$(compose ps --status running -q "$service")"
}

communities_backup="$(mktemp /opt/phub/staging.communities.env.backup.XXXXXX)"
communities_next="$(mktemp /opt/phub/staging.communities.env.next.XXXXXX)"
communities_was_present=false
if test -f "$communities_env"; then
  cp "$communities_env" "$communities_backup"
  communities_was_present=true
fi
chmod 600 "$communities_backup" "$communities_next"

worker_was_running=false
realtime_was_running=false
test -n "$(compose ps -q worker)" && worker_was_running=true
test -n "$(compose ps -q realtime)" && realtime_was_running=true

restore_profile() {
  if test "$communities_was_present" = true; then
    cp "$communities_backup" "$communities_env"
    chmod 600 "$communities_env"
  else
    rm -f "$communities_env"
  fi
  compose up -d --force-recreate api
  wait_for_service api
  if test "$worker_was_running" = true; then
    compose up -d worker
    wait_for_service worker
  else
    stop_and_verify worker
  fi
  if test "$realtime_was_running" = true; then
    compose up -d realtime
    wait_for_service realtime
  else
    stop_and_verify realtime
  fi
}

cleanup() {
  rm -f "$communities_backup" "$communities_next"
}
trap cleanup EXIT HUP INT TERM

cat > "$communities_next" <<'EOF'
COMMUNITIES_READ_MODE=legacy
COMMUNITY_LEGACY_READ_DETAIL_ENABLED=true
COMMUNITY_LEGACY_READ_FEED_ENABLED=true
COMMUNITY_LEGACY_READ_CHAT_ENABLED=true
COMMUNITY_LEGACY_READ_RATING_ENABLED=true
COMMUNITIES_LEGACY_TIMEOUT_MS=2500
COMMUNITIES_LEGACY_MAX_ATTEMPTS=1
COMMUNITIES_LEGACY_CACHE_TTL_MS=120000
COMMUNITY_MEDIA_ENABLED=false
COMMUNITY_INVITES_ENABLED=false
COMMUNITIES_REALTIME_ENABLED=false
EOF

mv "$communities_next" "$communities_env"
chmod 600 "$communities_env"

if ! compose up -d --force-recreate api || ! wait_for_service api; then
  echo 'Communities read-only API activation failed; restoring the previous process state' >&2
  restore_profile
  exit 1
fi

# This profile has no command, media, invite, worker or websocket surface. Stopping the two
# independent processes makes the process-level boundary observable instead of relying on flags.
if ! stop_and_verify worker || ! stop_and_verify realtime; then
  echo 'Communities read-only auxiliary-process stop failed; restoring the previous process state' >&2
  restore_profile
  exit 1
fi

if ! sh /opt/phub/verify-communities-legacy-read-only.sh; then
  echo 'Communities read-only verification failed; restoring the previous process state' >&2
  restore_profile
  exit 1
fi

echo 'Communities legacy read-only API activated; worker and realtime are stopped'
