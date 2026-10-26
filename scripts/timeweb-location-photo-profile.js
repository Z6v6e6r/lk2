// Closed 0102 profile. It binds the installed runtime, the separately published migrator and
// the enrolled controller without making any of those three identities interchangeable.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { assertControllerPromotionGitConfig } from './verify-source-ci.js';
import {
  LOCATION_PHOTO_CONTROLLER_BASE,
  parseApiWorkerControllerDiff,
  validateLocationPhotoControllerClosure,
} from './timeweb-api-worker-contract.js';

export const LOCATION_PHOTO_BACKUP_SCHEMA =
  'PHUB_TIMEWEB_LOCATION_PHOTO_PRE0102_BACKUP_NAMESPACE_V1';
export const LOCATION_PHOTO_MIGRATION_SCHEMA =
  'PHUB_TIMEWEB_LOCATION_PHOTO_0102_MIGRATION_OPERATION_V1';
export const LOCATION_PHOTO_PREFETCH_SCHEMA = 'PHUB_TIMEWEB_LOCATION_PHOTO_0102_PREFETCH_V1';
export const LOCATION_PHOTO_PRE_LEDGER =
  '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd';
export const LOCATION_PHOTO_POST_LEDGER =
  'ff74c193b5e5253f929818b1550d0e5c0264a9818cb0ee5437d49d5aa043904e';
