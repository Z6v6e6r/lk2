#!/bin/sh

set -eu

last4_csv="${1:-}"

if ! printf '%s' "$last4_csv" | grep -Eq '^[0-9]{4}(,[0-9]{4}){0,9}$'; then
  echo 'Expected one to ten comma-separated four-digit phone suffixes.' >&2
  exit 2
fi

cd /opt/phub

query="$(cat <<'SQL'
begin transaction read only;

with requested as (
  select suffix
  from regexp_split_to_table(current_setting('phub.diagnostic_phone_last4'), ',') as suffix
), matched as (
  select
    requested.suffix,
    tenant.id as tenant_id,
    tenant.tenant_key,
    identity_user.id as user_id,
    identity_user.status as user_status,
    access.permissions,
    privacy.chat_policy,
    delegation.id as delegation_id,
    delegation.granted_scopes,
    delegation.refresh_expires_at,
    delegation.last_refreshed_at,
    delegation.refresh_failed_at,
    delegation.refresh_failure_code,
    delegation.revoked_at,
    delegation.revoke_reason,
    delegation.updated_at as delegation_updated_at,
    count(identity_user.id) over (partition by requested.suffix) as user_matches
  from requested
  left join identity.tenants tenant
    on tenant.tenant_key = 'local-padel'
  left join profile.user_summaries profile
    on profile.tenant_id = tenant.id
   and right(profile.phone_e164, 4) = requested.suffix
  left join identity.users identity_user
    on identity_user.tenant_id = profile.tenant_id
   and identity_user.id = profile.user_id
  left join integration.user_delegations delegation
    on delegation.tenant_id = identity_user.tenant_id
   and delegation.user_id = identity_user.id
   and delegation.provider = 'VIVA'
  left join identity.user_access_profiles access
    on access.tenant_id = identity_user.tenant_id
   and access.user_id = identity_user.id
  left join profile.privacy_settings privacy
    on privacy.tenant_id = identity_user.tenant_id
   and privacy.user_id = identity_user.id
)
select concat_ws('|',
  'phone=***' || suffix,
  'matches=' || user_matches,
  'tenant=' || coalesce(tenant_key, 'NOT_FOUND'),
  'user_id=' || coalesce(user_id::text, 'NOT_FOUND'),
  'user_status=' || coalesce(user_status, 'NOT_FOUND'),
  'chat_direct_permission=' || case
    when 'chat.direct.create' = any(coalesce(permissions, '{}'::text[])) then 'YES'
    else 'NO'
  end,
  'chat_policy=' || coalesce(chat_policy, 'AUTHORIZED'),
  'messaging_http=' || coalesce((
    select runtime.http_enabled::text
    from messaging.tenant_runtime_settings runtime
    where runtime.tenant_id = matched.tenant_id
  ), 'false'),
  'messaging_direct=' || coalesce((
    select runtime.direct_enabled::text
    from messaging.tenant_runtime_settings runtime
    where runtime.tenant_id = matched.tenant_id
  ), 'false'),
  'messaging_realtime=' || coalesce((
    select runtime.realtime_enabled::text
    from messaging.tenant_runtime_settings runtime
    where runtime.tenant_id = matched.tenant_id
  ), 'false'),
  'delegation=' || case
    when delegation_id is null then 'MISSING'
    when revoked_at is not null then 'REVOKED'
    when refresh_expires_at is not null and refresh_expires_at <= now() then 'EXPIRED'
    else 'ACTIVE'
  end,
  'scopes=' || coalesce(array_to_string(granted_scopes, ','), 'NONE'),
  'refresh_expires_at=' || coalesce(refresh_expires_at::text, 'NONE'),
  'last_refreshed_at=' || coalesce(last_refreshed_at::text, 'NONE'),
  'refresh_failed_at=' || coalesce(refresh_failed_at::text, 'NONE'),
  'refresh_failure_code=' || coalesce(refresh_failure_code, 'NONE'),
  'revoked_at=' || coalesce(revoked_at::text, 'NONE'),
  'revoke_reason=' || coalesce(revoke_reason, 'NONE'),
  'delegation_updated_at=' || coalesce(delegation_updated_at::text, 'NONE'),
  'viva_components=' || case when user_id is null then 'NONE' else (
    select count(*)::text
    from integration.viva_home_source_components component
    where component.tenant_id = matched.tenant_id
      and component.user_id = matched.user_id
  ) end,
  'viva_last_sync=' || coalesce((
    select max(component.last_synced_at)::text
    from integration.viva_home_source_components component
    where component.tenant_id = matched.tenant_id
      and component.user_id = matched.user_id
  ), 'NONE'),
  'community_last_sync=' || coalesce((
    select component.last_synced_at::text
    from integration.community_home_source_components component
    where component.tenant_id = matched.tenant_id
      and component.user_id = matched.user_id
  ), 'NONE'),
  'promotion_last_sync=' || coalesce((
    select component.last_synced_at::text
    from integration.promotion_home_source_components component
    where component.tenant_id = matched.tenant_id
      and component.user_id = matched.user_id
  ), 'NONE'),
  'platform_components=' || case when user_id is null then 'NONE' else (
    select count(*)::text
    from integration.platform_home_source_components component
    where component.tenant_id = matched.tenant_id
      and component.user_id = matched.user_id
  ) end,
  'platform_last_sync=' || coalesce((
    select max(component.last_synced_at)::text
    from integration.platform_home_source_components component
    where component.tenant_id = matched.tenant_id
      and component.user_id = matched.user_id
  ), 'NONE'),
  'snapshot_updated_at=' || coalesce((
    select snapshot.updated_at::text
    from home.dashboard_snapshots snapshot
    where snapshot.tenant_id = matched.tenant_id
      and snapshot.user_id = matched.user_id
  ), 'NONE')
)
from matched
order by suffix, user_id nulls last;

commit;
SQL
)"

docker compose --env-file infrastructure.env -f compose.infrastructure.yaml exec -T postgres \
  sh -ec 'PGOPTIONS="-c default_transaction_read_only=on -c phub.diagnostic_phone_last4=$2" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -P pager=off -Atc "$1"' \
  sh "$query" "$last4_csv"
