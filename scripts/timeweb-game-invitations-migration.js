import { createHash } from 'node:crypto';
import { CUP_0119, CUP_0119_TARGET } from './timeweb-cup-0119-migration.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hex = (value, size) =>
  typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
const stop = (reason) => {
  throw new Error(`GAME_INVITATIONS_0120_${reason}`);
};

export const GAME_INVITATIONS_0120 = Object.freeze({
  filename: '0120_game_friend_invitations.sql',
  checksum: '39619b9cd39c62eeaeec0e55691473a4aa5b587acae3bfcb03a26f9db2f3903f',
  before: CUP_0119.after,
  after: '8a7b6bef43397c8347ea1800e35ed223a33ae8032e362eb8e92c1a94b4811668',
  backupLedger: '70adb2cea831f5b5ad58a44c6fd0b18324dba914b3eab4a4fd3c7c723c9e70c6',
  baselineReleaseId: 'dd73c7e02e81ad790f9c8c3ceb9f9ca988ad87a5-45820580791-1',
  restoreMessageSha256: '68915d6c67cff26463f4145fccaac5bebdfbcacd3125a187c737561ff2b0caf4',
  restoreDecision: 'OWNER_WAIVED_EXTERNAL_RESTORE_FOR_GAME_INVITATIONS_0120',
});

const PREDECESSOR_IMAGES = Object.freeze({
  api: 'sha256:2f1795217d28e4b37ca410f624dfe32f287787762cbeb5feb1a86cfd710b07ec',
  web: 'sha256:0f34d47f643aeaa5db3e8b3c4d730c50663afbe3a8d33a9374b099e02ef0adce',
  worker: 'sha256:6f510f4d3c3bec3e99e8bced8e199ff83c67bbdf4f1414edb3989458ee8be478',
  realtime: 'sha256:7e4f30ab2b8e871f459fd103a2856a801cf2796d2fe24910d9e931fda8301fed',
});

export function verifyGameInvitations0120Predecessor(services) {
  for (const [name, sha] of Object.entries(PREDECESSOR_IMAGES)) {
    const service = services[name];
    if (
      !service ||
      service.imageId !== sha ||
      service.image !== `ghcr.io/z6v6e6r/phub-${name}@${sha}` ||
      ((name === 'api' || name === 'web') &&
        service.releaseId !== GAME_INVITATIONS_0120.baselineReleaseId)
    )
      stop('APPLICATION_PREDECESSOR');
  }
  return services;
}

export const GAME_INVITATIONS_0120_TARGET = Object.freeze({
  database: CUP_0119_TARGET.database,
  systemIdentifier: CUP_0119_TARGET.systemIdentifier,
  operator: CUP_0119_TARGET.projectionOwner,
  owner: CUP_0119_TARGET.ledgerOwner,
  ledgerOid: CUP_0119_TARGET.ledgerOid,
  gamesOid: 18268,
  usersOid: 16557,
});

const relation = 'games.friend_invitations';
const parents =
  "('games.games'::regclass, 'identity.users'::regclass, 'public.schema_migrations'::regclass)";
const ledger = `select count(*)::integer,
  encode(sha256(convert_to(string_agg(filename||chr(9)||checksum,chr(10) order by filename)
    ||chr(10),'UTF8')),'hex') from public.schema_migrations`;

// Leave the ledger relation, role topology, schema ACLs and FK parents unchanged through DDL.
const witness = `select encode(sha256(convert_to(jsonb_build_object(
  'roles', (select jsonb_agg(to_jsonb(r) order by oid) from pg_roles r
    where rolname in ('phub_beta','phub_migrator','phub_runtime')),
  'memberships', (select jsonb_agg(to_jsonb(m) order by roleid,member,grantor) from pg_auth_members m),
  'schemas', (select jsonb_agg(to_jsonb(s) order by oid) from pg_namespace s
    where nspname in ('games','identity','public')),
  'defaults', (select jsonb_agg(to_jsonb(d) order by oid) from pg_default_acl d),
  'relations', (select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity)
    order by c.oid) from pg_class c where c.oid in ${parents}),
  'columns', (select jsonb_agg(to_jsonb(a) order by attrelid,attnum)
    from pg_attribute a where attrelid in ${parents} and attnum>0),
  'constraints', (select jsonb_agg(to_jsonb(c) order by oid)
    from pg_constraint c where conrelid in ${parents}),
  'indexes', (select jsonb_agg(to_jsonb(i) order by indexrelid)
    from pg_index i where indrelid in ${parents})
)::text,'UTF8')),'hex')`;

