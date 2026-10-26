// A bounded policy for the existing API/Web executor, never another executor.
import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
import {
  NOTIFICATION_POST_LEDGER,
  validateNotificationState,
} from './timeweb-notification-profile.js';

export const JOIN_OPERATION = 'PHUB_TIMEWEB_JOIN_DORMANT_API_WEB_OPERATION_V2';
export const JOIN_PLAN = 'PHUB_TIMEWEB_JOIN_DORMANT_API_WEB_PLAN_V1';
export const JOIN_RECEIPT = 'PHUB_TIMEWEB_JOIN_DORMANT_API_WEB_RECEIPT_V1';
export const JOIN_INSTALLED_KIND = 'API_WEB_JOIN_DORMANT_0105';
export const JOIN_RUNTIME_ANCHOR = '518be74e95b1f00f0d04671b343318143a759e9c';
export const JOIN_CONTROLLER_FILES = new Set([
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.d.ts',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/timeweb-adopt-manual-baseline.js',
  'scripts/timeweb-adopt-manual-baseline.d.ts',
  'scripts/timeweb-adopt-manual-baseline.test.ts',
  'scripts/timeweb-join-dormant-profile.js',
  'scripts/timeweb-join-dormant-profile.d.ts',
  'scripts/timeweb-join-dormant-profile.test.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'scripts/timeweb-notification-profile.js',
  'scripts/timeweb-notification-profile.d.ts',
  'scripts/timeweb-notification-profile.test.ts',
  'scripts/timeweb-api-worker-contract.d.ts',
  'scripts/timeweb-api-worker-migration.js',
  'scripts/timeweb-api-worker-migration.test.ts',
  'scripts/control-timeweb-database-backup.py',
  'scripts/test-timeweb-database-backup.py',
  'scripts/control-timeweb-database-backup.test.ts',
  'scripts/control-timeweb-location-photo-acl.py',
  'scripts/control-timeweb-location-photo-acl.test.ts',
  'scripts/rehearse-timeweb-backup-early-exit.py',
  'docs/runbooks/notification-migrations-0099-0101.md',
  'docs/runbooks/timeweb-standard-delivery.md',
  'docs/runbooks/timeweb-lk2-beta.md',
]);
// PR468 adds only the reviewed notification-prefetch CLI/declarations here.
// These paths remain outside the editable controller allowlist. Admit the two
// exact regular-blob transitions together, never an arbitrary later runner edit.
const NOTIFICATION_RECOVERY_BRIDGE = {
  'scripts/run-timeweb-standard-delivery.js': {
    oldOid: '8489049616f991e019b70a8199fcaa5dd4650aa8',
    newOid: '13cae992f42fb040f221299eecb09ca98896ac39',
  },
  'scripts/timeweb-api-worker-migration.d.ts': {
    oldOid: '9f776e939e9880fecf65738ec4c4f52923afe591',
    newOid: '02465a0e0f2812efc547380729405199fda5e3f1',
  },
};
// Exact PR469 Zod security/runtime patch, admitted only on its reviewed source edge.
// It never permits dependency/generated-runtime edits in a candidate-to-controller tail.
const REVIEWED_ZOD_RUNTIME_SOURCE = {
  sha: 'cccae751ad4134382b2e350db30e93e47099209d',
  tree: '0403f08abcefdce80b7d9974e630238de6ac8eb0',
};
const REVIEWED_ZOD_RUNTIME_BRIDGE = {
  'apps/worker/package.json': {
    oldOid: '0713ea75761e408a553b72038b19b200c01bcdb5',
    newOid: '843c95768cf781a086b093cb81b90a61e181bc31',
  },
  'deploy/jetson/generated/communities-staging-role-split-trusted-inventory-runtime.mjs': {
    oldOid: '77626917f7e3d14fdf98261c4830f92cc3e2f5ee',
    newOid: '2a17685b07e3edb05231ea54c4a02299e222ebb3',
  },
  'package-lock.json': {
    oldOid: '0bf8807982a8c5c4e02d7b2f136453120864b266',
    newOid: '58862c3cae7880baa6ce01ddb7f465f35657c7c1',
  },
  'packages/communities/package.json': {
    oldOid: 'd05064a59f4a7feba05dc0711f49975fa6243841',
    newOid: '9a36387717e180685751bb9289aa769758f2f800',
  },
  'packages/config/package.json': {
    oldOid: '9ce686c459e2cea82e6071a679c02376f8bfde64',
    newOid: '79ff9d592398708d8fef54f7599b1c69fef2babe',
  },
  'packages/database/package.json': {
    oldOid: '767781051a168a9ffb2fda3247900ae68c823c3e',
    newOid: 'cb23cdf6726c61216873b37075199c8c92ba0295',
  },
  'packages/games/package.json': {
    oldOid: 'a08dcd0ebca2f0658f74ed993489ffecfb5d5e93',
    newOid: '2e721fa3fda25af4c84fb5fb4e9234f5339baea5',
  },
  'packages/gift-certificates/package.json': {
    oldOid: '888ff46e39a0311986abd59c312d2f73bba1cb8c',
    newOid: 'b5b9fb8303c011af1b2bfc2759abe5adee803570',
  },
  'packages/gift-certificates/src/index.test.ts': {
    oldOid: '6de05ac10c64c5ce273f8780791a10b6a97b7d45',
    newOid: '7c250ed9cf5dd19cf91adaf6c0c8e941c87321cc',
  },
  'packages/home-projection/package.json': {
    oldOid: '3c8ef371d668697efcab3d5e63e90d879d30f88a',
    newOid: '9a18f1b9038bd45bed8f9733a2c42b16a00b7361',
  },
  'packages/locations/package.json': {
    oldOid: '5be3a5c5641d72baeaa4ff1f7bbf344af962f275',
    newOid: '279ac8da38f7e471c66b2eb345ae2165a8a72ec0',
  },
  'packages/notifications/package.json': {
    oldOid: '66a16c381c834943d65ec525e5044518d1cf1347',
    newOid: 'd62c82cf4e4bdb3ee32df96433ddc306124ffc07',
  },
  'packages/viva-adapter/package.json': {
    oldOid: 'ecb541f37b4f80129fff730b07efe46993bf86f9',
    newOid: 'f3f244a9b2a0f8061a403835352e2d2fc9ecbf6a',
  },
  'packages/viva-client-adapter/package.json': {
    oldOid: 'bfff8e7926440fc76dafadc7a7e2caba96157fe5',
    newOid: '0b3f670d0d6c2395b481adf987253d32616f062f',
  },
};
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
    'post105BackupOperationSha256',
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
      op.post105BackupOperationSha256,
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
export function validateJoinRuntimeTail(entries, runtimeSource) {
  if (runtimeSource !== undefined) {
    exact(runtimeSource, ['fromSha', 'toSha', 'toTree']);
    if (
      runtimeSource.fromSha !== JOIN_RUNTIME_ANCHOR ||
      !S.test(runtimeSource.toSha ?? '') ||
      !S.test(runtimeSource.toTree ?? '')
    )
      fail('RUNTIME_TAIL');
  }
  const zod = entries.filter((e) => Object.hasOwn(REVIEWED_ZOD_RUNTIME_BRIDGE, e.path));
  if (
    zod.length &&
    (!runtimeSource ||
      runtimeSource.toSha !== REVIEWED_ZOD_RUNTIME_SOURCE.sha ||
      runtimeSource.toTree !== REVIEWED_ZOD_RUNTIME_SOURCE.tree)
  )
    fail('RUNTIME_TAIL');
  const bridges = [NOTIFICATION_RECOVERY_BRIDGE, REVIEWED_ZOD_RUNTIME_BRIDGE];
  for (const pins of bridges) {
    const bridge = entries.filter((e) => Object.hasOwn(pins, e.path));
    const size = Object.keys(pins).length;
    if (
      bridge.length &&
      (bridge.length !== size ||
        new Set(bridge.map((e) => e.path)).size !== size ||
        bridge.some((e) => {
          const pin = pins[e.path];
          return (
            e.status !== 'M' ||
            e.oldMode !== '100644' ||
            e.newMode !== '100644' ||
            e.oldType !== 'blob' ||
            e.newType !== 'blob' ||
            e.oldOid !== pin.oldOid ||
            e.newOid !== pin.newOid
          );
        }))
    )
      fail('RUNTIME_TAIL');
  }
  for (const e of entries) {
    if (bridges.some((pins) => Object.hasOwn(pins, e.path))) continue;
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
// The sealed notification bundle is shared by JOIN preparation and post-0105 backup admission.
export function validateJoinNotificationSnapshot(bundle, values, op, snapshot) {
  exact(snapshot, ['api', 'web', 'secretSet', 'secretSetReleaseId', 'excluded']);
  const post = op?.schema === JOIN_POST105_BACKUP_SCHEMA;
  if (!post && !isJoinOperation(op)) fail('NOTIFICATION_PROFILE');
  const { api, web, secretSet, secretSetReleaseId } = snapshot;
  const plan = parseStrictJson(bundle.plan),
    sealedApi = parseStrictJson(bundle.apiIdentity);
  const fields = ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt'];
  const webFields = ['id', 'image', 'imageId', 'restarts', 'startedAt'];
  const sealedWeb = plan.excluded?.find((v) => v.id === web.id);
  if (
    !sealedWeb ||
    webFields.some((k) => web[k] !== sealedWeb[k]) ||
    fields.some((k) => api[k] !== sealedApi[k]) ||
    (post && fields.some((k) => api[k] !== op.expectedApi[k])) ||
    (!post && ['id', 'image', 'releaseId'].some((k) => web[k] !== op.expectedWeb[k])) ||
    web.revision !== web.releaseId?.slice(0, 40) ||
    !ID.test(web.releaseId ?? '') ||
    !same(secretSet, plan.previousSecrets)
  )
    fail('NOTIFICATION_SNAPSHOT');
  const bindingOp = post
    ? { ...op, expectedWeb: web, expectedCurrentSecretSetReleaseId: secretSetReleaseId }
    : op;
  return validateJoinNotificationBinding(bundle, values, bindingOp, snapshot.excluded);
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
      k.startsWith('PHUB_ADOPTION_') ||
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

// Rich post-0105 proof remains at its original canonical location. Never project it into
// the legacy nine-field V1 receipt or substitute a PRE102/degraded proof.
export const JOIN_POST105_BACKUP_SCHEMA = 'PHUB_TIMEWEB_JOIN_POST0105_BACKUP_NAMESPACE_V1';
export const JOIN_POST105_BACKUP_RECEIPT = 'PHUB_TIMEWEB_JOIN_POST105_BACKUP_RESTORE_V1';
export const JOIN_POST105_BACKUP_TERMINAL = 'PHUB_TIMEWEB_JOIN_POST105_BACKUP_TERMINAL_V1';
const BACKUP_ROOT = '/opt/phub/timeweb-beta/backups';
const PG_IMAGE =
  'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
const pythonBytes = (value) =>
  Buffer.from(
    (JSON.stringify(value) + '\n').replace(
      /[\u007f-\uffff]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    ),
  );
export function validateJoinPost105BackupOperation(op, join, controllerTree) {
  exact(op, [
    'schema',
    'profile',
    'target',
    'toolCommit',
    'toolFileSha256',
    'toolProofSha256',
    'toolInstallationSha256',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'controllerConfigSha256',
    'expectedBoundarySha256',
    'expectedApi',
    'expectedPostgres',
    'releaseId',
    'expectedLedgerSha256',
    'packageDescriptorSha256',
    'catalogsSha256',
    'expiresAt',
    'confirmation',
    'notificationBundleSha256',
  ]);
  exact(op.target, ['hostname', 'serverId', 'projectId']);
  if (
    op.schema !== JOIN_POST105_BACKUP_SCHEMA ||
    op.profile !== 'production' ||
    op.target.hostname !== 'lk2.padlhub.su' ||
    op.target.serverId !== 8886471 ||
    op.target.projectId !== 262717 ||
    op.controllerSha !== join.controllerSha ||
    op.toolCommit !== op.controllerSha ||
    !S.test(op.controllerSha ?? '') ||
    !S.test(controllerTree ?? '') ||
    op.controllerTree !== controllerTree ||
    typeof op.controllerSourceCiRunId !== 'string' ||
    !N.test(op.controllerSourceCiRunId) ||
    op.releaseId !== `${op.controllerSha}-${op.controllerSourceCiRunId}-1` ||
    op.expectedLedgerSha256 !== NOTIFICATION_POST_LEDGER ||
    op.notificationBundleSha256 !== join.notificationBundleSha256 ||
    !utc(op.expiresAt) ||
    op.confirmation !== 'BACKUP_RESTORE_JOIN_POST105_PRIVATE_NAMESPACE_KEEP_RUNTIME' ||
    [
      'toolFileSha256',
      'toolProofSha256',
      'toolInstallationSha256',
      'controllerConfigSha256',
      'expectedBoundarySha256',
      'packageDescriptorSha256',
      'catalogsSha256',
      'notificationBundleSha256',
    ].some((k) => !H.test(op[k] ?? ''))
  )
    fail('POST105_OPERATION');
  for (const service of ['Api', 'Postgres']) {
    const row = op['expected' + service];
    exact(row, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
    if (
      !H.test(row.id ?? '') ||
      row.restarts !== 0 ||
      typeof row.image !== 'string' ||
      row.imageId !== row.image.split('@')[1] ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}Z$/.test(row.startedAt ?? '') ||
      !Number.isFinite(Date.parse(row.startedAt)) ||
      !utc(row.startedAt.slice(0, 23) + 'Z')
    )
      fail('POST105_BASELINE');
  }
  if (
    ['id', 'image', 'releaseId'].some((k) => op.expectedApi[k] !== join.expectedApi[k]) ||
    !ID.test(op.expectedApi.releaseId ?? '') ||
    op.expectedApi.revision !== op.expectedApi.releaseId.slice(0, 40) ||
    !/^ghcr.io\/z6v6e6r\/phub-api@sha256:[a-f0-9]{64}$/.test(op.expectedApi.image) ||
    op.expectedPostgres.id !== 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c' ||
    op.expectedPostgres.image !== PG_IMAGE ||
    op.expectedPostgres.revision !== null ||
    op.expectedPostgres.releaseId !== null
  )
    fail('POST105_BASELINE');
  return op;
}
export function validateJoinPost105BackupTerminal(value, receipt, receiptBytes, preimageBytes) {
  exact(value, [
    'schema',
    'operationSha256',
    'receiptSha256',
    'preimageSha256',
    'target',
    'sourceLedgerSha256',
    'storageCleanupVerified',
    'reconciled',
    'notificationBundleSha256',
  ]);
  if (
    value.schema !== JOIN_POST105_BACKUP_TERMINAL ||
    value.operationSha256 !== receipt.operationSha256 ||
    value.receiptSha256 !== joinHash(receiptBytes) ||
    value.preimageSha256 !== joinHash(preimageBytes) ||
    !same(value.target, receipt.target) ||
    value.sourceLedgerSha256 !== NOTIFICATION_POST_LEDGER ||
    value.storageCleanupVerified !== true ||
    value.reconciled !== true ||
    value.notificationBundleSha256 !== receipt.notificationBundleSha256
  )
    fail('POST105_TERMINAL');
  return value;
}
export function validateJoinPost105SecurityInventory(value) {
  exact(value, ['schema', 'objects', 'roles', 'unsupported']);
  exact(value.unsupported, ['largeObjects', 'securityLabels']);
  const allowed = new Set(['phub_beta', 'phub_migrator', 'phub_runtime', 'phub', 'postgres']);
  if (
    value.schema !== 'PHUB_NOTIFICATION_BACKUP_SECURITY_V1' ||
    value.unsupported.largeObjects !== 0 ||
    value.unsupported.securityLabels !== 0 ||
    !Array.isArray(value.roles) ||
    value.roles.length < 1 ||
    value.roles.length > 100 ||
    !same(value.roles, [...new Set(value.roles)].sort()) ||
    value.roles.some(
      (role) =>
        typeof role !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(role) || !allowed.has(role),
    ) ||
    !Array.isArray(value.objects) ||
    value.objects.length < 1 ||
    value.objects.length > 20000
  )
    fail('POST105_SECURITY_INVENTORY');
  const known = (role) =>
    typeof role === 'string' && (value.roles.includes(role) || role.startsWith('pg_'));
  const keys = [];
  for (const row of value.objects) {
    exact(row, ['key', 'kind', 'owner', 'props', 'acl']);
    if (typeof row.key !== 'string' || !row.key || !known(row.owner) || !Array.isArray(row.acl))
      fail('POST105_SECURITY_INVENTORY');
    keys.push(row.key);
    for (const acl of row.acl) {
      exact(acl, ['grantor', 'grantee', 'privilege', 'grantable']);
      if (
        !known(acl.grantor) ||
        !(acl.grantee === 'PUBLIC' || known(acl.grantee)) ||
        typeof acl.grantable !== 'boolean'
      )
        fail('POST105_SECURITY_INVENTORY');
    }
  }
  if (!same(keys, [...new Set(keys)].sort())) fail('POST105_SECURITY_INVENTORY');
  return value;
}
export function validateJoinPost105BackupBundle(
  bundle,
  join,
  controllerTree,
  actual,
  { fresh = true, now = Date.now() } = {},
) {
  exact(bundle, ['operation', 'receipt', 'preimage', 'golden', 'descriptor', 'terminal']);
  exact(actual, ['dumpSha256', 'toolSha256', 'installationSha256']);
  const op = validateJoinPost105BackupOperation(
    parseStrictJson(bundle.operation),
    join,
    controllerTree,
  );
  const receipt = parseStrictJson(bundle.receipt),
    preimage = parseStrictJson(bundle.preimage);
  const directory = `${BACKUP_ROOT}/${op.releaseId}-join-post105`;
  exact(receipt, [
    'schema',
    'baselineReleaseId',
    'completedAt',
    'backupFile',
    'backupSha256',
    'restoreVerified',
    'restoreImage',
    'restoredLedgerSha256',
    'sourceLedgerSha256',
    'operationSha256',
    'target',
    'preimageSha256',
    'packageDescriptorSha256',
    'catalogsSha256',
    'aclRecovery',
    'securityPreimageSha256',
    'restoredSecuritySha256',
    'roleClosureSha256',
    'notificationBundleSha256',
  ]);
  if (
    receipt.schema !== JOIN_POST105_BACKUP_RECEIPT ||
    receipt.baselineReleaseId !== join.expectedApi.releaseId ||
    receipt.operationSha256 !== joinHash(bundle.operation) ||
    receipt.operationSha256 !== join.post105BackupOperationSha256 ||
    receipt.preimageSha256 !== joinHash(bundle.preimage) ||
    receipt.restoreVerified !== true ||
    receipt.backupFile !== directory + '/database.pgcustom' ||
    !H.test(receipt.backupSha256 ?? '') ||
    receipt.backupSha256 !== actual.dumpSha256 ||
    actual.toolSha256 !== op.toolFileSha256 ||
    actual.installationSha256 !== op.toolInstallationSha256 ||
    receipt.restoreImage !== PG_IMAGE ||
    receipt.sourceLedgerSha256 !== NOTIFICATION_POST_LEDGER ||
    receipt.restoredLedgerSha256 !== NOTIFICATION_POST_LEDGER ||
    receipt.packageDescriptorSha256 !== op.packageDescriptorSha256 ||
    op.packageDescriptorSha256 !== joinHash(bundle.descriptor) ||
    receipt.catalogsSha256 !== op.catalogsSha256 ||
    op.catalogsSha256 !== joinHash(bundle.golden) ||
    receipt.aclRecovery !== 'ISOLATED_OWNER_ACL_RESTORE_VERIFIED' ||
    receipt.notificationBundleSha256 !== join.notificationBundleSha256 ||
    !utc(receipt.completedAt) ||
    Date.parse(receipt.completedAt) > now ||
    Date.parse(receipt.completedAt) > Date.parse(op.expiresAt) ||
    (fresh && now - Date.parse(receipt.completedAt) > 3600000)
  )
    fail('POST105_BACKUP');
  exact(preimage, ['state', 'target', 'security']);
  validateNotificationState(preimage.state, 'post', bundle.golden, bundle.descriptor);
  validateJoinPost105SecurityInventory(preimage.security);
  if (
    !same(preimage.target, preimage.state.target) ||
    !same(preimage.target, receipt.target) ||
    receipt.securityPreimageSha256 !== joinHash(pythonBytes(preimage.security)) ||
    receipt.restoredSecuritySha256 !== receipt.securityPreimageSha256 ||
    !Array.isArray(preimage.security?.roles) ||
    receipt.roleClosureSha256 !== joinHash(pythonBytes(preimage.security.roles))
  )
    fail('POST105_SECURITY');
  validateJoinPost105BackupTerminal(
    parseStrictJson(bundle.terminal),
    receipt,
    bundle.receipt,
    bundle.preimage,
  );
  return {
    path: directory + '/database-backup-receipt.json',
    sha256: joinHash(bundle.receipt),
    operationSha256: joinHash(bundle.operation),
    preimageSha256: joinHash(bundle.preimage),
    dumpSha256: actual.dumpSha256,
    toolSha256: actual.toolSha256,
    installationSha256: actual.installationSha256,
    terminalSha256: joinHash(bundle.terminal),
    sourceLedgerSha256: NOTIFICATION_POST_LEDGER,
    notificationBundleSha256: op.notificationBundleSha256,
    completedAt: receipt.completedAt,
  };
}
