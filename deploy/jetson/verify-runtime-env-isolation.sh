#!/bin/sh
set -eu

api_env=${1:-/etc/phub/staging.env}
realtime_env=${2:-/etc/phub/realtime.env}
expected_owner=${3:-phub-deploy}
expected_realtime_enabled=${4:-false}

fail() {
  echo "runtime env isolation failed: $1" >&2
  exit 1
}

check_file() {
  file=$1
  [ -f "$file" ] || fail "required file is missing: $file"
  mode=$(stat -c '%a' "$file")
  owner=$(stat -c '%U' "$file")
  [ "$mode" = '600' ] || fail "$file must have mode 600"
  [ "$owner" = "$expected_owner" ] || fail "$file must be owned by $expected_owner"
  [ -r "$file" ] || fail "$file must be readable by the deployment identity"
}

has_key() {
  file=$1
  key=$2
  grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$file"
}

read_key() {
  file=$1
  key=$2
  awk -F= -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      value = substr($0, index($0, "=") + 1)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      found = 1
    }
    END { if (found) print value; else exit 1 }
  ' "$file"
}

check_file "$api_env"
check_file "$realtime_env"

case "$expected_realtime_enabled" in
  true | false) ;;
  *) fail 'expected realtime state must be true or false' ;;
esac

for override in /opt/phub/staging.override.env /opt/phub/staging.games.env; do
  if [ -f "$override" ] &&
    grep -Eq '^[[:space:]]*(COMMUNITIES_REALTIME_ENABLED|JWT_REALTIME_SECRET)[[:space:]]*=' "$override"
  then
    fail "realtime configuration must not be shadowed in $override"
  fi
done

has_key "$realtime_env" JWT_ACCESS_SECRET && fail 'JWT_ACCESS_SECRET leaked into realtime'
has_key "$realtime_env" JWT_REFRESH_SECRET && fail 'JWT_REFRESH_SECRET leaked into realtime'

api_realtime_secret=$(read_key "$api_env" JWT_REALTIME_SECRET) || fail 'API realtime key is missing'
gateway_realtime_secret=$(read_key "$realtime_env" JWT_REALTIME_SECRET) || fail 'realtime key is missing'
[ ${#api_realtime_secret} -ge 32 ] || fail 'API realtime key is too short'
[ "$api_realtime_secret" = "$gateway_realtime_secret" ] || fail 'API and realtime keys differ'

api_realtime_enabled=$(read_key "$api_env" COMMUNITIES_REALTIME_ENABLED) ||
  fail 'API realtime state is missing'
gateway_realtime_enabled=$(read_key "$realtime_env" COMMUNITIES_REALTIME_ENABLED) ||
  fail 'realtime process state is missing'
[ "$api_realtime_enabled" = "$expected_realtime_enabled" ] || fail 'API realtime state differs'
[ "$gateway_realtime_enabled" = "$expected_realtime_enabled" ] ||
  fail 'realtime process state differs'

unset api_realtime_secret gateway_realtime_secret api_realtime_enabled gateway_realtime_enabled
echo 'runtime env isolation passed (secret values were not printed)'
