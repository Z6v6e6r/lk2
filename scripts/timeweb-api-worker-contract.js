import { createHash } from 'node:crypto';
import { parseStrictJson } from './strict-json.js';
const ROOT = '/opt/phub/timeweb-beta',
  HASH = /^[a-f0-9]{64}$/,
  SHA = /^[a-f0-9]{40}$/,
  ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const names = ['.release-identity.json', 'api.env', 'migrator.env', 'realtime.env', 'worker.env'];
const hash = (v) => createHash('sha256').update(v).digest('hex'),
  same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  throw new Error(`API_WORKER_${code}`);
};
export const API_WORKER_BRIDGE = Object.freeze({
  candidateSha: '11954ffd6d7bf7bd9b198e7e68d2123011f091c1',
  candidateTree: 'f5f5b2b5227018cf237de4fb8d7fe0f8ef53d1d5',
  sourceCiRunId: '38141799775',
  publicationRunId: '38144582876',
  artifactId: '11705270641',
  artifactDigest: 'sha256:922c969b4ba3d5dfcb14874dd58574125e6f4bbba8ac9cdb73dd517fd3dbfe85',
  manifestSha256: '2d7aee9ece1b6f1001052b5d4ec1914c58159d2844310a255cd3d113c984214a',
  apiSource: '0d6078be7a50ed3f5761d66071527be003bd568f', // gitleaks:allow public Git revision
  apiRelease: '0d6078be7a50ed3f5761d66071527be003bd568f-37038298584-1', // gitleaks:allow public OCI release label
  apiDigest: 'sha256:a2563721aa46a7785d9ad00d98f002040cbd884446761bb5d7bbdf18a7a43c69',
  workerSource: 'ff42c9e9a23895d94889f2982224d21a41be8255',
  workerDigest: 'sha256:b22baaeb97729c131c1159f55c6fc4c174b54846585cd3f7975bf5bcf9898006',
  candidateApiDigest: 'sha256:7f68ac35eefce73ce1936a86567fc5af7674f0e92f01e793ec1ed3aa7d9ec45f',
  candidateWorkerDigest: 'sha256:85325e6ee73456e329e54efa644614c8683c08dc01c18f4428c2217c65702d3a',
  ledgerSha256: '564a58bc61c95c04496ca607697aba375e89e3b874ee171cd50a38c3387a3bf9',
  postgresId: 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
  postgresImage:
    'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
});
export const API_WORKER_CONTROLLER_FILES = new Set([
  'scripts/timeweb-api-worker-upgrade.d.ts',
  'scripts/timeweb-api-worker-adapter.test.ts',
  'scripts/timeweb-api-worker.fixture.ts',
  'scripts/timeweb-api-worker-contract.js',
  'scripts/timeweb-api-worker-upgrade.js',
  'scripts/timeweb-api-worker-upgrade.test.ts',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/provision-timeweb-beta-runtime-secrets.js',
  'scripts/provision-timeweb-beta-runtime-secrets.d.ts',
  'scripts/provision-timeweb-beta-runtime-secrets.test.ts',
  'docs/runbooks/timeweb-standard-delivery.md',
  'docs/runbooks/android-chats-fcm.md',
]);
export function exact(v, keys) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    !same(Object.keys(v).sort(), [...keys].sort())
  )
    fail('FIELDS');
}
export function validateApiWorkerOperation(op, now) {
  exact(op, [
    'schema',
    'target',
    'controllerSha',
    'controllerSourceCiRunId',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'expectedApi',
    'expectedWorker',
    'expectedCurrentSecretSetReleaseId',
    'candidateSecretHashes',
    'fcmEnvironment',
    'expiresAt',
    'confirmation',
  ]);
  exact(op.target, ['hostname', 'serverId', 'projectId']);
  if (
    op.schema !== 'PHUB_TIMEWEB_API_WORKER_OPERATION_V1' ||
    !same(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 }) ||
    !SHA.test(op.controllerSha ?? '') ||
    !/^[1-9][0-9]*$/.test(op.controllerSourceCiRunId ?? '') ||
    op.fcmEnvironment !== 'SANDBOX' ||
    !ID.test(op.expectedCurrentSecretSetReleaseId ?? '')
  )
    fail('IDENTITY');
  for (const key of [
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
  ])
    if (op[key] !== API_WORKER_BRIDGE[key]) fail('BRIDGE');
  for (const service of ['api', 'worker']) {
    const value = op[service === 'api' ? 'expectedApi' : 'expectedWorker'];
    exact(value, ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt']);
    const digest = API_WORKER_BRIDGE[`${service}Digest`];
    if (
      !HASH.test(value.id ?? '') ||
      value.image !== `ghcr.io/z6v6e6r/phub-${service}@${digest}` ||
      value.imageId !== digest ||
      value.revision !== API_WORKER_BRIDGE[`${service}Source`] ||
      value.releaseId !== (service === 'api' ? API_WORKER_BRIDGE.apiRelease : null) ||
      value.restarts !== 0 ||
      !Number.isFinite(Date.parse(value.startedAt))
    )
      fail('PREVIOUS');
  }
  exact(op.candidateSecretHashes, names);
  if (!Object.values(op.candidateSecretHashes).every((v) => typeof v === 'string' && HASH.test(v)))
    fail('SECRET_HASHES');
  const expiry = Date.parse(op.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== op.expiresAt ||
    (now !== undefined && (expiry - now < 1200000 || expiry - now > 3600000))
  )
    fail('EXPIRY');
  if (
    op.confirmation !==
    'UPGRADE_API_WORKER_11954FFD6D7B_FROM_0D6078BE7A50_FF42C9E9A238_GLOBAL_FCM_ON_TENANT_PROVIDER_GATES_OFF_NO_SEND'
  )
    fail('CONFIRMATION');
  return op;
}
export function validateApiWorkerControllerDelta(entries) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.some((v) => !['A', 'M'].includes(v.status) || !API_WORKER_CONTROLLER_FILES.has(v.path))
  )
    fail('CONTROLLER_DELTA');
}
export function validateApiWorkerLedger(applied, packaged) {
  if (!Array.isArray(applied) || !Array.isArray(packaged) || packaged.length !== 101)
    fail('LEDGER');
  const canonical = (values) =>
    values.map((v) => {
      exact(v, ['filename', 'checksum']);
      if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(v.filename ?? '') || !HASH.test(v.checksum ?? ''))
        fail('LEDGER');
      return v;
    });
  canonical(applied);
  canonical(packaged);
  const manifest = packaged.map((v) => `${v.filename}|${v.checksum}\n`).join('');
  if (hash(manifest) !== API_WORKER_BRIDGE.ledgerSha256 || !same(applied, packaged)) fail('LEDGER');
}

