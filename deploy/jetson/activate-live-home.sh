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
  promotion_sync_batch_size="${2:-}"
  override_tmp="$runtime_override_env.$$"
  umask 077
  trap 'rm -f "$override_tmp"' EXIT HUP INT TERM
  {
    printf 'HOME_READ_MODE=%s\n' "$home_read_mode"
    printf 'HOME_VIVA_SYNC_ENABLED=true\n'
    printf 'VIVA_DIRECT_READ_ENABLED=true\n'
    printf 'COMMUNITIES_READ_MODE=legacy\n'
    printf 'COMMUNITY_LEGACY_READ_DETAIL_ENABLED=true\n'
    printf 'COMMUNITY_LEGACY_READ_FEED_ENABLED=true\n'
    printf 'COMMUNITY_LEGACY_READ_CHAT_ENABLED=true\n'
    printf 'COMMUNITY_LEGACY_READ_RATING_ENABLED=true\n'
    printf 'COMMUNITIES_LEGACY_TIMEOUT_MS=2500\n'
    printf 'COMMUNITIES_LEGACY_MAX_ATTEMPTS=1\n'
    printf 'COMMUNITIES_LEGACY_CACHE_TTL_MS=120000\n'
    printf 'PROMOTIONS_READ_MODE=legacy\n'
    printf 'PROMOTIONS_LEGACY_BASE_URL=http://phab-showcase:3000\n'
    printf 'PROMOTIONS_HERO_PLACEMENT=cabinet_home_top\n'
    printf 'PROMOTIONS_STANDARD_PLACEMENT=cabinet_home\n'
    printf 'PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT=cabinet_for_me_strip\n'
    printf 'PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT=cabinet_for_me_card\n'
    printf 'PROMOTION_IMAGE_ALLOWED_HOSTS=phab-showcase\n'
    printf 'PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS=phab-showcase\n'
    if test -n "$promotion_sync_batch_size"; then
      printf 'PROMOTIONS_SYNC_BATCH_SIZE=%s\n' "$promotion_sync_batch_size"
    fi
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
previous_home_read_mode="$(
  sed -n 's/^HOME_READ_MODE=//p' "$runtime_override_env" 2>/dev/null |
    tail -n 1
)"
case "$previous_home_read_mode" in
  mock | projection) ;;
  *) previous_home_read_mode=mock ;;
esac

write_runtime_override mock 100
compose up -d --force-recreate worker
wait_for_service worker

active_delegations_sql="
  select count(*)
    from integration.user_delegations delegation
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
"

routing_ready_delegations_sql="
  select count(*)
    from integration.user_delegations delegation
    join integration.client_routing_plans plan
      on plan.tenant_id = delegation.tenant_id
     and plan.mode = 'MIXED_END_USER_READS'
     and plan.direct_read_operations @> array['profile.read']::text[]
    join integration.identity_provider_bindings binding
      on binding.tenant_id = delegation.tenant_id
     and binding.provider = 'VIVA'
     and nullif(btrim(binding.provider_tenant_key), '') is not null
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
"

active_delegations="$(sql "$active_delegations_sql")"
routing_ready_delegations="$(sql "$routing_ready_delegations_sql")"
if test "$active_delegations" -eq 0 || test "$routing_ready_delegations" != "$active_delegations"; then
  echo "Live booking-screen routing is not ready: ${routing_ready_delegations}/${active_delegations} active delegations" >&2
  echo "Set the tenant routing plan to MIXED_END_USER_READS with profile.read before activation" >&2
  write_runtime_override "$previous_home_read_mode"
  exit 1
fi

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
     and (
       select count(*)
         from integration.platform_home_source_components platform
        where platform.tenant_id = delegation.tenant_id
          and platform.user_id = delegation.user_id
          and platform.last_synced_at >= '${activation_started}'::timestamptz
     ) = 3
     and exists (
       select 1
         from home.dashboard_components location
        where location.tenant_id = delegation.tenant_id
          and location.user_id = delegation.user_id
          and location.component = 'locations'
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
  component_readiness="$(sql "
    select concat(
      'viva=', count(*) filter (where (
        select count(*)
          from integration.viva_home_source_components viva
         where viva.tenant_id = delegation.tenant_id
           and viva.user_id = delegation.user_id
           and viva.last_synced_at >= '${activation_started}'::timestamptz
      ) = 3), '/', count(*),
      ' community=', count(*) filter (where exists (
        select 1
          from integration.community_home_source_components community
         where community.tenant_id = delegation.tenant_id
           and community.user_id = delegation.user_id
           and community.last_synced_at >= '${activation_started}'::timestamptz
      )), '/', count(*),
      ' promotion=', count(*) filter (where exists (
        select 1
          from integration.promotion_home_source_components promotion
         where promotion.tenant_id = delegation.tenant_id
           and promotion.user_id = delegation.user_id
           and promotion.last_synced_at >= '${activation_started}'::timestamptz
      )), '/', count(*),
      ' platform=', count(*) filter (where (
        select count(*)
          from integration.platform_home_source_components platform
         where platform.tenant_id = delegation.tenant_id
           and platform.user_id = delegation.user_id
           and platform.last_synced_at >= '${activation_started}'::timestamptz
      ) = 3), '/', count(*),
      ' locations=', count(*) filter (where exists (
        select 1
          from home.dashboard_components location
         where location.tenant_id = delegation.tenant_id
           and location.user_id = delegation.user_id
           and location.component = 'locations'
      )), '/', count(*),
      ' snapshot=', count(*) filter (where exists (
        select 1
          from home.dashboard_snapshots snapshot
         where snapshot.tenant_id = delegation.tenant_id
           and snapshot.user_id = delegation.user_id
           and snapshot.updated_at >= '${activation_started}'::timestamptz
           and snapshot.stale_at > now()
      )), '/', count(*),
      ' viva_failure_codes=', coalesce(
        string_agg(distinct delegation.refresh_failure_code, ','), 'NONE'
      )
    )
      from integration.user_delegations delegation
     where delegation.provider = 'VIVA'
       and delegation.revoked_at is null
       and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
  ")"
  echo "Live Home component readiness: $component_readiness" >&2
  write_runtime_override "$previous_home_read_mode"
  compose up -d --force-recreate worker
  wait_for_service worker
  echo "Live Home projection did not become complete; previous API and worker read mode restored" >&2
  exit 1
fi

write_runtime_override projection
compose up -d --force-recreate api worker
wait_for_service api
wait_for_service worker

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
