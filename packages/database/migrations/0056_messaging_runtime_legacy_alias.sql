-- Reconcile the checksum-identical legacy filename used by an earlier staging release.
-- Fresh databases have no legacy journal row and continue into 0057 normally.

do $migration_alias$
declare
  expected_checksum constant text := '32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465';
  legacy_checksum text;
  current_checksum text;
  matching_relations integer;
  matching_columns integer;
  matching_constraints integer;
  matching_indexes integer;
  matching_policies integer;
begin
  select checksum
    into current_checksum
    from public.schema_migrations
   where filename = '0057_messaging_runtime.sql';

  if current_checksum is not null then
    if current_checksum <> expected_checksum then
      raise exception 'Migration 0057 checksum does not match the reviewed messaging runtime migration';
    end if;
    return;
  end if;

  select checksum
    into legacy_checksum
    from public.schema_migrations
   where filename = '0043_messaging_runtime.sql';

  if legacy_checksum is null then
    return;
  end if;
  if legacy_checksum <> expected_checksum then
    raise exception 'Legacy messaging runtime migration checksum does not match migration 0057';
  end if;

  select count(*)
    into matching_relations
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
   where (namespace.nspname, relation.relname) in (
     ('messaging', 'tenant_runtime_settings'),
     ('messaging', 'direct_conversation_commands'),
     ('messaging', 'read_cursor_commands')
   )
     and relation.relkind = 'r'
     and relation.relrowsecurity
     and relation.relforcerowsecurity;

  if matching_relations <> 3 then
    raise exception 'Legacy messaging runtime relations or RLS flags do not match migration 0057';
  end if;

  with expected(table_name, column_name) as (
    values
      ('tenant_runtime_settings', 'tenant_id'),
      ('tenant_runtime_settings', 'http_enabled'),
      ('tenant_runtime_settings', 'direct_enabled'),
      ('tenant_runtime_settings', 'realtime_enabled'),
      ('tenant_runtime_settings', 'contextual_enabled'),
      ('tenant_runtime_settings', 'updated_by'),
      ('tenant_runtime_settings', 'updated_at'),
      ('direct_conversation_commands', 'tenant_id'),
      ('direct_conversation_commands', 'actor_user_id'),
      ('direct_conversation_commands', 'idempotency_key'),
      ('direct_conversation_commands', 'other_user_id'),
      ('direct_conversation_commands', 'conversation_id'),
      ('direct_conversation_commands', 'created_at'),
      ('read_cursor_commands', 'tenant_id'),
      ('read_cursor_commands', 'user_id'),
      ('read_cursor_commands', 'conversation_id'),
      ('read_cursor_commands', 'idempotency_key'),
      ('read_cursor_commands', 'through_sequence'),
      ('read_cursor_commands', 'result_sequence'),
      ('read_cursor_commands', 'changed'),
      ('read_cursor_commands', 'created_at')
  )
  select count(*)
    into matching_columns
    from expected
    join information_schema.columns columns
      on columns.table_schema = 'messaging'
     and columns.table_name = expected.table_name
     and columns.column_name = expected.column_name;

  if matching_columns <> 21 then
    raise exception 'Legacy messaging runtime columns do not match migration 0057';
  end if;

  with expected(table_name, constraint_name) as (
    values
      ('tenant_runtime_settings', 'tenant_runtime_settings_pkey'),
      ('tenant_runtime_settings', 'tenant_runtime_settings_tenant_id_fkey'),
      ('tenant_runtime_settings', 'tenant_runtime_settings_tenant_id_updated_by_fkey'),
      ('direct_conversation_commands', 'direct_conversation_commands_check'),
      ('direct_conversation_commands', 'direct_conversation_commands_idempotency_key_check'),
      ('direct_conversation_commands', 'direct_conversation_commands_pkey'),
      ('direct_conversation_commands', 'direct_conversation_commands_tenant_id_actor_user_id_fkey'),
      ('direct_conversation_commands', 'direct_conversation_commands_tenant_id_other_user_id_fkey'),
      ('direct_conversation_commands', 'direct_conversation_commands_tenant_id_conversation_id_fkey'),
      ('read_cursor_commands', 'read_cursor_commands_idempotency_key_check'),
      ('read_cursor_commands', 'read_cursor_commands_pkey'),
      ('read_cursor_commands', 'read_cursor_commands_through_sequence_check'),
      ('read_cursor_commands', 'read_cursor_commands_result_sequence_check'),
      ('read_cursor_commands', 'read_cursor_commands_tenant_id_user_id_fkey'),
      ('read_cursor_commands', 'read_cursor_commands_tenant_id_conversation_id_fkey')
  )
  select count(*)
    into matching_constraints
    from expected
    join pg_catalog.pg_constraint constraint_record
      on constraint_record.conname = expected.constraint_name
    join pg_catalog.pg_class relation
      on relation.oid = constraint_record.conrelid
     and relation.relname = expected.table_name
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
     and namespace.nspname = 'messaging';

  if matching_constraints <> 15 then
    raise exception 'Legacy messaging runtime constraints do not match migration 0057';
  end if;

  select count(*)
    into matching_indexes
    from pg_catalog.pg_indexes indexes
   where (indexes.schemaname, indexes.tablename, indexes.indexname) in (
     ('messaging', 'direct_conversation_commands', 'direct_conversation_commands_conversation_idx'),
     ('messaging', 'read_cursor_commands', 'read_cursor_commands_conversation_idx')
   );

  if matching_indexes <> 2 then
    raise exception 'Legacy messaging runtime indexes do not match migration 0057';
  end if;

  select count(*)
    into matching_policies
    from pg_catalog.pg_policies policies
   where (policies.schemaname, policies.tablename, policies.policyname) in (
     ('messaging', 'tenant_runtime_settings', 'messaging_runtime_settings_tenant_isolation'),
     ('messaging', 'direct_conversation_commands', 'direct_conversation_commands_tenant_isolation'),
     ('messaging', 'read_cursor_commands', 'messaging_read_cursor_commands_tenant_isolation')
   )
     and policies.permissive = 'PERMISSIVE'
     and policies.cmd = 'ALL'
     and 'public'::name = any(policies.roles)
     and policies.qual is not null
     and policies.with_check is not null;

  if matching_policies <> 3 then
    raise exception 'Legacy messaging runtime policies do not match migration 0057';
  end if;

  insert into public.schema_migrations (filename, checksum)
  values ('0057_messaging_runtime.sql', expected_checksum);
end
$migration_alias$;