const postimage = `exists (
  select from pg_class r where r.oid=to_regclass('${relation}')
    and r.relkind='r' and r.relpersistence='p' and r.relrowsecurity and r.relforcerowsecurity
    and r.relowner='phub_migrator'::regrole
    and (select jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull,atthasdef) order by attnum)
      from pg_attribute where attrelid=r.oid and attnum>0 and not attisdropped)
      ='[["tenant_id","uuid",true,false],["game_id","uuid",true,false],
          ["recipient_user_id","uuid",true,false],["issued_at","timestamp with time zone",false,false]]'::jsonb
    and (select array_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint
      where conrelid=r.oid and convalidated)
      =array['PRIMARY KEY (tenant_id, game_id, recipient_user_id)',
        'FOREIGN KEY (tenant_id, game_id) REFERENCES games.games(tenant_id, id)',
        'FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES identity.users(tenant_id, id)']::text[]
    and (select count(*) from pg_constraint where conrelid=r.oid)=3
    and (r.reltoastrelid=0 or exists (select from pg_class t where t.oid=r.reltoastrelid and t.relowner=r.relowner))
    and (select count(*) from pg_index where indrelid=r.oid)=1
    and exists (select from pg_index i join pg_class idx on idx.oid=i.indexrelid
      where i.indrelid=r.oid and i.indisprimary and i.indisvalid and i.indisready
        and idx.relowner=r.relowner)
    and (select count(*) from pg_policy where polrelid=r.oid)=1
    and exists (select from pg_policy p where p.polrelid=r.oid
      and p.polname='game_friend_invitations_tenant' and p.polcmd='*' and p.polpermissive
      and p.polroles=array[0::oid]
      and pg_get_expr(p.polqual,r.oid) =
        '(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)'
      and pg_get_expr(p.polwithcheck,r.oid)=pg_get_expr(p.polqual,r.oid))
    and (select array_agg(privilege_type order by privilege_type) from aclexplode(r.relacl)
      where grantee<>'phub_migrator'::regrole)=array['SELECT']::text[]
    and not exists (select from aclexplode(r.relacl)
      where grantor<>'phub_migrator'::regrole
        or (grantee<>'phub_migrator'::regrole and (grantee<>'phub_runtime'::regrole or is_grantable)))
    and (select array_agg(attname||':'||privilege_type order by attname)
      from pg_attribute a cross join lateral aclexplode(a.attacl) acl where a.attrelid=r.oid)
      =array['game_id:INSERT','issued_at:UPDATE','recipient_user_id:INSERT','tenant_id:INSERT']::text[]
    and not exists (select from pg_attribute a cross join lateral aclexplode(a.attacl) acl
      where a.attrelid=r.oid and (grantor<>'phub_migrator'::regrole
        or grantee<>'phub_runtime'::regrole or is_grantable))
    and has_table_privilege('phub_runtime',r.oid,'SELECT')
    and not has_table_privilege('phub_runtime',r.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and has_column_privilege('phub_runtime',r.oid,'game_id','INSERT')
    and has_column_privilege('phub_runtime',r.oid,'tenant_id','INSERT')
    and has_column_privilege('phub_runtime',r.oid,'recipient_user_id','INSERT')
    and has_column_privilege('phub_runtime',r.oid,'issued_at','UPDATE')
    and not has_column_privilege('phub_runtime',r.oid,'issued_at','INSERT')
    and not has_column_privilege('phub_runtime',r.oid,'game_id','UPDATE')
    and not has_column_privilege('phub_runtime',r.oid,'tenant_id','UPDATE')
    and not has_column_privilege('phub_runtime',r.oid,'recipient_user_id','UPDATE')
)`;

