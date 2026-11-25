import { createHash } from 'node:crypto';

export const CUP_0119 = Object.freeze({
  source: '2105e3e03d68feec5da9667efbd801852406ffe4',
  filename: '0119_cup_calculated_player_levels.sql',
  checksum: 'f4b3b75576a67940fc5fb874cb5855675a6782e398803bee5316b4b75ac95b31',
  before: '7f89ae797f3981e8ca347ee36a135739ecd23c6a072f25624b212c46dbbf397e',
  after: '135185893ad4716e42ffdf8db6f148dc5b7c7ec2af7bf4acea4ec515419f9963',
});
export const CUP_0119_BACKUP = Object.freeze({
  releaseId: '43d4bd64e5ae2e1d2c64b30b7df48a5fdc67ec34-45551585649-1',
  baselineReleaseId: '0a4d640965e921e6d06eeb22de6cc6dcae07f0b1-45011215364-1',
  ledger: '4dab86cb18f7e3db7a0598cd657eaebc86f07d5af497dc0eea2e33900b6526c1',
});

export const CUP_0119_TARGET = Object.freeze({
  database: 'phub_beta',
  systemIdentifier: '7679125609183186977',
  projectionOwner: 'phub_beta',
  ledgerOwner: 'phub_migrator',
  projectionOid: 21345,
  ledgerOid: 16389,
});

const table = 'eligibility.cup_player_level_projections';
const constraint = 'cup_player_level_projections_source_event_type_check';
const oldCheck =
  "CHECK ((source_event_type = ANY (ARRAY['RATING_INITIAL_IMPORTED'::text, 'RATING_BOOTSTRAPPED_FROM_VIVA'::text, 'RATING_MANUALLY_CHANGED'::text])))";
const ledger = `select count(*)::integer,
  encode(sha256(convert_to(string_agg(filename||chr(9)||checksum,chr(10) order by filename)
    ||chr(10),'UTF8')),'hex') from public.schema_migrations`;
const shape = `select jsonb_agg(jsonb_build_object(
  'oid', t.oid, 'kind', t.relkind, 'owner', pg_get_userbyid(t.relowner),
  'acl', t.relacl, 'rls', t.relrowsecurity, 'force', t.relforcerowsecurity,
  'columns', (select jsonb_agg(to_jsonb(a) order by a.attnum) from pg_attribute a where a.attrelid=t.oid and a.attnum>0),
  'policies', (select jsonb_agg(to_jsonb(p) order by p.polname) from pg_policy p where p.polrelid=t.oid),
  'indexes', (select jsonb_agg(jsonb_build_array(i.indexrelid,pg_get_indexdef(i.indexrelid),i.indisvalid)
    order by i.indexrelid) from pg_index i where i.indrelid=t.oid),
  'otherConstraints', (select jsonb_agg(jsonb_build_array(c.oid,pg_get_constraintdef(c.oid),c.convalidated)
    order by c.oid) from pg_constraint c where c.conrelid=t.oid and c.conname<>'${constraint}'))
  order by t.oid) as snapshot
  from pg_class t where t.oid in ('${table}'::regclass,'public.schema_migrations'::regclass)`;
const stop = (reason) => {
  throw new Error(`CUP_0119_${reason}`);
};

