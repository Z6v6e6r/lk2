// A noncanonical predecessor is an observed rollback source, never a canonical publication.
// Only the explicit production-cutover operation may consume this evidence.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';

export const CUTOVER_OPERATION = 'PHUB_TIMEWEB_API_WEB_PRODUCTION_CUTOVER_V1';
export const CUTOVER_PLAN = 'PHUB_TIMEWEB_API_WEB_CUTOVER_PLAN_V1';
export const CUTOVER_RECEIPT = 'PHUB_TIMEWEB_API_WEB_CUTOVER_RECEIPT_V1';
export const LEGACY_RUNTIME = 'LEGACY_TEST_STAND_RUNTIME_V1';
export const LEGACY_SOURCE_SHA = '759083e37b4026f9690a3775a391f59f68f716a5';
export const COMPONENTS = ['api', 'web', 'worker', 'realtime', 'migrator'];
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const NUMBER = /^[1-9][0-9]*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const ROOT = '/opt/phub/timeweb-beta';
const RUNTIME = '/etc/phub/timeweb-beta';
const REGISTRY = 'ghcr.io/z6v6e6r';
const SECRETS = ['.release-identity.json', 'api.env', 'worker.env', 'realtime.env', 'migrator.env'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => {
  throw new Error(`production_cutover_${reason}`);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !equal(Object.keys(value).sort(), [...keys].sort())
  )
    fail('keys');
}
function image(component, value) {
  return new RegExp(`^${REGISTRY}/phub-${component}@sha256:[a-f0-9]{64}$`).test(value ?? '');
}
function timestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
export const isProductionCutover = (value) => value?.schema === CUTOVER_OPERATION;
export const legacyBaselineHash = (baseline) => hash(JSON.stringify(baseline));
export function validateLegacyBaseline(value) {
  exact(value, [
    'schema',
    'sourceSha',
    'sourceTree',
    'sourceCiRunId',
    'testStandRunId',
    'capturedAt',
    'releaseEnvSha256',
    'secretSetReleaseId',
    'secretHashes',
    'containers',
    'excludedSha256',
    'laneCurrentSha256',
    'laneHistorySha256',
    'databaseTarget',
    'ledgerSha256',
    'buildRecords',
  ]);
  if (
    value.schema !== LEGACY_RUNTIME ||
    !SHA.test(value.sourceSha ?? '') ||
    value.sourceSha !== LEGACY_SOURCE_SHA ||
    value.sourceCiRunId !== '43199615483' ||
    value.testStandRunId !== '43202079490' ||
    !SHA.test(value.sourceTree ?? '') ||
    !NUMBER.test(value.sourceCiRunId ?? '') ||
    !NUMBER.test(value.testStandRunId ?? '') ||
    !timestamp(value.capturedAt) ||
    !HASH.test(value.releaseEnvSha256 ?? '') ||
    !ID.test(value.secretSetReleaseId ?? '') ||
    ![
      value.excludedSha256,
      value.laneCurrentSha256,
      value.laneHistorySha256,
      value.ledgerSha256,
    ].every((v) => HASH.test(v ?? ''))
  )
    fail('legacy_identity');
  exact(value.databaseTarget, ['databaseName', 'systemIdentifier']);
  if (
    value.databaseTarget.databaseName !== 'phub_beta' ||
    value.databaseTarget.systemIdentifier !== '7679125609183186977'
  )
    fail('database_target');
  exact(value.secretHashes, SECRETS);
  if (SECRETS.some((key) => !HASH.test(value.secretHashes[key] ?? ''))) fail('secret_hash');
  exact(value.containers, ['api', 'web', 'worker', 'realtime']);
  for (const service of ['api', 'web', 'worker', 'realtime']) {
    const c = value.containers[service];
    exact(c, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
    if (
      !HASH.test(c.id ?? '') ||
      !image(service, c.image) ||
      !DIGEST.test(c.imageId ?? '') ||
      c.revision !== null ||
      c.restarts !== 0 ||
      !timestamp(c.startedAt) ||
      c.releaseId !==
        (['api', 'web'].includes(service) ? `lk2-beta-${value.sourceSha.slice(0, 12)}` : null)
    )
      fail('legacy_container');
  }
  if (
    !Array.isArray(value.buildRecords) ||
    value.buildRecords.length !== COMPONENTS.length ||
    new Set(value.buildRecords.map((v) => v.component)).size !== COMPONENTS.length
  )
    fail('build_records');
  for (const record of value.buildRecords) {
    exact(record, ['component', 'artifactId', 'artifactName', 'archiveDigest', 'imageDigest']);
    if (
      !COMPONENTS.includes(record.component) ||
      !NUMBER.test(record.artifactId ?? '') ||
      !/^Z6v6e6r~lk2~[A-Z0-9]+\.dockerbuild$/.test(record.artifactName ?? '') ||
      !DIGEST.test(record.archiveDigest ?? '') ||
      !DIGEST.test(record.imageDigest ?? '') ||
      (record.component !== 'migrator' &&
        value.containers[record.component].image !==
          `${REGISTRY}/phub-${record.component}@${record.imageDigest}`)
    )
      fail('build_record');
  }
  return value;
}
export function validateProductionCutover(value, fresh = false, now = Date.now()) {
  exact(value, [
    'schema',
    'profile',
    'target',
    'controllerSha',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'backupOperationSha256',
    'expectedApi',
    'expectedWeb',
    'legacyBaseline',
    'expiresAt',
    'confirmation',
  ]);
  if (
    !isProductionCutover(value) ||
    value.profile !== 'production' ||
    value.target !== 'lk2.padlhub.su' ||
    value.candidateSha !== value.controllerSha ||
    ![value.controllerSha, value.candidateSha, value.candidateTree].every((v) =>
      SHA.test(v ?? ''),
    ) ||
    ![value.sourceCiRunId, value.publicationRunId, value.artifactId].every((v) =>
      NUMBER.test(v ?? ''),
    ) ||
    !DIGEST.test(value.artifactDigest ?? '') ||
    !HASH.test(value.manifestSha256 ?? '') ||
    !HASH.test(value.backupOperationSha256 ?? '') ||
    !timestamp(value.expiresAt)
  )
    fail('operation');
  const baseline = validateLegacyBaseline(value.legacyBaseline);
  for (const [key, service] of [
    ['expectedApi', 'api'],
    ['expectedWeb', 'web'],
  ]) {
    exact(value[key], ['id', 'image', 'releaseId']);
    if (
      Object.keys(value[key]).some(
        (field) => value[key][field] !== baseline.containers[service][field],
      )
    )
      fail('previous_identity');
  }
  const expected = `CUTOVER_PRODUCTION_${value.candidateSha.slice(0, 12).toUpperCase()}_FROM_${legacyBaselineHash(baseline).slice(0, 12).toUpperCase()}_KEEP_DATA_AND_ACCOUNTS`;
  if (value.confirmation !== expected) fail('confirmation');
  if (
    fresh &&
    (Date.parse(value.expiresAt) <= now ||
      Date.parse(value.expiresAt) - now > 86400000 ||
      now - Date.parse(baseline.capturedAt) > 7200000 ||
      Date.parse(baseline.capturedAt) - now > 30000)
  )
    fail('expired');
  return value;
}
export function legacyReleaseEnvPath(baseline) {
  validateLegacyBaseline(baseline);
  return `${ROOT}/beta-lane/releases/${baseline.sourceSha}.env`;
}
export function legacyBuildArchivePath(baseline, component) {
  validateLegacyBaseline(baseline);
  if (!COMPONENTS.includes(component)) fail('component');
  return `${ROOT}/legacy-baselines/${baseline.sourceSha}/build-${component}.tar.gz`;
}
export function legacyEnvironment(baseline, bytes, identity) {
  validateLegacyBaseline(baseline);
  if (hash(bytes) !== baseline.releaseEnvSha256) fail('environment_hash');
  const values = {};
  for (const line of bytes.toString().trimEnd().split('\n')) {
    const match = /^([A-Z_]+)=([A-Za-z0-9_./:@-]+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('environment');
    values[match[1]] = match[2];
  }
  exact(values, [
    'PHUB_RELEASE_ID',
    'TIMEWEB_RUNTIME_ENV_ROOT',
    'TIMEWEB_FCM_CREDENTIAL_SOURCE',
    ...COMPONENTS.map((v) => `${v.toUpperCase()}_IMAGE_DIGEST`),
  ]);
  if (
    values.PHUB_RELEASE_ID !== baseline.containers.api.releaseId ||
    values.TIMEWEB_RUNTIME_ENV_ROOT !== RUNTIME ||
    values.TIMEWEB_FCM_CREDENTIAL_SOURCE !== '/etc/phub/timeweb-beta-fcm/fcm-service-account.json'
  )
    fail('environment_paths');
  for (const record of baseline.buildRecords)
    if (values[`${record.component.toUpperCase()}_IMAGE_DIGEST`] !== record.imageDigest)
      fail('environment_digest');
  exact(identity, ['schema', 'releaseId']);
  if (
    identity.schema !== 'PHUB_TIMEWEB_SECRET_SET_V1' ||
    identity.releaseId !== baseline.secretSetReleaseId
  )
    fail('secret_identity');
  return {
    ...values,
    REGISTRY,
    COMPOSE_PROFILES: '',
    PHUB_WORKER_ENABLED: 'true',
    PHUB_MIGRATOR_ENABLED: 'false',
    PHUB_RUNTIME_SECRET_SET_RELEASE_ID: baseline.secretSetReleaseId,
    PHUB_API_RUNTIME_ENV_FILE: `${RUNTIME}/api.env`,
    PHUB_REALTIME_RUNTIME_ENV_FILE: `${RUNTIME}/realtime.env`,
    PHUB_WORKER_RUNTIME_ENV_FILE: `${RUNTIME}/worker.env`,
    PHUB_MIGRATOR_RUNTIME_ENV_FILE: `${RUNTIME}/migrator.env`,
  };
}
export function validateLegacyRuntime(baseline, containers, excluded, secretHashes) {
  validateLegacyBaseline(baseline);
  if (
    !equal(containers, baseline.containers) ||
    hash(JSON.stringify(excluded)) !== baseline.excludedSha256 ||
    !SECRETS.every((v) => secretHashes[v] === baseline.secretHashes[v])
  )
    fail('runtime_drift');
}
export function validateLegacyRun(run, baseline) {
  if (
    String(run.id) !== baseline.testStandRunId ||
    run.head_sha !== baseline.sourceSha ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_run' ||
    run.path !== '.github/workflows/test-stand.yaml'
  )
    fail('test_stand_run');
}
export function validateLegacyArtifact(artifact, record, baseline) {
  if (
    String(artifact?.id) !== record.artifactId ||
    artifact?.name !== record.artifactName ||
    artifact?.digest !== record.archiveDigest ||
    artifact?.expired !== false ||
    String(artifact?.workflow_run?.id) !== baseline.testStandRunId ||
    artifact?.workflow_run?.head_sha !== baseline.sourceSha
  )
    fail('artifact');
}
// blob() returns bounded tar members without extracting any paths to the filesystem.
export function validateLegacyBuildRecord(baseline, component, archiveBytes, indexBytes, blob) {
  validateLegacyBaseline(baseline);
  const record = baseline.buildRecords.find((v) => v.component === component);
  if (!record || `sha256:${hash(archiveBytes)}` !== record.archiveDigest) fail('archive');
  const load = (digest) => {
    if (!DIGEST.test(digest ?? '')) fail('blob_digest');
    const bytes = blob(digest);
    if (`sha256:${hash(bytes)}` !== digest) fail('blob_hash');
    return parseStrictJson(bytes);
  };
  const index = parseStrictJson(indexBytes);
  if (index.schemaVersion !== 2 || index.manifests?.length !== 1) fail('archive_index');
  const manifest = load(index.manifests[0].digest);
  if (manifest.config?.mediaType !== 'application/vnd.buildkit.historyrecord.v0')
    fail('record_type');
  const history = load(manifest.config.digest);
  const attrs = history.FrontendAttrs;
  if (
    attrs?.['vcs:revision'] !== baseline.sourceSha ||
    attrs?.['vcs:source'] !== 'https://github.com/Z6v6e6r/lk2' ||
    attrs?.['vcs:localdir:dockerfile'] !== `apps/${component}` ||
    attrs?.filename !== 'Dockerfile' ||
    attrs?.platform !== 'linux/amd64' ||
    attrs?.['build-arg:PHUB_RELEASE'] !== baseline.sourceSha ||
    attrs?.['attest:provenance'] !==
      `type=provenance,builder-id=https://github.com/Z6v6e6r/lk2/actions/runs/${baseline.testStandRunId}/attempts/1,mode=max` ||
    history.Result?.Results?.['0']?.digest !== record.imageDigest ||
    !history.CompletedAt ||
    history.error ||
    history.Error
  )
    fail('build_source');
  const result = load(record.imageDigest);
  if (
    result.schemaVersion !== 2 ||
    !result.manifests?.some(
      (v) => v.platform?.os === 'linux' && v.platform?.architecture === 'amd64',
    )
  )
    fail('build_result');
}
export function validateCutoverLineage(receipt, plan, operation, descriptor, operationBytes) {
  validateProductionCutover(operation);
  const digest = legacyBaselineHash(operation.legacyBaseline);
  if (
    receipt.schema !== CUTOVER_RECEIPT ||
    plan.schema !== CUTOVER_PLAN ||
    receipt.legacyBaselineSha256 !== digest ||
    plan.legacyBaselineSha256 !== digest ||
    descriptor.PHUB_LEGACY_PREDECESSOR_SHA256 !== digest ||
    descriptor.PHUB_LEGACY_PREDECESSOR_RELEASE_ID !== operation.expectedApi.releaseId ||
    !Buffer.isBuffer(operationBytes) ||
    plan.operationSha256 !== hash(operationBytes) ||
    plan.backup?.operationSha256 !== operation.backupOperationSha256 ||
    !equal(parseStrictJson(operationBytes), operation)
  )
    fail('lineage');
}

export function validateCutoverPlanProofs(operation, plan, transaction) {
  exact(plan.backup, [
    'path',
    'sha256',
    'operationPath',
    'operationSha256',
    'receiptPath',
    'receiptSha256',
    'dumpSha256',
  ]);
  exact(plan.monitoring, ['providerSha256', 'alertSha256']);
  if (
    ![
      plan.backup.sha256,
      plan.backup.operationSha256,
      plan.backup.receiptSha256,
      plan.backup.dumpSha256,
      plan.monitoring.providerSha256,
      plan.monitoring.alertSha256,
    ].every((v) => HASH.test(v ?? '')) ||
    plan.backup.path !== `${transaction}/database-backup-receipt.json` ||
    plan.backup.receiptPath !== plan.backup.path ||
    plan.backup.sha256 !== plan.backup.receiptSha256 ||
    plan.backup.operationPath !== `${transaction}/backup-operation.json` ||
    plan.backup.operationSha256 !== operation.backupOperationSha256
  )
    fail('backup_drift');
}

export function assertCutoverBackupFiles(operation, plan, transaction, read, hashFile) {
  validateCutoverPlanProofs(operation, plan, transaction);
  if (
    hash(read(plan.backup.operationPath)) !== operation.backupOperationSha256 ||
    hash(read(plan.backup.receiptPath)) !== plan.backup.receiptSha256 ||
    parseStrictJson(read(plan.backup.receiptPath)).backupSha256 !== plan.backup.dumpSha256 ||
    hashFile(`${transaction}/database.pgcustom`) !== plan.backup.dumpSha256
  )
    fail('backup_drift');
}

export function assertCutoverReadbackFreshness(readAt, now = Date.now()) {
  if (!timestamp(readAt) || now - Date.parse(readAt) < 0 || now - Date.parse(readAt) > 30000)
    fail('monitoring_stale');
}

export function validateCutoverBackupOperation(operation, bytes, facts) {
  validateProductionCutover(operation);
  if (hash(bytes) !== operation.backupOperationSha256) fail('backup_operation_hash');
  const producer = parseStrictJson(bytes);
  const sameIdentity = (actual, expected) =>
    ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt'].every(
      (key) => actual[key] === expected?.[key],
    );
  if (
    producer.schema !== 'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_API_WEB_V1' ||
    producer.profile !== 'production' ||
    producer.candidateSha !== operation.candidateSha ||
    producer.controllerSha !== operation.controllerSha ||
    producer.controllerTree !== operation.candidateTree ||
    producer.toolCommit !== operation.controllerSha ||
    producer.publicationRunId !== operation.publicationRunId ||
    producer.releaseId !== `${operation.candidateSha}-${operation.publicationRunId}-1` ||
    facts.directory !== `${ROOT}/backups/${producer.releaseId}-api-web` ||
    !sameIdentity(operation.legacyBaseline.containers.api, producer.expectedApi) ||
    !sameIdentity(facts.postgres, producer.expectedPostgres) ||
    producer.predecessorAttestationSha256 !== legacyBaselineHash(operation.legacyBaseline) ||
    !equal(producer.expectedDatabaseTarget, operation.legacyBaseline.databaseTarget) ||
    producer.expectedLedgerSha256 !== operation.legacyBaseline.ledgerSha256 ||
    producer.toolFileSha256 !== facts.toolFileSha256 ||
    producer.controllerConfigSha256 !== facts.configSha256
  )
    fail('backup_operation');
  return producer;
}
