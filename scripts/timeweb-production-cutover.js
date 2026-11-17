// A noncanonical predecessor is an observed rollback source, never a canonical publication.
// Only the explicit production-cutover operation may consume this evidence.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import {
  OWNER_OPERATION,
  OWNER_PLAN,
  OWNER_RECEIPT,
  OWNER_KIND,
  CANONICAL_OPERATION,
  CANONICAL_PLAN,
  CANONICAL_RECEIPT,
  CANONICAL_KIND,
  CANONICAL_FRESH_OPERATION,
  CANONICAL_FRESH_RECEIPT,
  CANONICAL_PRIOR_RESTORE_POLICY,
  isCanonicalOwnerDirectedUpgrade,
  isOwnerDirectedCutover,
  validateOwnerDirectedDecisions,
  validateOwnerDirectedBinding,
  FRESH_BACKUP_OPERATION,
  FRESH_BACKUP_RECEIPT,
  PRIOR_RESTORE_POLICY,
  WAIVER_OPERATION,
  WAIVER_PLAN,
  WAIVER_RECEIPT,
  WAIVER_KIND,
  isWaivedRosterCutover,
  validateRosterAlertWaiver,
  validateNativeAdmissionBinding,
} from './timeweb-roster-alert-waiver.js';

export const CUTOVER_OPERATION = 'PHUB_TIMEWEB_API_WEB_PRODUCTION_CUTOVER_V1';
export const CUTOVER_PLAN = 'PHUB_TIMEWEB_API_WEB_CUTOVER_PLAN_V1';
export const CUTOVER_RECEIPT = 'PHUB_TIMEWEB_API_WEB_CUTOVER_RECEIPT_V1';
export const ROSTER_CUTOVER_OPERATION = 'PHUB_TIMEWEB_API_WORKER_WEB_PRODUCTION_CUTOVER_V2';
export const ROSTER_CUTOVER_PLAN = 'PHUB_TIMEWEB_API_WORKER_WEB_CUTOVER_PLAN_V2';
export const ROSTER_CUTOVER_RECEIPT = 'PHUB_TIMEWEB_API_WORKER_WEB_CUTOVER_RECEIPT_V2';
export const ROSTER_CUTOVER_KIND = 'API_WORKER_WEB_PRODUCTION_CUTOVER';
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
export const isRosterCutover = (value) =>
  value?.schema === ROSTER_CUTOVER_OPERATION ||
  isWaivedRosterCutover(value) ||
  isOwnerDirectedCutover(value);
export const isProductionCutover = (value) =>
  value?.schema === CUTOVER_OPERATION || isRosterCutover(value);
export const isLegacyProductionCutover = (value) =>
  isProductionCutover(value) && !isCanonicalOwnerDirectedUpgrade(value);
export const cutoverBaseline = (op) =>
  isCanonicalOwnerDirectedUpgrade(op) ? op.canonicalBaseline : op.legacyBaseline;
export const cutoverBaselineField = (op) =>
  isCanonicalOwnerDirectedUpgrade(op) ? 'canonicalBaselineSha256' : 'legacyBaselineSha256';
export const cutoverBaselineHash = (op) => hash(JSON.stringify(cutoverBaseline(op)));
export const cutoverPlanSchema = (value) =>
  isCanonicalOwnerDirectedUpgrade(value)
    ? CANONICAL_PLAN
    : isOwnerDirectedCutover(value)
      ? OWNER_PLAN
      : isWaivedRosterCutover(value)
        ? WAIVER_PLAN
        : isRosterCutover(value)
          ? ROSTER_CUTOVER_PLAN
          : CUTOVER_PLAN;
export const cutoverReceiptSchema = (value) =>
  isCanonicalOwnerDirectedUpgrade(value)
    ? CANONICAL_RECEIPT
    : isOwnerDirectedCutover(value)
      ? OWNER_RECEIPT
      : isWaivedRosterCutover(value)
        ? WAIVER_RECEIPT
        : isRosterCutover(value)
          ? ROSTER_CUTOVER_RECEIPT
          : CUTOVER_RECEIPT;