export function buildGameInvitations0120Sql(bytes, target, mode, expectedCatalogSha256) {
  if (hash(bytes) !== GAME_INVITATIONS_0120.checksum) stop('SQL_CHECKSUM');
  if (
    ![target.database, target.operator, target.owner].every((v) =>
      /^[a-z][a-z0-9_]{0,62}$/.test(v ?? ''),
    ) ||
    target.operator !== 'phub_beta' ||
    target.owner !== 'phub_migrator' ||
    !/^[1-9][0-9]{18,19}$/.test(target.systemIdentifier ?? '') ||
    ![target.ledgerOid, target.gamesOid, target.usersOid].every(
      (v) => Number.isSafeInteger(v) && v > 0 && v <= 4294967295,
    ) ||
    !['apply', 'readback'].includes(mode)
  )
    stop('TARGET');
  if (mode === 'apply' && !hex(expectedCatalogSha256, 64)) stop('CATALOG_WITNESS');

  const initial = `n=123 and h='${GAME_INVITATIONS_0120.before}' and to_regclass('${relation}') is null`;
  const final = `n=124 and h='${GAME_INVITATIONS_0120.after}' and ${postimage}`;
  const setup = `begin${mode === 'readback' ? ' read only' : ''};
set local search_path=pg_catalog, public;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local idle_in_transaction_session_timeout='40s';
do $guard$ begin
  if current_database() <> '${target.database}' or inet_server_addr() is not null
    or current_user <> '${target.operator}' or session_user <> current_user
    or current_setting('role') <> 'none' or pg_is_in_recovery()
    or current_setting('server_version_num')::integer / 10000 <> 16
    or (select system_identifier::text from pg_control_system()) is distinct from '${target.systemIdentifier}'
  then raise exception 'GAME_INVITATIONS_0120_TARGET'; end if;
  if not pg_try_advisory_xact_lock(7140221) then raise exception 'GAME_INVITATIONS_0120_BUSY'; end if;
end $guard$;
lock table public.schema_migrations in ${mode === 'apply' ? 'exclusive' : 'access share'} mode;
lock table games.games, identity.users in ${mode === 'apply' ? 'share row exclusive' : 'access share'} mode;
do $guard$ begin
  if to_regclass('public.schema_migrations')::oid is distinct from ${target.ledgerOid}::oid
    or to_regclass('games.games')::oid is distinct from ${target.gamesOid}::oid
    or to_regclass('identity.users')::oid is distinct from ${target.usersOid}::oid
    or not exists (select from pg_class where oid=${target.ledgerOid} and relkind='r' and relowner='phub_migrator'::regrole)
    or (select count(*) from pg_class where oid in (${target.gamesOid},${target.usersOid})
        and relkind='r' and relowner='phub_beta'::regrole and relrowsecurity and relforcerowsecurity) <> 2
    or (select count(*) from pg_constraint where contype in ('u','p') and convalidated
        and conrelid in (${target.gamesOid},${target.usersOid})
        and pg_get_constraintdef(oid) in ('UNIQUE (tenant_id, id)','PRIMARY KEY (tenant_id, id)')) <> 2
    or (select count(*) from pg_roles where rolname in ('phub_migrator','phub_runtime') and rolcanlogin
        and not (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)) <> 2
    or pg_has_role('phub_runtime','phub_migrator','MEMBER')
    or pg_has_role('phub_runtime','phub_beta','MEMBER')
    or not has_schema_privilege('phub_runtime','games','USAGE')
    or has_schema_privilege('phub_runtime','games','CREATE')
    or exists(select from pg_inherits where inhrelid in ${parents} or inhparent in ${parents})
    or exists(select from pg_event_trigger where evtenabled <> 'D')
    or exists(select from pg_trigger where tgrelid='public.schema_migrations'::regclass and not tgisinternal and tgenabled <> 'D')
  then raise exception 'GAME_INVITATIONS_0120_CATALOG'; end if;
end $guard$;
`;
  if (mode === 'readback') {
    return `${setup}
select jsonb_build_object('state',case when ${initial} then 'PREIMAGE'
  when ${final} then 'COMMITTED' else 'DRIFT' end,'catalogSha256',(${witness}))
from (${ledger}) l(n,h);
rollback;
`;
  }
  return `${setup}
do $guard$ begin
  if not exists(select from (${ledger}) l(n,h) where ${initial})
    or (${witness}) is distinct from '${expectedCatalogSha256}'
  then raise exception 'GAME_INVITATIONS_0120_PREIMAGE'; end if;
end $guard$;
${bytes.toString('utf8')}
alter table ${relation} owner to phub_migrator;
insert into public.schema_migrations(filename,checksum)
  values ('${GAME_INVITATIONS_0120.filename}','${GAME_INVITATIONS_0120.checksum}');
do $guard$ begin
  if not exists(select from (${ledger}) l(n,h) where ${final})
    or (${witness}) is distinct from '${expectedCatalogSha256}'
  then raise exception 'GAME_INVITATIONS_0120_POSTIMAGE'; end if;
end $guard$;
commit;
`;
}

