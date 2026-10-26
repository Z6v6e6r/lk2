\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
set local search_path = 'pg_catalog';
select pg_catalog.pg_advisory_xact_lock(7140221);
do $guard$
declare
  ledger_count integer;
  ledger_valid boolean;
  ledger_hash text;
begin
  if current_user <> 'phub_beta'
     or session_user <> current_user
     or current_setting('role') <> 'none'
     or not (
       select rolsuper and rolbypassrls and rolcanlogin
         from pg_catalog.pg_roles
        where rolname = current_user
     )
  then
    raise exception 'LOCATION_PHOTO_BOOTSTRAP_ADMIN';
  end if;

  select count(*),
         bool_and(filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$' and checksum ~ '^[a-f0-9]{64}$'),
         pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               pg_catalog.replace(
                 coalesce(
                   pg_catalog.json_agg(
                     pg_catalog.json_build_array(filename, checksum) order by filename
                   ),
                   '[]'::json
                 )::text,
                 ' ',
                 ''
               ) || E'\n',
               'UTF8'
             )
           ),
           'hex'
         )
    into ledger_count, ledger_valid, ledger_hash
    from public.schema_migrations;
  if ledger_count <> 105
     or ledger_valid is distinct from true
     or ledger_hash <> '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd'
     or to_regclass('locations.recommendation_card_photos') is not null
  then
    raise exception 'LOCATION_PHOTO_BOOTSTRAP_LEDGER';
  end if;

  if (
       select count(*) <> 2
          or not bool_and(
            rolcanlogin
            and not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)
          )
         from pg_catalog.pg_roles
        where rolname in ('phub_migrator', 'phub_runtime')
     )
     or exists (
       select 1
         from pg_catalog.pg_auth_members
        where member in ('phub_migrator'::regrole, 'phub_runtime'::regrole)
           or roleid in ('phub_migrator'::regrole, 'phub_runtime'::regrole)
     )
     or has_schema_privilege('phub_migrator', 'locations', 'USAGE') is distinct from true
     or has_schema_privilege('phub_migrator', 'locations', 'CREATE') is distinct from false
     or has_schema_privilege('phub_migrator', 'public', 'USAGE') is distinct from true
     or has_schema_privilege('phub_migrator', 'public', 'CREATE') is distinct from false
  then
    raise exception 'LOCATION_PHOTO_BOOTSTRAP_ROLE';
  end if;

  if exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid in ('locations.profiles'::regclass, 'locations.media_assets'::regclass)
          and a.attnum > 0
          and not a.attisdropped
          and has_column_privilege('phub_migrator', a.attrelid, a.attnum, 'REFERENCES')
     )
     or exists (
       select 1
         from pg_catalog.pg_class c
         cross join lateral pg_catalog.aclexplode(c.relacl) x
        where c.oid in ('locations.profiles'::regclass, 'locations.media_assets'::regclass)
          and x.grantee = 'phub_migrator'::regrole
     )
  then
    raise exception 'LOCATION_PHOTO_BOOTSTRAP_REFERENCE_PREIMAGE';
  end if;
end
$guard$;

grant create on schema locations, public to phub_migrator;
grant references (tenant_id, id) on locations.profiles to phub_migrator;
grant references (tenant_id, id) on locations.media_assets to phub_migrator;

do $guard$
begin
  if has_schema_privilege('phub_migrator', 'locations', 'CREATE') is distinct from true
     or has_schema_privilege('phub_migrator', 'public', 'CREATE') is distinct from true
     or (
       select count(*) <> 4
          or not bool_and(
            a.attname in ('tenant_id', 'id')
            and x.grantor = 'phub_beta'::regrole
            and x.grantee = 'phub_migrator'::regrole
            and x.privilege_type = 'REFERENCES'
            and not x.is_grantable
          )
         from pg_catalog.pg_attribute a
         cross join lateral pg_catalog.aclexplode(a.attacl) x
        where a.attrelid in ('locations.profiles'::regclass, 'locations.media_assets'::regclass)
          and a.attnum > 0
          and not a.attisdropped
     )
     or exists (
       select 1
         from pg_catalog.pg_class c
         cross join lateral pg_catalog.aclexplode(c.relacl) x
        where c.oid in ('locations.profiles'::regclass, 'locations.media_assets'::regclass)
          and x.grantee = 'phub_migrator'::regrole
     )
     or exists (
       select 1
         from pg_catalog.pg_attribute a
        where a.attrelid in ('locations.profiles'::regclass, 'locations.media_assets'::regclass)
          and a.attnum > 0
          and not a.attisdropped
          and a.attname not in ('tenant_id', 'id')
          and has_column_privilege('phub_migrator', a.attrelid, a.attnum, 'REFERENCES')
     )
  then
    raise exception 'LOCATION_PHOTO_BOOTSTRAP_POSTIMAGE';
  end if;
end
$guard$;
commit;
