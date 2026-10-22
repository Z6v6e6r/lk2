-- Fixed nested phase of the migration controller, after verified backup and durable ownership.
-- No standalone entry point, role membership, credentials, runtime grant or provider activation.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
set local search_path='pg_catalog';
select pg_catalog.pg_advisory_xact_lock(7140221);
do $$
declare ledger_hash text; ledger_count integer; valid_ledger boolean;
begin
 if current_user<>'phub_beta' or session_user<>current_user or current_setting('role')<>'none'
   or not (select rolsuper and rolbypassrls from pg_roles where rolname=current_user)
 then raise exception 'NOTIFICATION_BOOTSTRAP_ADMIN'; end if;
 select count(*),bool_and(filename ~ '^[0-9]{4}_[a-z0-9_]+\.sql$' and checksum ~ '^[a-f0-9]{64}$'),
   encode(sha256(convert_to(replace(coalesce(json_agg(json_build_array(filename,checksum) order by filename),'[]'::json)::text,' ','')||E'\n','UTF8')),'hex')
 into ledger_count,valid_ledger,ledger_hash from public.schema_migrations;
 if ledger_count<>102 or valid_ledger is distinct from true or ledger_hash<>'b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85'
 then raise exception 'NOTIFICATION_BOOTSTRAP_LEDGER'; end if;
 if (select count(*)<>2 or not bool_and(rolinherit and not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication))
      from pg_roles where rolname in ('phub_migrator','phub_runtime'))
   or exists(select 1 from pg_auth_members where member in ('phub_migrator'::regrole,'phub_runtime'::regrole) or roleid in ('phub_migrator'::regrole,'phub_runtime'::regrole))
 then raise exception 'NOTIFICATION_BOOTSTRAP_ROLE'; end if;
 if not has_function_privilege('phub_migrator','pg_catalog.pg_control_system()','EXECUTE')
   or not has_function_privilege('phub_runtime','pg_catalog.pg_control_system()','EXECUTE')
   or exists(select 1 from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
     where d.defaclrole='phub_migrator'::regrole and d.defaclobjtype='f'
     and (d.defaclnamespace=0 or n.nspname in ('notifications','support')))
 then raise exception 'NOTIFICATION_BOOTSTRAP_FUNCTION_PREIMAGE'; end if;
 if has_schema_privilege('phub_migrator','notifications','USAGE') or has_schema_privilege('phub_migrator','notifications','CREATE')
   or (select pg_get_userbyid(relowner)<>'phub_beta' from pg_class where oid='notifications.deliveries'::regclass)
   or (select pg_get_userbyid(nspowner)<>'phub_beta' from pg_namespace where nspname='notifications')
 then raise exception 'NOTIFICATION_BOOTSTRAP_OWNER_PREIMAGE'; end if;
 if exists(select 1 from pg_attribute where attrelid in ('notifications.templates'::regclass,'notifications.intents'::regclass)
      and attnum>0 and not attisdropped and has_column_privilege('phub_migrator',attrelid,attnum,'REFERENCES'))
   or exists(select 1 from pg_attribute where attrelid='notifications.deliveries'::regclass and attnum>0 and attacl is not null)
 then raise exception 'NOTIFICATION_BOOTSTRAP_REFERENCE_PREIMAGE'; end if;
 if (select count(*)<>11 or count(*) filter(where a.grantee='phub_runtime'::regrole)<>4
      or bool_or(a.is_grantable or a.grantor<>'phub_beta'::regrole or a.grantee not in ('phub_beta'::regrole,'phub_runtime'::regrole)
       or (a.grantee='phub_runtime'::regrole and a.privilege_type not in ('SELECT','INSERT','UPDATE','DELETE')))
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid='notifications.deliveries'::regclass)
 then raise exception 'NOTIFICATION_BOOTSTRAP_ACL_PREIMAGE'; end if;
end $$;
grant usage,create on schema notifications to phub_migrator;
grant references (tenant_id,id) on table notifications.templates,notifications.intents to phub_migrator;
alter table notifications.deliveries owner to phub_migrator;
do $$
begin
 if not has_schema_privilege('phub_migrator','notifications','USAGE') or not has_schema_privilege('phub_migrator','notifications','CREATE')
  or (select pg_get_userbyid(relowner)<>'phub_migrator' from pg_class where oid='notifications.deliveries'::regclass)
  or (select count(*)<>4 or not bool_and(x.grantor='phub_beta'::regrole and x.grantee='phub_migrator'::regrole
     and x.privilege_type='REFERENCES' and not x.is_grantable and a.attname in ('tenant_id','id'))
    from pg_attribute a cross join lateral aclexplode(a.attacl) x where a.attrelid in
     ('notifications.templates'::regclass,'notifications.intents'::regclass) and a.attnum>0 and not a.attisdropped)
  or exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) x where c.oid in
     ('notifications.templates'::regclass,'notifications.intents'::regclass) and x.grantee='phub_migrator'::regrole)
  or (select count(*)<>11 or count(*) filter(where a.grantee='phub_runtime'::regrole)<>4
      or bool_or(a.is_grantable or a.grantor<>'phub_migrator'::regrole or a.grantee not in ('phub_migrator'::regrole,'phub_runtime'::regrole)
       or (a.grantee='phub_runtime'::regrole and a.privilege_type not in ('SELECT','INSERT','UPDATE','DELETE')))
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where c.oid='notifications.deliveries'::regclass)
 then raise exception 'NOTIFICATION_BOOTSTRAP_POSTIMAGE'; end if;
end $$;
commit;
