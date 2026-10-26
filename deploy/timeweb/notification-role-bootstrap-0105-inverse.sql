-- Owner-only recovery artifact. Never applied on ledger 103/104/105 or by app rollback.
-- Controller must first prove exact saved bootstrap postimage and unchanged runtime/flags.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
set local search_path='pg_catalog';
select pg_advisory_xact_lock(7140221);
do $$
begin
 if current_user<>'phub_beta' or session_user<>current_user or current_setting('role')<>'none'
  or not (select rolsuper and rolbypassrls from pg_roles where rolname=current_user)
  or (select count(*)<>102 or encode(sha256(convert_to(replace(json_agg(json_build_array(filename,checksum) order by filename)::text,' ','')||E'\n','UTF8')),'hex')<>'b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85' from public.schema_migrations)
  or (select relowner<>'phub_migrator'::regrole from pg_class where oid='notifications.deliveries'::regclass)
  or not has_schema_privilege('phub_migrator','notifications','USAGE') or not has_schema_privilege('phub_migrator','notifications','CREATE')
  or (select count(*)<>4 or not bool_and(a.attname in ('tenant_id','id') and x.grantor='phub_beta'::regrole and x.grantee='phub_migrator'::regrole and x.privilege_type='REFERENCES' and not x.is_grantable)
   from pg_attribute a cross join lateral aclexplode(a.attacl) x where a.attrelid in ('notifications.templates'::regclass,'notifications.intents'::regclass) and a.attnum>0 and not a.attisdropped)
 then raise exception 'NOTIFICATION_BOOTSTRAP_INVERSE_PREIMAGE';end if;
end $$;
alter table notifications.deliveries owner to phub_beta;
revoke references (tenant_id,id) on table notifications.templates,notifications.intents from phub_migrator;
revoke usage,create on schema notifications from phub_migrator;
do $$
begin
 if has_schema_privilege('phub_migrator','notifications','USAGE') or has_schema_privilege('phub_migrator','notifications','CREATE')
  or (select relowner<>'phub_beta'::regrole from pg_class where oid='notifications.deliveries'::regclass)
  or exists(select 1 from pg_attribute a where a.attrelid in ('notifications.templates'::regclass,'notifications.intents'::regclass) and a.attnum>0 and not a.attisdropped and has_column_privilege('phub_migrator',a.attrelid,a.attnum,'REFERENCES'))
 then raise exception 'NOTIFICATION_BOOTSTRAP_INVERSE_POSTIMAGE';end if;
end $$;
commit;
