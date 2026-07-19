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

sql "
  select concat(
    'components=', coalesce(string_agg(distinct component.component, ',' order by component.component), 'NONE'),
    ' outbox_unpublished=', count(distinct event.id) filter (where event.published_at is null),
    ' projector_received=', count(distinct inbox.event_id),
    ' projector_processed=', count(distinct inbox.event_id) filter (where inbox.processed_at is not null)
  )
    from integration.user_delegations delegation
    left join home.dashboard_components component
      on component.tenant_id = delegation.tenant_id
     and component.user_id = delegation.user_id
    left join audit.outbox_events event
      on event.tenant_id = delegation.tenant_id
     and event.aggregate_id = delegation.user_id
     and event.event_type = 'home.projection.component.changed.v1'
    left join audit.inbox_events inbox
      on inbox.tenant_id = event.tenant_id
     and inbox.event_id = event.id
     and inbox.consumer_name = 'home-projector-v1'
   where delegation.provider = 'VIVA'
     and delegation.revoked_at is null
     and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
"
