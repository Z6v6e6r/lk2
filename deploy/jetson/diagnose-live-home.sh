#!/bin/sh

set -eu

cd /opt/phub

auth_correlation_id='fd11bad9-4441-441e-b474-a0a51d8e00bf'

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

api_container_id="$(compose ps -q api)"
test -n "$api_container_id"

echo "auth_runtime"
compose exec -T api node -e "
  const env = process.env;
  const decodedKeyBytes = (() => {
    try { return Buffer.from(env.VIVA_DELEGATION_ENCRYPTION_KEY || '', 'base64url').length; }
    catch { return -1; }
  })();
  console.log(JSON.stringify({
    appEnv: env.APP_ENV,
    vivaMode: env.VIVA_MODE,
    oauthEnabled: env.VIVA_OAUTH_ENABLED,
    redirectUri: env.VIVA_OAUTH_REDIRECT_URI,
    successRedirectUrl: env.VIVA_OAUTH_SUCCESS_REDIRECT_URL,
    oauthScopes: env.VIVA_OAUTH_SCOPES,
    delegationKeyBytes: decodedKeyBytes,
    delegationKeyVersionPresent: Boolean(env.VIVA_DELEGATION_KEY_VERSION)
  }));
"

echo "auth_audit"
sql "
  select concat(action, '|', resource_type, '|', result)
    from audit.audit_log
   where correlation_id = '$auth_correlation_id'
   order by occurred_at
"

echo "auth_acceptances"
sql "
  select concat(document_kind, '|', source)
    from legal.document_acceptances
   where correlation_id = '$auth_correlation_id'
   order by document_kind
"

echo "auth_request_log"
docker logs "$api_container_id" --since 3h 2>&1 \
  | grep -F "$auth_correlation_id" \
  | sed -E \
      -e 's/(code=)[^&" ]+/\1<redacted>/g' \
      -e 's/(state=)[^&" ]+/\1<redacted>/g' \
      -e 's/("(access|refresh)?[Tt]oken"[[:space:]]*:[[:space:]]*")[^"]+/\1<redacted>/g' \
      -e 's/("(authorization|cookie)"[[:space:]]*:[[:space:]]*")[^"]+/\1<redacted>/g' \
  || true

echo "recent_identity_provider_metrics"
docker logs "$api_container_id" --since 30m 2>&1 \
  | grep -F 'identity provider operation' \
  | tail -40 \
  || true

exit 0

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
    ' platform_fresh=', count(*) filter (where (
      select count(*)
        from integration.platform_home_source_components platform
       where platform.tenant_id = delegation.tenant_id
         and platform.user_id = delegation.user_id
         and platform.last_synced_at >= now() - interval '10 minutes'
    ) = 3),
    ' locations_component=', count(*) filter (where exists (
      select 1
        from home.dashboard_components location
       where location.tenant_id = delegation.tenant_id
         and location.user_id = delegation.user_id
         and location.component = 'locations'
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
