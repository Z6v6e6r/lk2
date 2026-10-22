-- Metadata-only, used solely by the closed notification backup profile in read-only transactions.
with namespaces as (
 select oid,nspname,nspowner,nspacl from pg_catalog.pg_namespace
 where left(nspname,3)<>'pg_' and nspname<>'information_schema'
), objects as (
 select 'database'::text as key,'database'::text as kind,d.datdba as owner,
  coalesce(d.datacl,pg_catalog.acldefault('d',d.datdba)) as acl,'{}'::jsonb as props
 from pg_catalog.pg_database d where d.datname=current_database()
 union all
 select 'schema:'||nspname,'schema',nspowner,coalesce(nspacl,pg_catalog.acldefault('n',nspowner)),'{}'::jsonb from namespaces
 union all
 select 'relation:'||n.nspname||'.'||c.relname,'relation',c.relowner,
  coalesce(c.relacl,pg_catalog.acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner)),
  jsonb_build_object('kind',c.relkind,'rls',c.relrowsecurity,'force',c.relforcerowsecurity)
 from pg_catalog.pg_class c join namespaces n on n.oid=c.relnamespace where c.relkind in ('r','p','v','m','S','f')
 union all
 select 'column:'||n.nspname||'.'||c.relname||'.'||a.attname,'column',c.relowner,a.attacl,'{}'::jsonb
 from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid join namespaces n on n.oid=c.relnamespace
 where a.attnum>0 and not a.attisdropped and a.attacl is not null
 union all
 select 'function:'||n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')','function',p.proowner,
  coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner)),
  jsonb_build_object('definer',p.prosecdef,'config',p.proconfig,'leakproof',p.proleakproof)
 from pg_catalog.pg_proc p join namespaces n on n.oid=p.pronamespace
 union all
 select 'type:'||n.nspname||'.'||t.typname,'type',t.typowner,coalesce(t.typacl,pg_catalog.acldefault('T',t.typowner)),
  jsonb_build_object('kind',t.typtype)
 from pg_catalog.pg_type t join namespaces n on n.oid=t.typnamespace
 union all
 select 'default:'||pg_catalog.pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'GLOBAL')||':'||d.defaclobjtype::text,'default',d.defaclrole,d.defaclacl,
  jsonb_build_object('scope',coalesce(n.nspname,'GLOBAL'),'type',d.defaclobjtype)
 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
 where d.defaclnamespace=0 or n.oid in(select oid from namespaces)
 union all
 select 'extension:'||e.extname,'extension',e.extowner,null::aclitem[],jsonb_build_object('name',e.extname,'schema',n.nspname,'version',e.extversion)
 from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace
 union all
 select 'language:'||l.lanname,'language',l.lanowner,coalesce(l.lanacl,pg_catalog.acldefault('l',l.lanowner)),jsonb_build_object('name',l.lanname)
 from pg_catalog.pg_language l where l.lanname='plpgsql'
), normalized as (
 select o.key,o.kind,pg_catalog.pg_get_userbyid(o.owner) as owner,o.props,
  coalesce((select jsonb_agg(jsonb_build_object('grantor',pg_catalog.pg_get_userbyid(a.grantor),
   'grantee',case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,
   'privilege',a.privilege_type,'grantable',a.is_grantable)
   order by pg_catalog.pg_get_userbyid(a.grantor) collate "C",case when a.grantee=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end collate "C",a.privilege_type collate "C")
   from pg_catalog.aclexplode(o.acl) a),'[]'::jsonb) as acl
 from objects o
), policies as (
 select 'policy:'||n.nspname||'.'||c.relname||':'||p.polname as key,'policy'::text as kind,
  pg_catalog.pg_get_userbyid(c.relowner) as owner,'[]'::jsonb as acl,
  jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
   'roles',(select jsonb_agg(case when r=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(r) end order by case when r=0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(r) end collate "C") from unnest(p.polroles) r),
   'qual',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) as props
 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join namespaces n on n.oid=c.relnamespace
), snapshot as (select * from normalized union all select key,kind,owner,props,acl from policies)
select jsonb_build_object('schema','PHUB_NOTIFICATION_BACKUP_SECURITY_V1',
 'unsupported',jsonb_build_object('largeObjects',(select count(*) from pg_catalog.pg_largeobject_metadata),'securityLabels',(select count(*) from pg_catalog.pg_seclabel)+(select count(*) from pg_catalog.pg_shseclabel)),
 'objects',(select jsonb_agg(to_jsonb(s) order by key collate "C") from snapshot s),
 'roles',(select jsonb_agg(name order by name collate "C") from (
  select owner as name from normalized union select owner from policies
  union select a->>'grantor' from normalized cross join lateral jsonb_array_elements(acl) a
  union select a->>'grantee' from normalized cross join lateral jsonb_array_elements(acl) a
  union select jsonb_array_elements_text(props->'roles') from policies
 ) r where name<>'PUBLIC' and left(name,3)<>'pg_'));