export const LOCATION_PHOTO_MIGRATION = Object.freeze({
  filename: '0102_location_recommendation_photos.sql',
  sha256: '8817a4dab03e78d27023d4b3ee72a12bfa8f2ffe4599e4e78df1d3a3893366f0',
  gitBlob: '4fd2f66cca7d585fae94f7e1d33ab1eca4b0f124',
});
export const LOCATION_PHOTO_PUBLISHED_MIGRATOR = Object.freeze({
  sourceSha: '4256e733a1f904d051a96492645f5767e4346ce1',
  sourceTree: '1c5c702be7f2fb7ce57574ad18f0839839aeebcd',
  publicationRunId: '40312260447',
  publicationRunAttempt: 1,
  manifestSha256: 'b637747e274edd683def496b4b759b7dc2d4d2b5394cfe0effb3c6d9913fcc28',
  image:
    'ghcr.io/z6v6e6r/phub-migrator@sha256:54921143466e832b775e0151b100cd4a98b6cbf61e4d9aa1a4ca6fe856efce0b',
  imageId: 'sha256:642fd873e2254506a61f0cd26b6e2c788b0d13b785d1be76dff7208425f50b48',
});
export const LOCATION_PHOTO_TARGET = Object.freeze({
  hostname: 'lk2.padlhub.su',
  serverId: 8886471,
  projectId: 262717,
});
export const LOCATION_PHOTO_DATABASE_TARGET = Object.freeze({
  databaseName: 'phub_beta',
  systemIdentifier: '7679125609183186977',
});
export const LOCATION_PHOTO_EDITOR_ACL = Object.freeze([
  Object.freeze(['notifications.scenario_commands', 'INSERT']),
  Object.freeze(['notifications.scenario_commands', 'SELECT']),
  Object.freeze(['notifications.scenario_runs', 'SELECT']),
  Object.freeze(['notifications.scenario_runs', 'UPDATE']),
  Object.freeze(['notifications.scenario_staff_tasks', 'SELECT']),
  Object.freeze(['notifications.scenario_versions', 'INSERT']),
  Object.freeze(['notifications.scenarios', 'INSERT']),
  Object.freeze(['notifications.scenarios', 'SELECT']),
  Object.freeze(['notifications.scenarios', 'UPDATE']),
]);
export const LOCATION_PHOTO_SECRET_NAMES = Object.freeze([
  '.release-identity.json',
  'api.env',
  'migrator.env',
  'realtime.env',
  'worker.env',
]);
export const LOCATION_PHOTO_MIGRATOR_PROBE_SOURCE = `import {Client} from 'pg';
const phase=process.argv[1];let client;
try{
 if(!['pre','bootstrap'].includes(phase))throw Error();
 const url=new URL(process.env.DATABASE_URL);
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.search||url.hash)throw Error();
 const wireRoleName=decodeURIComponent(url.username);
 const advisoryLockTimeoutMs=process.env.MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS;
 client=new Client({connectionString:url.toString(),connectionTimeoutMillis:5000,
  options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000'});
 await client.connect();await client.query('begin isolation level repeatable read read only');
 const rows=(await client.query(\`select current_user as "currentRoleName",session_user as "sessionRoleName",
 current_setting('role') as "roleOverride",current_database() as "databaseName",
 (select system_identifier::text from pg_catalog.pg_control_system()) as "systemIdentifier",
 pg_catalog.pg_is_in_recovery() as recovery,current_setting('transaction_read_only') as "readOnly",
 r.rolsuper as superuser,r.rolcreaterole as "createRole",r.rolcreatedb as "createDatabase",
 r.rolreplication as replication,r.rolbypassrls as "bypassRls",
 exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles parent on parent.oid=m.roleid
  where m.member=r.oid and (m.admin_option or parent.rolsuper or parent.rolcreaterole or parent.rolcreatedb
   or parent.rolreplication or parent.rolbypassrls or left(parent.rolname,3)='pg_')) as "privilegedMembership",
 pg_catalog.has_schema_privilege(current_user,'locations','USAGE') as "locationsUsage",
 pg_catalog.has_schema_privilege(current_user,'locations','CREATE') as "locationsCreate",
 pg_catalog.has_schema_privilege(current_user,'public','USAGE') as "publicUsage",
 pg_catalog.has_schema_privilege(current_user,'public','CREATE') as "publicCreate",
 pg_catalog.has_table_privilege(current_user,'public.schema_migrations','SELECT') as "ledgerSelect",
 pg_catalog.has_table_privilege(current_user,'public.schema_migrations','INSERT') as "ledgerInsert",
 (select count(*)::int from public.schema_migrations) as "ledgerRowCount",
 (select coalesce(pg_catalog.json_agg(a.attname order by a.attname),'[]'::json)
    from pg_catalog.pg_attribute a where a.attrelid='locations.profiles'::regclass
     and a.attnum>0 and not a.attisdropped
     and pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'REFERENCES')) as "profilesReferenceColumns",
 (select coalesce(pg_catalog.json_agg(a.attname order by a.attname),'[]'::json)
    from pg_catalog.pg_attribute a where a.attrelid='locations.media_assets'::regclass
     and a.attnum>0 and not a.attisdropped
     and pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'REFERENCES')) as "mediaReferenceColumns",
 (select coalesce(pg_catalog.json_agg(pg_catalog.json_build_object(
    'relation',a.attrelid::regclass::text,'column',a.attname,'grantor',pg_catalog.pg_get_userbyid(x.grantor),
    'grantee',pg_catalog.pg_get_userbyid(x.grantee),'privilege',x.privilege_type,'grantable',x.is_grantable)
    order by a.attrelid::regclass::text,a.attname),'[]'::json)
    from pg_catalog.pg_attribute a cross join lateral pg_catalog.aclexplode(a.attacl) x
   where a.attrelid in ('locations.profiles'::regclass,'locations.media_assets'::regclass)
     and a.attnum>0 and not a.attisdropped and x.grantee=current_user::regrole) as "parentReferenceAcl",
 not exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and database=(select oid from pg_catalog.pg_database where datname=current_database())
  and classid=0 and objid=7140221 and objsubid=1 and granted) as "migrationLockAvailable"
 from pg_catalog.pg_roles r where r.rolname=current_user\`)).rows;
 await client.query('rollback');if(rows.length!==1)throw Error();
 process.stdout.write(JSON.stringify({schema:'PHUB_LOCATION_PHOTO_MIGRATOR_ROLE_READBACK_V1',phase,wireRoleName,advisoryLockTimeoutMs,...rows[0]})+'\\n');
}catch{process.stderr.write('LOCATION_PHOTO_ROLE_PROOF_UNKNOWN\\n');process.exitCode=1;}
finally{await client?.end().catch(()=>{});}`;

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RELEASE = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const PARENT_REFERENCE_ACL = Object.freeze([
  Object.freeze(['locations.media_assets', 'id']),
  Object.freeze(['locations.media_assets', 'tenant_id']),
  Object.freeze(['locations.profiles', 'id']),
  Object.freeze(['locations.profiles', 'tenant_id']),
]);
const stop = (code) => {
  throw new Error(`LOCATION_PHOTO_PROFILE_${code}`);
};
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    stop('SHAPE');
}
function validateParentReferenceAcl(rows, enabled) {
  if (!Array.isArray(rows)) stop('PARENT_REFERENCE_ACL');
  const normalized = rows.map((row) => {
    exact(row, ['relation', 'column', 'grantor', 'grantee', 'privilege', 'grantable']);
    if (
      row.grantor !== 'phub_beta' ||
      row.grantee !== 'phub_migrator' ||
      row.privilege !== 'REFERENCES' ||
      row.grantable !== false
    )
      stop('PARENT_REFERENCE_ACL');
    return [row.relation, row.column];
  });
  if (!same(normalized, enabled ? PARENT_REFERENCE_ACL : [])) stop('PARENT_REFERENCE_ACL');
  return rows;
}
function identity(value, service) {
  exact(value, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
  const repository =
    service === 'postgres' ? 'docker.io/library/postgres' : `ghcr.io/z6v6e6r/phub-${service}`;
  if (
    !HASH.test(value.id ?? '') ||
    !DIGEST.test(value.imageId ?? '') ||
    value.image !== `${repository}@${value.imageId}` ||
    value.restarts !== 0 ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    (service === 'postgres'
      ? value.releaseId !== null || value.revision !== null
      : !SHA.test(value.revision ?? '') ||
        (service === 'api'
          ? !RELEASE.test(value.releaseId ?? '') || !value.releaseId.startsWith(value.revision)
          : value.releaseId !== null && !RELEASE.test(value.releaseId ?? '')))
  )
    stop('RUNTIME_IDENTITY');
}

export function validateLocationPhotoPackage(bytes) {
  const value = parseStrictJson(bytes);
  exact(value, [
    'schema',
    'migration',
    'ledger',
    'databaseTarget',
    'publishedMigrator',
    'editorAcl',
    'temporaryMigratorPrivileges',
    'runtimePhotoAcl',
  ]);
  if (
    value.schema !== 'PHUB_LOCATION_PHOTO_MIGRATION_0102_PACKAGE_V1' ||
    !same(value.migration, LOCATION_PHOTO_MIGRATION) ||
    !same(value.ledger, {
      preCount: 105,
      preSha256: LOCATION_PHOTO_PRE_LEDGER,
      postCount: 106,
      postSha256: LOCATION_PHOTO_POST_LEDGER,
    }) ||
    !same(value.databaseTarget, LOCATION_PHOTO_DATABASE_TARGET) ||
    !same(value.publishedMigrator, LOCATION_PHOTO_PUBLISHED_MIGRATOR) ||
    !same(value.editorAcl, LOCATION_PHOTO_EDITOR_ACL) ||
    !same(value.temporaryMigratorPrivileges, [
      'CREATE:locations',
      'CREATE:public',
      'REFERENCES:locations.media_assets(tenant_id,id)',
      'REFERENCES:locations.profiles(tenant_id,id)',
    ]) ||
    !same(value.runtimePhotoAcl, ['DELETE', 'INSERT', 'SELECT'])
  )
    stop('PACKAGE');
  return value;
}

export function validateLocationPhotoOperation(value, at) {
  exact(value, [
    'schema',
    'profile',
    'target',
    'expectedDatabaseTarget',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'publishedMigrator',
    'packageDescriptorSha256',
    'bootstrapSha256',
    'cleanupSha256',
    'expectedApi',
    'expectedWorker',
    'expectedPostgres',
    'expectedSecretSetReleaseId',
    'expectedSecretSetFiles',
    'expiresAt',
    'confirmation',
  ]);
  if (
    value.schema !== LOCATION_PHOTO_MIGRATION_SCHEMA ||
    value.profile !== 'beta' ||
    !same(value.target, LOCATION_PHOTO_TARGET) ||
    !same(value.expectedDatabaseTarget, LOCATION_PHOTO_DATABASE_TARGET) ||
    !SHA.test(value.controllerSha ?? '') ||
    !SHA.test(value.controllerTree ?? '') ||
    !/^[1-9][0-9]*$/.test(value.controllerSourceCiRunId ?? '') ||
    !same(value.publishedMigrator, LOCATION_PHOTO_PUBLISHED_MIGRATOR) ||
    !/^ghcr\.io\/z6v6e6r\/phub-migrator@sha256:[a-f0-9]{64}$/.test(
      value.publishedMigrator?.image ?? '',
    ) ||
    !DIGEST.test(value.publishedMigrator?.imageId ?? '') ||
    ![value.packageDescriptorSha256, value.bootstrapSha256, value.cleanupSha256].every((v) =>
      HASH.test(v ?? ''),
    )
  )
    stop('OPERATION');
  identity(value.expectedApi, 'api');
  identity(value.expectedWorker, 'worker');
  identity(value.expectedPostgres, 'postgres');
  if (!RELEASE.test(value.expectedSecretSetReleaseId ?? '')) stop('SECRET_SET');
  exact(value.expectedSecretSetFiles, LOCATION_PHOTO_SECRET_NAMES);
  if (!Object.values(value.expectedSecretSetFiles).every((v) => HASH.test(v ?? '')))
    stop('SECRET_SET');
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== value.expiresAt ||
    (at !== undefined && (expires - at < 20 * 60_000 || expires - at > 60 * 60_000)) ||
    value.confirmation !==
      'MIGRATE_LOCATION_PHOTO_0102_105_TO_106_TEMP_CREATE_LOCATIONS_PUBLIC_PARENT_REFERENCES_PRESERVE_EDITOR_ACL_NO_APP_DEPLOY'
  )
    stop('AUTHORITY');
  return value;
}

