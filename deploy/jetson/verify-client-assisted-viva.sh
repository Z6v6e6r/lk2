#!/bin/sh

set -eu

cd /opt/phub

base_runtime_env=/etc/phub/staging.env
auth_runtime_env=/opt/phub/staging.auth.env
runtime_override_env=/opt/phub/staging.override.env
games_runtime_env=/opt/phub/staging.games.env
tenant_key="${1:-local-padel}"

case "$tenant_key" in
  '' | *[!a-z0-9-]*)
    echo 'Tenant key must contain only lowercase letters, digits and hyphens' >&2
    exit 1
    ;;
esac

test -r "$base_runtime_env"
test -r "$auth_runtime_env"
test -r "$runtime_override_env"
test -r "$games_runtime_env"
test "$(stat -c %a "$runtime_override_env")" = 600

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

runtime_value() {
  key="$1"
  for file in "$games_runtime_env" "$runtime_override_env" "$auth_runtime_env" "$base_runtime_env"; do
    value="$(file_value "$file" "$key")"
    if test -n "$value"; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

require_value() {
  key="$1"
  expected="$2"
  actual="$(runtime_value "$key")"
  if test "$actual" != "$expected"; then
    echo "Unsafe client-assisted Viva configuration: ${key} must equal ${expected}" >&2
    exit 1
  fi
}

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"' \
    sh "$1"
}

require_value APP_ENV staging
case "$(runtime_value VIVA_MODE)" in
  sandbox | production) ;;
  *)
    echo 'Unsafe client-assisted Viva configuration: real provider mode is required' >&2
    exit 1
    ;;
esac
require_value VIVA_OAUTH_ENABLED true
require_value VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED true
require_value CORS_ORIGINS https://lk.nano.padlhub.su
require_value VIVA_OAUTH_REDIRECT_URI https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback
require_value VIVA_OAUTH_SUCCESS_REDIRECT_URL https://lk.nano.padlhub.su/
require_value VIVA_DIRECT_READ_ENABLED true
require_value HOME_VIVA_SYNC_ENABLED false
require_value HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED false
case "$(runtime_value HOME_READ_MODE)" in
  mock | projection) ;;
  *)
    echo 'Unsafe client-assisted Viva configuration: Home read mode must remain safe' >&2
    exit 1
    ;;
esac
require_value ACTIVITY_HISTORY_ENABLED true
require_value ACTIVITY_HISTORY_SYNC_ENABLED true

compose exec -T api node -e '
  if (process.env.APP_ENV !== "staging") process.exit(1);
  if (process.env.CORS_ORIGINS !== "https://lk.nano.padlhub.su") process.exit(1);
  if (process.env.VIVA_OAUTH_REDIRECT_URI !== "https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback") process.exit(1);
  if (process.env.VIVA_DIRECT_READ_ENABLED !== "true") process.exit(1);
  if (process.env.HOME_VIVA_SYNC_ENABLED !== "false") process.exit(1);
  if (process.env.HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED !== "false") process.exit(1);
  if (process.env.ACTIVITY_HISTORY_ENABLED !== "true") process.exit(1);
  if (process.env.ACTIVITY_HISTORY_SYNC_ENABLED !== "true") process.exit(1);
'
compose exec -T worker node -e '
  if (process.env.HOME_VIVA_SYNC_ENABLED !== "false") process.exit(1);
  if (process.env.HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED !== "false") process.exit(1);
'

active_delegations="$(sql "
  select count(*)
    from integration.user_delegations delegation
    join identity.tenants tenant on tenant.id = delegation.tenant_id
   where tenant.tenant_key = '${tenant_key}'
     and tenant.active = true
     and delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
