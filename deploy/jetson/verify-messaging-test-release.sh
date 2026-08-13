#!/bin/sh

set -eu

tenant_key="${1:?tenant key is required}"
player_a_id="${2:?player A UUID is required}"
player_b_id="${3:?player B UUID is required}"
expected_migration_checksum="${4:?migration checksum is required}"

fail() {
  echo "Messaging test release verification failed: $1" >&2
  exit 1
}

require_equal() {
  actual="$1"
  expected="$2"
  label="$3"
  test "$actual" = "$expected" || fail "$label"
}

if ! printf '%s' "$tenant_key" | grep -Eq '^[a-z0-9][a-z0-9-]{1,62}$'; then
  echo 'Invalid tenant key.' >&2
  exit 2
fi
for player_id in "$player_a_id" "$player_b_id"; do
  if ! printf '%s' "$player_id" | grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
    echo 'Invalid player UUID.' >&2
    exit 2
  fi
done
if test "$player_a_id" = "$player_b_id"; then
  echo 'Players must be distinct.' >&2
  exit 2
fi
if ! printf '%s' "$expected_migration_checksum" | grep -Eiq '^[0-9a-f]{64}$'; then
  echo 'Invalid migration checksum.' >&2
  exit 2
fi

cd /opt/phub

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec \
    'PGOPTIONS="-c default_transaction_read_only=on" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"' \
    sh "$1"
}

tenant_id="$(sql "select id from identity.tenants where tenant_key = '$tenant_key' and active = true")"
test -n "$tenant_id" || fail 'active tenant not found'

runtime_state="$(sql "
  select concat_ws('|', http_enabled::text, direct_enabled::text, realtime_enabled::text)
    from messaging.tenant_runtime_settings
   where tenant_id = '$tenant_id'
")"
require_equal "$runtime_state" 'true|true|true' 'messaging runtime flags are not all enabled'

ready_players="$(sql "
  select count(*)
    from identity.users identity_user
    join identity.user_access_profiles access
      on access.tenant_id = identity_user.tenant_id
     and access.user_id = identity_user.id
    left join profile.privacy_settings privacy
      on privacy.tenant_id = identity_user.tenant_id
     and privacy.user_id = identity_user.id
   where identity_user.tenant_id = '$tenant_id'
     and identity_user.id = any(array['$player_a_id'::uuid, '$player_b_id'::uuid])
     and identity_user.status = 'ACTIVE'
     and 'chat.direct.create' = any(access.permissions)
     and coalesce(privacy.chat_policy, 'AUTHORIZED') = 'AUTHORIZED'
")"
require_equal "$ready_players" 2 'selected players are not both chat-ready'

installed_checksum="$(sql "
  select checksum
    from public.schema_migrations
   where filename = '0057_messaging_runtime.sql'
")"
require_equal "$installed_checksum" "$expected_migration_checksum" 'migration 0057 checksum mismatch'

canonical_base_url=https://lk.nano.padlhub.su

conversation_probe="$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve lk.nano.padlhub.su:443:127.0.0.1 \
  --header 'Accept: application/json' \
  --write-out '\n%{http_code}' \
  "$canonical_base_url/user/api/v1/$tenant_key/conversations?limit=1")"
conversation_status="$(printf '%s\n' "$conversation_probe" | tail -1)"
conversation_body="$(printf '%s\n' "$conversation_probe" | sed '$d')"
require_equal "$conversation_status" 401 'anonymous conversations probe did not return HTTP 401'
printf '%s' "$conversation_body" | grep -Eq '"code"[[:space:]]*:[[:space:]]*"AUTH_REQUIRED"' \
  || fail 'anonymous conversations probe did not return AUTH_REQUIRED'

realtime_probe="$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve lk.nano.padlhub.su:443:127.0.0.1 \
  --header 'Accept: application/json' \
  --write-out '\n%{http_code}' \
  "$canonical_base_url/realtime/health/ready")"
realtime_status="$(printf '%s\n' "$realtime_probe" | tail -1)"
realtime_body="$(printf '%s\n' "$realtime_probe" | sed '$d')"
require_equal "$realtime_status" 200 'realtime readiness probe did not return HTTP 200'
for expected_field in \
  '"status"[[:space:]]*:[[:space:]]*"ready"' \
  '"redis"[[:space:]]*:[[:space:]]*true' \
  '"database"[[:space:]]*:[[:space:]]*true' \
  '"rabbit"[[:space:]]*:[[:space:]]*true'; do
  printf '%s' "$realtime_body" | grep -Eq "$expected_field" \
    || fail 'realtime readiness body is incomplete'
done

echo "Messaging test release verified: tenant=$tenant_key players=2 runtime=$runtime_state migration=0057 api=AUTH_REQUIRED realtime=ready"
