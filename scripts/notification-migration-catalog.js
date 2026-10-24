// One catalog contract shared by the enrolled host probes and the immutable migrator image.
// No business rows, OIDs, statistics or cluster-specific role identifiers enter the digest.
export const NOTIFICATION_CATALOG_VERSION = 'PHUB_NOTIFICATION_CATALOG_BUILDER_V1';
export const NOTIFICATION_NEW_TABLES = Object.freeze([
  'identity.local_password_reset_proofs',
  'identity.local_password_reset_receipts',
  'notifications.scenarios',
  'notifications.scenario_versions',
  'notifications.scenario_commands',
  'notifications.scenario_contexts',
  'notifications.scenario_runs',
  'notifications.scenario_source_sync',
  'notifications.scenario_source_keys',
  'notifications.scenario_staff_tasks',
]);
export const NOTIFICATION_DEFAULT_ACL_SQL = `select coalesce(jsonb_agg(jsonb_build_object(
 'scope',coalesce(n.nspname,'GLOBAL'),'type',d.defaclobjtype,
 'grantor',pg_catalog.pg_get_userbyid(a.grantor),
 'grantee',case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,
 'privilege',a.privilege_type,'grantable',a.is_grantable)
 order by coalesce(n.nspname,'GLOBAL'),d.defaclobjtype,a.grantee,a.privilege_type),'[]'::jsonb) as acl
 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
 cross join lateral pg_catalog.aclexplode(d.defaclacl) a
 where d.defaclrole='phub_migrator'::regrole and d.defaclobjtype='r'
 and (d.defaclnamespace=0 or n.nspname='identity')`;

// Live preimage: no stored function defaults; PostgreSQL's built-in owner/PUBLIC EXECUTE applies.
export const NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL = `not exists(select 1
 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
 where d.defaclrole='phub_migrator'::regrole and d.defaclobjtype='f'
 and (d.defaclnamespace=0 or n.nspname in ('notifications','support')))`;
export const NOTIFICATION_REFERENCES_SAFE_SQL = `
 (select count(*)=4 and bool_and(x.grantor='phub_beta'::regrole
   and x.grantee='phub_migrator'::regrole and x.privilege_type='REFERENCES'
   and not x.is_grantable and a.attname in ('tenant_id','id'))
  from pg_catalog.pg_attribute a cross join lateral pg_catalog.aclexplode(a.attacl) x
  where a.attrelid in ('notifications.templates'::regclass,'notifications.intents'::regclass)
  and a.attnum>0 and not a.attisdropped)
 and not exists(select 1 from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(c.relacl) x
  where c.oid in ('notifications.templates'::regclass,'notifications.intents'::regclass)
  and x.grantee='phub_migrator'::regrole)`;