export function validateApiWorkerReceipt(receipt, planSha256) {
  const terminal = receipt.status === 'RECONCILED' ? receipt.reconciledStatus : receipt.status;
  exact(receipt, [
    'schema',
    'status',
    'planSha256',
    'observedAt',
    ...(receipt.status === 'RECONCILED' ? ['reconciledStatus'] : []),
    ...(terminal === 'SUCCESS'
      ? [
          'installedBaselineSha256',
          'observationSha256',
          'providerReadbackSha256',
          'alertReadbackSha256',
        ]
      : []),
  ]);
  const phases = [
    'PREPARING',
    'PREPARED',
    'WORKER_STOP_INTENT',
    'WORKER_STOPPED',
    'SECRET_SWAP_INTENT',
    'SECRETS_ACTIVE',
    'API_INTENT',
    'API_ACTIVE',
    'WORKER_INTENT',
    'WORKER_ACTIVE',
    'OBSERVING',
    'BASELINE_INTENT',
    'GATE_RELEASE_INTENT',
    'SUCCESS',
    'ROLLBACK_INTENT',
    'WORKER_CONTAINED',
    'PREVIOUS_SECRETS',
    'ROLLED_BACK',
    'ROLLBACK_FAILED',
    'ABORTED',
  ];
  if (
    receipt.schema !== 'PHUB_TIMEWEB_API_WORKER_RECEIPT_V1' ||
    receipt.planSha256 !== planSha256 ||
    !HASH.test(planSha256) ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    !phases.includes(terminal) ||
    (receipt.status === 'RECONCILED' && !['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(terminal))
  )
    fail('RECEIPT');
  if (
    terminal === 'SUCCESS' &&
    ![
      'installedBaselineSha256',
      'observationSha256',
      'providerReadbackSha256',
      'alertReadbackSha256',
    ].every((k) => HASH.test(receipt[k] ?? ''))
  )
    fail('RECEIPT');
  return receipt;
}

export function assertPlan(plan, op, operationBytes) {
  exact(plan, [
    'schema',
    'operationSha256',
    'controllerSha',
    'manifestSha256',
    'artifactDigest',
    'composeSha256',
    'baselineSha256',
    'baselinePath',
    'previous',
    'candidate',
    'excluded',
    'previousSecrets',
    'candidateSecrets',
    'credential',
    'packagedLedger',
    'unchangedImages',
    'createdAt',
  ]);
  if (
    plan.schema !== 'PHUB_TIMEWEB_API_WORKER_PLAN_V1' ||
    plan.operationSha256 !== hash(operationBytes) ||
    plan.controllerSha !== op.controllerSha ||
    plan.manifestSha256 !== op.manifestSha256 ||
    plan.artifactDigest !== op.artifactDigest ||
    !same(plan.previous.api, op.expectedApi) ||
    !same(plan.previous.worker, op.expectedWorker) ||
    plan.previousSecrets.releaseId !== op.expectedCurrentSecretSetReleaseId ||
    !same(plan.candidateSecrets.files, op.candidateSecretHashes)
  )
    fail('PLAN');
  for (const service of ['api', 'worker']) {
    exact(plan.candidate[service], ['image', 'releaseId', 'revision']);
    if (
      plan.candidate[service].releaseId !==
        (service === 'api' ? `${op.candidateSha}-${op.publicationRunId}-1` : null) ||
      plan.candidate[service].revision !== op.candidateSha ||
      plan.candidate[service].image !==
        `ghcr.io/z6v6e6r/phub-${service}@${API_WORKER_BRIDGE[service === 'api' ? 'candidateApiDigest' : 'candidateWorkerDigest']}`
    )
      fail('PLAN');
  }
  if (
    ![
      `${ROOT}/releases/${op.expectedApi.releaseId}/release.env`,
      `${ROOT}/releases/${op.expectedApi.releaseId}/installed-components.env`,
    ].includes(plan.baselinePath) ||
    !['composeSha256', 'baselineSha256'].every((k) => HASH.test(plan[k] ?? ''))
  )
    fail('PLAN_PATH');
  exact(plan.previous, ['api', 'worker']);
  exact(plan.candidate, ['api', 'worker']);
  exact(plan.unchangedImages, [
    'WEB_IMAGE_DIGEST',
    'REALTIME_IMAGE_DIGEST',
    'MIGRATOR_IMAGE_DIGEST',
  ]);
  if (!Object.values(plan.unchangedImages).every((v) => /^sha256:[a-f0-9]{64}$/.test(v)))
    fail('PLAN_IMAGES');
  validateApiWorkerLedger(plan.packagedLedger, plan.packagedLedger);
}
export function validateInstalledApiWorkerEvidence({
  releaseId,
  values,
  bytes,
  receipt,
  planBytes,
  operationBytes,
  evidence,
}) {
  const plan = parseStrictJson(planBytes.toString()),
    op = validateApiWorkerOperation(parseStrictJson(operationBytes.toString()));
  assertPlan(plan, op, operationBytes);
  validateApiWorkerReceipt(receipt, hash(planBytes));
  if (
    releaseId !== `${op.candidateSha}-${op.publicationRunId}-1` ||
    values.PHUB_RELEASE_ID !== releaseId ||
    values.PHUB_RELEASE_SOURCE_SHA !== undefined ||
    values.PHUB_RELEASE_SOURCE_TREE !== undefined ||
    Object.entries(plan.unchangedImages).some(([k, v]) => values[k] !== v) ||
    values.PHUB_COMPONENT_ROLLOUT_KIND !== 'API_WORKER' ||
    values.PHUB_COMPONENT_ROLLOUT_RECEIPT !==
      `${ROOT}/backups/${releaseId}-api-worker/rollout-receipt.json` ||
    values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID !== releaseId ||
    receipt.installedBaselineSha256 !== hash(bytes) ||
    !['SUCCESS', 'RECONCILED'].includes(receipt.status) ||
    (receipt.status === 'RECONCILED' && receipt.reconciledStatus !== 'SUCCESS')
  )
    fail('INSTALLED');
  for (const service of ['api', 'worker'])
    if (
      `ghcr.io/z6v6e6r/phub-${service}@${values[`${service.toUpperCase()}_IMAGE_DIGEST`]}` !==
      plan.candidate[service].image
    )
      fail('INSTALLED');
  const observation = parseStrictJson(evidence['observation.json']);
  exact(observation, [
    'schema',
    'startedAt',
    'completedAt',
    'samples',
    'providerActivation',
    'deviceDelivery',
  ]);
  if (
    observation.schema !== 'PHUB_TIMEWEB_API_WORKER_OBSERVATION_V1' ||
    observation.providerActivation !== false ||
    observation.deviceDelivery !== false ||
    !Array.isArray(observation.samples) ||
    observation.samples.length !== 61 ||
    Date.parse(observation.completedAt) - Date.parse(observation.startedAt) < 900000 ||
    observation.samples.some(
      (v, i) =>
        !Number.isFinite(Date.parse(v)) ||
        (i > 0 && Date.parse(v) - Date.parse(observation.samples[i - 1]) < 15000),
    )
  )
    fail('INSTALLED_OBSERVATION');
  for (const [file, key] of [
    ['observation.json', 'observationSha256'],
    ['timeweb-monitor-readback.json', 'providerReadbackSha256'],
    ['alert-test-readback.json', 'alertReadbackSha256'],
  ])
    if (hash(evidence[file]) !== receipt[key]) fail('INSTALLED_EVIDENCE');
}
