// Closed, explicit Web-only mode of the enrolled controller. No publication, token, candidate code
// execution, API activation, migration, secret provisioning or installed-backend descriptor write.
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from './strict-json.js';
import { verifySourceCi } from './verify-source-ci.js';
import { standardWebComposeArgs } from './timeweb-standard-policy.js';
import {
  secureUpgradePath,
  readUpgradeFile,
  upgradeGit as git,
  upgradeDocker as docker,
  inspectUpgradeService as inspect,
  inspectUpgradeExcluded as excluded,
  upgradeSecretHashes as secrets,
  validateUpgradeCandidateAuthority as candidateAuthority,
  assertUpgradeImagePresent as imagePresent,
  probeUpgradeService as probe,
  validateUpgradeBackup as backupProof,
  readUpgradeMonitoring as monitoring,
  readInstalledApiBaseline,
  githubPublic,
  writeUpgradeAtomic as durable,
  apiWebArtifactSmokeArgs,
} from './timeweb-api-web-upgrade.js';

const ROOT = '/opt/phub/timeweb-beta';
const SOURCE = `${ROOT}/standard/source`;
const REQUEST = `${ROOT}/operator/web-upgrade.json`;
const LOCK = `${ROOT}/standard/active`;
const CONFIG = '/etc/phub/timeweb-beta-standard-delivery.json';
const COMPOSE = `${SOURCE}/deploy/timeweb/compose.beta.yaml`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  throw new Error(`CRITICAL_WEB_${code}`);
};
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const NUMBER = /^[1-9][0-9]*$/;
export const WEB_COMPATIBILITY = Object.freeze({
  baselineSource: '0d6078be7a50ed3f5761d66071527be003bd568f',
  baselineTree: '5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4',
  runtimeSource: '8960afe24211372320006fc4c5b18905923672f5',
  runtimeTree: 'bf0988012cfce0f14811491a14ae46fa57fe5541',
  runtimeDeltaSha256: 'c71dcfeb564b648ff78305680af3d3a37477a2d54e1db8101662c2b1d6e11fec',
});
// These are not build inputs: Web's npm scripts/imports do not execute these controller files.
// Everything else in COPY . . is frozen to the reviewed runtime tree, including all tests/deps.
export const WEB_CONTROLLER_FILES = new Set([
  'scripts/timeweb-critical-web.js',
  'scripts/timeweb-critical-web.test.ts',
  'scripts/rehearse-timeweb-standard-compose.js',
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/timeweb-api-web-upgrade.js',
  'docs/runbooks/timeweb-standard-delivery.md',
]);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !equal(Object.keys(value).sort(), [...keys].sort())
  )
    fail('FIELDS');
}
export function validateCriticalWebOperation(op, now) {
  exact(op, [
    'schema',
    'target',
    'component',
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
    'expectedWeb',
    'expiresAt',
    'confirmation',
  ]);
  exact(op.target, ['hostname', 'serverId', 'projectId']);
  if (
    op.schema !== 'PHUB_TIMEWEB_CRITICAL_WEB_OPERATION_V1' ||
    op.component !== 'web' ||
    !equal(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 }) ||
    ![op.controllerSha, op.candidateSha, op.candidateTree].every(
      (v) => typeof v === 'string' && SHA.test(v),
    ) ||
    op.candidateSha !== op.controllerSha ||
    op.sourceCiRunId !== op.controllerSourceCiRunId ||
    ![op.sourceCiRunId, op.publicationRunId, op.artifactId].every(
      (v) => typeof v === 'string' && NUMBER.test(v),
    ) ||
    !DIGEST.test(op.artifactDigest ?? '') ||
    !HASH.test(op.manifestSha256 ?? '')
  )
    fail('IDENTITY');
  for (const service of ['api', 'web']) {
    const previous = service === 'api' ? op.expectedApi : op.expectedWeb;
    exact(previous, ['id', 'image', 'releaseId']);
    if (
      !HASH.test(previous.id ?? '') ||
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        previous.image ?? '',
      ) ||
      !new RegExp(`^${WEB_COMPATIBILITY.baselineSource}-[1-9][0-9]*-1$`).test(
        previous.releaseId ?? '',
      )
    )
      fail('BASELINE');
  }
  const expiry = Date.parse(op.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== op.expiresAt ||
    (now !== undefined && (expiry - now < 1200000 || expiry - now > 3600000))
  )
    fail('EXPIRY');
  if (
    op.confirmation !==
    `UPGRADE_WEB_${op.candidateSha.slice(0, 12).toUpperCase()}_FROM_${op.expectedWeb.image.split('@')[1].slice(-12).toUpperCase()}_KEEP_API_${WEB_COMPATIBILITY.baselineSource.slice(0, 12).toUpperCase()}`
  )
    fail('CONFIRMATION');
  return op;
}
export function validateWebControllerDelta(entries) {
  if (!entries.every((v) => ['A', 'M'].includes(v.status) && WEB_CONTROLLER_FILES.has(v.path)))
    fail('SOURCE_DELTA');
}
export function validateCriticalWebSource(op, runGit = git) {
  if (
    runGit(['rev-parse', `${op.candidateSha}^{tree}`]) !== op.candidateTree ||
    runGit(['rev-parse', `${WEB_COMPATIBILITY.baselineSource}^{tree}`]) !==
      WEB_COMPATIBILITY.baselineTree ||
    runGit(['rev-parse', `${WEB_COMPATIBILITY.runtimeSource}^{tree}`]) !==
      WEB_COMPATIBILITY.runtimeTree
  )
    fail('SOURCE_TREE');
  runGit([
    'merge-base',
    '--is-ancestor',
    WEB_COMPATIBILITY.baselineSource,
    WEB_COMPATIBILITY.runtimeSource,
  ]);
  runGit(['merge-base', '--is-ancestor', WEB_COMPATIBILITY.runtimeSource, op.candidateSha]);
  // git() trims output, so use a newline-safe raw representation for the exact review fixture.
  const raw = runGit([
    'diff',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '-z',
    WEB_COMPATIBILITY.baselineSource,
    WEB_COMPATIBILITY.runtimeSource,
  ]);
  if (hash(raw) !== WEB_COMPATIBILITY.runtimeDeltaSha256) fail('RUNTIME_PROOF');
  const parts = runGit([
    'diff',
    '--no-renames',
    '--name-status',
    '-z',
    WEB_COMPATIBILITY.runtimeSource,
    op.candidateSha,
  ])
    .split('\0')
    .filter(Boolean);
  if (parts.length % 2) fail('SOURCE_DELTA');
  validateWebControllerDelta(
    Array.from({ length: parts.length / 2 }, (_, i) => ({
      status: parts[2 * i],
      path: parts[2 * i + 1],
    })),
  );
  for (let i = 1; i < parts.length; i += 2) {
    if (!/^100644 blob [a-f0-9]{40}\t/.test(runGit(['ls-tree', op.candidateSha, '--', parts[i]])))
      fail('CONTROLLER_FILE_MODE');
  }
}
export function validateCriticalWebRequestStat(info, owner = 0) {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== owner ||
    info.gid !== owner ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    info.size <= 0 ||
    info.size > 65536
  )
    fail('REQUEST_PATH');
}
function requestBytes(path) {
  secureUpgradePath(dirname(path));
  const before = lstatSync(path);
  validateCriticalWebRequestStat(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    validateCriticalWebRequestStat(opened);
    if (
      ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].some(
        (k) => before[k] !== opened[k],
      )
    )
      fail('REQUEST_RACE');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some((k) => opened[k] !== after[k]))
      fail('REQUEST_RACE');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
