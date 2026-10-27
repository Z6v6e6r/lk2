// Additive catalog contract for the two closed application steps. The enrolled
// 0099-0101/0102 catalog stays byte-exact; only this new contract adds semantics.
import {
  NOTIFICATION_CATALOG_SQL,
  NOTIFICATION_NEW_TABLES,
} from './notification-migration-catalog.js';

export const CLOSED_APPLICATION_CATALOG_VERSION = 'PHUB_CLOSED_APPLICATION_CATALOG_V1';
export const CLOSED_APPLICATION_NEW_TABLES = Object.freeze([
  'notifications.legacy_game_reminder_source_status',
  'notifications.legacy_game_reminder_sources',
  'notifications.legacy_game_reminder_recipients',
  'identity.external_subject_link_commands',
]);
export const CLOSED_APPLICATION_CATALOG_TABLES = Object.freeze([
  ...NOTIFICATION_NEW_TABLES,
  ...CLOSED_APPLICATION_NEW_TABLES,
]);
export const CLOSED_APPLICATION_EDITOR_ACL = Object.freeze(
  [
    ['notifications.scenario_commands', 'INSERT'],
    ['notifications.scenario_commands', 'SELECT'],
    ['notifications.scenario_runs', 'SELECT'],
    ['notifications.scenario_runs', 'UPDATE'],
    ['notifications.scenario_staff_tasks', 'SELECT'],
    ['notifications.scenario_versions', 'INSERT'],
    ['notifications.scenarios', 'INSERT'],
    ['notifications.scenarios', 'SELECT'],
    ['notifications.scenarios', 'UPDATE'],
  ].map((row) => Object.freeze(row)),
);

const suffix = ' order by key collate "C"';
if (!NOTIFICATION_CATALOG_SQL.endsWith(suffix))
  throw new Error('CLOSED_APPLICATION_CATALOG_BASE_SHAPE');
const base = NOTIFICATION_CATALOG_SQL.slice(0, -suffix.length);
export const CLOSED_APPLICATION_CATALOG_SQL = `with
 frozen_base as (${base}),
 target_scope as (select name,pg_catalog.to_regclass(name) as oid
   from unnest($1::text[]||array['notifications.deliveries','support.tickets','support.messages']) t(name)),
 relations as (select t.name,c.* from target_scope t join pg_catalog.pg_class c on c.oid=t.oid),
 extension as (
 select 'storage:'||r.name as key,jsonb_build_object(
   'accessMethod',coalesce(am.amname,''),'hasRules',r.relhasrules,
   'typedTable',case when r.reloftype=0 then '' else pg_catalog.format_type(r.reloftype,null) end,
   'tablespace',case when r.reltablespace=0 then 'DATABASE_DEFAULT' else ts.spcname end,
   'databaseTablespace',(select s.spcname from pg_catalog.pg_database d join pg_catalog.pg_tablespace s on s.oid=d.dattablespace where d.datname=current_database()),
   'options',(select coalesce(jsonb_agg(x order by x collate "C"),'[]'::jsonb) from unnest(r.reloptions) x),
   'parents',(select coalesce(jsonb_agg(jsonb_build_array(i.inhparent::regclass::text,i.inhseqno) order by i.inhseqno,i.inhparent::regclass::text collate "C"),'[]'::jsonb) from pg_catalog.pg_inherits i where i.inhrelid=r.oid),
   'children',(select coalesce(jsonb_agg(jsonb_build_array(i.inhrelid::regclass::text,i.inhseqno) order by i.inhrelid::regclass::text collate "C",i.inhseqno),'[]'::jsonb) from pg_catalog.pg_inherits i where i.inhparent=r.oid),
   'columnLineage',(select coalesce(jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.attislocal,a.attinhcount) order by a.attnum),'[]'::jsonb) from pg_catalog.pg_attribute a where a.attrelid=r.oid and a.attnum>0 and not a.attisdropped),
   'droppedColumns',(select coalesce(jsonb_agg(jsonb_build_array(a.attnum,a.attlen,a.attbyval,a.attalign,a.attstorage) order by a.attnum),'[]'::jsonb) from pg_catalog.pg_attribute a where a.attrelid=r.oid and a.attnum>0 and a.attisdropped)
 )::text as value from relations r
 left join pg_catalog.pg_am am on am.oid=r.relam left join pg_catalog.pg_tablespace ts on ts.oid=r.reltablespace
 union all
 select 'rewrite:'||r.name||':'||w.rulename,jsonb_build_object(
   'event',w.ev_type,'enabled',w.ev_enabled,'instead',w.is_instead,
   'definitionSha256',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_ruledef(w.oid,false),'UTF8')),'hex')
 )::text from relations r join pg_catalog.pg_rewrite w on w.ev_class=r.oid
 union all
 select 'index_storage:'||r.name||':'||c.relname,jsonb_build_object(
   'accessMethod',am.amname,'persistence',c.relpersistence,
   'tablespace',case when c.reltablespace=0 then 'DATABASE_DEFAULT' else ts.spcname end,
   'options',(select coalesce(jsonb_agg(x order by x collate "C"),'[]'::jsonb) from unnest(c.reloptions) x)
 )::text from relations r join pg_catalog.pg_index i on i.indrelid=r.oid
 join pg_catalog.pg_class c on c.oid=i.indexrelid join pg_catalog.pg_am am on am.oid=c.relam
 left join pg_catalog.pg_tablespace ts on ts.oid=c.reltablespace
 ) select key,value from (select key,value from frozen_base union all select key,value from extension) catalog order by key collate "C"`;
