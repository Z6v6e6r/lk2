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
test -r "$games_runtime_env"

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -n 1
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

require_value() {
  key="$1"
  expected="$2"
  actual="$(runtime_value "$key")"
  if test "$actual" != "$expected"; then
    echo "Client-assisted Viva activation requires ${key}=${expected}" >&2
    exit 1
  fi
}

require_value APP_ENV staging
case "$(runtime_value VIVA_MODE)" in
  sandbox | production) ;;
  *)
    echo 'Client-assisted Viva activation requires the staging Viva provider' >&2
    exit 1
    ;;
esac
require_value VIVA_OAUTH_ENABLED true
require_value VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED true
require_value CORS_ORIGINS https://lk.nano.padlhub.su
require_value VIVA_OAUTH_REDIRECT_URI https://lk.nano.padlhub.su/user/api/v1/local-padel/auth/viva/callback
require_value VIVA_OAUTH_SUCCESS_REDIRECT_URL https://lk.nano.padlhub.su/
test -n "$(runtime_value VIVA_DELEGATION_ENCRYPTION_KEY)"

previous_home_read_mode="$(runtime_value HOME_READ_MODE)"
case "$previous_home_read_mode" in
  mock | projection) ;;
  *)
    echo 'Client-assisted Viva activation requires an existing safe Home read mode' >&2
    exit 1
    ;;
esac

active_delegations_sql="
  select count(*)
    from integration.user_delegations delegation
    join identity.tenants tenant
      on tenant.id = delegation.tenant_id
     and tenant.tenant_key = '${tenant_key}'
     and tenant.active = true
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
"

routing_ready_delegations_sql="
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
"

other_mixed_plans_sql="
  select count(*)
    from integration.client_routing_plans plan
    join identity.tenants tenant
      on tenant.id = plan.tenant_id
     and tenant.tenant_key <> '${tenant_key}'
     and tenant.active = true
   where plan.mode = 'MIXED_END_USER_READS'
     and cardinality(plan.direct_read_operations) > 0
"

active_delegations="$(sql "$active_delegations_sql")"
routing_ready_delegations="$(sql "$routing_ready_delegations_sql")"
other_mixed_plans="$(sql "$other_mixed_plans_sql")"
if test "$active_delegations" -eq 0 || test "$routing_ready_delegations" != "$active_delegations"; then
  echo "Client-assisted Viva routing is not ready: ${routing_ready_delegations}/${active_delegations} active delegations" >&2
  exit 1
fi
if test "$other_mixed_plans" -ne 0; then
  echo 'Client-assisted Viva activation found an out-of-scope mixed tenant' >&2
  exit 1
fi

override_backup="$(mktemp /opt/phub/staging.override.env.client-assisted-backup.XXXXXX)"
override_next="$(mktemp /opt/phub/staging.override.env.client-assisted-next.XXXXXX)"
override_was_present=false
if test -f "$runtime_override_env"; then
  cp "$runtime_override_env" "$override_backup"
  override_was_present=true
fi
chmod 600 "$override_backup" "$override_next"

restore_override() {
  if test "$override_was_present" = true; then
    cp "$override_backup" "$runtime_override_env"
    chmod 600 "$runtime_override_env"
  else
    rm -f "$runtime_override_env"
  fi
}

cleanup() {
  rm -f "$override_backup" "$override_next"
}

activate() {
  if test -f "$runtime_override_env"; then
    awk -F= '
      $1 != "VIVA_DIRECT_READ_ENABLED" &&
      $1 != "HOME_VIVA_SYNC_ENABLED" &&
      $1 != "HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED"
    ' "$runtime_override_env" > "$override_next" || return 1
  else
    : > "$override_next"
  fi
  {
    printf '%s\n' 'VIVA_DIRECT_READ_ENABLED=true'
    printf '%s\n' 'HOME_VIVA_SYNC_ENABLED=false'
    printf '%s\n' 'HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED=false'
  } >> "$override_next" || return 1
  chmod 600 "$override_next" || return 1
  mv "$override_next" "$runtime_override_env" || return 1

  test "$(runtime_value HOME_READ_MODE)" = "$previous_home_read_mode" || return 1
  test "$(runtime_value VIVA_DIRECT_READ_ENABLED)" = true || return 1
  test "$(runtime_value HOME_VIVA_SYNC_ENABLED)" = false || return 1
  test "$(runtime_value HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED)" = false || return 1

  compose up -d --force-recreate api worker || return 1
  wait_for_service api || return 1
  wait_for_service worker || return 1
  compose exec -T api node -e '
    if (process.env.VIVA_DIRECT_READ_ENABLED !== "true") process.exit(1);
    if (process.env.HOME_VIVA_SYNC_ENABLED !== "false") process.exit(1);
    if (process.env.HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED !== "false") process.exit(1);
    if (process.env.HOME_READ_MODE !== process.argv[1]) process.exit(1);
  ' "$previous_home_read_mode" || return 1
  compose exec -T worker node -e '
    if (process.env.HOME_VIVA_SYNC_ENABLED !== "false") process.exit(1);
    if (process.env.HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED !== "false") process.exit(1);
    if (process.env.HOME_READ_MODE !== process.argv[1]) process.exit(1);
  ' "$previous_home_read_mode" || return 1

  active_delegations="$(sql "$active_delegations_sql")" || return 1
  routing_ready_delegations="$(sql "$routing_ready_delegations_sql")" || return 1
  other_mixed_plans="$(sql "$other_mixed_plans_sql")" || return 1
  test "$active_delegations" -gt 0 || return 1
  test "$routing_ready_delegations" = "$active_delegations" || return 1
  test "$other_mixed_plans" -eq 0 || return 1
}

if ! activate; then
  echo 'Client-assisted Viva activation failed; restoring the previous runtime override' >&2
  restore_override
  compose up -d --force-recreate api worker >/dev/null 2>&1 || true
  wait_for_service api >/dev/null 2>&1 || true
  wait_for_service worker >/dev/null 2>&1 || true
  cleanup
  exit 1
fi

cleanup
echo "Client-assisted Viva reads enabled for ${tenant_key} without changing Home mode (${previous_home_read_mode}); routing=${routing_ready_delegations}/${active_delegations}"
