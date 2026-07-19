#!/bin/sh

set -eu

cd /opt/phub

base_runtime_env=/etc/phub/staging.env
runtime_override_env=/opt/phub/staging.override.env

test -r "$base_runtime_env"

runtime_value() {
  key="$1"
  sed -n "s/^${key}=//p" "$base_runtime_env" | tail -n 1
}

test "$(runtime_value APP_ENV)" = staging
case "$(runtime_value VIVA_MODE)" in
  sandbox | production) ;;
  *)
    echo "Live Home requires the existing staging Viva provider configuration" >&2
    exit 1
    ;;
esac
test "$(runtime_value VIVA_OAUTH_ENABLED)" = true
test -n "$(runtime_value VIVA_DELEGATION_ENCRYPTION_KEY)"

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

write_runtime_override() {
  home_read_mode="$1"
  override_tmp="$runtime_override_env.$$"
  umask 077
  trap 'rm -f "$override_tmp"' EXIT HUP INT TERM
  {
    printf 'HOME_READ_MODE=%s\n' "$home_read_mode"
    printf 'HOME_VIVA_SYNC_ENABLED=true\n'
    printf 'COMMUNITIES_READ_MODE=legacy\n'
    printf 'PROMOTIONS_READ_MODE=legacy\n'
  } > "$override_tmp"
  mv "$override_tmp" "$runtime_override_env"
  trap - EXIT HUP INT TERM
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

activation_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_runtime_override mock
compose up -d --force-recreate worker
wait_for_service worker

active_delegations_sql="
  select count(*)
    from integration.user_delegations delegation
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
"

ready_delegations_sql="
  select count(*)
    from integration.user_delegations delegation
    join home.dashboard_snapshots snapshot
      on snapshot.tenant_id = delegation.tenant_id
     and snapshot.user_id = delegation.user_id
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
     and snapshot.updated_at >= '${activation_started}'::timestamptz
     and snapshot.stale_at > now()
     and (
       select count(*)
         from integration.viva_home_source_components viva
        where viva.tenant_id = delegation.tenant_id
          and viva.user_id = delegation.user_id
          and viva.last_synced_at >= '${activation_started}'::timestamptz
     ) = 3
     and exists (
       select 1
         from integration.community_home_source_components community
        where community.tenant_id = delegation.tenant_id
          and community.user_id = delegation.user_id
          and community.last_synced_at >= '${activation_started}'::timestamptz
     )
     and exists (
       select 1
         from integration.promotion_home_source_components promotion
        where promotion.tenant_id = delegation.tenant_id
          and promotion.user_id = delegation.user_id
          and promotion.last_synced_at >= '${activation_started}'::timestamptz
     )
"

projection_ready=0
attempt=0
while test "$attempt" -lt 24; do
  active_delegations="$(sql "$active_delegations_sql")"
  ready_delegations="$(sql "$ready_delegations_sql")"
  echo "Live Home projection readiness: ${ready_delegations}/${active_delegations} active delegations"
  if test "$active_delegations" -gt 0 && test "$ready_delegations" = "$active_delegations"; then
    projection_ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 15
done

if test "$projection_ready" -ne 1; then
  echo "Live Home projection did not become complete; API remains on its previous read mode" >&2
  exit 1
fi

write_runtime_override projection
compose up -d --force-recreate api
wait_for_service api

projection_source_ok="$(sql "
  select coalesce(bool_and(snapshot.payload #>> '{snapshot,source}' = 'LOCAL_PROJECTION'), false)
    from home.dashboard_snapshots snapshot
    join integration.user_delegations delegation
      on delegation.tenant_id = snapshot.tenant_id
     and delegation.user_id = snapshot.user_id
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
")"
test "$projection_source_ok" = t

echo "Live Home projection enabled and verified"
