#!/bin/sh

set -eu

app_root="${PHUB_APP_ROOT:-/opt/phub}"
cd "$app_root"

base_runtime_env="${PHUB_BASE_RUNTIME_ENV:-/etc/phub/staging.env}"
auth_runtime_env="$app_root/staging.auth.env"
runtime_override_env="$app_root/staging.override.env"
recheck_seconds="${PHUB_MEDIA_ROLLBACK_RECHECK_SECONDS:-5}"
rollback_mode="${PHUB_MEDIA_ROLLBACK_MODE:-feature}"
compatibility_floor="${PHUB_ROLLBACK_COMPATIBILITY_FLOOR:-}"

file_value() {
  file="$1"
  key="$2"
  sed -n "s/^${key}=//p" "$file" 2>/dev/null | tail -n 1
}

runtime_value() {
  key="$1"
  # Compose loads base, auth and then override for the worker. Read in reverse precedence.
  for file in "$app_root/staging.games.env" "$runtime_override_env" "$auth_runtime_env" "$base_runtime_env"; do
    value="$(file_value "$file" "$key")"
    if test -n "$value"; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

fail() {
  printf '%s\n' "Media rollback refused: $*" >&2
  exit 1
}

client_compatible() {
  printf '%s\n' "Media rollback requires the client-media compatibility floor: $*" >&2
  exit 42
}

community_compatible() {
  printf '%s\n' "Media rollback requires the community-logo compatibility floor: $*" >&2
  exit 43
}

case "$rollback_mode" in
  pre-cutover | compatible-client | compatible-logo | feature) ;;
  *) fail "unknown rollback mode: $rollback_mode" ;;
esac
case "$rollback_mode:$compatibility_floor" in
  pre-cutover: | feature:) ;;
  compatible-client:client-media | compatible-logo:community-logo) ;;
  compatible-client:* | compatible-logo:*)
    fail "rollback mode and PHUB_ROLLBACK_COMPATIBILITY_FLOOR disagree"
    ;;
  *) fail 'PHUB_ROLLBACK_COMPATIBILITY_FLOOR is valid only for a compatible rollback' ;;
esac

compose() {
  docker compose --env-file infrastructure.env --env-file release.env "$@"
}

running_flag_value() {
  service="$1"
  key="$2"
  if ! container_id="$(compose ps --status running -q "$service")"; then
    fail "cannot resolve the running $service container"
  fi
  test -n "$container_id" || return 0
  if ! env_dump="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")"; then
    fail "cannot inspect the running $service container"
  fi
  value="$(printf '%s\n' "$env_dump" | sed -n "s/^${key}=//p" | tail -n 1)"
  case "$value" in
    true | false) printf '%s' "$value" ;;
    *) fail "running $service has no literal boolean $key" ;;
  esac
}

require_running_flag() {
  service="$1"
  key="$2"
  expected="$3"
  value="$(running_flag_value "$service" "$key")"
  test -z "$value" && return 0
  test "$value" = "$expected" || fail "running $service must have $key=$expected"
}

require_running_service_flag() {
  service="$1"
  key="$2"
  expected="$3"
  value="$(running_flag_value "$service" "$key")"
  test -n "$value" || fail "running $service is required for compatible rollback"
  test "$value" = "$expected" || fail "running $service must have $key=$expected"
}

validate_runtime_boolean() {
  key="$1"
  value="$2"
  case "$value" in
    '' | true | false) ;;
    *) fail "runtime files contain a non-boolean $key" ;;
  esac
}

runtime_profile_client="$(runtime_value PROFILE_PHOTO_CLIENT_SYNC_ENABLED)"
runtime_stable="$(runtime_value COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED)"
runtime_backfill="$(runtime_value COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED)"
validate_runtime_boolean PROFILE_PHOTO_CLIENT_SYNC_ENABLED "$runtime_profile_client"
validate_runtime_boolean COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED "$runtime_stable"
validate_runtime_boolean COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED "$runtime_backfill"
api_profile_client="$(running_flag_value api PROFILE_PHOTO_CLIENT_SYNC_ENABLED)"
api_stable="$(running_flag_value api COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED)"
api_backfill="$(running_flag_value api COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED)"
worker_stable="$(running_flag_value worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED)"
worker_backfill="$(running_flag_value worker COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED)"

