// A bounded policy for the existing API/Web executor, never another executor.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import { NOTIFICATION_POST_LEDGER } from './timeweb-notification-profile.js';

export const JOIN_OPERATION = 'PHUB_TIMEWEB_JOIN_DORMANT_API_WEB_OPERATION_V1';
export const JOIN_PLAN = 'PHUB_TIMEWEB_JOIN_DORMANT_API_WEB_PLAN_V1';
export const JOIN_RECEIPT = 'PHUB_TIMEWEB_JOIN_DORMANT_API_WEB_RECEIPT_V1';
export const JOIN_INSTALLED_KIND = 'API_WEB_JOIN_DORMANT_0105';
export const JOIN_RUNTIME_ANCHOR = '518be74e95b1f00f0d04671b343318143a759e9c';
export const JOIN_CONTROLLER_FILES = new Set([
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.d.ts',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/timeweb-join-dormant-profile.js',
  'scripts/timeweb-join-dormant-profile.d.ts',
  'scripts/timeweb-join-dormant-profile.test.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/test-timeweb-database-backup.py',
  'scripts/control-timeweb-database-backup.test.ts',
  'scripts/rehearse-timeweb-backup-early-exit.py',
  'docs/runbooks/notification-migrations-0099-0101.md',
  'docs/runbooks/timeweb-standard-delivery.md',
  'docs/runbooks/timeweb-lk2-beta.md',
]);
export const JOIN_PHASES = [
  'PREPARING',
  'PREPARED',
  'SECRET_SWAP_INTENT',
  'SECRETS_ACTIVE',
  'API_INTENT',
  'API_ACTIVE',
  'WEB_INTENT',
  'OBSERVING',
  'BASELINE_INTENT',
  'SUCCESS',
  'ROLLBACK_INTENT',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
  'ABORTED',
  'RECONCILED',
];
const H = /^[a-f0-9]{64}$/,
  S = /^[a-f0-9]{40}$/,
  N = /^[1-9][0-9]*$/;
const ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const utc = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export const joinHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw Error('JOIN_DORMANT_' + code);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (v, keys) => {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !same(Object.keys(v).sort(), [...keys].sort())
  )
    fail('SHAPE');
};
export const isJoinOperation = (op) => op?.schema === JOIN_OPERATION;
export function validateJoinOperation(op, requireUnexpired = false, now = Date.now()) {
  exact(op, [
    'schema',
    'target',
    'controllerSha',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'expectedApi',
    'expectedWeb',
    'expectedCurrentSecretSetReleaseId',
    'candidateSecretHashes',
    'verifierPublicKeySha256',
    'notificationBundleSha256',
    'expectedExcludedSha256',
    'expiresAt',
    'confirmation',
  ]);
  if (
    !isJoinOperation(op) ||
    op.target !== 'lk2.padlhub.su' ||
    ![op.controllerSha, op.candidateSha, op.candidateTree].every((v) => S.test(v ?? '')) ||
    ![op.sourceCiRunId, op.publicationRunId, op.artifactId].every(
      (v) => typeof v === 'string' && N.test(v),
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(op.artifactDigest ?? '') ||
    ![
      op.manifestSha256,
      op.verifierPublicKeySha256,
      op.notificationBundleSha256,
      op.expectedExcludedSha256,
    ].every((v) => H.test(v ?? '')) ||
    !ID.test(op.expectedCurrentSecretSetReleaseId ?? '')
  )
    fail('OPERATION');
  for (const service of ['Api', 'Web']) {
    const v = op['expected' + service];
    exact(v, ['id', 'image', 'releaseId']);
    if (
      !H.test(v.id ?? '') ||
      !ID.test(v.releaseId ?? '') ||
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service.toLowerCase()}@sha256:[a-f0-9]{64}$`).test(
        v.image ?? '',
      )
    )
      fail('PREVIOUS');
  }
  exact(op.candidateSecretHashes, [
    '.release-identity.json',
    'api.env',
    'worker.env',
    'realtime.env',
    'migrator.env',
  ]);
  if (
    !Object.values(op.candidateSecretHashes).every((v) => H.test(v ?? '')) ||
    !utc(op.expiresAt) ||
    (requireUnexpired &&
      (Date.parse(op.expiresAt) <= now || Date.parse(op.expiresAt) - now > 3600000))
  )
    fail('AUTHORITY');
  if (
    op.confirmation !==
    `DEPLOY_DORMANT_JOIN_API_WEB_${op.candidateSha.slice(0, 12).toUpperCase()}_FROM_${op.expectedApi.releaseId.slice(0, 12).toUpperCase()}_NO_JOIN_NO_PROVIDER_WRITES`
  )
    fail('CONFIRMATION');
  return op;
}
export function validateJoinRuntimeTail(entries) {
  for (const e of entries) {
    if (
      !JOIN_CONTROLLER_FILES.has(e.path) ||
      !['A', 'M'].includes(e.status) ||
      e.newMode !== '100644' ||
      e.newType !== 'blob' ||
      !S.test(e.newOid ?? '') ||
      (e.status === 'M' &&
        (e.oldMode !== '100644' || e.oldType !== 'blob' || !S.test(e.oldOid ?? ''))) ||
      (e.status === 'A' && (e.oldMode !== '000000' || e.oldOid !== '0'.repeat(40)))
    )
      fail('RUNTIME_TAIL');
  }
}
// The caller first validates the full installed notification evidence using the
// existing receipt reader. These are additional terminal/capsule/hash bindings.
export function validateJoinNotificationBinding(bundle, values, op, currentExcluded) {
  exact(bundle, [
    'operation',
    'plan',
    'capsule',
    'receipt',
    'observation',
    'descriptor',
    'apiIdentity',
    'workerIdentity',
  ]);
  const receipt = parseStrictJson(bundle.receipt),
    capsule = parseStrictJson(bundle.capsule);
  const plan = parseStrictJson(bundle.plan),
    api = parseStrictJson(bundle.apiIdentity),
    worker = parseStrictJson(bundle.workerIdentity);
  exact(capsule, ['schema', 'operation', 'plan']);
  if (
    ['operation', 'plan'].some(
      (k) =>
        typeof capsule[k] !== 'string' ||
        Buffer.from(capsule[k], 'base64').toString('base64') !== capsule[k],
    )
  )
    fail('NOTIFICATION_CAPSULE');
  if (
    values.PHUB_COMPONENT_ROLLOUT_KIND !== 'API_WORKER_NOTIFICATION_0105' ||
    values.PHUB_RELEASE_ID !== op.expectedApi.releaseId ||
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== op.expectedCurrentSecretSetReleaseId ||
    receipt.schema !== 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V2' ||
    receipt.status !== 'RECONCILED' ||
    receipt.reconciledStatus !== 'SUCCESS' ||
    capsule.schema !== 'PHUB_TIMEWEB_API_WORKER_CAPSULE_V1' ||
    !Buffer.from(capsule.operation ?? '', 'base64').equals(bundle.operation) ||
    !Buffer.from(capsule.plan ?? '', 'base64').equals(bundle.plan) ||
    receipt.planSha256 !== joinHash(bundle.plan) ||
    receipt.installedBaselineSha256 !== joinHash(bundle.descriptor) ||
    receipt.observationSha256 !== joinHash(bundle.observation)
  )
    fail('NOTIFICATION_BASELINE');
  const oldWeb = plan.excluded?.find(
    (v) => v.id === op.expectedWeb.id && v.image === op.expectedWeb.image,
  );
  const actualWorker = currentExcluded?.find((v) => v.id === worker.id);
  if (
    !oldWeb ||
    `ghcr.io/z6v6e6r/phub-web@${values.WEB_IMAGE_DIGEST}` !== op.expectedWeb.image ||
    api.id !== op.expectedApi.id ||
    api.image !== op.expectedApi.image ||
    api.releaseId !== op.expectedApi.releaseId ||
    worker.image !== `ghcr.io/z6v6e6r/phub-worker@${values.WORKER_IMAGE_DIGEST}` ||
    !actualWorker ||
    actualWorker.status !== 'running' ||
    actualWorker.health !== 'healthy' ||
    ['id', 'image', 'imageId', 'restarts', 'startedAt'].some(
      (k) => actualWorker[k] !== worker[k],
    ) ||
    !same(
      currentExcluded.filter((v) => v.id !== worker.id),
      plan.excluded.filter((v) => v.id !== oldWeb.id),
    )
  )
    fail('NOTIFICATION_RUNTIME_LINEAGE');
  const digest = joinHash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(bundle)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, joinHash(v)]),
      ),
    ),
  );
  if (digest !== op.notificationBundleSha256) fail('NOTIFICATION_BUNDLE');
  return digest;
}
export function validateJoinBackupLedger(receipt) {
  if (
    receipt?.restoreVerified !== true ||
    receipt.sourceLedgerSha256 !== NOTIFICATION_POST_LEDGER ||
    receipt.restoredLedgerSha256 !== NOTIFICATION_POST_LEDGER
  )
    fail('POST0105_BACKUP');
}
export function validateJoinRunningEnvironment(actual, expected) {
  if (
    actual.SUBSCRIPTION_RUNTIME_WARN_MODE !== 'OFF' ||
    (actual.GAME_COMMERCIAL_JOIN_ENABLED !== undefined &&
      actual.GAME_COMMERCIAL_JOIN_ENABLED !== 'false') ||
    Object.entries(expected).some(([k, v]) => actual[k] !== v) ||
    Object.keys(actual).some(
      (k) =>
        /^(SUBSCRIPTION_RUNTIME_|GAME_COMMERCIAL_JOIN_)/.test(k) && !Object.hasOwn(expected, k),
    )
  )
    fail('RUNNING_ENVIRONMENT');
}
export function validateJoinReceipt(receipt, planSha256, op, plan, planBytes) {
  const success =
    receipt.status === 'SUCCESS' ||
    (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS');
  exact(receipt, [
    'schema',
    'status',
    'planSha256',
    'observedAt',
    ...(success
      ? [
          'installedBaselineSha256',
          'observationSha256',
          'providerReadbackSha256',
          'alertReadbackSha256',
        ]
      : []),
    ...(receipt.status === 'RECONCILED' ? ['reconciledStatus'] : []),
  ]);
  if (
    receipt.schema !== JOIN_RECEIPT ||
    !JOIN_PHASES.includes(receipt.status) ||
    !H.test(planSha256 ?? '') ||
    receipt.planSha256 !== planSha256 ||
    !utc(receipt.observedAt) ||
    (receipt.status === 'RECONCILED' &&
      !['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(receipt.reconciledStatus)) ||
    (success &&
      [
        'installedBaselineSha256',
        'observationSha256',
        'providerReadbackSha256',
        'alertReadbackSha256',
      ].some((k) => !H.test(receipt[k] ?? '')))
  )
    fail('RECEIPT');
  if (op || plan) {
    if (
      !isJoinOperation(op) ||
      plan?.schema !== JOIN_PLAN ||
      !Buffer.isBuffer(planBytes) ||
      joinHash(planBytes) !== planSha256 ||
      !same(parseStrictJson(planBytes), plan) ||
      plan.controllerSha !== op.controllerSha ||
      !H.test(plan.operationSha256 ?? '')
    )
      fail('RECEIPT_CONTEXT');
  }
  return receipt;
}
// Historical validation uses the sealed authorization window, never the current clock.
export function validateJoinObservation(value, op, plan, planSha256) {
  exact(value, [
    'schema',
    'operationSha256',
    'planSha256',
    'candidateSha',
    'startedAt',
    'completedAt',
    'elapsedSeconds',
    'samples',
    'serverErrors',
  ]);
  if (
    value.schema !== 'PHUB_TIMEWEB_JOIN_DORMANT_OBSERVATION_V1' ||
    value.operationSha256 !== plan.operationSha256 ||
    value.planSha256 !== planSha256 ||
    value.candidateSha !== op.candidateSha ||
    !H.test(value.operationSha256 ?? '') ||
    !H.test(planSha256 ?? '') ||
    !utc(value.startedAt) ||
    !utc(value.completedAt) ||
    !utc(plan.createdAt) ||
    !utc(op.expiresAt) ||
    Date.parse(value.startedAt) < Date.parse(plan.createdAt) ||
    Date.parse(value.completedAt) > Date.parse(op.expiresAt) ||
    value.elapsedSeconds !== (Date.parse(value.completedAt) - Date.parse(value.startedAt)) / 1000 ||
    value.elapsedSeconds < 900 ||
    value.serverErrors !== 0
  )
    fail('OBSERVATION');
  exact(value.samples, ['api', 'web']);
  const percentile = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
  for (const service of ['api', 'web']) {
    const sample = value.samples[service];
    exact(sample, ['privateMs', 'publicMs', 'timestamps', 'p95PrivateMs', 'p95PublicMs']);
    if (
      ![sample.privateMs, sample.publicMs, sample.timestamps].every(
        (v) => Array.isArray(v) && v.length === 61,
      ) ||
      ![...sample.privateMs, ...sample.publicMs].every((v) => Number.isFinite(v) && v >= 0) ||
      sample.timestamps.some(
        (t, i) =>
          !utc(t) ||
          Date.parse(t) < Date.parse(value.startedAt) ||
          Date.parse(t) > Date.parse(value.completedAt) ||
          (i > 0 && Date.parse(t) - Date.parse(sample.timestamps[i - 1]) < 15000),
      ) ||
      sample.p95PrivateMs !== percentile(sample.privateMs) ||
      sample.p95PublicMs !== percentile(sample.publicMs) ||
      Math.max(sample.p95PrivateMs, sample.p95PublicMs) >= (service === 'api' ? 1500 : 1000)
    )
      fail('OBSERVATION_SAMPLES');
  }
  return value;
}
export function buildJoinInstalledDescriptor(values, plan, id, journalPath) {
  const next = {
    ...values,
    PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
    PHUB_RELEASE_ID: id,
    PHUB_RUNTIME_SECRET_SET_RELEASE_ID: id,
    PHUB_COMPONENT_ROLLOUT_KIND: JOIN_INSTALLED_KIND,
    PHUB_COMPONENT_ROLLOUT_RECEIPT: journalPath,
    API_IMAGE_DIGEST: plan.candidate.api.image.split('@')[1],
    WEB_IMAGE_DIGEST: plan.candidate.web.image.split('@')[1],
  };
  for (const service of ['worker', 'realtime'])
    if (plan.unchangedServiceImages[service])
      next[service.toUpperCase() + '_IMAGE_DIGEST'] =
        plan.unchangedServiceImages[service].split('@')[1];
  for (const k of Object.keys(next))
    if (
      k.startsWith('PHUB_CANONICAL_') ||
      k.startsWith('PHUB_PUBLICATION_') ||
      k.endsWith('_RUNTIME_DIGEST') ||
      ['PHUB_RELEASE_SOURCE_SHA', 'PHUB_RELEASE_SOURCE_TREE'].includes(k)
    )
      delete next[k];
  return Buffer.from(
    Object.entries(next)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n',
  );
}
