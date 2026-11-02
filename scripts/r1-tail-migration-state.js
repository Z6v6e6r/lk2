import frozenCatalogs from '../deploy/timeweb/r1-tail108-119-catalogs.v1.json' with { type: 'json' };
import { R1_TAIL_CATALOG_SQL, R1_TAIL_TABLES } from './r1-tail-migration-catalog.js';
import { R1_TAIL_ACL_SQL, validateR1TailAcl } from './r1-tail-migration-acl.js';
import {
  R1_TAIL_TARGET,
  r1Exact,
  r1LedgerCount,
  r1Same,
  r1Stop,
  r1Encode,
  r1Hash,
  validateR1TailCatalogs,
  validateR1TailCatalog,
} from './r1-tail-migration-profile.js';
const array = `array[${R1_TAIL_TABLES.map((name) => `'${name}'`).join(',')}]::text[]`;
export const R1_TAIL_SAFE_ROLES_SQL = `(select count(*)=2 and bool_and(not(rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) and rolinherit)
 from pg_catalog.pg_roles where rolname in('phub_migrator','phub_runtime'))
 and not exists(select 1 from pg_catalog.pg_auth_members where member in('phub_migrator'::regrole,'phub_runtime'::regrole)
  or roleid in('phub_migrator'::regrole,'phub_runtime'::regrole))
 and not pg_catalog.has_database_privilege('phub_runtime',current_database(),'CREATE')
 and not pg_catalog.has_schema_privilege('phub_migrator','public','CREATE')
 and not exists(select 1 from pg_catalog.pg_namespace n where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
  and pg_catalog.has_schema_privilege('phub_runtime',n.oid,'CREATE'))
 and not exists(select 1 from pg_catalog.pg_event_trigger where evtenabled<>'D')
 and not exists(select 1 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
  cross join lateral pg_catalog.aclexplode(d.defaclacl)a where d.defaclrole='phub_migrator'::regrole
  and(d.defaclnamespace=0 or n.nspname in('booking','commerce','eligibility','games','integration','locations','notifications'))
  and((d.defaclobjtype='r' and a.grantee<>'phub_migrator'::regrole)or d.defaclobjtype='f'))`;
export const R1_TAIL_STATE_SQL = `begin isolation level repeatable read read only;set local search_path='pg_catalog';
 set local statement_timeout='15s';set local lock_timeout='2s';
 select jsonb_build_object('schema','PHUB_R1_TAIL_STATE_V1',
 'target',jsonb_build_object('databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system())),
 'rolesSafe',(${R1_TAIL_SAFE_ROLES_SQL}),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum)order by filename),'[]'::jsonb)from public.schema_migrations),
 'catalog',(select jsonb_agg(jsonb_build_object('key',key,'value',value)order by key collate "C")from(${R1_TAIL_CATALOG_SQL.replaceAll('$1::text[]', array)})c),
 'security',(${R1_TAIL_ACL_SQL}),
 'footprint',(select jsonb_agg(jsonb_build_object('name',name,'bytes',pg_catalog.pg_total_relation_size(name::regclass),'rows',
  case name when 'notifications.intents' then(select count(*)from notifications.intents)else(select count(*)from notifications.deliveries)end)order by name)
  from unnest(array['notifications.deliveries','notifications.intents'])t(name)),
 'hazards',jsonb_build_object('migrationLockHeld',exists(select 1 from pg_catalog.pg_locks where locktype='advisory'
  and database=(select oid from pg_catalog.pg_database where datname=current_database())and classid=0 and objid=7140221 and objsubid=1 and granted),
 'longTransactions',(select count(*)from pg_catalog.pg_stat_activity where datname=current_database()and pid<>pg_backend_pid()and xact_start<clock_timestamp()-interval '30 seconds'),
 'conflictingLocks',(select count(*)from pg_catalog.pg_locks where pid<>pg_backend_pid()and relation in('notifications.intents'::regclass,'notifications.deliveries'::regclass))));rollback;`;
export function r1TailSourceCatalogs(expectedSha256) {
  const bytes = r1Encode(frozenCatalogs);
  const catalogs = validateR1TailCatalogs(frozenCatalogs, bytes, expectedSha256);
  if (catalogs.builderSha256 !== r1Hash(R1_TAIL_CATALOG_SQL)) r1Stop('CATALOG_BUILDER');
  return catalogs;
}
export function validateR1TailState(
  operation,
  value,
  phase,
  count,
  catalogs = r1TailSourceCatalogs(operation.catalogsSha256),
) {
  r1Exact(value, [
    'schema',
    'target',
    'rolesSafe',
    'ledger',
    'catalog',
    'security',
    'footprint',
    'hazards',
  ]);
  if (
    value.schema !== 'PHUB_R1_TAIL_STATE_V1' ||
    !r1Same(value.target, R1_TAIL_TARGET) ||
    value.rolesSafe !== true ||
    r1LedgerCount(value.ledger) !== count
  )
    r1Stop('DATABASE_STATE');
  if (!['prepared', 'cleaned', 'either'].includes(phase)) r1Stop('PHASE');
  const verify = (selected) => {
    validateR1TailCatalog(value.catalog, catalogs, operation.catalogVariant, count, selected);
    validateR1TailAcl(value.security, selected);
  };
  if (phase === 'either') {
    try {
      verify('prepared');
    } catch {
      verify('cleaned');
    }
  } else verify(phase);
  r1Exact(value.hazards, ['migrationLockHeld', 'longTransactions', 'conflictingLocks']);
  if (
    value.hazards.migrationLockHeld !== false ||
    value.hazards.longTransactions !== 0 ||
    value.hazards.conflictingLocks !== 0
  )
    r1Stop('DDL_HAZARD');
  if (!Array.isArray(value.footprint) || value.footprint.length !== 2) r1Stop('FOOTPRINT');
  for (const [i, name] of ['notifications.deliveries', 'notifications.intents'].entries()) {
    const row = value.footprint[i];
    r1Exact(row, ['name', 'bytes', 'rows']);
    if (
      row.name !== name ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > 268435456 ||
      !Number.isSafeInteger(row.rows) ||
      row.rows < 0
    )
      r1Stop('FOOTPRINT');
  }
  return value;
}