export function validateLocationPhotoBackupOperation(value, at) {
  exact(value, [
    'schema',
    'profile',
    'target',
    'expectedDatabaseTarget',
    'toolCommit',
    'toolFileSha256',
    'controllerSha',
    'toolProofSha256',
    'toolInstallationSha256',
    'controllerTree',
    'controllerConfigSha256',
    'expectedBoundarySha256',
    'expectedApi',
    'expectedPostgres',
    'expiresAt',
    'confirmation',
    'releaseId',
    'controllerSourceCiRunId',
    'expectedLedgerSha256',
    'packageDescriptorSha256',
    'migratorPrefetch',
  ]);
  exact(value.migratorPrefetch, ['requestSha256', 'receiptSha256', 'migratorImage', 'imageId']);
  if (
    value.schema !== LOCATION_PHOTO_BACKUP_SCHEMA ||
    value.profile !== 'beta' ||
    !same(value.target, LOCATION_PHOTO_TARGET) ||
    !same(value.expectedDatabaseTarget, LOCATION_PHOTO_DATABASE_TARGET) ||
    !SHA.test(value.controllerSha ?? '') ||
    value.toolCommit !== value.controllerSha ||
    !SHA.test(value.controllerTree ?? '') ||
    !/^[1-9][0-9]*$/.test(value.controllerSourceCiRunId ?? '') ||
    value.releaseId !== `${value.controllerSha}-${value.controllerSourceCiRunId}-1` ||
    value.expectedLedgerSha256 !== LOCATION_PHOTO_PRE_LEDGER ||
    !HASH.test(value.migratorPrefetch.requestSha256 ?? '') ||
    !HASH.test(value.migratorPrefetch.receiptSha256 ?? '') ||
    value.migratorPrefetch.migratorImage !== LOCATION_PHOTO_PUBLISHED_MIGRATOR.image ||
    value.migratorPrefetch.imageId !== LOCATION_PHOTO_PUBLISHED_MIGRATOR.imageId ||
    ![
      value.toolFileSha256,
      value.toolProofSha256,
      value.toolInstallationSha256,
      value.controllerConfigSha256,
      value.expectedBoundarySha256,
      value.packageDescriptorSha256,
    ].every((item) => HASH.test(item ?? '')) ||
    value.confirmation !== 'BACKUP_RESTORE_LOCATION_PHOTO_PRE0102_PRIVATE_NAMESPACE_KEEP_RUNTIME'
  )
    stop('BACKUP_OPERATION');
  identity(value.expectedApi, 'api');
  identity(value.expectedPostgres, 'postgres');
  const expires = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== value.expiresAt ||
    (at !== undefined && (expires - at < 20 * 60_000 || expires - at > 60 * 60_000))
  )
    stop('BACKUP_AUTHORITY');
  return value;
}

