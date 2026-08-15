#!/bin/sh

set -eu

fail() {
  printf '%s\n' "Media migration verification refused: $*" >&2
  exit 1
}

if test "$#" -lt 1 || test "$#" -gt 2; then
  fail 'usage: verify-media-migration-ledger.sh <migration-manifest-base64> [database]'
fi

manifest_base64="$1"
database="${2:-}"
legacy_alias_filename=0043_messaging_runtime.sql
legacy_alias_checksum=32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465
if ! manifest="$(printf '%s' "$manifest_base64" | base64 -d 2>/dev/null)"; then
  fail 'candidate migration manifest is not valid base64'
fi
if ! printf '%s\n' "$manifest" | awk -F '|' '
  NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/ { invalid = 1 }
  seen[$2]++
  END {
    if (NR == 0 || invalid) exit 1
    for (filename in seen) if (seen[filename] != 1) exit 1
  }
'; then
  fail 'candidate migration manifest is malformed or contains duplicate filenames'
fi

app_root="${PHUB_APP_ROOT:-/opt/phub}"
cd "$app_root"

infrastructure() {
  docker compose --env-file infrastructure.env -f compose.infrastructure.yaml "$@"
}

if test -z "$database"; then
  database="$(infrastructure exec -T postgres sh -ec 'printf %s "$POSTGRES_DB"')"
fi
case "$database" in
  *[!A-Za-z0-9_]*|'') fail 'database name is malformed' ;;
esac

sql() {
  infrastructure exec -T postgres sh -ec '
    exec env PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000" \
      psql -X -qAt -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -c "$2"
  ' sh "$database" "$1"
}

server_version="$(sql 'show server_version_num')"
case "$server_version" in 16????) ;; *) fail "restore rehearsal requires PostgreSQL 16 (observed=$server_version)" ;; esac

ledger="$(sql "begin transaction read only;
  select filename || '|' || checksum from public.schema_migrations order by filename;
  commit;")"
ledger="$(printf '%s\n' "$ledger" | awk -F '|' 'NF == 2 { print }')"
if ! printf '%s\n' "$ledger" | awk -F '|' '
  NF != 2 || $1 !~ /^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/ || $2 !~ /^[0-9a-f]{64}$/ { exit 1 }
'; then
  fail 'migration ledger is malformed'
fi

manifest_count="$(printf '%s\n' "$manifest" | awk 'NF { count += 1 } END { print count + 0 }')"
ledger_count="$(printf '%s\n' "$ledger" | awk 'NF { count += 1 } END { print count + 0 }')"
legacy_alias_count=0

while IFS='|' read -r filename checksum; do
  test -n "$filename" || continue
  expected_checksum="$(printf '%s\n' "$manifest" |
    awk -F '|' -v filename="$filename" '$2 == filename { print $1 }')"
  if test -z "$expected_checksum"; then
    if test "$filename" = "$legacy_alias_filename" && test "$checksum" = "$legacy_alias_checksum"; then
      legacy_alias_count=$((legacy_alias_count + 1))
      continue
    fi
    fail "ledger contains an unknown migration: $filename"
  fi
  test "$checksum" = "$expected_checksum" || fail "migration checksum mismatch: $filename"
done <<EOF
$ledger
EOF
test "$legacy_alias_count" -le 1 || fail 'migration ledger contains duplicate legacy aliases'
expected_ledger_count=$((manifest_count + legacy_alias_count))
test "$ledger_count" -eq "$expected_ledger_count" ||
  fail "migration ledger count differs from candidate manifest and reviewed aliases (ledger=$ledger_count candidate=$manifest_count aliases=$legacy_alias_count)"

while IFS='|' read -r checksum filename; do
  observed_checksum="$(printf '%s\n' "$ledger" |
    awk -F '|' -v filename="$filename" '$1 == filename { print $2 }')"
  test "$observed_checksum" = "$checksum" || fail "candidate migration is absent or mismatched: $filename"
done <<EOF
$manifest
EOF