export const cutoverInstalledKind = (value) =>
  [CANONICAL_OPERATION, CANONICAL_PLAN].includes(value?.schema)
    ? CANONICAL_KIND
    : [OWNER_OPERATION, OWNER_PLAN].includes(value?.schema)
      ? OWNER_KIND
      : [WAIVER_OPERATION, WAIVER_PLAN].includes(value?.schema)
        ? WAIVER_KIND
        : [ROSTER_CUTOVER_OPERATION, ROSTER_CUTOVER_PLAN].includes(value?.schema)
          ? ROSTER_CUTOVER_KIND
          : 'API_WEB';
export const legacyBaselineHash = (baseline) => hash(JSON.stringify(baseline));
export const CANONICAL_BASELINE_SOURCE = '4b8dbaa12c1ec3fea478a5e661465955e4b0c7c0';
export const CANONICAL_BASELINE_RELEASE = `${CANONICAL_BASELINE_SOURCE}-43751306581-1`;
export const CANONICAL_BASELINE_SCHEMA = 'PHUB_TIMEWEB_INSTALLED_CANONICAL_ROSTER_RUNTIME_V1';
export const CANONICAL_BASELINE_IMAGES = Object.freeze({
  api: 'sha256:f589eadccc4beeb0c629c029354acbf4d5f427517bce9d81c71fe07c4053f0e3',
  worker: 'sha256:010cc45bff9633efee72979356c7534d400becd379e86d2069307d5a39726c8b',
  web: 'sha256:3dd7c4846c3e4d65830e66b7c57de41d5a60b147b72709e70d68888b937d0f69',
  realtime: 'sha256:7e4f30ab2b8e871f459fd103a2856a801cf2796d2fe24910d9e931fda8301fed',
});
/** One real canonical predecessor; this is not a fallback for legacy or arbitrary manual state. */
export function validateCanonicalBaseline(value) {
  exact(value, [
    'schema',
    'capturedAt',
    'installedReleaseId',
    'sourceSha',
    'sourceTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'manifestSha256',
    'installedDescriptorSha256',
    'operationSha256',
    'planSha256',
    'receiptSha256',
    'observationSha256',
    'backupOperationSha256',
    'backupReceiptSha256',
    'secretSetReleaseId',
    'secretHashes',
    'containers',
    'excludedSha256',
    'databaseTarget',
    'ledgerSha256',
  ]);
  const frozenIdentity =
    value.installedReleaseId === CANONICAL_BASELINE_RELEASE &&
    value.sourceSha === CANONICAL_BASELINE_SOURCE &&
    value.sourceTree === '8907550c2386aaddc97b3fbda186dced43db00bd' &&
    value.sourceCiRunId === '43749601790' &&
    value.publicationRunId === '43751306581' &&
    value.artifactId === '14176493246' &&
    value.manifestSha256 === '15465f17d7d4384ea2392fda664ff438a340389b3c5df29d2bd14d4e5ee82672';
  // V6: after a canonical upgrade the installed release is the new predecessor. Its custody is
  // attested live by attestCanonicalBaseline; this validator only enforces shape and identity.
  const derivedIdentity =
    value.installedReleaseId !== CANONICAL_BASELINE_RELEASE &&
    /^[0-9a-f]{40}-[1-9][0-9]*-1$/u.test(value.installedReleaseId ?? '') &&
    value.sourceSha === value.installedReleaseId.slice(0, 40) &&
    typeof value.sourceTree === 'string' &&
    /^[0-9a-f]{40}$/u.test(value.sourceTree) &&
    /^[1-9][0-9]*$/u.test(String(value.sourceCiRunId ?? '')) &&
    /^[1-9][0-9]*$/u.test(String(value.publicationRunId ?? '')) &&
    /^[1-9][0-9]*$/u.test(String(value.artifactId ?? '')) &&
    HASH.test(value.manifestSha256 ?? '');
  if (
    value.schema !== CANONICAL_BASELINE_SCHEMA ||
    (!frozenIdentity && !derivedIdentity) ||
    !timestamp(value.capturedAt) ||
    !ID.test(value.secretSetReleaseId ?? '') ||
    value.ledgerSha256 !== '4dab86cb18f7e3db7a0598cd657eaebc86f07d5af497dc0eea2e33900b6526c1' ||
    [
      'installedDescriptorSha256',
      'operationSha256',
      'planSha256',
      'receiptSha256',
      'observationSha256',
      'backupOperationSha256',
      'backupReceiptSha256',
      'excludedSha256',
    ].some((k) => !HASH.test(value[k] ?? ''))
  )
    fail('canonical_identity');
  exact(value.databaseTarget, ['databaseName', 'systemIdentifier']);
  if (
    value.databaseTarget.databaseName !== 'phub_beta' ||
    value.databaseTarget.systemIdentifier !== '7679125609183186977'
  )
    fail('canonical_database');
  exact(value.secretHashes, SECRETS);
  if (SECRETS.some((k) => !HASH.test(value.secretHashes[k] ?? ''))) fail('canonical_secret_hash');
  exact(value.containers, ['api', 'web', 'worker', 'realtime']);
  for (const service of ['api', 'web', 'worker', 'realtime']) {
    const c = value.containers[service];
    exact(c, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
    if (
      !HASH.test(c.id ?? '') ||
      !image(service, c.image) ||
      (frozenIdentity && c.imageId !== CANONICAL_BASELINE_IMAGES[service]) ||
      c.imageId !== c.image.split('@')[1] ||
      c.restarts !== 0 ||
      !timestamp(c.startedAt) ||
      c.releaseId !==
        (['api', 'web'].includes(service)
          ? frozenIdentity
            ? CANONICAL_BASELINE_RELEASE
            : value.installedReleaseId
          : null) ||
      c.revision !== (service === 'realtime' ? null : value.sourceSha)
    )
      fail('canonical_container');
  }
  return value;
}
export function canonicalRuntimeHash(baseline) {
  validateCanonicalBaseline(baseline);
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  const { capturedAt: _capturedAt, ...runtime } = baseline;
  return hash(JSON.stringify(sorted(runtime)));
}
// Compatibility only. Full lineage/confirmation/freshness keep the complete baseline hash.
export function legacyRuntimeHash(baseline) {
  validateLegacyBaseline(baseline);
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  const { capturedAt: _capturedAt, ...runtime } = baseline;
  return hash(JSON.stringify(sorted(runtime)));
}
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
    ...(isRosterCutover(value) ? ['expectedWorker'] : []),
    ...(isWaivedRosterCutover(value) ? ['alertWaiver'] : []),
    ...(isOwnerDirectedCutover(value) ? ['ownerDecisions'] : []),
    isCanonicalOwnerDirectedUpgrade(value) ? 'canonicalBaseline' : 'legacyBaseline',
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
  const canonical = isCanonicalOwnerDirectedUpgrade(value);
  const baseline = canonical
    ? validateCanonicalBaseline(value.canonicalBaseline)
    : validateLegacyBaseline(value.legacyBaseline);
  if (isWaivedRosterCutover(value))
    validateRosterAlertWaiver(value, legacyBaselineHash(baseline), fresh, now);
  if (isOwnerDirectedCutover(value)) validateOwnerDirectedDecisions(value, fresh, now);
  for (const [key, service] of [
    ['expectedApi', 'api'],
    ['expectedWeb', 'web'],
    ...(isRosterCutover(value) ? [['expectedWorker', 'worker']] : []),
  ]) {
    exact(value[key], ['id', 'image', 'releaseId']);
    if (
      Object.keys(value[key]).some(
        (field) => value[key][field] !== baseline.containers[service][field],
      )
    )
      fail('previous_identity');
  }
  const expected = `${canonical ? 'UPGRADE_CANONICAL_PRODUCTION_' : 'CUTOVER_PRODUCTION_'}${isRosterCutover(value) ? 'API_WORKER_WEB_' : ''}${isOwnerDirectedCutover(value) ? 'OWNER_SKIPPED_ALERT_DRILL_PROVIDER_READBACK_REPEAT_RESTORE_' : isWaivedRosterCutover(value) ? 'WITHOUT_INDUCED_ALERT_KEEP_OTHER_GATES_' : ''}${value.candidateSha.slice(0, 12).toUpperCase()}_FROM_${legacyBaselineHash(baseline).slice(0, 12).toUpperCase()}_KEEP_DATA_AND_ACCOUNTS`;
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
  const digest = cutoverBaselineHash(operation),
    field = cutoverBaselineField(operation);
  const prefix = isCanonicalOwnerDirectedUpgrade(operation)
    ? 'PHUB_CANONICAL_PREDECESSOR_'
    : 'PHUB_LEGACY_PREDECESSOR_';
  if (
    receipt.schema !== cutoverReceiptSchema(operation) ||
    plan.schema !== cutoverPlanSchema(operation) ||
    receipt[field] !== digest ||
    plan[field] !== digest ||
    descriptor[prefix + 'SHA256'] !== digest ||
    descriptor[prefix + 'RELEASE_ID'] !== operation.expectedApi.releaseId ||
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
    ...(isOwnerDirectedCutover(operation)
      ? ['admissionPolicy', 'priorReferenceSha256', 'ownerReceiptSha256']
      : []),
  ]);
  if (isOwnerDirectedCutover(operation)) {
    validateOwnerDirectedBinding(operation, plan.monitoring, plan.operationSha256);
    if (
      plan.backup.admissionPolicy !==
        (isCanonicalOwnerDirectedUpgrade(operation)
          ? CANONICAL_PRIOR_RESTORE_POLICY
          : PRIOR_RESTORE_POLICY) ||
      ![plan.backup.priorReferenceSha256, plan.backup.ownerReceiptSha256].every((v) =>
        HASH.test(v ?? ''),
      )
    )
      fail('backup_policy');
  } else if (isWaivedRosterCutover(operation))
    validateNativeAdmissionBinding(operation, plan.monitoring, plan.operationSha256);
  else exact(plan.monitoring, ['providerSha256', 'alertSha256']);
  if (
    ![
      plan.backup.sha256,
      plan.backup.operationSha256,
      plan.backup.receiptSha256,
      plan.backup.dumpSha256,
      ...(isWaivedRosterCutover(operation) || isOwnerDirectedCutover(operation)
        ? []
        : [plan.monitoring.providerSha256, plan.monitoring.alertSha256]),
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
  if (isOwnerDirectedCutover(operation)) {
    const r = parseStrictJson(read(plan.backup.receiptPath));
    if (
      r.schema !==
        (isCanonicalOwnerDirectedUpgrade(operation)
          ? CANONICAL_FRESH_RECEIPT
          : FRESH_BACKUP_RECEIPT) ||
      r.freshDumpRestored !== false ||
      r.freshDumpIntegrityStatus !== 'PG16_TOC_PARSE_VERIFIED' ||
      r.restoreAdmissionPolicy !== plan.backup.admissionPolicy ||
      r.priorReferenceSha256 !== plan.backup.priorReferenceSha256 ||
      r.ownerReceiptSha256 !== plan.backup.ownerReceiptSha256 ||
      hash(read(`${transaction}/prior-full-restore-reference.json`)) !== r.priorReferenceSha256 ||
      hash(read(`${transaction}/owner-restore-decision.json`)) !== r.ownerReceiptSha256
    )
      fail('backup_policy');
  }
}

export function assertCutoverReadbackFreshness(readAt, now = Date.now()) {
  if (!timestamp(readAt) || now - Date.parse(readAt) < 0 || now - Date.parse(readAt) > 30000)
    fail('monitoring_stale');
}

export function validateRosterCutoverObservation(value, receiptAt = undefined) {
  exact(value, [
    'windowSeconds',
    'samplesPerService',
    'latencyMs',
    'serverErrors',
    'startedAt',
    'completedAt',
    'elapsedSeconds',
  ]);
  exact(value.latencyMs, ['api', 'worker', 'web']);
  if (
    value.windowSeconds !== 900 ||
    value.samplesPerService !== 61 ||
    value.serverErrors !== 0 ||
    !timestamp(value.startedAt) ||
    !timestamp(value.completedAt) ||
    !Number.isFinite(value.elapsedSeconds) ||
    value.elapsedSeconds < 900 ||
    value.elapsedSeconds > 7200 ||
    value.elapsedSeconds !== (Date.parse(value.completedAt) - Date.parse(value.startedAt)) / 1000 ||
    (receiptAt !== undefined &&
      (!timestamp(receiptAt) || Date.parse(value.completedAt) > Date.parse(receiptAt)))
  )
    fail('roster_observation');
  for (const service of ['api', 'worker', 'web']) {
    const values = value.latencyMs[service];
    if (
      !Array.isArray(values) ||
      values.length !== 61 ||
      values.some((v) => !Number.isFinite(v) || v < 0 || v > 10000)
    )
      fail('roster_observation_samples');
    const p95 = [...values].sort((a, b) => a - b)[57];
    if (p95 > (service === 'api' ? 1500 : service === 'web' ? 1000 : 10000))
      fail('roster_observation_latency');
  }
  return value;
}

export function validateCutoverBackupOperation(operation, bytes, facts) {
  validateProductionCutover(operation);
  if (hash(bytes) !== operation.backupOperationSha256) fail('backup_operation_hash');
  const producer = parseStrictJson(bytes);
  const canonical = isCanonicalOwnerDirectedUpgrade(operation),
    baseline = cutoverBaseline(operation);
  const freshSchema = canonical ? CANONICAL_FRESH_OPERATION : FRESH_BACKUP_OPERATION;
  const sameIdentity = (actual, expected) =>
    ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt'].every(
      (key) => actual[key] === expected?.[key],
    );
  if (
    ![
      'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_API_WEB_V1',
      'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_DISK_V2',
      ...(isOwnerDirectedCutover(operation) ? [freshSchema] : []),
    ].includes(producer.schema) ||
    (isOwnerDirectedCutover(operation) && producer.schema !== freshSchema) ||
    (canonical && !equal(producer.canonicalBaseline, baseline)) ||
    (isOwnerDirectedCutover(operation) &&
      producer.predecessorRuntimeSha256 !==
        (canonical ? canonicalRuntimeHash(baseline) : legacyRuntimeHash(baseline))) ||
    producer.profile !== 'production' ||
    producer.candidateSha !== operation.candidateSha ||
    producer.controllerSha !== operation.controllerSha ||
    producer.controllerTree !== operation.candidateTree ||
    producer.toolCommit !== operation.controllerSha ||
    producer.publicationRunId !== operation.publicationRunId ||
    producer.releaseId !== `${operation.candidateSha}-${operation.publicationRunId}-1` ||
    facts.directory !== `${ROOT}/backups/${producer.releaseId}-api-web` ||
    !sameIdentity(baseline.containers.api, producer.expectedApi) ||
    !sameIdentity(facts.postgres, producer.expectedPostgres) ||
    producer.predecessorAttestationSha256 !== cutoverBaselineHash(operation) ||
    !equal(producer.expectedDatabaseTarget, baseline.databaseTarget) ||
    producer.expectedLedgerSha256 !== baseline.ledgerSha256 ||
    producer.toolFileSha256 !== facts.toolFileSha256 ||
    producer.controllerConfigSha256 !== facts.configSha256
  )
    fail('backup_operation');
  return producer;
}