async function ci(id, sha) {
  const run = await githubPublic(`actions/runs/${id}`);
  const jobs = await githubPublic(`actions/runs/${id}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs?.length) fail('SOURCE_JOBS');
  verifySourceCi(run, jobs.jobs, sha);
}
export async function runCriticalWebTransition(ops, mode, phase) {
  if (mode === 'reconcile') {
    if (!['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(phase)) fail('RECONCILE_PHASE');
    await (phase === 'SUCCESS' ? ops.attestCandidate() : ops.attestPrevious());
    await ops.attestBackend();
    await ops.journal('RECONCILED', phase);
    await ops.unlock();
    return 'RECONCILED';
  }
  if (mode === 'recover') {
    if (['PREPARED', 'PREPARATION_FAILED'].includes(phase)) {
      await ops.attestPrevious();
      await ops.attestBackend();
      await ops.journal('ABORTED');
      return 'ABORTED';
    }
    if (!['ACTIVATING', 'OBSERVING', 'ROLLBACK_INTENT', 'ROLLBACK_FAILED'].includes(phase))
      fail('RECOVERY_PHASE');
    await ops.journal('ROLLBACK_INTENT');
    try {
      await ops.rollback();
      await ops.attestPrevious();
      await ops.attestBackend();
      await ops.journal('ROLLED_BACK');
    } catch {
      await ops.journal('ROLLBACK_FAILED');
      fail('ROLLBACK_UNPROVEN');
    }
    return 'ROLLED_BACK';
  }
  if (mode !== 'deploy' || phase !== 'PREPARED') fail('DEPLOY_PHASE');
  let activated = false;
  try {
    await ops.attestPrevious();
    await ops.preflight();
    await ops.pull();
    await ops.artifactSmoke();
    await ops.authorizeActivation();
    await ops.journal('ACTIVATING');
    await ops.activate(() => {
      activated = true;
    });
    await ops.journal('OBSERVING');
    await ops.observe();
    await ops.attestCandidate();
    await ops.attestBackend();
    await ops.journal('SUCCESS');
  } catch (error) {
    if (!activated) {
      await ops.journal('PREPARATION_FAILED');
      throw error;
    }
    try {
      await ops.journal('ROLLBACK_INTENT');
      await ops.rollback();
      await ops.attestPrevious();
      await ops.attestBackend();
      await ops.journal('ROLLED_BACK');
    } catch {
      await ops.journal('ROLLBACK_FAILED');
      fail('ROLLBACK_UNPROVEN');
    }
    throw error;
  }
  // An unlock/fsync failure after durable SUCCESS is reconciled; it must never trigger an extra up.
  await ops.unlock();
  return 'SUCCESS';
}
export async function observeCriticalWeb(ops) {
  const startedAt = ops.now();
  const samples = [];
  for (let round = 0; round < 61; round++) {
    await ops.attest();
    const row = { observedAt: new Date(ops.now()).toISOString() };
    for (const service of ['api', 'web']) {
      for (const access of ['private', 'public']) {
        const value = await ops.probe(service, access === 'public');
        if (!Number.isFinite(value) || value < 0) fail('PROBE_LATENCY');
        row[`${service}_${access}`] = value;
      }
    }
    samples.push(row);
    if (round < 60) await ops.sleep(15000);
  }
  await ops.attest();
  if (ops.now() - startedAt < 900000) fail('OBSERVATION_WINDOW');
  for (const service of ['api', 'web'])
    for (const access of ['private', 'public']) {
      const values = samples.map((v) => v[`${service}_${access}`]).sort((a, b) => a - b);
      if (values[Math.ceil(values.length * 0.95) - 1] > (service === 'api' ? 1500 : 1000))
        fail('LATENCY_THRESHOLD');
    }
  return {
    schema: 'PHUB_TIMEWEB_CRITICAL_WEB_OBSERVATION_V1',
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(ops.now()).toISOString(),
    samples,
  };
}
export function validateCriticalWebReceipt(receipt, planSha256, operationSha256, readEvidence) {
  const required = [
    'schema',
    'status',
    'planSha256',
    'operationSha256',
    'observedAt',
    'userOutcome',
  ];
  const optional = [
    'observationSha256',
    'providerSha256',
    'alertSha256',
    'reconciledStatus',
    'reconciledAt',
  ];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    required.some((k) => !Object.hasOwn(receipt, k)) ||
    Object.keys(receipt).some((k) => ![...required, ...optional].includes(k)) ||
    receipt.schema !== 'PHUB_TIMEWEB_CRITICAL_WEB_RECEIPT_V1' ||
    receipt.planSha256 !== planSha256 ||
    receipt.operationSha256 !== operationSha256 ||
    ![
      'PREPARED',
      'ACTIVATING',
      'OBSERVING',
      'SUCCESS',
      'PREPARATION_FAILED',
      'ROLLBACK_INTENT',
      'ROLLED_BACK',
      'ROLLBACK_FAILED',
      'ABORTED',
      'RECONCILED',
    ].includes(receipt.status) ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    new Date(Date.parse(receipt.observedAt)).toISOString() !== receipt.observedAt ||
    receipt.userOutcome !== 'requires-product-feedback'
  )
    fail('RECEIPT');
  for (const field of ['observationSha256', 'providerSha256', 'alertSha256'])
    if (receipt[field] !== undefined && !HASH.test(receipt[field])) fail('RECEIPT');
  if (
    receipt.status === 'RECONCILED' &&
    (!['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(receipt.reconciledStatus) ||
      !Number.isFinite(Date.parse(receipt.reconciledAt)) ||
      new Date(Date.parse(receipt.reconciledAt)).toISOString() !== receipt.reconciledAt)
  )
    fail('RECEIPT');
  if (
    receipt.status !== 'RECONCILED' &&
    (receipt.reconciledStatus !== undefined || receipt.reconciledAt !== undefined)
  )
    fail('RECEIPT');
  if (receipt.status === 'SUCCESS' || receipt.reconciledStatus === 'SUCCESS')
    validateCriticalWebSuccessEvidence(receipt, readEvidence);
}
export function validateCriticalWebSuccessEvidence(receipt, readEvidence) {
  for (const [field, name] of [
    ['observationSha256', 'observation.json'],
    ['providerSha256', 'provider-final.json'],
    ['alertSha256', 'alerts-final.json'],
  ]) {
    if (!HASH.test(receipt[field] ?? '') || hash(readEvidence(name)) !== receipt[field])
      fail('SUCCESS_EVIDENCE');
  }
}
export function validateCriticalWebRecoveryImages(rows, plan) {
  if (rows.length > 1) fail('WEB_AMBIGUOUS');
  if (!rows.length) return;
  const v = rows[0];
  if (
    ![plan.candidate, plan.previous.web].some(
      (expected) =>
        v.Config.Image === expected.image &&
        v.Config.Labels['phub.release-id'] === expected.releaseId,
    )
  )
    fail('WEB_UNKNOWN');
}
function webForRecovery(plan) {
  const ids = docker([
    'ps',
    '-aq',
    '--filter',
    'label=com.docker.compose.project=phub-timeweb-beta',
    '--filter',
    'label=com.docker.compose.service=web',
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  validateCriticalWebRecoveryImages(
    ids.map((id) => JSON.parse(docker(['inspect', id]))[0]),
    plan,
  );
}

function removeLock(pointer) {
  if (!readUpgradeFile(LOCK).equals(pointer)) fail('LOCK_DRIFT');
  unlinkSync(LOCK);
  const fd = openSync(dirname(LOCK), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function runCriticalWeb(mode, requestPath) {
  if (
    !['deploy', 'recover', 'reconcile'].includes(mode) ||
    requestPath !== REQUEST ||
    process.getuid?.() !== 0 ||
    resolve(dirname(fileURLToPath(import.meta.url)), '..') !== SOURCE
  )
    fail('ENTRY');
  secureUpgradePath(SOURCE);
  secureUpgradePath(`${SOURCE}/.git`);
  for (const path of [
    'node_modules/typescript/lib/typescript.js',
    'node_modules/postcss/lib/postcss.js',
  ])
    secureUpgradePath(`${SOURCE}/${path}`);
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secureUpgradePath(`${SOURCE}/${path}`);
  const config = parseStrictJson(readUpgradeFile(CONFIG));
  let pointer, transaction, opBytes;
  if (mode === 'deploy') opBytes = requestBytes(REQUEST);
  else {
    pointer = readUpgradeFile(LOCK);
    const lock = parseStrictJson(pointer);
    exact(lock, ['schema', 'planPath', 'planSha256']);
    if (
      lock.schema !== 'PHUB_TIMEWEB_CRITICAL_WEB_LOCK_V1' ||
      !HASH.test(lock.planSha256 ?? '') ||
      !new RegExp(`^${ROOT}/backups/[a-f0-9]{40}-[1-9][0-9]*-1-web/plan\\.json$`).test(
        lock.planPath ?? '',
      )
    )
      fail('LOCK');
    transaction = dirname(lock.planPath);
    secureUpgradePath(transaction, 0o700);
    opBytes = readUpgradeFile(`${transaction}/operation.json`);
    if (hash(readUpgradeFile(lock.planPath)) !== lock.planSha256) fail('PLAN_DIGEST');
  }
  const op = validateCriticalWebOperation(
    parseStrictJson(opBytes),
    mode === 'deploy' ? Date.now() : undefined,
  );
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    !config.owner ||
    config.controllerSha !== op.controllerSha ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail('CONTROLLER');
  validateCriticalWebSource(op);
  const id = `${op.candidateSha}-${op.publicationRunId}-1`;
  const directory = `${ROOT}/releases/${id}`;
  const expectedTransaction = `${ROOT}/backups/${id}-web`;
  if (transaction && transaction !== expectedTransaction) fail('TRANSACTION');
  transaction = expectedTransaction;
  secureUpgradePath(transaction, 0o700);
  const planPath = `${transaction}/plan.json`,
    receiptPath = `${transaction}/rollout-receipt.json`;
  let plan, phase;
  if (mode === 'deploy') {
    if (existsSync(LOCK) || existsSync(planPath) || existsSync(receiptPath)) fail('UNRECONCILED');
    await ci(op.sourceCiRunId, op.candidateSha);
    if (
      git(['ls-remote', 'https://github.com/Z6v6e6r/lk2.git', 'refs/heads/main']).split(/\s/)[0] !==
      op.candidateSha
    )
      fail('MAIN_DRIFT');
    const manifest = await candidateAuthority(op, directory);
    const baseline = readInstalledApiBaseline(op.expectedApi.releaseId);
    const api = inspect('api'),
      web = inspect('web');
    for (const [actual, expected] of [
      [api, op.expectedApi],
      [web, op.expectedWeb],
    ]) {
      if (
        actual.id !== expected.id ||
        actual.image !== expected.image ||
        actual.releaseId !== expected.releaseId ||
        actual.restarts !== 0
      )
        fail('BASELINE_DRIFT');
    }
    if (
      baseline.values.PHUB_MIGRATOR_ENABLED !== 'false' ||
      api.image !== `ghcr.io/z6v6e6r/phub-api@${baseline.values.API_IMAGE_DIGEST}`
    )
      fail('BASELINE_ENV');
    const image = manifest.images.find((v) => v.component === 'web');
    plan = {
      schema: 'PHUB_TIMEWEB_CRITICAL_WEB_PLAN_V1',
      operationSha256: hash(opBytes),
      owner: config.owner,
      compatibility: WEB_COMPATIBILITY,
      manifestSha256: op.manifestSha256,
      artifactDigest: op.artifactDigest,
      candidate: { image: `${image.repository}@${image.digest}`, releaseId: id },
      previous: { api, web },
      baseline: { path: baseline.path, sha256: hash(baseline.bytes) },
      secrets: secrets(),
      excluded: excluded(),
      composeSha256: hash(readUpgradeFile(COMPOSE, 0o644)),
      backup: backupProof(transaction, api),
    };
    monitoring();
    imagePresent(web.image, WEB_COMPATIBILITY.baselineSource);
    durable(`${transaction}/operation.json`, opBytes, true);
    durable(planPath, JSON.stringify(plan) + '\n', true);
    pointer = Buffer.from(
      JSON.stringify({
        schema: 'PHUB_TIMEWEB_CRITICAL_WEB_LOCK_V1',
        planPath,
        planSha256: hash(readUpgradeFile(planPath)),
      }) + '\n',
    );
    durable(LOCK, pointer, true);
    phase = 'PREPARED';
  } else {
    plan = parseStrictJson(readUpgradeFile(planPath));
    if (
      plan.schema !== 'PHUB_TIMEWEB_CRITICAL_WEB_PLAN_V1' ||
      plan.operationSha256 !== hash(opBytes) ||
      !equal(plan.compatibility, WEB_COMPATIBILITY) ||
      plan.manifestSha256 !== op.manifestSha256 ||
      plan.artifactDigest !== op.artifactDigest ||
      plan.candidate.releaseId !== id ||
      !/^ghcr.io\/z6v6e6r\/phub-web@sha256:[a-f0-9]{64}$/.test(plan.candidate.image) ||
      ![plan.previous.api, plan.previous.web].every((v, i) =>
        ['id', 'image', 'releaseId'].every((k) => v[k] === [op.expectedApi, op.expectedWeb][i][k]),
      )
    )
      fail('PLAN');
    if (existsSync(receiptPath)) {
      const receipt = parseStrictJson(readUpgradeFile(receiptPath));
      validateCriticalWebReceipt(receipt, hash(readUpgradeFile(planPath)), hash(opBytes), (name) =>
        readUpgradeFile(`${transaction}/${name}`),
      );
      phase = receipt.status === 'RECONCILED' ? receipt.reconciledStatus : receipt.status;
      if (phase === 'SUCCESS')
        validateCriticalWebSuccessEvidence(receipt, (name) =>
          readUpgradeFile(`${transaction}/${name}`),
        );
    } else phase = 'PREPARED';
  }
  const planSha256 = hash(readUpgradeFile(planPath));
  const assertBackend = () => {
    if (
      git(['rev-parse', 'HEAD']) !== op.controllerSha ||
      git(['status', '--porcelain', '--untracked-files=no']) !== '' ||
      !equal(inspect('api'), plan.previous.api) ||
      !equal(excluded(), plan.excluded) ||
      !equal(secrets(), plan.secrets) ||
      hash(readUpgradeFile(plan.baseline.path)) !== plan.baseline.sha256 ||
      hash(readUpgradeFile(COMPOSE, 0o644)) !== plan.composeSha256 ||
      hash(readUpgradeFile(plan.backup.path)) !== plan.backup.sha256 ||
      !readUpgradeFile(LOCK).equals(pointer) ||
      hash(readUpgradeFile(planPath)) !== planSha256 ||
      hash(readUpgradeFile(`${transaction}/operation.json`)) !== plan.operationSha256
    )
      fail('BACKEND_DRIFT');
  };
  const attestWeb = (expected) => {
    const actual = inspect('web');
    if (
      actual.image !== expected.image ||
      actual.releaseId !== expected.releaseId ||
      actual.restarts !== 0
    )
      fail('WEB_DRIFT');
    return actual;
  };
  const overlay = `${transaction}/web-candidate.env`,
    rollback = `${transaction}/web-previous.env`;
  const envBytes = (expected) =>
    `PHUB_RELEASE_ID=${expected.releaseId}\nWEB_IMAGE_DIGEST=${expected.image.split('@')[1]}\n`;
  if (mode === 'deploy') {
    durable(overlay, envBytes(plan.candidate), true);
    durable(rollback, envBytes(plan.previous.web), true);
  }
  const compose = (file, operation) => {
    if (
      readUpgradeFile(file).toString() !==
      envBytes(file === overlay ? plan.candidate : plan.previous.web)
    )
      fail('OVERLAY_DRIFT');
    return docker(standardWebComposeArgs(COMPOSE, plan.baseline.path, file, operation));
  };
  const waitWeb = async (expected) => {
    for (let i = 0; i < 45; i++) {
      try {
        assertBackend();
        attestWeb(expected);
        return;
      } catch {
        await new Promise((done) => setTimeout(done, 2000));
      }
    }
    fail('READINESS');
  };
  let observationSha256, activatedWeb;
  const journal = async (status, reconciledStatus) => {
    const finalMonitoring = status === 'SUCCESS' ? monitoring() : undefined;
    if (finalMonitoring) {
      durable(`${transaction}/provider-final.json`, finalMonitoring.provider);
      durable(`${transaction}/alerts-final.json`, finalMonitoring.alerts);
    }
    const previousReceipt = existsSync(receiptPath)
      ? parseStrictJson(readUpgradeFile(receiptPath))
      : {};
    durable(
      receiptPath,
      JSON.stringify({
        ...previousReceipt,
        schema: 'PHUB_TIMEWEB_CRITICAL_WEB_RECEIPT_V1',
        status,
        planSha256,
        operationSha256: plan.operationSha256,
        observedAt: status === 'RECONCILED' ? previousReceipt.observedAt : new Date().toISOString(),
        ...(status === 'RECONCILED' ? { reconciledAt: new Date().toISOString() } : {}),
        ...(observationSha256 ? { observationSha256 } : {}),
        ...(reconciledStatus ? { reconciledStatus } : {}),
        ...(finalMonitoring
          ? {
              providerSha256: finalMonitoring.providerSha256,
              alertSha256: finalMonitoring.alertSha256,
            }
          : {}),
        userOutcome: 'requires-product-feedback',
      }) + '\n',
    );
  };
  assertBackend();
  if (mode === 'deploy') {
    if (!equal(inspect('web'), plan.previous.web)) fail('PREVIOUS_WEB_DRIFT');
    await journal('PREPARED');
  } else webForRecovery(plan);
  const activationAuthority = async () => {
    validateCriticalWebOperation(op, Date.now());
    assertBackend();
    if (!equal(backupProof(transaction, plan.previous.api), plan.backup)) fail('BACKUP_DRIFT');
    if (
      git(['ls-remote', 'https://github.com/Z6v6e6r/lk2.git', 'refs/heads/main']).split(/\s/)[0] !==
      op.candidateSha
    )
      fail('MAIN_DRIFT');
    monitoring();
    if (!equal(inspect('web'), plan.previous.web)) fail('PREVIOUS_WEB_DRIFT');
  };
  const status = await runCriticalWebTransition(
    {
      preflight: async () => {
        validateCriticalWebOperation(op, Date.now());
        if (!equal(backupProof(transaction, plan.previous.api), plan.backup)) fail('BACKUP_DRIFT');
        assertBackend();
        monitoring();
        if (
          git(['ls-remote', 'https://github.com/Z6v6e6r/lk2.git', 'refs/heads/main']).split(
            /\s/,
          )[0] !== op.candidateSha
        )
          fail('MAIN_DRIFT');
        if (JSON.parse(compose(overlay, 'config')).services.web.image !== plan.candidate.image)
          fail('COMPOSE');
      },
      pull: async () => {
        compose(overlay, 'pull');
        imagePresent(plan.candidate.image, op.candidateSha);
      },
      artifactSmoke: async () => {
        docker(apiWebArtifactSmokeArgs('web', plan.candidate.image));
      },
      authorizeActivation: activationAuthority,
      activate: async (markMutating) => {
        await activationAuthority();
        markMutating();
        compose(overlay, 'up');
        await waitWeb(plan.candidate);
        activatedWeb = attestWeb(plan.candidate);
      },
      observe: async () => {
        const evidence = await observeCriticalWeb({
          now: () => Date.now(),
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
          probe,
          attest: async () => {
            assertBackend();
            if (!equal(attestWeb(plan.candidate), activatedWeb)) fail('WEB_RESTART');
            monitoring();
          },
        });
        const bytes = Buffer.from(
          JSON.stringify({ ...evidence, installedWeb: activatedWeb }) + '\n',
        );
        durable(`${transaction}/observation.json`, bytes, true);
        observationSha256 = hash(bytes);
      },
      attestCandidate: async () => {
        const actual = attestWeb(plan.candidate);
        if (
          !equal(
            actual,
            parseStrictJson(readUpgradeFile(`${transaction}/observation.json`)).installedWeb,
          )
        )
          fail('SUCCESS_WEB_DRIFT');
      },
      attestPrevious: async () => {
        const actual = attestWeb(plan.previous.web);
        if (
          (mode === 'deploy' || mode === 'recover') &&
          ['PREPARED', 'PREPARATION_FAILED'].includes(phase) &&
          !equal(actual, plan.previous.web)
        )
          fail('PREPARATION_DRIFT');
      },
      attestBackend: async () => {
        assertBackend();
      },
      rollback: async () => {
        assertBackend();
        webForRecovery(plan);
        imagePresent(plan.previous.web.image, WEB_COMPATIBILITY.baselineSource);
        compose(rollback, 'up');
        await waitWeb(plan.previous.web);
      },
      journal,
      unlock: async () => {
        const receipt = parseStrictJson(readUpgradeFile(receiptPath));
        validateCriticalWebReceipt(receipt, planSha256, plan.operationSha256, (name) =>
          readUpgradeFile(`${transaction}/${name}`),
        );
        if (
          receipt.planSha256 !== planSha256 ||
          !['SUCCESS', 'RECONCILED'].includes(receipt.status)
        )
          fail('UNLOCK_RECEIPT');
        if (receipt.status === 'SUCCESS' || receipt.reconciledStatus === 'SUCCESS')
          validateCriticalWebSuccessEvidence(receipt, (name) =>
            readUpgradeFile(`${transaction}/${name}`),
          );
        removeLock(pointer);
      },
    },
    mode,
    phase,
  );
  return {
    schema: 'PHUB_TIMEWEB_CRITICAL_WEB_RESULT_V1',
    status,
    receiptPath,
    receiptSha256: hash(readUpgradeFile(receiptPath)),
    backendUnchanged: true,
  };
}