export function validateLocationPhotoMigratorReadback(value, phase, target) {
  exact(value, [
    'schema',
    'phase',
    'wireRoleName',
    'advisoryLockTimeoutMs',
    'currentRoleName',
    'sessionRoleName',
    'roleOverride',
    'databaseName',
    'systemIdentifier',
    'recovery',
    'readOnly',
    'superuser',
    'createRole',
    'createDatabase',
    'replication',
    'bypassRls',
    'privilegedMembership',
    'locationsUsage',
    'locationsCreate',
    'publicUsage',
    'publicCreate',
    'ledgerSelect',
    'ledgerInsert',
    'ledgerRowCount',
    'profilesReferenceColumns',
    'mediaReferenceColumns',
    'parentReferenceAcl',
    'migrationLockAvailable',
  ]);
  exact(target, ['databaseName', 'systemIdentifier']);
  validateParentReferenceAcl(value.parentReferenceAcl, phase === 'bootstrap');
  if (
    !['pre', 'bootstrap'].includes(phase) ||
    value.schema !== 'PHUB_LOCATION_PHOTO_MIGRATOR_ROLE_READBACK_V1' ||
    value.phase !== phase ||
    value.wireRoleName !== 'phub_migrator' ||
    value.advisoryLockTimeoutMs !== '30000' ||
    value.currentRoleName !== 'phub_migrator' ||
    value.sessionRoleName !== 'phub_migrator' ||
    value.roleOverride !== 'none' ||
    value.databaseName !== target.databaseName ||
    value.systemIdentifier !== target.systemIdentifier ||
    value.recovery !== false ||
    value.readOnly !== 'on' ||
    [
      'superuser',
      'createRole',
      'createDatabase',
      'replication',
      'bypassRls',
      'privilegedMembership',
    ].some((key) => value[key] !== false) ||
    value.locationsUsage !== true ||
    value.locationsCreate !== (phase === 'bootstrap') ||
    value.publicUsage !== true ||
    value.publicCreate !== (phase === 'bootstrap') ||
    value.ledgerSelect !== true ||
    value.ledgerInsert !== true ||
    value.ledgerRowCount !== 105 ||
    !same(value.profilesReferenceColumns, phase === 'bootstrap' ? ['id', 'tenant_id'] : []) ||
    !same(value.mediaReferenceColumns, phase === 'bootstrap' ? ['id', 'tenant_id'] : []) ||
    value.migrationLockAvailable !== true
  )
    stop('MIGRATOR_ROLE');
  return value;
}

export function attestLocationPhotoControllerSource(operation, deps) {
  const { git, read, secure, present } = deps,
    assertGitConfig = deps.assertGitConfig ?? assertControllerPromotionGitConfig;
  const source = '/opt/phub/timeweb-beta/standard/source';
  if (!secure(source, 0o700).isDirectory() || !secure(`${source}/.git`).isDirectory())
    stop('SOURCE_DIRECTORY');
  // This must precede every discovery/read command executed in the repository.
  assertGitConfig(git);
  const config = parseStrictJson(read('/etc/phub/timeweb-beta-standard-delivery.json'));
  exact(config, ['schema', 'enabled', 'owner', 'controllerSha']);
  if (
    git(['rev-parse', '--show-toplevel']) !== source ||
    git(['rev-parse', '--absolute-git-dir']) !== `${source}/.git` ||
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !== `${source}/.git` ||
    git(['rev-parse', 'HEAD']) !== operation.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== operation.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all']) ||
    config.schema !== 1 ||
    config.enabled !== true ||
    typeof config.owner !== 'string' ||
    !config.owner.trim() ||
    config.controllerSha !== operation.controllerSha ||
    present(`${source}/.git/objects/info/alternates`) ||
    present(`${source}/.git/shallow`)
  )
    stop('SOURCE');
  if (
    git(['rev-parse', `${LOCATION_PHOTO_CONTROLLER_BASE.sha}^{tree}`]) !==
    LOCATION_PHOTO_CONTROLLER_BASE.tree
  )
    stop('SOURCE_BASE');
  git(['merge-base', '--is-ancestor', LOCATION_PHOTO_CONTROLLER_BASE.sha, operation.controllerSha]);
  validateLocationPhotoControllerClosure(
    parseApiWorkerControllerDiff(
      git([
        'diff',
        '--no-renames',
        '--raw',
        '--abbrev=40',
        '-z',
        LOCATION_PHOTO_CONTROLLER_BASE.sha,
        operation.controllerSha,
      ]),
    ),
  );
  for (const item of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/.exec(item);
    if (
      !match ||
      match[2].startsWith('/') ||
      match[2].split('/').includes('..') ||
      match[2].includes('\\')
    )
      stop('SOURCE_FILE');
    secure(`${source}/${match[2]}`, match[1] === '100644' ? 0o644 : 0o755);
  }
  return operation;
}