")"
routing_ready_delegations="$(sql "
  select count(*)
    from integration.user_delegations delegation
    join identity.tenants tenant
      on tenant.id = delegation.tenant_id
     and tenant.tenant_key = '${tenant_key}'
     and tenant.active = true
    join integration.client_routing_plans plan
      on plan.tenant_id = delegation.tenant_id
     and plan.mode = 'MIXED_END_USER_READS'
     and plan.direct_read_operations = array['profile.read']::text[]
    join integration.identity_provider_bindings binding
      on binding.tenant_id = delegation.tenant_id
     and binding.provider = 'VIVA'
     and nullif(btrim(binding.provider_tenant_key), '') is not null
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
")"
other_mixed_plans="$(sql "
  select count(*)
    from integration.client_routing_plans plan
    join identity.tenants tenant
      on tenant.id = plan.tenant_id
     and tenant.tenant_key <> '${tenant_key}'
     and tenant.active = true
   where plan.mode = 'MIXED_END_USER_READS'
     and cardinality(plan.direct_read_operations) > 0
")"
test "$active_delegations" -gt 0
test "$routing_ready_delegations" = "$active_delegations"
test "$other_mixed_plans" -eq 0

provider_tenant_key="$(sql "
  select binding.provider_tenant_key
    from integration.identity_provider_bindings binding
    join identity.tenants tenant on tenant.id = binding.tenant_id
   where tenant.tenant_key = '${tenant_key}'
     and tenant.active = true
     and binding.provider = 'VIVA'
   limit 1
")"
case "$provider_tenant_key" in
  '' | *[!A-Za-z0-9_-]*)
    echo 'Client-assisted Viva provider binding is invalid' >&2
    exit 1
    ;;
esac

cors_headers="$(mktemp /tmp/phub-viva-cors.XXXXXX)"
trap 'rm -f "$cors_headers"' EXIT HUP INT TERM
viva_base_url="$(runtime_value VIVA_END_USER_API_URL)"
test -n "$viva_base_url"
curl --fail --silent --show-error \
  --request OPTIONS \
  --output /dev/null \
  --dump-header "$cors_headers" \
  --header 'Origin: https://lk.nano.padlhub.su' \
  --header 'Access-Control-Request-Method: GET' \
  --header 'Access-Control-Request-Headers: authorization' \
  "${viva_base_url%/}/v1/${provider_tenant_key}/exercises?date=$(date -u +%Y-%m-%d)"
tr -d '\r' < "$cors_headers" | grep -Eiq '^access-control-allow-origin: https://lk\.nano\.padlhub\.su$'
tr -d '\r' < "$cors_headers" | grep -Eiq '^access-control-allow-headers:.*authorization'

compose exec -T api node -e '
  const tenant = process.argv[1];
  const checks = [
    ["/booking-screen-read-jobs", { screen: "FOR_ME" }],
    ["/booking-screen-read-jobs", { screen: "GROUP_TRAININGS" }],
    ["/booking-screen-read-jobs", { screen: "MY_BOOKINGS" }],
    ["/booking-screen-read-jobs", {
      screen: "EVENT_CATALOG",
      query: {
        surface: "GAMES",
        localDates: ["2026-08-04"],
        kinds: ["COACH_GAME"],
        availability: "ALL",
        limit: 20,
      },
    }],
    ["/booking-screen-read-jobs", {
      screen: "EVENT_CATALOG",
      query: {
        surface: "TRAININGS",
        localDates: ["2026-08-04"],
        kinds: ["TRAINING"],
        availability: "ALL",
        limit: 20,
      },
    }],
    ["/activity-history-read-jobs", {}],
  ];
  Promise.all(checks.map(async ([path, body]) => {
    const response = await fetch(`http://127.0.0.1:3000/user/api/v1/${tenant}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Platform": "web" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (response.status !== 401 || payload.code !== "AUTH_REQUIRED") process.exitCode = 1;
  })).catch(() => { process.exitCode = 1; });
' "$tenant_key"

echo "Client-assisted Viva runtime verified: routing=${routing_ready_delegations}/${active_delegations}, Home server sync disabled, Nano CORS accepted"
