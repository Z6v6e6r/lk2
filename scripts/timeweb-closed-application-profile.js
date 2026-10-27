// New migration-only enrollment. No application rollout, runtime ACL, env or send activation.
import { createHash } from 'node:crypto';
import descriptor from '../deploy/timeweb/closed-application-migrations-0103-0104.v1.json' with { type: 'json' };
import { parseStrictJson } from './strict-json.js';
import {
  closedApplicationAclPlan,
  closedApplicationAclSql,
  validateClosedApplicationAcl,
} from './closed-application-migration-acl.js';
import {
  CLOSED_APPLICATION_CATALOG_SQL,
  CLOSED_APPLICATION_CATALOG_TABLES,
} from './closed-application-migration-catalog.js';

export const CLOSED_APPLICATION_HOST_TARGET = Object.freeze({
  hostname: 'lk2.padlhub.su',
  serverId: 8886471,
  projectId: 262717,
});
export const CLOSED_APPLICATION_DATABASE_TARGET = Object.freeze({
  databaseName: 'phub_beta',
  systemIdentifier: '7679125609183186977',
});
export const CLOSED_APPLICATION_POSTGRES_CONTAINER =
  'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c';
export const CLOSED_APPLICATION_OPERATION_SCHEMAS = Object.freeze({
  game_start_0103: 'PHUB_TIMEWEB_GAME_START_0103_MIGRATION_OPERATION_V1',
  subject_link_0104: 'PHUB_TIMEWEB_SUBJECT_LINK_0104_MIGRATION_OPERATION_V1',
});
export const CLOSED_APPLICATION_STAGE = Object.freeze({
  game_start_0103: {
    prefix: 'PHUB_GAME_START_0103',
    slug: 'game-start0103',
    backupMode: 'game-start-pre0103',
    argument: '--game-start-migration-0103',
  },
  subject_link_0104: {
    prefix: 'PHUB_SUBJECT_LINK_0104',
    slug: 'subject-link0104',
    backupMode: 'subject-link-pre0104',
    argument: '--subject-link-migration-0104',
  },
});
const ROOT = '/opt/phub/timeweb-beta';
const HASH = /^[a-f0-9]{64}$/,
  SHA = /^[a-f0-9]{40}$/,
  DIGEST = /^sha256:[a-f0-9]{64}$/,
  RUN = /^[1-9][0-9]*$/;
