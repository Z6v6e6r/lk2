#!/usr/bin/env sh
set -eu

confirmation=${SSH_ORIGINAL_COMMAND:-}
app_root=${PHUB_APP_ROOT:-/opt/phub}
backup_command=${PHUB_BACKUP_COMMAND:-/usr/local/libexec/phub/create-communities-staging-backup.sh}
restore_helper=${PHUB_RESTORE_HELPER:-/usr/local/libexec/phub/verify-postgres-backup-restore.sh}

if [ "$confirmation" != INVENTORY_COMMUNITIES_STAGING ]; then
  echo "exact Communities staging inspection confirmation is required" >&2
  exit 64
fi
script_path="$(readlink -f "$0")"
if [ ! -f "$script_path" ] || [ -L "$script_path" ] || [ "$(stat -c %u "$script_path")" -ne 0 ]; then
  echo "Communities staging inspection command is not a root-owned regular file" >&2
  exit 1
fi
case "$(stat -c %a "$script_path")" in
  700|744|755) ;;
  *) echo "Communities staging inspection command mode is unsafe" >&2; exit 1 ;;
esac
if [ "${PHUB_INVENTORY_TIMEOUT_ACTIVE:-}" != 1 ]; then
  exec /usr/bin/timeout --signal=TERM --kill-after=30s 10m \
    /usr/bin/env PHUB_INVENTORY_TIMEOUT_ACTIVE=1 "$script_path" "$@"
fi
validate_root_artifact() {
  artifact_path="$(readlink -f "$1")"
  if [ ! -f "$artifact_path" ] || [ -L "$artifact_path" ] || [ "$(stat -c %u "$artifact_path")" -ne 0 ]; then
    echo "installed preflight artifact is not a root-owned regular file" >&2
    exit 1
  fi
  case "$(stat -c %a "$artifact_path")" in
    700|744|755) ;;
    *) echo "installed preflight artifact mode is unsafe" >&2; exit 1 ;;
  esac
  printf '%s' "$artifact_path"
}
backup_command="$(validate_root_artifact "$backup_command")"
restore_helper="$(validate_root_artifact "$restore_helper")"
validate_readonly_input() {
  if [ ! -e "$1" ] || [ -L "$1" ] || [ -w "$1" ] || [ "$(stat -c %u "$1")" -eq "$(id -u)" ]; then
    echo "staging input is absent or writable by the forced-command principal: $1" >&2
    exit 1
  fi
}
validate_readonly_input "$app_root"
validate_readonly_input "$app_root/infrastructure.env"
validate_readonly_input "$app_root/compose.infrastructure.yaml"
validate_readonly_input "$app_root/release.env"
if [ -e "$app_root/.env" ] || [ -L "$app_root/.env" ]; then
  validate_readonly_input "$app_root/.env"
fi
secret_root=${PHUB_SECRET_ROOT:-/etc/phub}
if [ ! -d "$secret_root" ] || [ -L "$secret_root" ] || [ ! -x "$secret_root" ]; then
  echo "runtime-secret transition root is not safely inspectable" >&2
  exit 1
fi
for artifact in \
  "$secret_root/.runtime-secret-isolation.transition.json" \
  "$secret_root/.runtime-secret-isolation.transition.json.next" \
  "$secret_root/.runtime-secret-isolation.staging.backup" \
  "$secret_root/.runtime-secret-isolation.staging.next" \
  "$secret_root/.runtime-secret-isolation.realtime.next" \
  "$app_root/.runtime-secret-isolation.compose.backup" \
  "$app_root/.runtime-secret-isolation.compose.next"; do
  if [ -e "$artifact" ] || [ -L "$artifact" ]; then
    echo "unresolved runtime-secret transition blocks Communities staging inspection" >&2
    exit 1
  fi
done

cd "$app_root"

active_release="$(sed -n 's/^RELEASE=//p' release.env 2>/dev/null || true)"
case "$active_release" in
  ''|*[!0-9a-f]*) echo "active release SHA is absent or invalid" >&2; exit 1 ;;
esac
if [ "${#active_release}" -ne 40 ]; then
  echo "active release SHA is absent or invalid" >&2
  exit 1
fi

printf 'META|activeRelease|%s\n' "$active_release"
printf 'META|remoteScriptSha|%s\n' "$(sha256sum "$script_path" | cut -d ' ' -f 1)"
printf 'META|installedBackupScriptSha|%s\n' "$(sha256sum "$backup_command" | cut -d ' ' -f 1)"
printf 'META|installedRestoreHelperSha|%s\n' "$(sha256sum "$restore_helper" | cut -d ' ' -f 1)"

