#!/bin/sh

set -eu

tenant_key="${1:?tenant key is required}"
player_a_id="${2:?player A UUID is required}"
player_b_id="${3:?player B UUID is required}"
expected_migration_checksum="${4:?migration checksum is required}"

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
test -n "$tenant_id"

runtime_state="$(sql "
  select concat_ws('|', http_enabled, direct_enabled, realtime_enabled)
    from messaging.tenant_runtime_settings
   where tenant_id = '$tenant_id'
")"
test "$runtime_state" = 'true|true|true'

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
test "$ready_players" = 2

installed_checksum="$(sql "
  select checksum
    from public.schema_migrations
   where filename = '0057_messaging_runtime.sql'
")"
test "$installed_checksum" = "$expected_migration_checksum"

canonical_base_url=https://lk.nano.padlhub.su

conversation_probe="$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve lk.nano.padlhub.su:443:127.0.0.1 \
  --header 'Accept: application/json' \
  --write-out '\n%{http_code}' \
  "$canonical_base_url/user/api/v1/$tenant_key/conversations?limit=1")"
conversation_status="$(printf '%s\n' "$conversation_probe" | tail -1)"
conversation_body="$(printf '%s\n' "$conversation_probe" | sed '$d')"
test "$conversation_status" = 401
printf '%s' "$conversation_body" | grep -Eq '"code"[[:space:]]*:[[:space:]]*"AUTH_REQUIRED"'

realtime_probe="$(curl --silent --show-error --connect-timeout 5 --max-time 15 \
  --resolve lk.nano.padlhub.su:443:127.0.0.1 \
  --header 'Accept: application/json' \
  --write-out '\n%{http_code}' \
  "$canonical_base_url/realtime/health/ready")"
realtime_status="$(printf '%s\n' "$realtime_probe" | tail -1)"
realtime_body="$(printf '%s\n' "$realtime_probe" | sed '$d')"
test "$realtime_status" = 200
for expected_field in \
  '"status"[[:space:]]*:[[:space:]]*"ready"' \
  '"redis"[[:space:]]*:[[:space:]]*true' \
  '"database"[[:space:]]*:[[:space:]]*true' \
  '"rabbit"[[:space:]]*:[[:space:]]*true'; do
  printf '%s' "$realtime_body" | grep -Eq "$expected_field"
done

echo "Messaging test release verified: tenant=$tenant_key players=2 runtime=$runtime_state migration=0057 api=AUTH_REQUIRED realtime=ready"