export const NOTIFICATION_CATALOG_SQL = `with
 targets as (select name,pg_catalog.to_regclass(name) as oid, name=any($1::text[]) as fresh
   from unnest($1::text[]||array['notifications.deliveries','support.tickets','support.messages']) t(name)),
 relations as (select t.*,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl
   from targets t join pg_catalog.pg_class c on c.oid=t.oid),
 functions as (select p.*,n.nspname,l.lanname from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid=p.pronamespace join pg_catalog.pg_language l on l.oid=p.prolang
   where (n.nspname,p.proname) in (('notifications','scenario_version_immutable'),
    ('notifications','guard_extended_scenario'),('support','guard_internal_task'))),
 snapshot as (
 select 'relation:'||r.name as key,jsonb_build_object('kind',r.relkind,
   'owner',case when pg_catalog.pg_get_userbyid(r.relowner)='phub_migrator' then 'MIGRATOR' else pg_catalog.pg_get_userbyid(r.relowner) end,
   'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'persistence',c.relpersistence,'replicaIdentity',c.relreplident,'partition',c.relispartition,'acl',
   (select jsonb_agg(jsonb_build_array(
      case when a.grantee=0 then 'PUBLIC' when a.grantee='phub_migrator'::regrole then 'MIGRATOR'
       when a.grantee='phub_runtime'::regrole then 'RUNTIME' else pg_catalog.pg_get_userbyid(a.grantee) end,
      case when a.grantor='phub_migrator'::regrole then 'MIGRATOR' else pg_catalog.pg_get_userbyid(a.grantor) end,
      a.privilege_type,a.is_grantable) order by case when a.grantee=0 then 'PUBLIC' when a.grantee='phub_migrator'::regrole then 'MIGRATOR' when a.grantee='phub_runtime'::regrole then 'RUNTIME' else pg_catalog.pg_get_userbyid(a.grantee) end,case when a.grantor='phub_migrator'::regrole then 'MIGRATOR' else pg_catalog.pg_get_userbyid(a.grantor) end,a.privilege_type)
    from pg_catalog.aclexplode(coalesce(r.relacl,pg_catalog.acldefault('r',r.relowner))) a)) as value
 from relations r join pg_catalog.pg_class c on c.oid=r.oid
 union all
 select 'column:'||r.name||':'||a.attname,jsonb_build_object('number',a.attnum,
   'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
   'default',coalesce(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''),'identity',a.attidentity,
   'generated',a.attgenerated,'collation',case when a.attcollation=0 then '' else a.attcollation::regcollation::text end,
   'acl',(select coalesce(jsonb_agg(jsonb_build_array(
     case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end,
     pg_catalog.pg_get_userbyid(x.grantor),x.privilege_type,x.is_grantable)
     order by case when x.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x.grantee) end,pg_catalog.pg_get_userbyid(x.grantor),x.privilege_type),'[]'::jsonb) from pg_catalog.aclexplode(a.attacl) x))
 from relations r join pg_catalog.pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
 left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where r.fresh or (r.name='notifications.deliveries' and a.attname in ('scenario_available_at','scenario_dispatch_started_at','scenario_v2_available_at','next_attempt_at','state'))
 or (r.name='support.tickets' and a.attname='internal_only')
 union all
 select 'constraint:'||r.name||':'||c.conname,jsonb_build_object('type',c.contype,
   'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,
   'definition',pg_catalog.pg_get_constraintdef(c.oid,false),
   'parent',case when c.confrelid=0 then '' else c.confrelid::regclass::text end,
   'columns',(select jsonb_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(num,ord)
     join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num),
   'parentColumns',(select jsonb_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(num,ord)
     join pg_catalog.pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num))
 from relations r join pg_catalog.pg_constraint c on c.conrelid=r.oid
 where r.fresh or c.conname in ('messages_check','scenario_delivery_legacy_parked','scenario_v2_legacy_parked')
 union all
 select 'index:'||r.name||':'||ic.relname,jsonb_build_object('definition',pg_catalog.pg_get_indexdef(i.indexrelid),
   'method',am.amname,'ready',i.indisready,'valid',i.indisvalid,'live',i.indislive,
   'unique',i.indisunique,'primary',i.indisprimary,'nullsNotDistinct',i.indnullsnotdistinct,
   'predicate',coalesce(pg_catalog.pg_get_expr(i.indpred,i.indrelid),''))
 from relations r join pg_catalog.pg_index i on i.indrelid=r.oid join pg_catalog.pg_class ic on ic.oid=i.indexrelid
 join pg_catalog.pg_am am on am.oid=ic.relam
 where r.fresh or ic.relname in ('notification_scenario_delivery_due_idx','notification_scenario_v2_due_idx')
 union all
 select 'policy:'||r.name||':'||p.polname,jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
   'roles',(select jsonb_agg(case when x=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x) end
     order by case when x=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(x) end) from unnest(p.polroles) x),
   'qual',coalesce(pg_catalog.pg_get_expr(p.polqual,p.polrelid),''),
   'check',coalesce(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),''))
 from relations r join pg_catalog.pg_policy p on p.polrelid=r.oid
 union all
 select 'trigger:'||r.name||':'||t.tgname,jsonb_build_object('enabled',t.tgenabled,'definition',pg_catalog.pg_get_triggerdef(t.oid,false))
 from relations r join pg_catalog.pg_trigger t on t.tgrelid=r.oid and not t.tgisinternal

 union all
 select 'function:'||f.nspname||'.'||f.proname||'('||pg_catalog.pg_get_function_identity_arguments(f.oid)||')',
   jsonb_build_object('owner',case when pg_catalog.pg_get_userbyid(f.proowner)='phub_migrator' then 'MIGRATOR' else pg_catalog.pg_get_userbyid(f.proowner) end,
    'kind',f.prokind,'leakproof',f.proleakproof,'parallel',f.proparallel,'language',f.lanname,'return',pg_catalog.pg_get_function_result(f.oid),'volatility',f.provolatile,
    'securityDefiner',f.prosecdef,'strict',f.proisstrict,'config',f.proconfig,
    'definition',pg_catalog.pg_get_functiondef(f.oid),
    'acl',(select jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC'
      when a.grantee='phub_migrator'::regrole then 'MIGRATOR' else pg_catalog.pg_get_userbyid(a.grantee) end,
      case when a.grantor='phub_migrator'::regrole then 'MIGRATOR' else pg_catalog.pg_get_userbyid(a.grantor) end,
      a.privilege_type,a.is_grantable) order by case when a.grantee=0 then 'PUBLIC' when a.grantee='phub_migrator'::regrole then 'MIGRATOR' when a.grantee='phub_runtime'::regrole then 'RUNTIME' else pg_catalog.pg_get_userbyid(a.grantee) end,case when a.grantor='phub_migrator'::regrole then 'MIGRATOR' else pg_catalog.pg_get_userbyid(a.grantor) end,a.privilege_type)
      from pg_catalog.aclexplode(coalesce(f.proacl,pg_catalog.acldefault('f',f.proowner))) a)) from functions f
 union all
 select 'parent:'||c.conrelid::regclass::text||':'||c.conname,
   jsonb_build_object('definition',pg_catalog.pg_get_constraintdef(c.oid,false),'valid',c.convalidated,
    'owner',case when pg_catalog.pg_get_userbyid(p.relowner)='phub_migrator' then 'MIGRATOR' else pg_catalog.pg_get_userbyid(p.relowner) end,
    'columns',(select jsonb_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num))
 from pg_catalog.pg_constraint c join pg_catalog.pg_class p on p.oid=c.conrelid where c.contype in ('p','u') and c.conrelid in
   ('identity.local_email_credentials'::regclass,'identity.tenants'::regclass,'identity.users'::regclass,
    'notifications.templates'::regclass,'notifications.intents'::regclass,'support.tickets'::regclass)
 ) select key,value::text as value from snapshot order by key collate "C"`;

export const NOTIFICATION_NEW_TABLE_SECURITY_SQL = `select t.name,
 pg_catalog.pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,c.relforcerowsecurity as force,
 (select count(*)::int from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
  where a.grantee<>c.relowner) as "nonOwnerGrants",
 (select count(*)::int from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and a.attacl is not null) as "columnAcls",
 exists(select 1 from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
  where pg_catalog.has_table_privilege('phub_runtime',c.oid,p)) as "runtimeAccess"
 from unnest($1::text[]) t(name) join pg_catalog.pg_class c on c.oid=pg_catalog.to_regclass(t.name) order by t.name`;