function cup0119SqlHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildCup0119Sql(bytes, target, mode, expectedCatalogSha256) {
  if (cup0119SqlHash(bytes) !== CUP_0119.checksum) stop('SQL_CHECKSUM');
  if (
    ![target.database, target.projectionOwner, target.ledgerOwner].every((v) =>
      /^[a-z][a-z0-9_]{0,62}$/.test(v ?? ''),
    ) ||
    !/^[1-9][0-9]{18,19}$/.test(target.systemIdentifier ?? '') ||
    ![target.projectionOid, target.ledgerOid].every(
      (oid) => Number.isSafeInteger(oid) && oid > 0 && oid <= 4294967295,
    ) ||
    !['apply', 'readback'].includes(mode)
  )
    stop('TARGET');
  if (mode === 'apply' && !/^[a-f0-9]{64}$/.test(expectedCatalogSha256 ?? ''))
    stop('CATALOG_WITNESS');
  const sql = bytes.toString('utf8');
  const eventTypes = [...sql.matchAll(/'([A-Z0-9_]+)'/g)].map((entry) => entry[1]);
  if (eventTypes.length !== 21 || new Set(eventTypes).size !== 21) stop('EVENTS');
  const newCheck = `CHECK ((source_event_type = ANY (ARRAY[${eventTypes.map((e) => `'${e}'::text`).join(', ')}]))) NOT VALID`;
  const check = (definition, validated) => `exists(select from pg_constraint
    where conrelid='${table}'::regclass and conname='${constraint}' and contype='c'
      and convalidated=${validated} and pg_get_constraintdef(oid)=$definition$${definition}$definition$)`;
  const exactBefore = `n=122 and h='${CUP_0119.before}' and ${check(oldCheck, 'true')}`;
  const exactAfter = `n=123 and h='${CUP_0119.after}' and ${check(newCheck, 'false')}`;
  const setup = `begin${mode === 'readback' ? ' read only' : ''};
set local search_path=pg_catalog, public;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local idle_in_transaction_session_timeout='40s';
do $guard$ begin
  if current_database() <> '${target.database}' or inet_server_addr() is not null
    or current_user <> '${target.projectionOwner}' or session_user <> current_user
    or current_setting('role') <> 'none' or pg_is_in_recovery()
    or current_setting('server_version_num')::integer / 10000 <> 16
    or (select system_identifier::text from pg_control_system()) is distinct from '${target.systemIdentifier}'
  then raise exception 'CUP_0119_TARGET'; end if;
  if not pg_try_advisory_xact_lock(7140221) then raise exception 'CUP_0119_BUSY'; end if;
end $guard$;
lock table public.schema_migrations, ${table} in ${mode === 'apply' ? 'access exclusive' : 'access share'} mode;
do $guard$ begin
  if not exists(select from pg_class where oid='${table}'::regclass and oid=${target.projectionOid} and relkind='r'
       and pg_get_userbyid(relowner)='${target.projectionOwner}' and relrowsecurity and relforcerowsecurity)
    or not exists(select from pg_class where oid='public.schema_migrations'::regclass and oid=${target.ledgerOid} and relkind='r'
       and pg_get_userbyid(relowner)='${target.ledgerOwner}')
    or not has_table_privilege(current_user,'public.schema_migrations','INSERT')
    or not has_table_privilege(current_user,'public.schema_migrations','SELECT')
    or exists(select from pg_inherits where inhrelid in ('${table}'::regclass,'public.schema_migrations'::regclass)
       or inhparent in ('${table}'::regclass,'public.schema_migrations'::regclass))
    or exists(select from pg_event_trigger where evtenabled <> 'D')
    or exists(select from pg_trigger where tgrelid='public.schema_migrations'::regclass and not tgisinternal and tgenabled <> 'D')
  then raise exception 'CUP_0119_CATALOG'; end if;
end $guard$;
`;
  if (mode === 'readback')
    return `${setup}
select jsonb_build_object(
  'state', case when ${exactBefore} then 'PREIMAGE' when ${exactAfter} then 'COMMITTED' else 'DRIFT' end,
  'catalogSha256', encode(sha256(convert_to((${shape})::text,'UTF8')),'hex')
)
from (${ledger}) l(n,h);
rollback;
`;

  return `${setup}
create temporary table cup_0119_preimage on commit drop as (${shape});
do $guard$ begin
  if not exists(select from (${ledger}) l(n,h) where ${exactBefore})
    or (select encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') from pg_temp.cup_0119_preimage)
       is distinct from '${expectedCatalogSha256}'
  then raise exception 'CUP_0119_PREIMAGE'; end if;
end $guard$;
${sql}
insert into public.schema_migrations(filename, checksum) values ('${CUP_0119.filename}','${CUP_0119.checksum}');
do $guard$ begin
  if not exists(select from (${ledger}) l(n,h) where ${exactAfter})
    or (${shape}) is distinct from (select snapshot from pg_temp.cup_0119_preimage)
  then raise exception 'CUP_0119_POSTIMAGE'; end if;
end $guard$;
commit;
`;
}

export function validateCup0119Request(value, enrollment, now) {
  const keys = [
    'schema',
    'attemptId',
    'controllerSha',
    'migrationSourceSha',
    'postgresContainerId',
    'expiresAt',
    'externalRestoreDecision',
    'retainedBackupReceiptSha256',
  ];
  const decision = value?.externalRestoreDecision;
  const exact = (item, fields) =>
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...fields].sort());
  if (
    !exact(value, keys) ||
    !exact(decision, ['status', 'owner', 'referenceSha256']) ||
    value.schema !== 'PHUB_TIMEWEB_CUP_0119_REQUEST_V1' ||
    typeof value.attemptId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.attemptId,
    ) ||
    !/^[a-f0-9]{40}$/.test(value.controllerSha) ||
    value.controllerSha !== enrollment.controllerSha ||
    value.migrationSourceSha !== CUP_0119.source ||
    typeof value.postgresContainerId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.postgresContainerId) ||
    typeof value.retainedBackupReceiptSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.retainedBackupReceiptSha256) ||
    decision.status !== 'OWNER_WAIVED_EXTERNAL_RESTORE_FOR_CUP_0119' ||
    typeof decision.owner !== 'string' ||
    !decision.owner ||
    decision.owner !== enrollment.owner ||
    typeof decision.referenceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(decision.referenceSha256)
  )
    stop('REQUEST');
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== value.expiresAt ||
    (now !== undefined && (expires <= now || expires - now > 60 * 60 * 1000))
  )
    stop('EXPIRED');
  return value;
}

export function validateCup0119RetainedBackup(receipt, archive, expectedPath) {
  if (
    receipt?.schema !== 'PHUB_TIMEWEB_CANONICAL_FRESH_DUMP_PRIOR_RESTORE_V1' ||
    receipt.baselineReleaseId !== CUP_0119_BACKUP.baselineReleaseId ||
    receipt.restoreAdmissionPolicy !== 'EXACT_CANONICAL_PRIOR_FULL_RESTORE_OWNER_WAIVER_V1' ||
    receipt.databaseTarget?.databaseName !== CUP_0119_TARGET.database ||
    receipt.databaseTarget?.systemIdentifier !== CUP_0119_TARGET.systemIdentifier ||
    receipt.sourceLedgerSha256 !== CUP_0119_BACKUP.ledger ||
    receipt.freshDumpRestored !== false ||
    receipt.freshDumpIntegrityStatus !== 'PG16_TOC_PARSE_VERIFIED' ||
    receipt.backupFile !== expectedPath ||
    !Number.isSafeInteger(receipt.dumpBytes) ||
    receipt.dumpBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.backupSha256) ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    !archive.isFile() ||
    archive.nlink !== 1 ||
    archive.size !== receipt.dumpBytes
  )
    stop('RETAINED_BACKUP');
}