if test "$rollback_mode" != pre-cutover; then
  test "$runtime_profile_client" != true && test "$api_profile_client" != true ||
    fail 'client-assisted profile-photo writes are active'
fi

case "$rollback_mode" in
  compatible-client)
    require_running_service_flag worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED false
    require_running_service_flag worker COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false
    require_running_flag api COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED false
    require_running_flag api COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false
    test "$runtime_stable" != true || fail 'stable community-logo delivery is active'
    test "$runtime_backfill" != true || fail 'community-logo compatibility backfill is active'
    ;;
  compatible-logo)
    require_running_service_flag worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED true
    require_running_service_flag worker COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false
    require_running_flag api COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED true
    require_running_flag api COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false
    test "$runtime_stable" = true || fail 'stable community-logo delivery is not active'
    test "$runtime_backfill" != true || fail 'community-logo compatibility backfill is active'
    ;;
  feature)
    require_running_service_flag worker COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED false
    require_running_service_flag worker COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false
    require_running_flag api COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED false
    require_running_flag api COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED false
    test "$runtime_stable" != true || fail 'stable community-logo delivery is active'
    test "$runtime_backfill" != true || fail 'community-logo compatibility backfill is active'
    ;;
  pre-cutover) ;;
esac

if test "$rollback_mode" = compatible-client; then
  if ! compose exec -T worker node -e '
    const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
    process.exit(code.includes("phub.client-media-rollback.v1") ? 0 : 1);
  '; then
    fail 'running worker does not provide the client-media compatibility floor'
  fi
elif test "$rollback_mode" = compatible-logo; then
  if ! compose exec -T worker node -e '
    const code = require("node:fs").readFileSync("/app/apps/worker/dist/main.js", "utf8");
    process.exit(
      code.includes("phub.client-media-rollback.v1") &&
      code.includes("phub.community-logo-rollback.v1") ? 0 : 1,
    );
  '; then
    fail 'running worker does not provide both media compatibility floors'
  fi
fi

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"' \
    sh "$1"
}

require_home_queue_drained() {
  if ! queue_table="$(infrastructure exec -T rabbitmq rabbitmqctl -q list_queues name messages_ready messages_unacknowledged)"; then
    fail 'cannot inspect the Home projector queue'
  fi
  queue_counts="$(printf '%s\n' "$queue_table" |
    awk '$1 == "phub.home-projector.v1" { print $2 "|" $3 }')"
  test "$queue_counts" = '0|0' ||
    fail "Home projector queue is missing or not drained (${queue_counts:-missing})"
}

profile_migration="0079_profile_photo_client_assisted_source.sql"
community_migration="0080_community_logo_stable_delivery.sql"
profile_null_sources=0
profile_command_count=0
profile_gc_count=0
cutover_active=0
community_incompatible_counts='0|0|0|0|0|0'

if test "$(sql "select count(*) from public.schema_migrations where filename = '$profile_migration'")" != 0; then
  profile_counts="$(sql "select
    (select count(*) from integration.user_profile_photo_sync where source_url is null)::text || '|' ||
    (select count(*) from integration.profile_photo_client_commands)::text")"
  profile_null_sources="${profile_counts%%|*}"
  profile_command_count="${profile_counts#*|}"
  if test "$rollback_mode" != pre-cutover; then
    test "$profile_command_count" = 0 ||
      fail "profile-photo client commands are not drained ($profile_command_count)"
  fi
  if test "$rollback_mode" = feature; then
    test "$profile_null_sources" = 0 ||
      fail "target worker cannot read client-assisted profile mappings ($profile_null_sources)"
  fi
  if test "$rollback_mode" = feature; then
    profile_gc_count="$(sql "select count(*) from integration.profile_photo_object_gc")"
    test "$profile_gc_count" = 0 ||
      fail "profile-photo feature drain still has object GC rows ($profile_gc_count)"
  fi
fi

