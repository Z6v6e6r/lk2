-- Test stand only: application role grants after a fresh `migrator` run.
--
-- The fresh test stand applies every migration as the PostgreSQL superuser (as local
-- development and CI do), so all relations are owned by that superuser. The API, Worker and
-- Realtime connect as the non-superuser, non-owner role `phub_runtime`, which keeps
-- FORCE ROW LEVEL SECURITY and tenant policies in effect.
--
-- This is deliberately broad (DML on every application table) and idempotent: it exists so a
-- disposable test stand can run the current main. It is NOT the production least-privilege
-- plan; production keeps its reviewed per-table grant route.
--
-- Usage (as the superuser, after migrations):
--   psql "$SUPERUSER_DATABASE_URL" -v ON_ERROR_STOP=1 -v runtime_password="'...'" \
--     -f deploy/test-stand/grant-runtime.sql

\set ON_ERROR_STOP on
\if :{?runtime_password}
\else
  do $missing$ begin raise exception 'runtime_password is required (psql -v runtime_password=...)'; end $missing$;
\endif

select format('create role phub_runtime login password %L', :runtime_password)
 where not exists (select 1 from pg_roles where rolname = 'phub_runtime')
\gexec

select format('alter role phub_runtime with login nosuperuser nocreatedb nocreaterole nobypassrls password %L',
              :runtime_password)
\gexec

select format('grant connect, temporary on database %I to phub_runtime', current_database())
\gexec

do $grants$
declare
  schema_name text;
begin
  for schema_name in
    select n.nspname
      from pg_catalog.pg_namespace n
     where n.nspname !~ '^pg_'
       and n.nspname <> 'information_schema'
     order by n.nspname
  loop
    execute format('grant usage on schema %I to phub_runtime', schema_name);
    execute format('grant select, insert, update, delete on all tables in schema %I to phub_runtime', schema_name);
    execute format('grant usage, select, update on all sequences in schema %I to phub_runtime', schema_name);
    execute format('grant execute on all functions in schema %I to phub_runtime', schema_name);
    execute format('alter default privileges in schema %I grant select, insert, update, delete on tables to phub_runtime', schema_name);
    execute format('alter default privileges in schema %I grant usage, select, update on sequences to phub_runtime', schema_name);
    execute format('alter default privileges in schema %I grant execute on functions to phub_runtime', schema_name);
  end loop;
end
$grants$;

-- The migration ledger stays read-only for the application.
revoke insert, update, delete on public.schema_migrations from phub_runtime;

select count(*) as runtime_tables_without_dml
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p')
   and n.nspname !~ '^pg_'
   and n.nspname <> 'information_schema'
   and c.relname <> 'schema_migrations'
   and not has_table_privilege('phub_runtime', c.oid, 'select, insert, update, delete');