function exact(record, keys) {
  return (
    record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...keys].sort())
  );
}

export function validateGameInvitations0120Request(value, enrollment, now) {
  const decision = value?.externalRestoreDecision;
  if (
    !exact(value, [
      'schema',
      'attemptId',
      'controllerSha',
      'migrationSourceSha',
      'postgresContainerId',
      'expiresAt',
      'externalRestoreDecision',
      'retainedBackupReceiptSha256',
      'backupReleaseId',
    ]) ||
    !exact(decision, ['status', 'owner', 'referenceSha256', 'backupDecisionSha256']) ||
    value.schema !== 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_REQUEST_V1' ||
    typeof value.attemptId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.attemptId,
    ) ||
    !hex(value.controllerSha, 40) ||
    value.controllerSha !== enrollment.controllerSha ||
    value.migrationSourceSha !== value.controllerSha ||
    !hex(value.postgresContainerId, 64) ||
    !hex(value.retainedBackupReceiptSha256, 64) ||
    typeof value.backupReleaseId !== 'string' ||
    !/^[1-9][0-9]*-1$/.test(value.backupReleaseId.slice(41)) ||
    !value.backupReleaseId.startsWith(value.migrationSourceSha + '-') ||
    decision.status !== GAME_INVITATIONS_0120.restoreDecision ||
    typeof decision.owner !== 'string' ||
    !decision.owner ||
    decision.owner !== enrollment.owner ||
    decision.referenceSha256 !== GAME_INVITATIONS_0120.restoreMessageSha256 ||
    !hex(decision.backupDecisionSha256, 64)
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

export function validateGameInvitations0120Backup(receipt, archive, expectedPath, now) {
  const completed = Date.parse(receipt?.completedAt);
  if (
    receipt?.schema !== 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_FRESH_DUMP_V1' ||
    receipt.restoreAdmissionPolicy !== 'GAME_INVITATIONS_0120_INTEGRITY_ONLY_V1' ||
    receipt.baselineReleaseId !== GAME_INVITATIONS_0120.baselineReleaseId ||
    receipt.databaseTarget?.databaseName !== GAME_INVITATIONS_0120_TARGET.database ||
    receipt.databaseTarget?.systemIdentifier !== GAME_INVITATIONS_0120_TARGET.systemIdentifier ||
    receipt.sourceLedgerSha256 !== GAME_INVITATIONS_0120.backupLedger ||
    receipt.freshDumpRestored !== false ||
    receipt.freshDumpIntegrityStatus !== 'PG16_TOC_PARSE_VERIFIED' ||
    receipt.backupFile !== expectedPath ||
    !hex(receipt.backupSha256, 64) ||
    !Number.isFinite(completed) ||
    completed > now ||
    now - completed > 60 * 60 * 1000 ||
    !Number.isSafeInteger(receipt.dumpBytes) ||
    receipt.dumpBytes <= 0 ||
    !archive.isFile() ||
    archive.nlink !== 1 ||
    archive.size !== receipt.dumpBytes
  )
    stop('BACKUP');
}
