-- Catalog-only diagnostic. Run through an already authorized read connection; emits no business rows.
-- This is not an apply script or an activation/backup proof.
begin transaction isolation level repeatable read read only;
set local statement_timeout = '15s';
set local lock_timeout = '2s';
with
roles as (select 'phub_migrator'::regrole::oid as migrator, 'phub_runtime'::regrole::oid as runtime),
schemas as (select oid,nspname from pg_catalog.pg_namespace where nspname in ('identity','notifications','support')),
defaults as (
  select coalesce(n.nspname,'GLOBAL') as scope,d.defaclobjtype::text as object_type,d.defaclacl as acl
  from pg_catalog.pg_default_acl d cross join roles r
  left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
  where d.defaclrole=r.migrator and d.defaclobjtype in ('r','f')
    and (d.defaclnamespace=0 or n.nspname in ('identity','notifications','support'))
  union all
  select 'GLOBAL',t.kind::text,pg_catalog.acldefault(t.kind,r.migrator)
  from roles r cross join (values ('r'::"char"),('f'::"char")) t(kind)
  where not exists(select 1 from pg_catalog.pg_default_acl d
    where d.defaclrole=r.migrator and d.defaclnamespace=0 and d.defaclobjtype=t.kind)
),
parents(name,columns) as (values
 ('identity.local_email_credentials',array['tenant_id','id','user_id']),
 ('identity.tenants',array['id']), ('identity.users',array['tenant_id','id']),
 ('notifications.templates',array['tenant_id','id']), ('notifications.intents',array['tenant_id','id']),
 ('support.tickets',array['tenant_id','id'])
),
checks(name,ok) as (
  select 'migratorRestricted',not (p.rolsuper or p.rolcreaterole or p.rolcreatedb or p.rolreplication or p.rolbypassrls)
    and not exists(select 1 from pg_catalog.pg_roles other where other.oid<>p.oid
      and pg_catalog.pg_has_role(p.oid,other.oid,'MEMBER')
      and (other.rolsuper or other.rolcreaterole or other.rolcreatedb or other.rolreplication or other.rolbypassrls or left(other.rolname,3)='pg_'))
    from pg_catalog.pg_roles p cross join roles r where p.oid=r.migrator
  union all select 'runtimeCannotAssumeMigrator',not pg_catalog.pg_has_role(r.runtime,r.migrator,'MEMBER') from roles r
  union all select s.nspname||'Schema',pg_catalog.has_schema_privilege(r.migrator,s.oid,'CREATE')
    and pg_catalog.has_schema_privilege(r.migrator,s.oid,'USAGE') from schemas s cross join roles r
  union all select 'plpgsqlUsage',pg_catalog.has_language_privilege(r.migrator,'plpgsql','USAGE') from roles r
  union all select 'uuidExecute',pg_catalog.has_function_privilege(r.migrator,'pg_catalog.gen_random_uuid()','EXECUTE') from roles r
  union all select 'ledgerSelectInsert',pg_catalog.has_table_privilege(r.migrator,'public.schema_migrations','SELECT')
    and pg_catalog.has_table_privilege(r.migrator,'public.schema_migrations','INSERT') from roles r
  union all select case p.name when 'identity.local_email_credentials' then 'credentialsReferences'
    when 'identity.tenants' then 'tenantsReferences' when 'identity.users' then 'usersReferences'
    when 'notifications.templates' then 'templatesReferences' when 'notifications.intents' then 'intentsReferences'
    when 'support.tickets' then 'ticketsReferences' end,
    (select bool_and(pg_catalog.has_column_privilege(r.migrator,p.name,column_name,'REFERENCES')) from unnest(p.columns) column_name)
    from parents p cross join roles r
  union all select 'newObjectsAbsent',
    not exists(select 1 from unnest(array[
      'identity.local_password_reset_proofs','identity.local_password_reset_receipts',
      'notifications.scenarios','notifications.scenario_versions','notifications.scenario_commands',
      'notifications.scenario_contexts','notifications.scenario_runs','notifications.scenario_source_sync',
      'notifications.scenario_source_keys','notifications.scenario_staff_tasks']) n where pg_catalog.to_regclass(n) is not null)
    and not exists(select 1 from pg_catalog.pg_attribute a where a.attnum>0 and not a.attisdropped and
      ((a.attrelid='notifications.deliveries'::regclass and a.attname in ('scenario_available_at','scenario_dispatch_started_at','scenario_v2_available_at'))
       or (a.attrelid='support.tickets'::regclass and a.attname='internal_only')))
    and not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where (n.nspname,p.proname) in (('notifications','scenario_version_immutable'),('notifications','guard_extended_scenario'),('support','guard_internal_task')))
    and not exists(select 1 from pg_catalog.pg_policy where polrelid='support.tickets'::regclass and polname='support_internal_ticket_access')
    and not exists(select 1 from pg_catalog.pg_trigger where not tgisinternal
      and tgname in ('support_internal_visibility_guard','support_internal_message_guard','scenario_staff_ticket_guard','extended_scenario_writer_guard','scenario_versions_immutable'))
    and pg_catalog.to_regclass('notifications.notification_scenario_delivery_due_idx') is null
    and pg_catalog.to_regclass('notifications.notification_scenario_v2_due_idx') is null
)
select jsonb_build_object(
 'schema','PHUB_NOTIFICATION_MIGRATION_DIAGNOSTIC_V1',
 'capturedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'databaseName',current_database(),
 'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()),
 'postgresMajor',current_setting('server_version_num')::integer/10000,
 'readOnly',current_setting('transaction_read_only'), 'migrator','phub_migrator','runtime','phub_runtime',
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum) order by filename),'[]') from public.schema_migrations),
 'checks',(select jsonb_agg(jsonb_build_object('name',name,'ok',coalesce(ok,false)) order by name) from checks),
 'defaultAcls',(select coalesce(jsonb_agg(jsonb_build_object('scope',d.scope,'objectType',d.object_type,
   'grantee',case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,
   'privilege',a.privilege_type,'grantable',a.is_grantable) order by d.scope,d.object_type,a.grantee,a.privilege_type),'[]')
   from defaults d cross join lateral pg_catalog.aclexplode(d.acl) a),
 'relations',(select jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'owner',pg_catalog.pg_get_userbyid(c.relowner),
   'canAlter',pg_catalog.pg_has_role(r.migrator,c.relowner,'USAGE')) order by c.oid::regclass::text)
   from pg_catalog.pg_class c cross join roles r where c.oid in ('notifications.deliveries'::regclass,'support.tickets'::regclass,'support.messages'::regclass)),
 'parentDefinitions',(select jsonb_agg(jsonb_build_object('name',p.name,'definition',
   (select jsonb_build_object('owner',pg_catalog.pg_get_userbyid(c.relowner),'keys',
      (select jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_catalog.pg_get_constraintdef(k.oid),'validated',k.convalidated) order by k.conname)
       from pg_catalog.pg_constraint k where k.conrelid=c.oid and k.contype in ('p','u')))::text
    from pg_catalog.pg_class c where c.oid=p.name::regclass)) order by p.name) from parents p)
)::text;
rollback;
