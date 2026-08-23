#!/bin/sh
set -eu
umask 077

CONTAINER_NAME="phub-gate4-control-pg16-verify-$$"
CONTAINER_LABEL_KEY="com.padlhub.disposable"
CONTAINER_LABEL_VALUE="communities-role-split-gate4-control-plane-pg16-verification"
ADMIN_DATABASE="phub_gate4_control_verify"
CONTAINER_ID=""
RUN_STATE_DIRECTORY=""
CID_FILE=""
FIXTURE_PASSWORD=""

fail() {
  printf '%s\n' "GATE4_CONTROL_PG16_VERIFY_FAILED|code=$1" >&2
  exit 1
}

cleanup() {
  cleanup_failed=0
  if [ -z "$CONTAINER_ID" ] && [ -n "$CID_FILE" ] && [ -f "$CID_FILE" ]; then
    IFS= read -r CONTAINER_ID < "$CID_FILE" || true
  fi
  if [ -z "$CONTAINER_ID" ]; then
    CONTAINER_ID="$(docker inspect --format '{{.Id}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  fi
  if [ -n "$CONTAINER_ID" ]; then
    case "$CONTAINER_ID" in
      *[!a-f0-9]* | '') cleanup_failed=1 ;;
      *)
        observed="$(docker inspect --format '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.padlhub.disposable" }}' "$CONTAINER_ID" 2>/dev/null || true)"
        expected="$CONTAINER_ID|/$CONTAINER_NAME|$CONTAINER_LABEL_VALUE"
        if [ "$observed" != "$expected" ]; then
          printf '%s\n' 'GATE4_CONTROL_PG16_VERIFY_CLEANUP_REFUSED|resource=container|reason=identity_mismatch' >&2
          cleanup_failed=1
        elif ! docker rm --force --volumes "$CONTAINER_ID" >/dev/null; then
          printf '%s\n' 'GATE4_CONTROL_PG16_VERIFY_CLEANUP_FAILED|resource=container' >&2
          cleanup_failed=1
        else
          CONTAINER_ID=""
        fi
        ;;
    esac
  fi
  if [ -n "$RUN_STATE_DIRECTORY" ]; then
    case "$RUN_STATE_DIRECTORY" in
      "${TMPDIR:-/tmp}"/phub-gate4-control-pg16-verify.*)
        if [ "$cleanup_failed" -eq 0 ] && [ -z "$CONTAINER_ID" ]; then
          if [ -n "$CID_FILE" ] && [ -f "$CID_FILE" ]; then
            rm -f "$CID_FILE" || cleanup_failed=1
          fi
          rmdir "$RUN_STATE_DIRECTORY" 2>/dev/null || cleanup_failed=1
        fi
        ;;
      *) cleanup_failed=1 ;;
    esac
  fi
  FIXTURE_PASSWORD=""
  return "$cleanup_failed"
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if ! cleanup && [ "$status" -eq 0 ]; then
    status=1
  fi
  exit "$status"
}

trap 'on_exit' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v docker >/dev/null 2>&1 || fail docker_missing
command -v openssl >/dev/null 2>&1 || fail openssl_missing
command -v mktemp >/dev/null 2>&1 || fail mktemp_missing
[ -x ./node_modules/.bin/vitest ] || fail dependencies_missing

case "$CONTAINER_NAME" in
  phub-gate4-control-pg16-verify-[1-9][0-9]*) ;;
  *) fail container_name_invalid ;;
esac

existing="$(docker ps --all --quiet --filter "name=^/$CONTAINER_NAME$")"
[ -z "$existing" ] || fail container_name_collision

RUN_STATE_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/phub-gate4-control-pg16-verify.XXXXXX")"
[ -d "$RUN_STATE_DIRECTORY" ] && [ ! -L "$RUN_STATE_DIRECTORY" ] || fail state_directory_invalid
CID_FILE="$RUN_STATE_DIRECTORY/container.cid"
FIXTURE_PASSWORD="$(openssl rand -hex 32)"
case "$FIXTURE_PASSWORD" in
  *[!a-f0-9]* | '') fail fixture_password_invalid ;;
esac

docker run \
  --detach \
  --pull never \
  --cidfile "$CID_FILE" \
  --name "$CONTAINER_NAME" \
  --label "$CONTAINER_LABEL_KEY=$CONTAINER_LABEL_VALUE" \
  --env "POSTGRES_PASSWORD=$FIXTURE_PASSWORD" \
  --env "POSTGRES_DB=$ADMIN_DATABASE" \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=256m \
  postgres:16-alpine >/dev/null || fail docker_run

IFS= read -r CONTAINER_ID < "$CID_FILE" || [ -n "$CONTAINER_ID" ] || fail container_id_missing
case "$CONTAINER_ID" in
  *[!a-f0-9]* | '') fail container_id_invalid ;;
esac

ready=false
attempt=0
while [ "$attempt" -lt 60 ]; do
  if docker exec "$CONTAINER_ID" pg_isready --quiet --username postgres --dbname "$ADMIN_DATABASE"; then
    ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" = true ] || fail postgres_not_ready

binding="$(docker port "$CONTAINER_ID" 5432/tcp)"
case "$binding" in
  127.0.0.1:[1-9][0-9]*) ;;
  *) fail port_binding_invalid ;;
esac
port="${binding##*:}"

PHUB_GATE4_CONTROL_PG16_VERIFY_URL="postgresql://postgres:$FIXTURE_PASSWORD@127.0.0.1:$port/$ADMIN_DATABASE" \
PHUB_GATE4_CONTROL_PG16_VERIFY_CONTAINER_ID="$CONTAINER_ID" \
PHUB_GATE4_CONTROL_PG16_VERIFY_CONTAINER_NAME="$CONTAINER_NAME" \
  ./node_modules/.bin/vitest run \
    apps/migrator/src/communities-staging-role-split-trusted-inventory-pg-control-plane.pg.test.ts \
    --testTimeout 30000

cleanup || fail cleanup_failed
trap - EXIT HUP INT TERM

if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  fail container_retained
fi

printf '%s\n' 'GATE4_CONTROL_PG16_VERIFY_PASSED|major=16|fixture=disposable|clock=monotonic_fence|ledger=single_use_append_only|roles=separated|container_retained=false'