media_invariants="$(sql "begin transaction read only;
  select
    (select count(*) from integration.community_logo_sync
      where (delivery_url is null) <> (delivery_expires_at is null))::text || '|' ||
    (select count(*) from pg_constraint
      where conname = 'community_logo_sync_delivery_pair_chk'
        and conrelid = 'integration.community_logo_sync'::regclass
        and contype = 'c'
        and convalidated
        and translate(lower(pg_get_expr(conbin, conrelid)), E' \n\t()', '') =
          'delivery_urlisnull=delivery_expires_atisnull')::text || '|' ||
    (select count(*) from pg_class
      where oid in (
        'integration.profile_photo_client_commands'::regclass,
        'integration.profile_photo_observation_watermarks'::regclass,
        'integration.community_logo_observation_watermarks'::regclass
      ) and relrowsecurity and relforcerowsecurity)::text || '|' ||
    (select count(*) from pg_attribute
      where attrelid = 'integration.user_profile_photo_sync'::regclass
        and attname = 'source_url' and not attnotnull)::text || '|' ||
    (select count(*)
      from pg_policy policy
      join pg_class relation on relation.oid = policy.polrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where (namespace.nspname, relation.relname, policy.polname) in (
        ('integration', 'profile_photo_client_commands', 'profile_photo_client_commands_tenant_isolation'),
        ('integration', 'profile_photo_observation_watermarks', 'profile_photo_observation_watermarks_tenant_isolation'),
        ('integration', 'community_logo_observation_watermarks', 'community_logo_observation_watermarks_tenant_isolation')
      )
        and policy.polpermissive
        and policy.polcmd = '*'
        and policy.polroles = array[0]::oid[]
        and translate(lower(pg_get_expr(policy.polqual, policy.polrelid)), E' \n\t()', '') =
          'tenant_id=nullifcurrent_setting''app.tenant_id''::text,true,''''::text::uuid'
        and translate(lower(pg_get_expr(policy.polwithcheck, policy.polrelid)), E' \n\t()', '') =
          'tenant_id=nullifcurrent_setting''app.tenant_id''::text,true,''''::text::uuid')::text || '|' ||
    (select count(*)
      from pg_policy policy
      where policy.polrelid in (
        'integration.profile_photo_client_commands'::regclass,
        'integration.profile_photo_observation_watermarks'::regclass,
        'integration.community_logo_observation_watermarks'::regclass
      ))::text || '|' ||
    (select count(*)
      from pg_constraint
      where conrelid = 'integration.profile_photo_client_commands'::regclass
        and contype = 'c'
        and convalidated
        and conname in (
          'profile_photo_client_commands_kind_check',
          'profile_photo_client_commands_payload_check'
        ))::text || '|' ||
    (select count(*)
      from pg_constraint
      where conrelid = 'integration.profile_photo_client_commands'::regclass
        and contype = 'c'
        and (
          (conname = 'profile_photo_client_commands_kind_check' and
            translate(lower(pg_get_expr(conbin, conrelid)), E' \n\t()', '') =
              'command_kind::text=anyarray[''upsert''::charactervarying,''delete''::charactervarying]::text[]') or
          (conname = 'profile_photo_client_commands_payload_check' and
            translate(lower(pg_get_expr(conbin, conrelid)), E' \n\t()', '') =
              'command_kind::text=''upsert''::textandrequest_sha256isnotnullandcontent_sha256isnotnullandobject_keyisnotnullorcommand_kind::text=''delete''::textandrequest_sha256isnullandcontent_sha256isnullandobject_keyisnullandavatar_urlisnull'))::text || '|' ||
    (select count(*)
      from pg_attribute
      where attrelid = 'integration.profile_photo_client_commands'::regclass
        and not attisdropped
        and (
          (attname = 'command_kind' and attnotnull) or
          (attname in ('request_sha256', 'content_sha256', 'object_key') and not attnotnull)
        ))::text || '|' ||
    (select count(*)
      from pg_attribute attribute
      join pg_attrdef attribute_default
        on attribute_default.adrelid = attribute.attrelid
        and attribute_default.adnum = attribute.attnum
      where attribute.attrelid = 'integration.profile_photo_client_commands'::regclass
        and attribute.attname = 'command_kind'
        and translate(lower(pg_get_expr(attribute_default.adbin, attribute_default.adrelid)), E' \n\t()', '') =
          '''upsert''::charactervarying')::text;
  commit;")"
media_invariants="$(printf '%s\n' "$media_invariants" | awk -F '|' 'NF == 10 { print; exit }')"
test "$media_invariants" = '0|1|3|1|3|3|2|2|4|1' || fail "media schema, RLS, policy or command-constraint invariants failed ($media_invariants)"

printf 'media_migration_ledger database=%s postgres=%s packaged_migrations=%s reviewed_legacy_aliases=%s invalid_delivery_pairs=0 validated_constraint=1 validated_profile_command_constraints=2 exact_profile_command_constraint_definitions=2 profile_command_column_state=4 profile_command_default=1 forced_rls_tables=3 exact_rls_policies=3 total_rls_policies=3 nullable_profile_source=1 status=passed\n' \
  "$database" "$server_version" "$manifest_count" "$legacy_alias_count"