export function attestLocationPhotoBackupSource(operation, deps) {
  validateLocationPhotoBackupOperation(operation);
  const { git, read, secure, present } = deps;
  const source = '/opt/phub/timeweb-beta/standard/source';
  attestLocationPhotoControllerSource(operation, { git, read, secure, present });
  const descriptor = read(`${source}/deploy/timeweb/location-photo-migration-0102.v1.json`, 0o644),
    migration = read(
      `${source}/packages/database/migrations/${LOCATION_PHOTO_MIGRATION.filename}`,
      0o644,
    );
  validateLocationPhotoPackage(descriptor);
  if (
    hash(descriptor) !== operation.packageDescriptorSha256 ||
    hash(migration) !== LOCATION_PHOTO_MIGRATION.sha256 ||
    git([
      'hash-object',
      `${source}/packages/database/migrations/${LOCATION_PHOTO_MIGRATION.filename}`,
    ]) !== LOCATION_PHOTO_MIGRATION.gitBlob
  )
    stop('SOURCE_INPUT');
  return operation;
}

export function validateLocationPhotoManifest(operation, manifest, manifestBytes) {
  validateLocationPhotoOperation(operation);
  if (
    hash(manifestBytes) !== operation.publishedMigrator.manifestSha256 ||
    manifest?.schemaVersion !== 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2' ||
    manifest.gitCommit !== operation.publishedMigrator.sourceSha ||
    manifest.gitTree !== operation.publishedMigrator.sourceTree ||
    String(manifest.publication?.runId) !== operation.publishedMigrator.publicationRunId ||
    manifest.publication?.runAttempt !== operation.publishedMigrator.publicationRunAttempt
  )
    stop('MANIFEST');
  const images = manifest.images?.filter((row) => row.component === 'migrator') ?? [];
  if (
    images.length !== 1 ||
    `ghcr.io/z6v6e6r/phub-migrator@${images[0].digest}` !== operation.publishedMigrator.image ||
    images[0].runtimeDigest !== operation.publishedMigrator.imageId ||
    images[0].revision !== operation.publishedMigrator.sourceSha
  )
    stop('MANIFEST');
  return manifest;
}

export function validateLocationPhotoLedger(rows, phase) {
  const expectedCount = ['pre', 'bootstrap'].includes(phase) ? 105 : 106;
  const expectedHash =
    expectedCount === 105 ? LOCATION_PHOTO_PRE_LEDGER : LOCATION_PHOTO_POST_LEDGER;
  if (!Array.isArray(rows) || rows.length !== expectedCount) stop('LEDGER');
  let previous = '';
  for (const row of rows) {
    exact(row, ['filename', 'checksum']);
    if (
      !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(row.filename ?? '') ||
      !HASH.test(row.checksum ?? '') ||
      row.filename <= previous
    )
      stop('LEDGER');
    previous = row.filename;
  }
  if (hash(JSON.stringify(rows.map((row) => [row.filename, row.checksum])) + '\n') !== expectedHash)
    stop('LEDGER');
  if (
    expectedCount === 106 &&
    (rows[105].filename !== LOCATION_PHOTO_MIGRATION.filename ||
      rows[105].checksum !== LOCATION_PHOTO_MIGRATION.sha256)
  )
    stop('LEDGER');
  return expectedHash;
}

export function validateLocationPhotoState(
  value,
  phase,
  expectedTarget = LOCATION_PHOTO_DATABASE_TARGET,
) {
  if (!['pre', 'bootstrap', 'post', 'cleanup'].includes(phase)) stop('STATE_PHASE');
  exact(value, [
    'schema',
    'phase',
    'target',
    'ledger',
    'rolesSafe',
    'privileges',
    'hazards',
    'editorAcl',
    'photo',
  ]);
  exact(value.target, ['databaseName', 'systemIdentifier']);
  exact(expectedTarget, ['databaseName', 'systemIdentifier']);
  exact(value.privileges, [
    'migratorUsage',
    'migratorCreate',
    'migratorPublicUsage',
    'migratorPublicCreate',
    'migratorProfilesReferenceColumns',
    'migratorMediaReferenceColumns',
    'migratorParentReferenceAcl',
    'parentColumnAclCount',
    'runtimeUsage',
    'runtimeProfilesSelect',
    'runtimeMediaSelect',
  ]);
  exact(value.hazards, ['migrationLockHeld', 'longTransactions', 'conflictingLocks']);
  exact(value.photo, ['exists', 'owner', 'rowCount', 'catalogOk', 'nonOwnerAcl', 'columnAclCount']);
  validateParentReferenceAcl(
    value.privileges.migratorParentReferenceAcl,
    ['bootstrap', 'post'].includes(phase),
  );
  if (
    value.schema !== 'PHUB_LOCATION_PHOTO_DATABASE_STATE_V1' ||
    value.phase !== phase ||
    !same(value.target, expectedTarget) ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(value.target.databaseName ?? '') ||
    !/^[1-9][0-9]*$/.test(value.target.systemIdentifier ?? '') ||
    value.rolesSafe !== true ||
    value.privileges.migratorUsage !== true ||
    value.privileges.migratorCreate !== ['bootstrap', 'post'].includes(phase) ||
    value.privileges.migratorPublicUsage !== true ||
    value.privileges.migratorPublicCreate !== ['bootstrap', 'post'].includes(phase) ||
    value.privileges.parentColumnAclCount !== (['bootstrap', 'post'].includes(phase) ? 4 : 0) ||
    !same(
      value.privileges.migratorProfilesReferenceColumns,
      ['bootstrap', 'post'].includes(phase) ? ['id', 'tenant_id'] : [],
    ) ||
    !same(
      value.privileges.migratorMediaReferenceColumns,
      ['bootstrap', 'post'].includes(phase) ? ['id', 'tenant_id'] : [],
    ) ||
    value.privileges.runtimeUsage !== true ||
    value.privileges.runtimeProfilesSelect !== true ||
    value.privileges.runtimeMediaSelect !== true ||
    value.hazards.migrationLockHeld !== false ||
    value.hazards.longTransactions !== 0 ||
    value.hazards.conflictingLocks !== 0
  )
    stop('STATE');
  validateLocationPhotoLedger(value.ledger, phase);
  const editor = value.editorAcl.map((row) => {
    exact(row, ['relation', 'grantor', 'grantee', 'privilege', 'grantable']);
    if (
      row.grantor !== 'phub_migrator' ||
      row.grantee !== 'phub_runtime' ||
      row.grantable !== false
    )
      stop('EDITOR_ACL');
    return [row.relation, row.privilege];
  });
  if (!same(editor, LOCATION_PHOTO_EDITOR_ACL)) stop('EDITOR_ACL');
  const exists = ['post', 'cleanup'].includes(phase);
  if (
    value.photo.exists !== exists ||
    (exists
      ? value.photo.owner !== 'phub_migrator' ||
        value.photo.rowCount !== 0 ||
        value.photo.catalogOk !== true ||
        !same(value.photo.nonOwnerAcl, []) ||
        value.photo.columnAclCount !== 0
      : value.photo.owner !== null ||
        value.photo.rowCount !== 0 ||
        value.photo.catalogOk !== false ||
        !same(value.photo.nonOwnerAcl, []) ||
        value.photo.columnAclCount !== 0)
  )
    stop('PHOTO_CATALOG');
  return value;
}

