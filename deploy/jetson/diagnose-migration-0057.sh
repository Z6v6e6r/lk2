#!/bin/sh

set -eu

expected_checksum="${1:-}"
case "$expected_checksum" in
  *[!0-9a-f]*|'')
    echo 'Expected migration checksum must be 64 lowercase hexadecimal characters.' >&2
    exit 1
    ;;
esac
if [ "${#expected_checksum}" -ne 64 ]; then
  echo 'Expected migration checksum must be 64 lowercase hexadecimal characters.' >&2
  exit 1
fi

cd /opt/phub

docker compose --env-file infrastructure.env -f compose.infrastructure.yaml \
  exec -T postgres sh -ec '
    exec env PGOPTIONS="-c default_transaction_read_only=on" \
      psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -v ON_ERROR_STOP=1 \
        -v expected_checksum="$1"
  ' sh "$expected_checksum" <<'SQL'
\pset format unaligned
\pset tuples_only on

begin transaction read only;

select 'expected_0057_checksum|' || :'expected_checksum';

select concat(
  'migration|',
  filename,
  '|checksum=', checksum,
  '|expected_0057_checksum=', (checksum = :'expected_checksum')::text
)
from public.schema_migrations
where filename in (
  '0043_messaging_runtime.sql',
  '0043_community_member_rank.sql',
  '0057_messaging_runtime.sql'
)
   or checksum = :'expected_checksum'
order by filename;

select concat(
  'migration_0057_status|',
  case
    when not exists (
      select 1
      from public.schema_migrations
      where filename = '0057_messaging_runtime.sql'
    ) then 'missing'
    when exists (
      select 1
      from public.schema_migrations
      where filename = '0057_messaging_runtime.sql'
        and checksum = :'expected_checksum'
    ) then 'matching'
    else 'checksum_mismatch'
  end
);

with expected(schema_name, relation_name) as (
  values
    ('messaging', 'tenant_runtime_settings'),
    ('messaging', 'direct_conversation_commands'),
    ('messaging', 'read_cursor_commands')
)
select concat(
  'relation|',
  expected.schema_name, '.', expected.relation_name,
  '|kind=', coalesce(relation.relkind::text, 'missing'),
  '|rls=', coalesce(relation.relrowsecurity::text, 'missing'),
  '|force_rls=', coalesce(relation.relforcerowsecurity::text, 'missing')
)
from expected
left join pg_catalog.pg_namespace namespace
  on namespace.nspname = expected.schema_name
left join pg_catalog.pg_class relation
  on relation.relnamespace = namespace.oid
 and relation.relname = expected.relation_name
order by expected.schema_name, expected.relation_name;

select concat(
  'column|',
  columns.table_schema, '.', columns.table_name, '.', columns.column_name,
  '|position=', columns.ordinal_position,
  '|type=', columns.udt_schema, '.', columns.udt_name,
  '|nullable=', columns.is_nullable,
  '|default=', coalesce(columns.column_default, '<none>')
)
from information_schema.columns columns
where (columns.table_schema, columns.table_name) in (
  ('messaging', 'tenant_runtime_settings'),
  ('messaging', 'direct_conversation_commands'),
  ('messaging', 'read_cursor_commands')
)
order by columns.table_schema, columns.table_name, columns.ordinal_position;

select concat(
  'constraint|',
  namespace.nspname, '.', relation.relname, '.', constraint_record.conname,
  '|type=', constraint_record.contype,
  '|definition=', pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
)
from pg_catalog.pg_constraint constraint_record
join pg_catalog.pg_class relation
  on relation.oid = constraint_record.conrelid
join pg_catalog.pg_namespace namespace
  on namespace.oid = relation.relnamespace
where (namespace.nspname, relation.relname) in (
  ('messaging', 'tenant_runtime_settings'),
  ('messaging', 'direct_conversation_commands'),
  ('messaging', 'read_cursor_commands')
)
order by namespace.nspname, relation.relname, constraint_record.conname;

select concat(
  'index|',
  indexes.schemaname, '.', indexes.tablename, '.', indexes.indexname,
  '|definition=', indexes.indexdef
)
from pg_catalog.pg_indexes indexes
where (indexes.schemaname, indexes.tablename) in (
  ('messaging', 'tenant_runtime_settings'),
  ('messaging', 'direct_conversation_commands'),
  ('messaging', 'read_cursor_commands')
)
order by indexes.schemaname, indexes.tablename, indexes.indexname;

select concat(
  'policy|',
  policies.schemaname, '.', policies.tablename, '.', policies.policyname,
  '|permissive=', policies.permissive,
  '|roles=', array_to_string(policies.roles, ','),
  '|command=', policies.cmd,
  '|using=', coalesce(policies.qual, '<none>'),
  '|check=', coalesce(policies.with_check, '<none>')
)
from pg_catalog.pg_policies policies
where (policies.schemaname, policies.tablename) in (
  ('messaging', 'tenant_runtime_settings'),
  ('messaging', 'direct_conversation_commands'),
  ('messaging', 'read_cursor_commands')
)
order by policies.schemaname, policies.tablename, policies.policyname;

commit;
SQL