docker compose --env-file infrastructure.env -f compose.infrastructure.yaml exec -T postgres \
  sh -ec '
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c search_path=pg_catalog"
    exec psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At
  ' <<'SQL'
begin transaction isolation level repeatable read read only;
set local idle_in_transaction_session_timeout = '30s';

select (to_regclass('public.schema_migrations') is not null)::text as ledger_exists \gset
\if :ledger_exists
\else
  \echo 'migration ledger is absent'
  \quit 3
\endif

select 'META|targetDatabase|' || current_database();
select 'META|systemIdentifier|' || system_identifier::text from pg_catalog.pg_control_system();
select 'META|serverVersionNum|' || current_setting('server_version_num');
select 'META|databaseBytes|' || pg_catalog.pg_database_size(current_database());
select 'META|roleSuper|' || r.rolsuper::text
  from pg_catalog.pg_roles r
 where r.rolname = current_user;
select 'META|roleBypassRls|' || r.rolbypassrls::text
  from pg_catalog.pg_roles r
 where r.rolname = current_user;
select 'META|roleReadAllStatsUsage|' ||
       (r.rolsuper or pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'usage'))::text
  from pg_catalog.pg_roles r
 where r.rolname = current_user;

select 'MIGRATION|' || filename || '|' || checksum
  from public.schema_migrations
 order by filename;

select (to_regclass('community_content.media_assets') is not null)::text as media_exists \gset
select 'META|communityMediaExists|' || :'media_exists';
\if :media_exists
  select 'META|communityMediaRows|' || count(*)::text
    from community_content.media_assets;
  select 'META|communityMediaBytes|' || pg_catalog.pg_total_relation_size('community_content.media_assets'::regclass)::text;
\else
  select 'META|communityMediaRows|0';
  select 'META|communityMediaBytes|0';
\endif

select (to_regclass('profile.privacy_commands') is not null)::text as privacy_exists \gset
select 'META|privacyCommandsExists|' || :'privacy_exists';
\if :privacy_exists
  select 'META|privacyMissingPayloads|' || count(*)::text
    from profile.privacy_commands
   where not (result_payload ? 'visibilityMode')
      or not (result_payload ? 'sections');
\else
  select 'META|privacyMissingPayloads|0';
\endif

select 'META|rlsGapCount|' || count(*)::text
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r'
   and n.nspname in ('communities', 'community_content')
   and (not c.relrowsecurity or not c.relforcerowsecurity);