const RELEASE = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const secretNames = [
  '.release-identity.json',
  'api.env',
  'migrator.env',
  'realtime.env',
  'worker.env',
];
const identityKeys = ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const same = (a, b) => canonical(a) === canonical(b);
const fail = (code) => {
  throw Error(`CLOSED_APPLICATION_PROFILE_${code}`);
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    fail('SHAPE');
};
function kind(value) {
  if (!Object.hasOwn(CLOSED_APPLICATION_STAGE, value)) fail('KIND');
  return value;
}
function checkpoint(count) {
  const value = descriptor.checkpoints[String(count)];
  if (!value) fail('CHECKPOINT');
  return value;
}
export function closedApplicationSchemas(profile) {
  const prefix = CLOSED_APPLICATION_STAGE[kind(profile)].prefix;
  return Object.freeze({
    receipt: `${prefix}_MIGRATION_RECEIPT_V1`,
    plan: `${prefix}_MIGRATION_PLAN_V1`,
    roleProof: `${prefix}_MIGRATOR_ROLE_PROOF_V1`,
    cleanupProof: `${prefix}_CLEANUP_PROOF_V1`,
    bootstrapProof: `${prefix}_BOOTSTRAP_PROOF_V1`,
    success: `${prefix}_MIGRATION_SUCCESS_V1`,
  });
}
export function validateClosedRuntimeIdentity(value, service) {
  if (!['api', 'worker', 'postgres'].includes(service)) fail('RUNTIME_IDENTITY');
  exact(value, identityKeys);
  const repository =
    service === 'postgres' ? 'docker.io/library/postgres' : `ghcr.io/z6v6e6r/phub-${service}`;
  if (
    !HASH.test(value.id ?? '') ||
    !DIGEST.test(value.imageId ?? '') ||
    value.image !==
      (service === 'postgres'
        ? 'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
        : `${repository}@${value.imageId}`) ||
    !Number.isSafeInteger(value.restarts) ||
    value.restarts < 0 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    (service === 'postgres'
      ? value.releaseId !== null || value.revision !== null
      : !SHA.test(value.revision ?? '') ||
        (service === 'api'
          ? !RELEASE.test(value.releaseId ?? '') || !value.releaseId.startsWith(value.revision)
          : value.releaseId !== null && !RELEASE.test(value.releaseId ?? '')))
  )
    fail('RUNTIME_IDENTITY');
  return value;
}
export function closedApplicationInputDigests(operation) {
  const acl = closedApplicationAclPlan(
    operation.migrationProfile,
    operation.expectedPrivilegePreimage,
  );
  return {
    packageDescriptorSha256: operation.packageDescriptorSha256,
    catalogBuilderSha256: operation.catalogBuilderSha256,
    aclPreimageSha256: acl.preimageSha256,
    bootstrapSha256: acl.bootstrapSha256,
    cleanupSha256: acl.cleanupSha256,
  };
}
export function validateClosedApplicationOperation(value, at) {
  exact(value, [
    'schema',
    'profile',
    'migrationProfile',
    'target',
    'expectedDatabaseTarget',
    'catalogVariant',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'publishedMigrator',
    'packageDescriptorSha256',
    'catalogBuilderSha256',
    'expectedPrivilegePreimage',
    'aclPreimageSha256',
    'bootstrapSha256',
    'cleanupSha256',
    'expectedApi',
    'expectedWorker',
    'expectedPostgres',
    'expectedSecretSetReleaseId',
    'expectedSecretSetFiles',
    'previousMigrationSuccess',
    'expiresAt',
    'confirmation',
  ]);
  const profile = kind(value.migrationProfile);
  exact(value.target, ['hostname', 'serverId', 'projectId']);
  exact(value.expectedDatabaseTarget, ['databaseName', 'systemIdentifier']);
  exact(value.publishedMigrator, [
    'sourceSha',
    'sourceTree',
    'publicationRunId',
    'publicationRunAttempt',
    'manifestSha256',
    'image',
    'imageId',
  ]);
  const image = value.publishedMigrator;
  if (
    value.schema !== CLOSED_APPLICATION_OPERATION_SCHEMAS[profile] ||
    value.profile !== 'beta' ||
    !same(value.target, CLOSED_APPLICATION_HOST_TARGET) ||
    !same(value.expectedDatabaseTarget, CLOSED_APPLICATION_DATABASE_TARGET) ||
    !['DORMANT', 'SCENARIO_EDITOR_V1'].includes(value.catalogVariant) ||
    !SHA.test(value.controllerSha ?? '') ||
    !SHA.test(value.controllerTree ?? '') ||
    !RUN.test(value.controllerSourceCiRunId ?? '') ||
    image.sourceSha !== value.controllerSha ||
    image.sourceTree !== value.controllerTree ||
    !RUN.test(image.publicationRunId ?? '') ||
    image.publicationRunAttempt !== 1 ||
    !HASH.test(image.manifestSha256 ?? '') ||
    !/^ghcr\.io\/z6v6e6r\/phub-migrator@sha256:[a-f0-9]{64}$/.test(image.image ?? '') ||
    !DIGEST.test(image.imageId ?? '') ||
    ![
      value.packageDescriptorSha256,
      value.catalogBuilderSha256,
      value.aclPreimageSha256,
      value.bootstrapSha256,
      value.cleanupSha256,
    ].every((item) => HASH.test(item ?? ''))
  )
    fail('OPERATION');
  for (const service of ['api', 'worker', 'postgres'])
    validateClosedRuntimeIdentity(
      value[`expected${service[0].toUpperCase()}${service.slice(1)}`],
      service,
    );
  if (
    value.expectedPostgres.id !== CLOSED_APPLICATION_POSTGRES_CONTAINER ||
    value.expectedPostgres.imageId !==
      'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
  )
    fail('POSTGRES_TARGET');
  if (!RELEASE.test(value.expectedSecretSetReleaseId ?? '')) fail('SECRET_SET');
  exact(value.expectedSecretSetFiles, secretNames);
  if (!Object.values(value.expectedSecretSetFiles).every((item) => HASH.test(item ?? '')))
    fail('SECRET_SET');
  const inputs = closedApplicationInputDigests(value);
  if (
    ['aclPreimageSha256', 'bootstrapSha256', 'cleanupSha256'].some(
      (key) => inputs[key] !== value[key],
    )
  )
    fail('ACL_INPUTS');
  if (profile === 'game_start_0103') {
    if (value.previousMigrationSuccess !== null) fail('PREVIOUS_MIGRATION');
  } else {
    exact(value.previousMigrationSuccess, ['path', 'sha256', 'operationSha256']);
    if (
      value.previousMigrationSuccess.path !==
        `${ROOT}/backups/${value.controllerSha}-${value.controllerSourceCiRunId}-1-game-start0103-migration/migration-success.json` ||
      !HASH.test(value.previousMigrationSuccess.sha256 ?? '') ||
      !HASH.test(value.previousMigrationSuccess.operationSha256 ?? '')
    )
      fail('PREVIOUS_MIGRATION');
  }
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== value.expiresAt ||
    (at !== undefined && (expires - at < 20 * 60000 || expires - at > 60 * 60000)) ||
    value.confirmation !==
      `MIGRATE_${profile.toUpperCase()}_ONLY_PRESERVE_PREEXISTING_ACL_NO_APP_DEPLOY_NO_SEND`
  )
    fail('AUTHORITY');
  return value;
}
export function validateClosedApplicationLedger(profile, rows, phase) {
  const step = descriptor.profiles[kind(profile)];
  if (!['pre', 'bootstrap', 'post', 'cleanup'].includes(phase)) fail('PHASE');
  const count = ['pre', 'bootstrap'].includes(phase) ? step.preCount : step.postCount;
  if (!Array.isArray(rows) || rows.length !== count) fail('LEDGER');
  let previous = '';
  for (const row of rows) {
    exact(row, ['filename', 'checksum']);
    if (
      !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(row.filename ?? '') ||
      !HASH.test(row.checksum ?? '') ||
      row.filename <= previous
    )
      fail('LEDGER');
    previous = row.filename;
  }
  const digest = hash(JSON.stringify(rows.map((row) => [row.filename, row.checksum])) + '\n');
  if (digest !== checkpoint(count).ledgerSha256) fail('LEDGER');
  return digest;
}
export function closedApplicationCommand(operation, containerKind) {
  validateClosedApplicationOperation(operation);
  if (containerKind !== 'migration') fail('COMMAND_KIND');
  const target = {
    ...CLOSED_APPLICATION_DATABASE_TARGET,
    catalogVariant: operation.catalogVariant,
  };
  return [
    'node',
    'apps/migrator/dist/main.js',
    CLOSED_APPLICATION_STAGE[operation.migrationProfile].argument,
    Buffer.from(JSON.stringify(target)).toString('base64'),
  ];
}
export function validateClosedApplicationCatalog(operation, rows, count) {
  if (!['DORMANT', 'SCENARIO_EDITOR_V1'].includes(operation.catalogVariant))
    fail('CATALOG_VARIANT');
  const expected = checkpoint(count).catalogs[operation.catalogVariant];
  if (!Array.isArray(rows) || rows.length !== expected.rowCount) fail('CATALOG');
  const normalized = rows.map((row) => {
    exact(row, ['key', 'value']);
    if (typeof row.key !== 'string' || typeof row.value !== 'string') fail('CATALOG');
    return { key: row.key, value: row.value };
  });
  if (hash(JSON.stringify(normalized) + '\n') !== expected.sha256) fail('CATALOG');
}
export function closedApplicationCatalogSql() {
  const array = `array[${CLOSED_APPLICATION_CATALOG_TABLES.map((name) => `'${name}'`).join(',')}]::text[]`;
  return CLOSED_APPLICATION_CATALOG_SQL.replaceAll('$1::text[]', array);
}
export function validateClosedApplicationManifest(operation, manifest, bytes) {
  validateClosedApplicationOperation(operation);
  const image = operation.publishedMigrator;
  const matches = manifest?.images?.filter((row) => row.component === 'migrator') ?? [];
  if (
    hash(bytes) !== image.manifestSha256 ||
    manifest?.schemaVersion !== 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2' ||
    manifest.gitCommit !== image.sourceSha ||
    manifest.gitTree !== image.sourceTree ||
    String(manifest.publication?.runId) !== image.publicationRunId ||
    manifest.publication?.runAttempt !== 1 ||
    matches.length !== 1 ||
    `ghcr.io/z6v6e6r/phub-migrator@${matches[0].digest}` !== image.image ||
    matches[0].runtimeDigest !== image.imageId ||
    matches[0].revision !== image.sourceSha
  )
    fail('MANIFEST');
  return manifest;
}
const safeRolesSql = `(select count(*)=2 and bool_and(not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) and rolinherit)
  from pg_catalog.pg_roles where rolname in ('phub_migrator','phub_runtime'))
  and not exists(select 1 from pg_catalog.pg_auth_members where member in ('phub_migrator'::regrole,'phub_runtime'::regrole) or roleid in ('phub_migrator'::regrole,'phub_runtime'::regrole))
  and not pg_catalog.has_schema_privilege('phub_migrator','public','CREATE')
  and not pg_catalog.has_database_privilege('phub_runtime',current_database(),'CREATE')
  and not exists(select 1 from pg_catalog.pg_namespace n where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema' and pg_catalog.has_schema_privilege('phub_runtime',n.oid,'CREATE'))
  and not exists(select 1 from pg_catalog.pg_event_trigger where evtenabled<>'D')`;
