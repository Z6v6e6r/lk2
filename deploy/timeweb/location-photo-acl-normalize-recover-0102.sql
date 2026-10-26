\set ON_ERROR_STOP on
-- Source building block only: a sealed one-attempt operation/receipt and exact runtime binding
-- are required by the runbook. Never execute by hand or retry after a lost acknowledgement.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';
set local search_path = 'pg_catalog';
do $photo_acl$
declare
  ledger_count integer;
  ledger_hash text;
  ledger_valid boolean;
  schema_snapshot jsonb;
  security_before jsonb;
  security_after jsonb;
begin
  if current_database() <> 'phub_beta' or current_user <> 'phub_beta'
     or session_user <> current_user or current_setting('role') <> 'none'
     or not exists(select 1 from pg_roles where rolname=current_user and rolsuper and rolbypassrls and rolcanlogin)
     or (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) <> current_user
  then raise exception 'LOCATION_PHOTO_ACL_IDENTITY'; end if;
  if (select system_identifier::text from pg_control_system()) <> '7679125609183186977'
  then raise exception 'LOCATION_PHOTO_ACL_SYSTEM'; end if;
  if not pg_try_advisory_xact_lock(7140221) then raise exception 'LOCATION_PHOTO_ACL_LOCK'; end if;
  select count(*), bool_and(filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$' and checksum ~ '^[a-f0-9]{64}$'), encode(sha256(convert_to(replace(coalesce(
    json_agg(json_build_array(filename,checksum) order by filename),'[]'::json)::text,' ','') || E'\n','UTF8')),'hex')
    into ledger_count,ledger_valid,ledger_hash from public.schema_migrations;
  if ledger_count <> 105 or ledger_valid is distinct from true or ledger_hash <> '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd'
     or to_regclass('locations.recommendation_card_photos') is not null
  then raise exception 'LOCATION_PHOTO_ACL_LEDGER'; end if;
  if (select count(*)<>2 or not bool_and(rolcanlogin and not(rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
      from pg_roles where rolname in ('phub_migrator','phub_runtime'))
     or exists(select 1 from pg_auth_members where roleid in ('phub_migrator'::regrole,'phub_runtime'::regrole)
                or member in ('phub_migrator'::regrole,'phub_runtime'::regrole))
  then raise exception 'LOCATION_PHOTO_ACL_ROLES'; end if;
  if exists(select 1 from pg_event_trigger where evtenabled <> 'D')
     or exists(select 1 from pg_stat_activity where datid=(select oid from pg_database where datname=current_database())
       and pid<>pg_backend_pid() and state<>'idle' and xact_start<clock_timestamp()-interval '30 seconds')
     or exists(select 1 from pg_locks where pid is distinct from pg_backend_pid()
       and relation in ('public.schema_migrations'::regclass,'locations.profiles'::regclass,'locations.media_assets'::regclass)
       and (not granted or mode in ('RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')))
  then raise exception 'LOCATION_PHOTO_ACL_HAZARD'; end if;
  select (select coalesce(jsonb_agg(s.value order by s.name collate "C"), '[]'::jsonb)
    from (select n.nspname name, jsonb_build_object('schema',n.nspname,
      'owner',pg_get_userbyid(n.nspowner),'acl',
      (select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
        'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
                 pg_get_userbyid(a.grantor) collate "C",a.privilege_type collate "C",a.is_grantable), '[]'::jsonb)
       from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a)) value
      from pg_namespace n where n.nspname in ('locations','public')) s) into schema_snapshot;
  if schema_snapshot is distinct from '[{"acl":[{"grantee":"phub_beta","grantor":"phub_beta","grantable":false,"privilege":"CREATE"},{"grantee":"phub_beta","grantor":"phub_beta","grantable":false,"privilege":"USAGE"},{"grantor":"phub_beta","grantee":"phub_migrator","privilege":"USAGE","grantable":false},{"grantee":"phub_runtime","grantor":"phub_beta","grantable":false,"privilege":"USAGE"}],"owner":"phub_beta","schema":"locations"},{"acl":[{"grantee":"PUBLIC","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"},{"grantee":"pg_database_owner","grantor":"pg_database_owner","grantable":false,"privilege":"CREATE"},{"grantee":"pg_database_owner","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"},{"grantee":"phub_migrator","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"},{"grantee":"phub_runtime","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"}],"owner":"pg_database_owner","schema":"public"}]'::jsonb
  then raise exception 'LOCATION_PHOTO_ACL_SCHEMA_PREIMAGE'; end if;
  select jsonb_build_object(
      'schemas',(select coalesce(jsonb_agg(jsonb_build_array(oid,nspname,nspowner,nspacl::text) order by oid),'[]'::jsonb) from pg_namespace where nspname not in ('locations','public')),
      'relations',(select coalesce(jsonb_agg(jsonb_build_array(oid,relowner,relacl::text,relrowsecurity,relforcerowsecurity) order by oid),'[]'::jsonb) from pg_class),
      'columns',(select coalesce(jsonb_agg(jsonb_build_array(attrelid,attnum,attacl::text) order by attrelid,attnum),'[]'::jsonb) from pg_attribute where attacl is not null),
      'defaults',(select coalesce(jsonb_agg(jsonb_build_array(oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl::text) order by oid),'[]'::jsonb) from pg_default_acl),
      'roles',(select coalesce(jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid),'[]'::jsonb) from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')),
      'members',(select coalesce(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option) order by roleid,member),'[]'::jsonb) from pg_auth_members where roleid in (select oid from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')) or member in (select oid from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')))
    ) into security_before;

  revoke usage on schema locations from phub_migrator restrict;
  grant create on schema public to phub_migrator;

  select (select coalesce(jsonb_agg(s.value order by s.name collate "C"), '[]'::jsonb)
    from (select n.nspname name, jsonb_build_object('schema',n.nspname,
      'owner',pg_get_userbyid(n.nspowner),'acl',
      (select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
        'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
                 pg_get_userbyid(a.grantor) collate "C",a.privilege_type collate "C",a.is_grantable), '[]'::jsonb)
       from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a)) value
      from pg_namespace n where n.nspname in ('locations','public')) s) into schema_snapshot;
  if schema_snapshot is distinct from '[{"acl":[{"grantee":"phub_beta","grantor":"phub_beta","grantable":false,"privilege":"CREATE"},{"grantee":"phub_beta","grantor":"phub_beta","grantable":false,"privilege":"USAGE"},{"grantee":"phub_runtime","grantor":"phub_beta","grantable":false,"privilege":"USAGE"}],"owner":"phub_beta","schema":"locations"},{"acl":[{"grantee":"PUBLIC","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"},{"grantee":"pg_database_owner","grantor":"pg_database_owner","grantable":false,"privilege":"CREATE"},{"grantee":"pg_database_owner","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"},{"grantee":"phub_migrator","grantor":"pg_database_owner","grantable":false,"privilege":"CREATE"},{"grantee":"phub_migrator","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"},{"grantee":"phub_runtime","grantor":"pg_database_owner","grantable":false,"privilege":"USAGE"}],"owner":"pg_database_owner","schema":"public"}]'::jsonb
  then raise exception 'LOCATION_PHOTO_ACL_SCHEMA_POSTIMAGE'; end if;
  select jsonb_build_object(
      'schemas',(select coalesce(jsonb_agg(jsonb_build_array(oid,nspname,nspowner,nspacl::text) order by oid),'[]'::jsonb) from pg_namespace where nspname not in ('locations','public')),
      'relations',(select coalesce(jsonb_agg(jsonb_build_array(oid,relowner,relacl::text,relrowsecurity,relforcerowsecurity) order by oid),'[]'::jsonb) from pg_class),
      'columns',(select coalesce(jsonb_agg(jsonb_build_array(attrelid,attnum,attacl::text) order by attrelid,attnum),'[]'::jsonb) from pg_attribute where attacl is not null),
      'defaults',(select coalesce(jsonb_agg(jsonb_build_array(oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl::text) order by oid),'[]'::jsonb) from pg_default_acl),
      'roles',(select coalesce(jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by oid),'[]'::jsonb) from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')),
      'members',(select coalesce(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option) order by roleid,member),'[]'::jsonb) from pg_auth_members where roleid in (select oid from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')) or member in (select oid from pg_roles where rolname in ('phub_beta','phub_migrator','phub_runtime')))
    ) into security_after;
  if security_after is distinct from security_before
  then raise exception 'LOCATION_PHOTO_ACL_UNRELATED_SECURITY_DRIFT'; end if;
end
$photo_acl$;
commit;