with expected(migration_filename, schema_name, relation_name) as (
  values
    ('0018_communities_foundation.sql', 'communities', 'communities'),
    ('0018_communities_foundation.sql', 'communities', 'memberships'),
    ('0019_community_home_source.sql', 'integration', 'community_home_source_components'),
    ('0020_community_logo_storage.sql', 'integration', 'community_logo_sync'),
    ('0020_community_logo_storage.sql', 'integration', 'community_logo_object_gc'),
    ('0054_community_membership_pin_commands.sql', 'communities', 'membership_pin_commands'),
    ('0055_community_create_commands.sql', 'communities', 'create_commands'),
    ('0057_community_membership_lifecycle.sql', 'communities', 'join_requests'),
    ('0057_community_membership_lifecycle.sql', 'communities', 'membership_lifecycle_commands'),
    ('0058_community_direct_invites.sql', 'communities', 'direct_invites'),
    ('0058_community_direct_invites.sql', 'communities', 'direct_invite_commands'),
    ('0059_community_direct_invite_quotas.sql', 'communities', 'direct_invite_quota_grants'),
    ('0059_community_direct_invite_quotas.sql', 'communities', 'direct_invite_quota_grant_commands'),
    ('0062_community_ownership_transfers.sql', 'communities', 'ownership_transfer_commands'),
    ('0063_community_content_foundation.sql', 'community_content', 'posts'),
    ('0063_community_content_foundation.sql', 'community_content', 'post_revisions'),
    ('0063_community_content_foundation.sql', 'community_content', 'comments'),
    ('0063_community_content_foundation.sql', 'community_content', 'comment_revisions'),
    ('0063_community_content_foundation.sql', 'community_content', 'post_reactions'),
    ('0063_community_content_foundation.sql', 'community_content', 'comment_reactions'),
    ('0063_community_content_foundation.sql', 'community_content', 'commands'),
    ('0064_community_durable_events.sql', 'community_content', 'event_heads'),
    ('0064_community_durable_events.sql', 'community_content', 'events'),
    ('0065_community_content_moderation.sql', 'community_content', 'moderation_commands'),
    ('0065_community_content_moderation.sql', 'community_content', 'moderation_actions'),
    ('0066_community_member_count_projection.sql', 'communities', 'member_count_projections'),
    ('0066_community_member_count_projection.sql', 'communities', 'member_count_contributions'),
    ('0067_community_media_lifecycle.sql', 'community_content', 'media_assets'),
    ('0067_community_media_lifecycle.sql', 'community_content', 'media_variants'),
    ('0067_community_media_lifecycle.sql', 'community_content', 'post_revision_media'),
    ('0067_community_media_lifecycle.sql', 'community_content', 'media_commands'),
    ('0067_community_media_lifecycle.sql', 'community_content', 'media_gc_jobs'),
    ('0076_community_create_quota_grants.sql', 'communities', 'create_quota_grants'),
    ('0076_community_create_quota_grants.sql', 'communities', 'create_quota_grant_commands'),
    ('0077_community_media_operational_recovery.sql', 'community_content', 'media_operations_commands'),
    ('0079_profile_photo_client_assisted_source.sql', 'integration', 'profile_photo_client_commands'),
    ('0079_profile_photo_client_assisted_source.sql', 'integration', 'profile_photo_observation_watermarks'),
    ('0080_community_logo_stable_delivery.sql', 'integration', 'community_logo_observation_watermarks')
)
select 'RLS|' || e.schema_name || '.' || e.relation_name || '|' ||
       (c.oid is not null)::text || '|' ||
       coalesce(c.relrowsecurity, false)::text || '|' ||
       coalesce(c.relforcerowsecurity, false)::text
  from expected e
  join public.schema_migrations m on m.filename = e.migration_filename
  left join pg_catalog.pg_namespace n on n.nspname = e.schema_name
  left join pg_catalog.pg_class c
    on c.relnamespace = n.oid
   and c.relname = e.relation_name
   and c.relkind = 'r'
 order by e.schema_name, e.relation_name;

select 'META|invalidIndexCount|' || count(*)::text
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indexrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname in ('communities', 'community_content')
   and (not i.indisvalid or not i.indisready);

select 'META|quotaIndexCount|' || count(*)::text
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_index i on i.indexrelid = c.oid
 where n.nspname = 'community_content'
   and c.relname in (
     'community_media_actor_outstanding_quota_idx',
     'community_media_actor_daily_bytes_quota_idx',
     'community_media_actor_pipeline_quota_idx',
     'community_media_tenant_pipeline_quota_idx'
   )
   and i.indisvalid
   and i.indisready;

select 'INDEX|' || c.relname || '|' || tn.nspname || '|' || t.relname || '|' ||
       i.indisvalid::text || '|' || i.indisready::text || '|' ||
       coalesce((
         select string_agg(pg_catalog.pg_get_indexdef(i.indexrelid, position, true), ',' order by position)
           from generate_series(1, i.indnkeyatts) position
       ), '') || '|' ||
       coalesce((
         select string_agg(pg_catalog.pg_get_indexdef(i.indexrelid, position, true), ',' order by position)
           from generate_series(i.indnkeyatts + 1, i.indnatts) position
       ), '') || '|' ||
       coalesce(pg_catalog.pg_get_expr(i.indpred, i.indrelid, true), '')
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_index i on i.indexrelid = c.oid
  join pg_catalog.pg_class t on t.oid = i.indrelid
  join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
 where n.nspname = 'community_content'
   and c.relname in (
     'community_media_actor_outstanding_quota_idx',
     'community_media_actor_daily_bytes_quota_idx',
     'community_media_actor_pipeline_quota_idx',
     'community_media_tenant_pipeline_quota_idx'
   )
 order by c.relname;

select 'META|longTransactionCount|' || count(*)::text
  from pg_catalog.pg_stat_activity
 where datname = current_database()
   and pid <> pg_backend_pid()
   and xact_start < clock_timestamp() - interval '5 minutes';

select 'META|waitingLockCount|' || count(*)::text
  from pg_catalog.pg_locks
 where database = (select oid from pg_catalog.pg_database where datname = current_database())
   and not granted;

commit;
SQL