if test "$(sql "select count(*) from public.schema_migrations where filename = '$community_migration'")" != 0; then
  cutover_active="$(sql "select count(*) from integration.media_cutover_state
    where feature = 'community_logo_stable_delivery' and active")"

  read_community_pre_cutover_counts() {
    sql "select
      (select count(*) from integration.community_logo_sync
        where delivery_url is null or delivery_expires_at is null)::text || '|' ||
      (select count(*) from integration.community_home_source_components
        where exists (
          select 1 from jsonb_array_elements(payload) item
           where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
        ))::text || '|' ||
      (select count(*) from home.dashboard_components
        where component = 'communities'
          and exists (
            select 1 from jsonb_array_elements(payload) item
             where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
          ))::text || '|' ||
      (select count(*) from home.dashboard_snapshots
        where exists (
          select 1 from jsonb_array_elements(coalesce(payload->'communities', '[]'::jsonb)) item
           where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
        ))::text || '|' ||
      (select count(*) from home.base_snapshots
        where exists (
          select 1 from jsonb_array_elements(coalesce(payload#>'{communities,value}', '[]'::jsonb)) item
           where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
        ))::text || '|' ||
      (select count(*) from audit.outbox_events
        where published_at is null
          and event_type = 'home.projection.component.changed.v1'
          and exists (
            select 1 from jsonb_array_elements(coalesce(payload->'value', '[]'::jsonb)) item
             where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
          ))::text"
  }

  verify_community_pre_cutover() {
    checked_counts="$(read_community_pre_cutover_counts)"
    test "$checked_counts" = '0|0|0|0|0|0' ||
      fail "community-logo incompatible state remains ($checked_counts)"
  }

  community_incompatible_counts="$(read_community_pre_cutover_counts)"

  verify_community_drain() {
    community_counts="$(sql "select
      (select count(*) from integration.community_logo_sync
        where delivery_url is null or delivery_expires_at is null
           or delivery_expires_at <= now() + interval '5 minutes')::text || '|' ||
      (select count(*) from integration.community_home_source_components
        where exists (
          select 1 from jsonb_array_elements(payload) item
          left join integration.community_logo_sync logo
            on logo.tenant_id = integration.community_home_source_components.tenant_id
           and logo.community_id::text = item->>'id'
          where (logo.delivery_url is null and item->>'logoUrl' like '%/public/api/v1/media/community-logos/%')
             or (logo.delivery_url is not null and item->>'logoUrl' is distinct from logo.delivery_url)
        ))::text || '|' ||
      (select count(*) from home.dashboard_components
        where component = 'communities'
          and exists (
            select 1 from jsonb_array_elements(payload) item
            left join integration.community_logo_sync logo
              on logo.tenant_id = home.dashboard_components.tenant_id
             and logo.community_id::text = item->>'id'
            where (logo.delivery_url is null and item->>'logoUrl' like '%/public/api/v1/media/community-logos/%')
               or (logo.delivery_url is not null and item->>'logoUrl' is distinct from logo.delivery_url)
          ))::text || '|' ||
      (select count(*) from home.dashboard_snapshots
        where exists (
          select 1 from jsonb_array_elements(coalesce(payload->'communities', '[]'::jsonb)) item
          left join integration.community_logo_sync logo
            on logo.tenant_id = home.dashboard_snapshots.tenant_id
           and logo.community_id::text = item->>'id'
          where (logo.delivery_url is null and item->>'logoUrl' like '%/public/api/v1/media/community-logos/%')
             or (logo.delivery_url is not null and item->>'logoUrl' is distinct from logo.delivery_url)
        ))::text || '|' ||
      (select count(*) from home.base_snapshots
        where exists (
          select 1 from jsonb_array_elements(coalesce(payload#>'{communities,value}', '[]'::jsonb)) item
          left join integration.community_logo_sync logo
            on logo.tenant_id = home.base_snapshots.tenant_id
           and logo.community_id::text = item->>'id'
          where (logo.delivery_url is null and item->>'logoUrl' like '%/public/api/v1/media/community-logos/%')
             or (logo.delivery_url is not null and item->>'logoUrl' is distinct from logo.delivery_url)
        ))::text || '|' ||
      (select count(*) from audit.outbox_events
        where published_at is null
          and event_type = 'home.projection.component.changed.v1'
          and exists (
            select 1 from jsonb_array_elements(coalesce(payload->'value', '[]'::jsonb)) item
            left join integration.community_logo_sync logo
              on logo.tenant_id = audit.outbox_events.tenant_id
             and logo.community_id::text = item->>'id'
            where (logo.delivery_url is null and item->>'logoUrl' like '%/public/api/v1/media/community-logos/%')
               or (logo.delivery_url is not null and item->>'logoUrl' is distinct from logo.delivery_url)
          ))::text")"
    test "$community_counts" = '0|0|0|0|0|0' ||
      fail "community-logo compatibility drain is incomplete ($community_counts)"
  }
  verify_community_stable_state() {
    stable_incompatible_counts="$(sql "select
      (select count(*) from integration.community_home_source_components
        where exists (
          select 1 from jsonb_array_elements(payload) item
          left join integration.community_logo_sync logo
            on logo.tenant_id = integration.community_home_source_components.tenant_id
           and logo.community_id::text = item->>'id'
          where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
            and logo.object_key is null
        ))::text || '|' ||
      (select count(*) from home.dashboard_components
        where component = 'communities'
          and exists (
            select 1 from jsonb_array_elements(payload) item
            left join integration.community_logo_sync logo
              on logo.tenant_id = home.dashboard_components.tenant_id
             and logo.community_id::text = item->>'id'
            where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
              and logo.object_key is null
          ))::text || '|' ||
      (select count(*) from home.dashboard_snapshots
        where exists (
          select 1 from jsonb_array_elements(coalesce(payload->'communities', '[]'::jsonb)) item
          left join integration.community_logo_sync logo
            on logo.tenant_id = home.dashboard_snapshots.tenant_id
           and logo.community_id::text = item->>'id'
          where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
            and logo.object_key is null
        ))::text || '|' ||
      (select count(*) from home.base_snapshots
        where exists (
          select 1 from jsonb_array_elements(coalesce(payload#>'{communities,value}', '[]'::jsonb)) item
          left join integration.community_logo_sync logo
            on logo.tenant_id = home.base_snapshots.tenant_id
           and logo.community_id::text = item->>'id'
          where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
            and logo.object_key is null
        ))::text || '|' ||
      (select count(*) from audit.outbox_events
        where published_at is null
          and event_type = 'home.projection.component.changed.v1'
          and exists (
            select 1 from jsonb_array_elements(coalesce(payload->'value', '[]'::jsonb)) item
            left join integration.community_logo_sync logo
              on logo.tenant_id = audit.outbox_events.tenant_id
             and logo.community_id::text = item->>'id'
            where item->>'logoUrl' like '%/public/api/v1/media/community-logos/%'
              and logo.object_key is null
          ))::text")"
    test "$stable_incompatible_counts" = '0|0|0|0|0' ||
      fail "stable community-logo state has unresolved mappings ($stable_incompatible_counts)"
  }
  case "$rollback_mode" in
    pre-cutover)
      :
      ;;
    compatible-client)
      test "$cutover_active" = 0 || fail 'client-media rollback cannot cross a stable-logo cutover'
      verify_community_pre_cutover
      ;;
    compatible-logo)
      test "$cutover_active" = 1 || fail 'stable-to-stable rollback requires an active cutover'
      verify_community_stable_state
      sleep "$recheck_seconds"
      verify_community_stable_state
      require_home_queue_drained
      ;;
    feature)
      verify_community_pre_cutover
      verify_community_drain
      sleep "$recheck_seconds"
      verify_community_drain
      require_home_queue_drained
      compose stop worker
      verify_community_drain
      require_home_queue_drained
      sql "update integration.media_cutover_state set active = false, updated_at = now()
        where feature = 'community_logo_stable_delivery'" >/dev/null
      ;;
  esac
fi

if test "$rollback_mode" = pre-cutover; then
  test "$runtime_profile_client" != true && test "$api_profile_client" != true ||
    fail 'client-assisted profile-photo writes are active'
  test "$profile_command_count" = 0 ||
    fail "profile-photo client commands are not drained ($profile_command_count)"
  test "$runtime_backfill" != true && test "$api_backfill" != true &&
    test "$worker_backfill" != true || fail 'community-logo compatibility backfill is active'

  if test "$runtime_stable" = true || test "$api_stable" = true ||
    test "$worker_stable" = true || test "$cutover_active" != 0 ||
    test "$community_incompatible_counts" != '0|0|0|0|0|0'; then
    community_compatible "stable community-logo state was observed ($community_incompatible_counts)"
  fi
  test "$profile_null_sources" = 0 ||
    client_compatible "client-assisted profile mappings exist ($profile_null_sources)"
fi

printf '%s\n' "Media rollback compatibility verified ($rollback_mode)"