const targetSql = `jsonb_build_object('databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()))`;
const lockAvailableSql = `not exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and database=(select oid from pg_catalog.pg_database where datname=current_database()) and classid=0 and objid=7140221 and objsubid=1 and granted)`;
export function closedApplicationRoleProbeSource(profile) {
  kind(profile);
  const query = `select jsonb_build_object('target',${targetSql},'currentRoleName',current_user,'sessionRoleName',session_user,
    'roleOverride',current_setting('role'),'readOnly',current_setting('transaction_read_only'),'recovery',pg_catalog.pg_is_in_recovery(),
    'rolesSafe',(${safeRolesSql}),'migrationLockAvailable',(${lockAvailableSql}),'acl',(${closedApplicationAclSql(profile)})) value`;
  return `import {Client} from 'pg';let client;try{
    const phase=process.argv[1];if(!['pre','bootstrap'].includes(phase))throw Error();
    const url=new URL(process.env.DATABASE_URL);if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash||decodeURIComponent(url.username)!=='phub_migrator'||url.pathname!=='/phub_beta')throw Error();
    client=new Client({connectionString:url.toString(),connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000'});
    await client.connect();await client.query("begin isolation level repeatable read read only;set local search_path='pg_catalog'");
    const rows=(await client.query(${JSON.stringify(query)})).rows;await client.query('rollback');if(rows.length!==1)throw Error();
    process.stdout.write(JSON.stringify({schema:'PHUB_CLOSED_APPLICATION_MIGRATOR_READBACK_V1',migrationProfile:${JSON.stringify(profile)},phase,wireRoleName:decodeURIComponent(url.username),...rows[0].value})+'\\n');
  }catch{process.stderr.write('CLOSED_APPLICATION_ROLE_PROOF_UNKNOWN\\n');process.exitCode=1;}finally{await client?.end().catch(()=>{});}`;
}
export function validateClosedApplicationRoleReadback(
  operation,
  value,
  phase,
  target = CLOSED_APPLICATION_DATABASE_TARGET,
) {
  exact(value, [
    'schema',
    'migrationProfile',
    'phase',
    'wireRoleName',
    'target',
    'currentRoleName',
    'sessionRoleName',
    'roleOverride',
    'readOnly',
    'recovery',
    'rolesSafe',
    'migrationLockAvailable',
    'acl',
  ]);
  const profile = kind(operation.migrationProfile);
  const acl = closedApplicationAclPlan(profile, operation.expectedPrivilegePreimage);
  if (
    !['pre', 'bootstrap'].includes(phase) ||
    value.schema !== 'PHUB_CLOSED_APPLICATION_MIGRATOR_READBACK_V1' ||
    value.migrationProfile !== profile ||
    value.phase !== phase ||
    value.wireRoleName !== 'phub_migrator' ||
    value.currentRoleName !== 'phub_migrator' ||
    value.sessionRoleName !== 'phub_migrator' ||
    value.roleOverride !== 'none' ||
    value.readOnly !== 'on' ||
    value.recovery !== false ||
    value.rolesSafe !== true ||
    value.migrationLockAvailable !== true ||
    !same(target, CLOSED_APPLICATION_DATABASE_TARGET) ||
    !same(value.target, target) ||
    !same(value.acl, phase === 'pre' ? acl.preimage : acl.bootstrap)
  )
    fail('ROLE_READBACK');
  return value;
}
export function closedApplicationStateSql(profile, phase) {
  const step = descriptor.profiles[kind(profile)];
  if (!['pre', 'bootstrap', 'post', 'cleanup'].includes(phase)) fail('PHASE');
  const post = ['post', 'cleanup'].includes(phase);
  const count = post ? step.postCount : step.preCount;
  const newTables =
    count >= 107
      ? [
          'notifications.legacy_game_reminder_source_status',
          'notifications.legacy_game_reminder_sources',
          'notifications.legacy_game_reminder_recipients',
        ]
      : [];
  if (count === 108) newTables.push('identity.external_subject_link_commands');
  const emptyRows = newTables.length
    ? `jsonb_build_object(${newTables.map((name) => `'${name}',(select count(*) from ${name})`).join(',')})`
    : `'{}'::jsonb`;
  return `begin isolation level repeatable read read only;set local search_path='pg_catalog';set local statement_timeout='15s';set local lock_timeout='2s';
    select jsonb_build_object('schema','PHUB_CLOSED_APPLICATION_DATABASE_STATE_V1','migrationProfile','${profile}','phase','${phase}',
    'target',${targetSql},'rolesSafe',(${safeRolesSql}),
    'ledger',(select coalesce(jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum) order by filename),'[]'::jsonb) from public.schema_migrations),
    'catalog',(select jsonb_agg(jsonb_build_object('key',key,'value',value) order by key collate "C") from (${closedApplicationCatalogSql()}) c),
    'acl',(${closedApplicationAclSql(profile)}),'newTableRows',${emptyRows},
    'hazards',jsonb_build_object('migrationLockHeld',not (${lockAvailableSql}),
      'longTransactions',(select count(*) from pg_catalog.pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start<clock_timestamp()-interval '30 seconds'),
      'conflictingLocks',(select count(*) from pg_catalog.pg_locks where pid<>pg_backend_pid() and relation in ('notifications.scenario_runs'::regclass,'notifications.scenario_contexts'::regclass))),
    'footprint',(select jsonb_agg(jsonb_build_object('name',name,'bytes',pg_catalog.pg_total_relation_size(name::regclass),'rows',case name when 'notifications.scenario_runs' then (select count(*) from notifications.scenario_runs) else (select count(*) from notifications.scenario_contexts) end) order by name)
      from unnest(array['notifications.scenario_contexts','notifications.scenario_runs']) t(name)),
    'gameStartDuplicates',(select count(*) from (select 1 from notifications.scenario_runs where context_kind='GAME_START' group by tenant_id,scenario_id,target_id,recipient_user_id having count(*)>1) d));rollback;`;
}
export function validateClosedApplicationState(operation, value, phase) {
  exact(value, [
    'schema',
    'migrationProfile',
    'phase',
    'target',
    'rolesSafe',
    'ledger',
    'catalog',
    'acl',
    'newTableRows',
    'hazards',
    'footprint',
    'gameStartDuplicates',
  ]);
  const profile = kind(operation.migrationProfile),
    step = descriptor.profiles[profile];
  const count = ['pre', 'bootstrap'].includes(phase) ? step.preCount : step.postCount;
  const acl = closedApplicationAclPlan(profile, operation.expectedPrivilegePreimage);
  if (
    !['pre', 'bootstrap', 'post', 'cleanup'].includes(phase) ||
    value.schema !== 'PHUB_CLOSED_APPLICATION_DATABASE_STATE_V1' ||
    value.migrationProfile !== profile ||
    value.phase !== phase ||
    !same(value.target, CLOSED_APPLICATION_DATABASE_TARGET) ||
    value.rolesSafe !== true ||
    !same(value.acl, ['bootstrap', 'post'].includes(phase) ? acl.bootstrap : acl.preimage)
  )
    fail('STATE');
  validateClosedApplicationLedger(profile, value.ledger, phase);
  validateClosedApplicationCatalog(operation, value.catalog, count);
  validateClosedApplicationAcl(profile, value.acl);
  if (
    !same(value.hazards, { migrationLockHeld: false, longTransactions: 0, conflictingLocks: 0 }) ||
    value.gameStartDuplicates !== 0
  )
    fail('HAZARDS');
  const tables =
    count >= 107
      ? [
          'notifications.legacy_game_reminder_source_status',
          'notifications.legacy_game_reminder_sources',
          'notifications.legacy_game_reminder_recipients',
        ]
      : [];
  if (count === 108) tables.push('identity.external_subject_link_commands');
  exact(value.newTableRows, tables);
  if (Object.values(value.newTableRows).some((rows) => rows !== 0)) fail('NEW_TABLE_ROWS');
  if (!Array.isArray(value.footprint) || value.footprint.length !== 2) fail('FOOTPRINT');
  for (const [index, name] of [
    'notifications.scenario_contexts',
    'notifications.scenario_runs',
  ].entries()) {
    const row = value.footprint[index];
    exact(row, ['name', 'bytes', 'rows']);
    if (
      row.name !== name ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > 268435456 ||
      !Number.isSafeInteger(row.rows) ||
      row.rows < 0 ||
      row.rows > 250000
    )
      fail('FOOTPRINT');
  }
  return value;
}
const receiptPhases = [
  'PREPARING',
  'PROBE_MIGRATOR_PRE_CREATE_INTENT',
  'PROBE_MIGRATOR_PRE_START_INTENT',
  'BOOTSTRAP_INTENT',
  'BOOTSTRAP_APPLIED',
  'PROBE_MIGRATOR_BOOTSTRAP_CREATE_INTENT',
  'PROBE_MIGRATOR_BOOTSTRAP_START_INTENT',
  'PREPARED',
  'CREATE_INTENT',
  'CREATED',
  'START_INTENT',
  'STARTED',
  'CLEANUP_INTENT',
  'CLEANUP_APPLIED',
  'SUCCESS',
  'ABORTED',
  'RECONCILED',
];
export function validateClosedApplicationPlan(value, bytes) {
  const operation = validateClosedApplicationOperation(parseStrictJson(bytes)),
    profile = operation.migrationProfile,
    step = descriptor.profiles[profile];
  exact(value, [
    'schema',
    'operationSha256',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'publishedMigrator',
    'imageId',
    'preLedgerSha256',
    'postLedgerSha256',
    'secretSet',
    'runtime',
    'backup',
    'inputs',
    'roleProbeSourceSha256',
    'preimage',
  ]);
  exact(value.secretSet, ['releaseId', 'device', 'inode', 'files']);
  exact(value.secretSet.files, secretNames);
  exact(value.runtime, ['api', 'worker', 'postgres', 'controllerConfigSha256', 'excluded']);
  for (const service of ['api', 'worker']) {
    const row = value.runtime[service];
    exact(row, ['identity', 'status', 'health', 'fingerprint']);
    if (
      !same(row.identity, operation[service === 'api' ? 'expectedApi' : 'expectedWorker']) ||
      row.status !== 'running' ||
      row.health !== 'healthy' ||
      !HASH.test(row.fingerprint ?? '')
    )
      fail('PLAN_RUNTIME');
  }
  if (
    !same(value.runtime.postgres, operation.expectedPostgres) ||
    !HASH.test(value.runtime.controllerConfigSha256 ?? '') ||
    !Array.isArray(value.runtime.excluded) ||
    value.runtime.excluded.length > 512 ||
    new Set(value.runtime.excluded.map((row) => row?.identity?.id)).size !==
      value.runtime.excluded.length ||
    !value.runtime.excluded.some((row) => same(row.identity, operation.expectedPostgres))
  )
    fail('PLAN_RUNTIME');
  for (const row of value.runtime.excluded) {
    exact(row, ['identity', 'status', 'health', 'fingerprint']);
    exact(row.identity, identityKeys);
    if (!HASH.test(row.identity.id ?? '') || !HASH.test(row.fingerprint ?? ''))
      fail('PLAN_RUNTIME');
  }
  if (
    value.schema !== closedApplicationSchemas(profile).plan ||
    value.operationSha256 !== hash(bytes) ||
    value.controllerSha !== operation.controllerSha ||
    value.controllerTree !== operation.controllerTree ||
    value.controllerSourceCiRunId !== operation.controllerSourceCiRunId ||
    !same(value.publishedMigrator, operation.publishedMigrator) ||
    value.imageId !== operation.publishedMigrator.imageId ||
    value.preLedgerSha256 !== checkpoint(step.preCount).ledgerSha256 ||
    value.postLedgerSha256 !== checkpoint(step.postCount).ledgerSha256 ||
    value.roleProbeSourceSha256 !== hash(closedApplicationRoleProbeSource(profile)) ||
    value.secretSet.releaseId !== operation.expectedSecretSetReleaseId ||
    !same(value.secretSet.files, operation.expectedSecretSetFiles) ||
    !Number.isSafeInteger(value.secretSet.device) ||
    value.secretSet.device < 0 ||
    !Number.isSafeInteger(value.secretSet.inode) ||
    value.secretSet.inode < 1 ||
    !same(value.inputs, closedApplicationInputDigests(operation))
  )
    fail('PLAN');
  exact(value.backup, [
    'path',
    'sha256',
    'operationSha256',
    'preimageSha256',
    'target',
    'migrationProfile',
    'sourceLedgerSha256',
    'catalogVariant',
  ]);
  if (
    value.backup.path !==
      `${ROOT}/backups/${operation.controllerSha}-${operation.controllerSourceCiRunId}-1-${CLOSED_APPLICATION_STAGE[profile].backupMode}/database-backup-receipt.json` ||
    !['sha256', 'operationSha256', 'preimageSha256'].every((key) =>
      HASH.test(value.backup[key] ?? ''),
    ) ||
    !same(value.backup.target, operation.expectedDatabaseTarget) ||
    value.backup.migrationProfile !== profile ||
    value.backup.sourceLedgerSha256 !== checkpoint(step.preCount).ledgerSha256 ||
    value.backup.catalogVariant !== operation.catalogVariant
  )
    fail('PLAN_BACKUP');
  validateClosedApplicationState(operation, value.preimage, 'pre');
  return value;
}
export function validateClosedApplicationReceipt(profile, value, planSha, operationSha) {
  kind(profile);
  exact(value, [
    'schema',
    'status',
    'planSha256',
    'operationSha256',
    'observedAt',
    'containerId',
    'successSha256',
    'reconciledStatus',
  ]);
  const observed = Date.parse(value.observedAt);
  if (
    value.schema !== closedApplicationSchemas(profile).receipt ||
    !receiptPhases.includes(value.status) ||
    value.planSha256 !== planSha ||
    value.operationSha256 !== operationSha ||
    !HASH.test(planSha ?? '') ||
    !HASH.test(operationSha ?? '') ||
    !Number.isFinite(observed) ||
    new Date(observed).toISOString() !== value.observedAt ||
    (value.containerId !== null && !HASH.test(value.containerId ?? '')) ||
    (value.successSha256 !== null && !HASH.test(value.successSha256 ?? '')) ||
    (value.status === 'RECONCILED'
      ? !['SUCCESS', 'ABORTED'].includes(value.reconciledStatus)
      : value.reconciledStatus !== null) ||
    ((value.status === 'SUCCESS' || value.reconciledStatus === 'SUCCESS') &&
      (!value.containerId || !value.successSha256))
  )
    fail('RECEIPT');
  return value;
}
export function createClosedApplicationKernelProfile(operation) {
  validateClosedApplicationOperation(operation);
  const profile = operation.migrationProfile,
    step = descriptor.profiles[profile];
  return Object.freeze({
    kind: profile,
    preCount: step.preCount,
    postCount: step.postCount,
    preLedgerSha256: checkpoint(step.preCount).ledgerSha256,
    postLedgerSha256: checkpoint(step.postCount).ledgerSha256,
    errorPrefix: profile === 'game_start_0103' ? 'GAME_START_' : 'SUBJECT_LINK_',
    schemas: closedApplicationSchemas(profile),
    roleProbeSource: closedApplicationRoleProbeSource(profile),
    validateOperation: (value, at) => {
      validateClosedApplicationOperation(value, at);
      if (!same(value, operation)) fail('OPERATION_DRIFT');
      return value;
    },
    validateLedger: (rows, phase) => validateClosedApplicationLedger(profile, rows, phase),
    validateState: (value, phase) => validateClosedApplicationState(operation, value, phase),
    validateMigratorReadback: (value, phase, target) =>
      validateClosedApplicationRoleReadback(operation, value, phase, target),
    validatePlan: (value, bytes) => {
      if (!same(parseStrictJson(bytes), operation)) fail('OPERATION_DRIFT');
      return validateClosedApplicationPlan(value, bytes);
    },
    validateReceipt: (value, planSha, operationSha) =>
      validateClosedApplicationReceipt(profile, value, planSha, operationSha),
    readState: (effects, phase) => effects.closedApplicationState(phase),
    readProof: (effects, name) => effects.readClosedApplicationProof(name),
    writeProof: (effects, name, bytes) => effects.writeClosedApplicationProof(name, bytes),
  });
}
// Only inspect activation switches; never return or log any environment values.
// Missing new switches are admitted solely on a proven ancestor before their introduction.
export function assertClosedApplicationRuntimeOff(operation, environments, git) {
  const selected = new Set([
    'NOTIFICATION_SCENARIOS_ENABLED',
    'LEGACY_GAME_REMINDERS_SOURCE_ENABLED',
    'AUTH_PHONE_SUBJECT_LINK_ENABLED',
  ]);
  const flags = {};
  for (const service of ['api', 'worker']) {
    const bytes = environments?.[service];
    const lines = Array.isArray(bytes)
      ? bytes
      : Buffer.isBuffer(bytes)
        ? bytes.toString('utf8').trimEnd().split('\n')
        : null;
    if (!lines) fail('RUNTIME_ENV');
    const seen = new Set(),
      values = {};
    for (const line of lines) {
      const match = typeof line === 'string' ? /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line) : null;
      if (!match || seen.has(match[1]) || line.includes('\0') || line.includes('\r'))
        fail('RUNTIME_ENV');
      seen.add(match[1]);
      if (selected.has(match[1])) values[match[1]] = match[2];
    }
    flags[service] = values;
  }
  const off = (service, key, introduction) => {
    const values = flags[service];
    if (Object.hasOwn(values, key)) {
      if (!['false', '0'].includes(values[key])) fail('RUNTIME_FLAGS');
      return;
    }
    if (!introduction || typeof git !== 'function') fail('RUNTIME_FLAGS');
    const revision = operation[service === 'api' ? 'expectedApi' : 'expectedWorker']?.revision;
    if (!SHA.test(revision ?? '')) fail('RUNTIME_FLAGS');
    try {
      git(['merge-base', '--is-ancestor', revision, `${introduction}^1`]);
      if (git(['show', `${revision}:packages/config/src/index.ts`]).includes(key))
        fail('RUNTIME_FLAGS');
    } catch {
      fail('RUNTIME_FLAGS');
    }
  };
  off('worker', 'NOTIFICATION_SCENARIOS_ENABLED');
  off('worker', 'LEGACY_GAME_REMINDERS_SOURCE_ENABLED', '903b86b0f2fb30cf10e5097de11d7c85e0948fdd');
  off('api', 'AUTH_PHONE_SUBJECT_LINK_ENABLED', '47c90dd26a6ab0b12944979a2456cebb92b76726');
  return true;
}
