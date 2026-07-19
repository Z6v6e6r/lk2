#!/bin/sh

set -eu

cd /opt/phub

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

sql() {
  infrastructure exec -T postgres sh -ec \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "$1"' \
    sh "$1"
}

sql "
  select concat(
    'active=', count(*),
    ' viva_complete=', count(*) filter (where (
      select count(*)
        from integration.viva_home_source_components viva
       where viva.tenant_id = delegation.tenant_id
         and viva.user_id = delegation.user_id
    ) = 3),
    ' viva_fresh=', count(*) filter (where (
      select count(*)
        from integration.viva_home_source_components viva
       where viva.tenant_id = delegation.tenant_id
         and viva.user_id = delegation.user_id
         and viva.last_synced_at >= now() - interval '10 minutes'
    ) = 3),
    ' community_fresh=', count(*) filter (where exists (
      select 1
        from integration.community_home_source_components community
       where community.tenant_id = delegation.tenant_id
         and community.user_id = delegation.user_id
         and community.last_synced_at >= now() - interval '10 minutes'
    )),
    ' promotion_fresh=', count(*) filter (where exists (
      select 1
        from integration.promotion_home_source_components promotion
       where promotion.tenant_id = delegation.tenant_id
         and promotion.user_id = delegation.user_id
         and promotion.last_synced_at >= now() - interval '10 minutes'
    )),
    ' snapshot_projection=', count(*) filter (where exists (
      select 1
        from home.dashboard_snapshots snapshot
       where snapshot.tenant_id = delegation.tenant_id
         and snapshot.user_id = delegation.user_id
         and snapshot.payload #>> '{snapshot,source}' = 'LOCAL_PROJECTION'
    )),
    ' snapshot_fresh=', count(*) filter (where exists (
      select 1
        from home.dashboard_snapshots snapshot
       where snapshot.tenant_id = delegation.tenant_id
         and snapshot.user_id = delegation.user_id
         and snapshot.updated_at >= now() - interval '10 minutes'
         and snapshot.stale_at > now()
    )),
    ' viva_failure_codes=', coalesce(
      string_agg(distinct delegation.refresh_failure_code, ','), 'NONE'
    )
  )
    from integration.user_delegations delegation
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
"
