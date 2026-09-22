#!/bin/sh
# Derive the staging worker runtime contract from the API runtime environment.
#
# The deployed worker publishes outbox events but never issues API sessions. `loadWorkerConfig`
# fails closed when it receives JWT_ACCESS_SECRET or JWT_REFRESH_SECRET and requires the explicit
# WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true attestation, so a single shared runtime file that
# also serves the API cannot be handed to the worker. This helper copies every source key except
# those two signing secrets, adds the attestation, and refuses to write anything until the source
# and the target both look safe.
set -eu

source_env=${1:-/etc/phub/staging.env}
worker_env=${2:-/opt/phub/staging.worker.env}

fail() {
  printf '%s\n' "worker runtime env derivation refused: $*" >&2
  exit 1
}

test "$(printf '%s' "$source_env$worker_env" | tr -d '\r\n')" = "$source_env$worker_env" ||
  fail 'paths must be single-line values'
case "$source_env" in
  /*) ;;
  *) fail 'source runtime env path must be absolute' ;;
esac
case "$worker_env" in
  /*) ;;
  *) fail 'worker runtime env path must be absolute' ;;
esac
test "$source_env" != "$worker_env" || fail 'source and worker runtime env must differ'

test -f "$source_env" && test ! -L "$source_env" || fail 'source runtime env is absent or unsafe'
test "$(stat -c '%a' "$source_env")" = 600 || fail 'source runtime env mode is not 0600'
test "$(stat -c '%u' "$source_env")" = "$(id -u)" ||
  fail 'source runtime env owner is not the deployment identity'

for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  grep -Eq "^${key}=" "$source_env" || fail "source runtime env has no ${key} to isolate"
done
grep -Eq '^WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=' "$source_env" &&
  fail 'source runtime env already carries the worker isolation attestation'

worker_dir=$(dirname "$worker_env")
test -d "$worker_dir" && test ! -L "$worker_dir" || fail 'worker runtime env directory is unsafe'
if test -e "$worker_env" || test -L "$worker_env"; then
  test -f "$worker_env" && test ! -L "$worker_env" || fail 'worker runtime env target is unsafe'
  test "$(stat -c '%u' "$worker_env")" = "$(id -u)" ||
    fail 'worker runtime env target owner is not the deployment identity'
fi

umask 077
worker_tmp="${worker_env}.$$"
test ! -e "$worker_tmp" && test ! -L "$worker_tmp" || fail 'worker runtime env temporary file exists'
trap 'rm -f "$worker_tmp"' EXIT HUP INT TERM

awk '
  /^JWT_ACCESS_SECRET=/ { next }
  /^JWT_REFRESH_SECRET=/ { next }
  { print }
' "$source_env" > "$worker_tmp"
printf '%s\n' 'WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true' >> "$worker_tmp"
chmod 600 "$worker_tmp"
mv "$worker_tmp" "$worker_env"
trap - EXIT HUP INT TERM

test "$(stat -c '%a' "$worker_env")" = 600 || fail 'derived worker runtime env mode is not 0600'
for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  grep -Eq "^${key}=" "$worker_env" && fail "derived worker runtime env still contains ${key}"
done
grep -Fxq 'WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true' "$worker_env" ||
  fail 'derived worker runtime env lacks the isolation attestation'
source_key_count=$(awk '/^[A-Z][A-Z0-9_]*=/{ count += 1 } END { print count + 0 }' "$source_env")
worker_key_count=$(awk '/^[A-Z][A-Z0-9_]*=/{ count += 1 } END { print count + 0 }' "$worker_env")
test "$worker_key_count" -eq "$((source_key_count - 1))" ||
  fail 'derived worker runtime env key count is inconsistent with the source'

printf '%s\n' \
  "worker runtime env derived: source=$source_env target=$worker_env (secret values were not printed)"