export function locationPhotoStateSql(phase) {
  if (!['pre', 'bootstrap', 'post', 'cleanup'].includes(phase)) stop('STATE_PHASE');
  const expectedExists = ['post', 'cleanup'].includes(phase);
  return `begin isolation level repeatable read read only;
set local search_path='pg_catalog';set local statement_timeout='15s';set local lock_timeout='2s';
with target as (select to_regclass('locations.recommendation_card_photos') oid),
parent_reference_acl as (
 select a.attrelid::regclass::text relation,a.attname "column",pg_get_userbyid(x.grantor) grantor,
        pg_get_userbyid(x.grantee) grantee,x.privilege_type privilege,x.is_grantable grantable
 from pg_attribute a cross join lateral aclexplode(a.attacl) x
 where a.attrelid in ('locations.profiles'::regclass,'locations.media_assets'::regclass)
   and a.attnum>0 and not a.attisdropped and x.grantee='phub_migrator'::regrole
 order by a.attrelid::regclass::text collate "C",a.attname collate "C"
),
editor_acl as (
 select n.nspname||'.'||c.relname relation,pg_get_userbyid(a.grantor) grantor,
        case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee,
        a.privilege_type privilege,a.is_grantable grantable
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 where n.nspname='notifications' and c.relname in ('scenarios','scenario_versions','scenario_commands','scenario_runs','scenario_staff_tasks')
   and a.grantee<>c.relowner
 order by (n.nspname||'.'||c.relname) collate "C",a.privilege_type collate "C"
), photo_acl as (
 select case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee,
        pg_get_userbyid(a.grantor) grantor,a.privilege_type privilege,a.is_grantable grantable
 from target t join pg_class c on c.oid=t.oid
 cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 where a.grantee<>c.relowner
 order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",a.privilege_type collate "C"
), catalog as (
 select t.oid,
   coalesce((select relkind='r' and relpersistence='p' and relowner='phub_migrator'::regrole
     and relam=(select oid from pg_am where amname='heap') and reltablespace=0 and not relhasrules
     and relrowsecurity and relforcerowsecurity and not relispartition and reloptions is null and relreplident='d'
     from pg_class where oid=t.oid),false)
   and not exists(select 1 from pg_inherits where inhrelid=t.oid or inhparent=t.oid)
   and not exists(select 1 from pg_attribute where attrelid=t.oid and attnum>0 and attisdropped)
   and coalesce((select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',coalesce(pg_get_expr(d.adbin,d.adrelid),''),'identity',a.attidentity,'generated',a.attgenerated,'hasMissing',a.atthasmissing,'collationSchema',cn.nspname,'collation',co.collname) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum left join pg_collation co on co.oid=a.attcollation left join pg_namespace cn on cn.oid=co.collnamespace where a.attrelid=t.oid and a.attnum>0 and not a.attisdropped),'[]'::jsonb)
     = '[{"name":"tenant_id","type":"uuid","notNull":true,"default":"","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null},{"name":"location_id","type":"uuid","notNull":true,"default":"","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null},{"name":"asset_id","type":"uuid","notNull":true,"default":"","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null},{"name":"event_type","type":"text","notNull":true,"default":"","identity":"","generated":"","hasMissing":false,"collationSchema":"pg_catalog","collation":"default"},{"name":"is_active","type":"boolean","notNull":true,"default":"false","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null},{"name":"sort_order","type":"integer","notNull":true,"default":"0","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null},{"name":"created_at","type":"timestamp with time zone","notNull":true,"default":"now()","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null},{"name":"updated_at","type":"timestamp with time zone","notNull":true,"default":"now()","identity":"","generated":"","hasMissing":false,"collationSchema":null,"collation":null}]'::jsonb
   and coalesce((select jsonb_agg(jsonb_build_object('name',conname,'type',contype,'keys',conkey,'foreignKeys',confkey,'foreignRelation',case when confrelid=0 then null else confrelid::regclass::text end,'definition',pg_get_constraintdef(oid,true),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred,'match',case when contype='f' then confmatchtype else null end,'update',case when contype='f' then confupdtype else null end,'delete',case when contype='f' then confdeltype else null end) order by conname collate "C") from pg_constraint where conrelid=t.oid),'[]'::jsonb)
     = '[{"name":"recommendation_card_photos_event_type_check","type":"c","keys":[4],"foreignKeys":null,"foreignRelation":null,"definition":"CHECK (event_type = ANY (ARRAY[''GAME''::text, ''COACH_GAME''::text, ''TRAINING''::text, ''TOURNAMENT''::text]))","validated":true,"deferrable":false,"deferred":false,"match":null,"update":null,"delete":null},{"name":"recommendation_card_photos_pkey","type":"p","keys":[1,2,4,3],"foreignKeys":null,"foreignRelation":null,"definition":"PRIMARY KEY (tenant_id, location_id, event_type, asset_id)","validated":true,"deferrable":false,"deferred":false,"match":null,"update":null,"delete":null},{"name":"recommendation_card_photos_sort_order_check","type":"c","keys":[6],"foreignKeys":null,"foreignRelation":null,"definition":"CHECK (sort_order >= 0 AND sort_order <= 99)","validated":true,"deferrable":false,"deferred":false,"match":null,"update":null,"delete":null},{"name":"recommendation_card_photos_tenant_id_asset_id_fkey","type":"f","keys":[1,3],"foreignKeys":[1,2],"foreignRelation":"locations.media_assets","definition":"FOREIGN KEY (tenant_id, asset_id) REFERENCES locations.media_assets(tenant_id, id)","validated":true,"deferrable":false,"deferred":false,"match":"s","update":"a","delete":"a"},{"name":"recommendation_card_photos_tenant_id_location_id_fkey","type":"f","keys":[1,2],"foreignKeys":[1,2],"foreignRelation":"locations.profiles","definition":"FOREIGN KEY (tenant_id, location_id) REFERENCES locations.profiles(tenant_id, id) ON DELETE CASCADE","validated":true,"deferrable":false,"deferred":false,"match":"s","update":"a","delete":"c"}]'::jsonb
   and coalesce((select jsonb_agg(jsonb_build_object('name',idx.relname,'definition',pg_get_indexdef(i.indexrelid),'method',am.amname,'keys',i.indkey::text,'attributes',(select jsonb_agg(jsonb_build_object('position',u.ordinality,'opclassSchema',opn.nspname,'opclass',opc.opcname,'collationSchema',coln.nspname,'collation',coll.collname,'option',u.option) order by u.ordinality) from unnest(i.indclass::oid[],i.indcollation::oid[],i.indoption::smallint[]) with ordinality u(opclass_oid,collation_oid,option,ordinality) join pg_opclass opc on opc.oid=u.opclass_oid join pg_namespace opn on opn.oid=opc.opcnamespace left join pg_collation coll on coll.oid=u.collation_oid left join pg_namespace coln on coln.oid=coll.collnamespace),'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'replident',i.indisreplident,'predicate',pg_get_expr(i.indpred,i.indrelid),'expressions',pg_get_expr(i.indexprs,i.indrelid)) order by idx.relname collate "C") from pg_index i join pg_class idx on idx.oid=i.indexrelid join pg_am am on am.oid=idx.relam where i.indrelid=t.oid),'[]'::jsonb)
     = '[{"name":"locations_recommendation_card_photos_read_idx","definition":"CREATE INDEX locations_recommendation_card_photos_read_idx ON locations.recommendation_card_photos USING btree (tenant_id, location_id, event_type, is_active, sort_order, asset_id)","method":"btree","keys":"1 2 4 5 6 3","attributes":[{"position":1,"opclassSchema":"pg_catalog","opclass":"uuid_ops","collationSchema":null,"collation":null,"option":0},{"position":2,"opclassSchema":"pg_catalog","opclass":"uuid_ops","collationSchema":null,"collation":null,"option":0},{"position":3,"opclassSchema":"pg_catalog","opclass":"text_ops","collationSchema":"pg_catalog","collation":"default","option":0},{"position":4,"opclassSchema":"pg_catalog","opclass":"bool_ops","collationSchema":null,"collation":null,"option":0},{"position":5,"opclassSchema":"pg_catalog","opclass":"int4_ops","collationSchema":null,"collation":null,"option":0},{"position":6,"opclassSchema":"pg_catalog","opclass":"uuid_ops","collationSchema":null,"collation":null,"option":0}],"unique":false,"primary":false,"valid":true,"ready":true,"live":true,"replident":false,"predicate":null,"expressions":null},{"name":"recommendation_card_photos_pkey","definition":"CREATE UNIQUE INDEX recommendation_card_photos_pkey ON locations.recommendation_card_photos USING btree (tenant_id, location_id, event_type, asset_id)","method":"btree","keys":"1 2 4 3","attributes":[{"position":1,"opclassSchema":"pg_catalog","opclass":"uuid_ops","collationSchema":null,"collation":null,"option":0},{"position":2,"opclassSchema":"pg_catalog","opclass":"uuid_ops","collationSchema":null,"collation":null,"option":0},{"position":3,"opclassSchema":"pg_catalog","opclass":"text_ops","collationSchema":"pg_catalog","collation":"default","option":0},{"position":4,"opclassSchema":"pg_catalog","opclass":"uuid_ops","collationSchema":null,"collation":null,"option":0}],"unique":true,"primary":true,"valid":true,"ready":true,"live":true,"replident":false,"predicate":null,"expressions":null}]'::jsonb
   and coalesce((select jsonb_agg(jsonb_build_object('name',polname,'cmd',polcmd,'permissive',polpermissive,'roles',polroles::text,'qual',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) order by polname collate "C") from pg_policy where polrelid=t.oid),'[]'::jsonb)
     = '[{"name":"location_recommendation_card_photos_tenant_isolation","cmd":"*","permissive":true,"roles":"{0}","qual":"(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)","check":"(tenant_id = (NULLIF(current_setting(''app.tenant_id''::text, true), ''''::text))::uuid)"}]'::jsonb
   and not exists(select 1 from pg_rewrite where ev_class=t.oid)
   and not exists(select 1 from pg_trigger where tgrelid=t.oid and not tgisinternal) catalog_ok
 from target t
)
select jsonb_build_object(
 'schema','PHUB_LOCATION_PHOTO_DATABASE_STATE_V1','phase','${phase}',
 'target',jsonb_build_object('databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_control_system())),
 'ledger',(select coalesce(jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum) order by filename),'[]'::jsonb) from public.schema_migrations),
 'rolesSafe',(select count(*)=2 and bool_and(not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls and rolcanlogin) from pg_roles where rolname in ('phub_migrator','phub_runtime'))
   and not exists(select 1 from pg_auth_members where member in(select oid from pg_roles where rolname in('phub_migrator','phub_runtime')) or roleid in(select oid from pg_roles where rolname in('phub_migrator','phub_runtime'))),
 'privileges',jsonb_build_object(
   'migratorUsage',has_schema_privilege('phub_migrator','locations','USAGE'),
   'migratorCreate',has_schema_privilege('phub_migrator','locations','CREATE'),
   'migratorPublicUsage',has_schema_privilege('phub_migrator','public','USAGE'),
   'migratorPublicCreate',has_schema_privilege('phub_migrator','public','CREATE'),
   'migratorProfilesReferenceColumns',(select coalesce(jsonb_agg(attname order by attname),'[]'::jsonb) from pg_attribute where attrelid='locations.profiles'::regclass and attnum>0 and not attisdropped and has_column_privilege('phub_migrator',attrelid,attnum,'REFERENCES')),
   'migratorMediaReferenceColumns',(select coalesce(jsonb_agg(attname order by attname),'[]'::jsonb) from pg_attribute where attrelid='locations.media_assets'::regclass and attnum>0 and not attisdropped and has_column_privilege('phub_migrator',attrelid,attnum,'REFERENCES')),
   'migratorParentReferenceAcl',(select coalesce(jsonb_agg(to_jsonb(r) order by relation collate "C","column" collate "C"),'[]'::jsonb) from parent_reference_acl r),
   'parentColumnAclCount',(select count(*)::int from pg_attribute where attrelid in ('locations.profiles'::regclass,'locations.media_assets'::regclass) and attnum>0 and not attisdropped and attacl is not null),
   'runtimeUsage',has_schema_privilege('phub_runtime','locations','USAGE'),
   'runtimeProfilesSelect',has_table_privilege('phub_runtime','locations.profiles','SELECT'),
   'runtimeMediaSelect',has_table_privilege('phub_runtime','locations.media_assets','SELECT')),
 'hazards',jsonb_build_object(
   'migrationLockHeld',exists(select 1 from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database()) and classid=0 and objid=7140221 and objsubid=1 and granted),
   'longTransactions',(select count(*)::int from pg_stat_activity where datid=(select oid from pg_database where datname=current_database()) and pid<>pg_backend_pid() and xact_start is not null and state<>'idle' and xact_start<clock_timestamp()-interval '30 seconds'),
   'conflictingLocks',(select count(*)::int from pg_locks where pid is distinct from pg_backend_pid()
     and relation in ('locations.profiles'::regclass,'locations.media_assets'::regclass,'public.schema_migrations'::regclass,(select oid from target))
     and (not granted or mode in ('RowExclusiveLock','ShareUpdateExclusiveLock','ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')))),
 'editorAcl',(select coalesce(jsonb_agg(to_jsonb(e) order by relation collate "C",privilege collate "C"),'[]'::jsonb) from editor_acl e),
 'photo',jsonb_build_object('exists',(select oid is not null from target),'owner',(select pg_get_userbyid(relowner) from target join pg_class on pg_class.oid=target.oid),'rowCount',${expectedExists ? '(select count(*)::int from locations.recommendation_card_photos)' : '0'},'catalogOk',coalesce((select catalog_ok from catalog),false),'nonOwnerAcl',(select coalesce(jsonb_agg(to_jsonb(a) order by grantee collate "C",privilege collate "C"),'[]'::jsonb) from photo_acl a),'columnAclCount',(select count(*)::int from target join pg_attribute on attrelid=target.oid where attnum>0 and not attisdropped and attacl is not null))
)::text;
rollback;`;
}

export const locationPhotoHash = hash;
