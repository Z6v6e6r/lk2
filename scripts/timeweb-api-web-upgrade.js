// Explicit manual mode of the enrolled standard controller. Never execute candidate source.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  readdirSync,
  linkSync,
  unlinkSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename } from 'node:path';
import { validateCanonicalManifest } from './timeweb-release-manifest-contract.js';
import { validateTimewebRuntimeSecretPaths } from './render-timeweb-beta-release-env.js';
import { verifySourceCi } from './verify-source-ci.js';
import {
  validateTimewebMonitorReadback,
  validateTimewebAlertReadback,
} from './produce-timeweb-api-web-observability-evidence.js';
import { validateTimewebMonitoringEvidence } from './verify-timeweb-api-web-observability.js';

const ROOT = '/opt/phub/timeweb-beta';
const SOURCE = `${ROOT}/standard/source`;
const REQUEST = `${ROOT}/operator/api-web-upgrade.json`;
const CONFIG = '/etc/phub/timeweb-beta-standard-delivery.json';
const LOCK = `${ROOT}/standard/active`;
const COMPOSE = `${SOURCE}/deploy/timeweb/compose.beta.yaml`;
const RUNTIME = '/etc/phub/timeweb-beta';
const REPO = 'Z6v6e6r/lk2';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{40}-[1-9][0-9]*-1$/;
const NUMBER = /^[1-9][0-9]*$/;
const SECRET_NAMES = [
  'api.env',
  'worker.env',
  'realtime.env',
  'migrator.env',
  '.release-identity.json',
];
const CONTROLLER_FILES = new Set([
  'scripts/run-timeweb-standard-delivery.js',
  'scripts/timeweb-api-web-upgrade.js',
  'scripts/timeweb-api-web-upgrade.test.ts',
  'scripts/rehearse-timeweb-standard-compose.js',
  'scripts/timeweb-standard-compose.test.ts',
  'scripts/verify-timeweb-api-web-observability.js',
  'scripts/verify-timeweb-api-web-observability.d.ts',
  'docs/runbooks/timeweb-standard-delivery.md',
]);
// One reviewed, nonexecuted ancestry bridge; never a runtime/migration allowance.
export const INERT_CONTROLLER_BRIDGE = {
  candidate: '5429a69ca350c3277b8e6de4c2f5714176ac3f8e',
  sha: '9bbe61d63ba078f54d683d561ff097e96b59274e',
  blobs: {
    'docs/plans/customer-core/ARCHITECTURE.md': '926db8080242ef884b922087aedb8d39dac0e07e',
    'docs/plans/customer-core/AUDIT.md': 'cc562a50c1a63f50ca143bd08224c0ed437c00b2',
    'docs/plans/customer-core/MIGRATION_AND_ACCEPTANCE.md':
      'c80f7ac6af15e7e4382c49a2138850becd08154d',
    'docs/plans/customer-core/NEXT_CODEX_TASK.md': '987d8aa4aa58d736dc3be2a1f1317c84fd8e66c2',
    'docs/plans/customer-core/ROADMAP.md': '1ae333d67475eb7ac3bfedc6f222d223ae60aabb',
    'packages/database/migrations/0096_profile_contacts.sql':
      'dc9171185f0a7b75d80ecde64c6b08b4f3baa4c1',
    'packages/database/src/contact-repository-postgres.test.ts':
      '3a48fd7cb7b2bb796dfad7f7b913df31ae8b5258',
    'packages/database/src/contact-repository.test.ts': '70b5a7a0d89949a0e8326dd4ed1dab324bd0f371',
    'packages/database/src/contact-repository.ts': 'fffe999d05e73170a516d758cd210657171d18c1',
  },
};
export function validateControllerBridge(candidate, bridge, entries) {
  if (
    candidate !== INERT_CONTROLLER_BRIDGE.candidate ||
    bridge !== INERT_CONTROLLER_BRIDGE.sha ||
    !Array.isArray(entries) ||
    entries.length !== Object.keys(INERT_CONTROLLER_BRIDGE.blobs).length ||
    new Set(entries.map((v) => v.path)).size !== entries.length ||
    entries.some(
      (v) =>
        v.status !== 'A' ||
        v.mode !== '100644' ||
        v.type !== 'blob' ||
        INERT_CONTROLLER_BRIDGE.blobs[v.path] !== v.oid,
    )
  )
    fail('inert_controller_bridge');
}
const environment = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  DOCKER_CONFIG: '/root/.docker',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  COMPOSE_PROFILES: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function exact(value, keys) {
  if (!value || Array.isArray(value) || !equal(Object.keys(value).sort(), [...keys].sort()))
    fail('invalid_keys');
}
export function validateApiWebOperation(value) {
  exact(value, [
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
    'confirmation',
  ]);
  if (
    value.schema !== 'PHUB_TIMEWEB_API_WEB_OPERATION_V1' ||
    value.target !== 'lk2.padlhub.su' ||
    ![value.controllerSha, value.candidateSha, value.candidateTree].every((v) =>
      SHA.test(v ?? ''),
    ) ||
    ![value.sourceCiRunId, value.publicationRunId, value.artifactId].every(
      (v) => typeof v === 'string' && NUMBER.test(v),
    ) ||
    !DIGEST.test(value.artifactDigest ?? '') ||
    !HASH.test(value.manifestSha256 ?? '')
  )
    fail('invalid_operation');
  for (const service of ['api', 'web']) {
    const previous = value[service === 'api' ? 'expectedApi' : 'expectedWeb'];
    exact(previous, ['id', 'image', 'releaseId']);
    if (
      !HASH.test(previous.id ?? '') ||
      !ID.test(previous.releaseId ?? '') ||
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        previous.image ?? '',
      )
    )
      fail('invalid_previous');
  }
  if (
    value.confirmation !==
    `DEPLOY_API_WEB_${value.candidateSha.slice(0, 12).toUpperCase()}_FROM_${value.expectedApi.releaseId.slice(0, 12).toUpperCase()}_${value.expectedWeb.releaseId.slice(0, 12).toUpperCase()}`
  )
    fail('invalid_confirmation');
  return value;
}
export function validateControllerDelta(entries) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.some(({ status, path }) => !['A', 'M'].includes(status) || !CONTROLLER_FILES.has(path))
  )
    fail('candidate_controller_delta');
}
export function apiWebComposeArgs(baseline, overlay, action, service) {
  if (!['api', 'web'].includes(service) || !['config', 'pull', 'up'].includes(action))
    fail('invalid_stage');
  return [
    'compose',
    '--env-file',
    baseline,
    '--env-file',
    overlay,
    '-f',
    COMPOSE,
    ...(action === 'config'
      ? ['config', '--format', 'json']
      : action === 'pull'
        ? ['pull', service]
        : ['up', '-d', '--no-deps', service]),
  ];
}
// Every ambiguous activation has a durable intent. Recovery always converges to the previous pair.
export async function runApiWebTransition(ops) {
  let activationIntent = false;
  try {
    await ops.preflight();
    await ops.pullAndSmoke();
    await ops.journal('PREPARED');
    activationIntent = true; // An intent write may have committed even when its fsync fails.
    await ops.journal('API_INTENT');
    await ops.activate('api');
    await ops.journal('API_ACTIVE');
    await ops.journal('WEB_INTENT');
    await ops.activate('web');
    await ops.journal('OBSERVING');
    await ops.observe();
    await ops.attest();
    await ops.installBaseline();
    await ops.journal('SUCCESS');
  } catch (error) {
    if (activationIntent) await recoverApiWebTransition(ops);
    else {
      await ops.abort();
      await ops.journal('ABORTED');
    }
    throw error;
  }
}
export async function recoverApiWebTransition(ops) {
  try {
    await ops.journal('ROLLBACK_INTENT');
    // Continue API restoration even if Web restoration fails; never declare a partial restore safe.
    const errors = [];
    for (const service of ['web', 'api']) {
      try {
        await ops.restore(service);
      } catch {
        errors.push(service);
      }
    }
    if (errors.length) fail('restore_failed');
    await (ops.attestRestored ?? ops.attest)();
    await ops.journal('ROLLED_BACK');
  } catch {
    await ops.journal('ROLLBACK_FAILED');
    fail('rollback_failed');
  }
}
export async function recoverApiWebPhase(phase, ops) {
  if (['PREPARING', 'PREPARED'].includes(phase)) {
    await ops.abort();
    await ops.journal('ABORTED');
    return 'ABORTED';
  }
  if (
    ![
      'API_INTENT',
      'API_ACTIVE',
      'WEB_INTENT',
      'OBSERVING',
      'ROLLBACK_INTENT',
      'ROLLBACK_FAILED',
    ].includes(phase)
  )
    fail('invalid_recovery_phase');
  await recoverApiWebTransition(ops);
  return 'ROLLED_BACK';
}
export function validateUnchangedImages(values) {
  exact(values, ['worker', 'realtime']);
  for (const service of ['worker', 'realtime'])
    if (
      values[service] !== null &&
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        values[service] ?? '',
      )
    )
      fail('unchanged_image_identity');
  return values;
}
export async function reconcileApiWebPhase(receipt, ops) {
  const terminal = receipt.status === 'RECONCILED' ? receipt.reconciledStatus : receipt.status;
  if (!['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(terminal)) fail('nonterminal_reconciliation');
  await ops.attestTerminal(terminal);
  await ops.journalReconciled(terminal);
  await ops.releaseLock();
  return 'RECONCILED';
}
function secure(path, mode) {
  const value = lstatSync(path);
  if (
    value.isSymbolicLink() ||
    value.uid !== 0 ||
    value.gid !== 0 ||
    value.mode & 0o022 ||
    (!value.isDirectory() && (!value.isFile() || value.nlink !== 1)) ||
    (mode !== undefined && (value.mode & 0o777) !== mode)
  )
    fail('insecure_path');
  if (path !== '/') secure(dirname(path));
  return value;
}
// A power loss between link and unlink may preserve the writer's exact second name.
// Normalize only that single secure inode twin, never an unrelated hardlink or a symlink.
export function normalizeUpgradeHardlink(path, expectedUid = 0, expectedGid = 0) {
  const value = lstatSync(path);
  if (value.nlink === 1) return false;
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 2 ||
    value.uid !== expectedUid ||
    value.gid !== expectedGid ||
    (value.mode & 0o777) !== 0o600
  )
    fail('invalid_atomic_twin');
  const prefix = basename(path) + '.incoming-';
  const twins = readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && /^[a-f0-9]{24}$/.test(name.slice(prefix.length)))
    .map((name) => `${dirname(path)}/${name}`)
    .filter((twin) => {
      const current = lstatSync(twin);
      return (
        current.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === value.dev &&
        current.ino === value.ino &&
        current.nlink === 2 &&
        current.uid === expectedUid &&
        current.gid === expectedGid &&
        (current.mode & 0o777) === 0o600
      );
    });
  if (twins.length !== 1) fail('ambiguous_atomic_twin');
  unlinkSync(twins[0]);
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (lstatSync(path).nlink !== 1) fail('atomic_twin_changed');
  return true;
}
function read(path, mode = 0o600, max = 4 * 1024 * 1024) {
  if (path.startsWith(ROOT + '/')) {
    secure(dirname(path));
    normalizeUpgradeHardlink(path);
  }
  const before = secure(path, mode);
  if (!before.isFile() || before.size > max) fail('invalid_file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('file_race');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
// Hash large backups in bounded memory while preserving the secure descriptor identity.
export function hashUpgradeDescriptor(fd, maximum = 64 * 1024 ** 3) {
  const before = fstatSync(fd);
  if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximum)
    fail('invalid_backup_file');
  const digest = createHash('sha256');
  const block = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < before.size) {
    const count = readSync(fd, block, 0, Math.min(block.length, before.size - position), position);
    if (!count) fail('backup_changed');
    digest.update(block.subarray(0, count));
    position += count;
  }
  const after = fstatSync(fd);
  if (
    ['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some((key) => before[key] !== after[key])
  )
    fail('backup_changed');
  return digest.digest('hex');
}
function hashBackupFile(path) {
  const before = secure(path, 0o600);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('file_race');
    return hashUpgradeDescriptor(fd);
  } finally {
    closeSync(fd);
  }
}
function durable(path, bytes, exclusive = false) {
  secure(dirname(path));
  if (exclusive && existsSync(path)) fail('existing_receipt');
  if (existsSync(path)) secure(path, 0o600);
  writeUpgradeAtomic(path, bytes, exclusive);
}
export function writeUpgradeAtomic(path, bytes, exclusive = false) {
  const temporary = `${path}.incoming-${randomBytes(12).toString('hex')}`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function command(program, args, opts = {}) {
  return execFileSync(program, args, {
    cwd: SOURCE,
    env: environment,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}
const git = (args) =>
  command('/usr/bin/git', [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    ...args,
  ]).trim();
const docker = (args) => command('/usr/bin/docker', args);
export async function githubPublic(path) {
  if (
    !/^actions\/runs\/[1-9][0-9]*(?:\/attempts\/1\/jobs\?per_page=100|\/artifacts\?per_page=100)?$/.test(
      path,
    )
  )
    fail('github_path');
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) fail('github_read_failed');
  return response.json();
}
async function verifyCi(id, sha) {
  const run = await githubPublic(`actions/runs/${id}`);
  const jobs = await githubPublic(`actions/runs/${id}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs?.length) fail('truncated_jobs');
  verifySourceCi(run, jobs.jobs, sha);
}
function parseEnv(bytes) {
  const values = {};
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([A-Z_0-9]+)=([a-zA-Z0-9_./:@-]*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('noncanonical_env');
    values[match[1]] = match[2];
  }
  return values;
}
function inspect(service, project = 'phub-timeweb-beta', optional = false) {
  const ids = docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (!ids.length && optional) return null;
  if (ids.length !== 1) fail('service_count');
  const value = JSON.parse(docker(['inspect', ids[0]]))[0];
  if (value.State.Status !== 'running' || value.State.Health?.Status !== 'healthy')
    fail('unhealthy_service');
  return {
    id: value.Id,
    image: value.Config.Image,
    imageId: value.Image,
    releaseId: value.Config.Labels['phub.release-id'] ?? null,
    revision: value.Config.Labels['org.opencontainers.image.revision'] ?? null,
    restarts: value.RestartCount,
    startedAt: value.State.StartedAt,
  };
}
function excluded() {
  if (docker(['ps', '-q', '--filter', 'label=com.docker.compose.service=migrator']).trim())
    fail('active_migrator');
  // All existing non-target running containers are part of the unchanged boundary, including ingress/dependencies.
  const ids = docker(['ps', '-q']).trim().split('\n').filter(Boolean);
  return ids
    .map((id) => JSON.parse(docker(['inspect', id]))[0])
    .filter(
      (v) =>
        !(
          v.Config.Labels['com.docker.compose.project'] === 'phub-timeweb-beta' &&
          ['api', 'web'].includes(v.Config.Labels['com.docker.compose.service'])
        ),
    )
    .map((v) => ({
      id: v.Id,
      image: v.Config.Image,
      imageId: v.Image,
      restarts: v.RestartCount,
      startedAt: v.State.StartedAt,
      status: v.State.Status,
      health: v.State.Health?.Status ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function secretHashes() {
  return Object.fromEntries(
    SECRET_NAMES.map((name) => [name, hash(read(`${RUNTIME}/${name}`, 0o600, 131072))]),
  );
}
async function candidateAuthority(op, directory) {
  const run = await githubPublic(`actions/runs/${op.publicationRunId}`);
  if (
    String(run.id) !== op.publicationRunId ||
    run.head_sha !== op.candidateSha ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== '.github/workflows/publish-timeweb-amd64-images.yaml'
  )
    fail('publication_identity');
  const list = await githubPublic(`actions/runs/${op.publicationRunId}/artifacts?per_page=100`);
  if (list.total_count !== list.artifacts?.length) fail('truncated_artifacts');
  const name = `timeweb-amd64-canonical-release-${op.candidateSha}-${op.publicationRunId}-1`;
  const matches = list.artifacts.filter((v) => v.name === name);
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    artifact.expired !== false ||
    String(artifact.id) !== op.artifactId ||
    artifact.digest !== op.artifactDigest ||
    String(artifact.workflow_run?.id) !== op.publicationRunId ||
    artifact.workflow_run?.head_sha !== op.candidateSha
  )
    fail('artifact_identity');
  const archive = `${directory}/artifact/canonical-artifact.zip`;
  if (`sha256:${hash(read(archive))}` !== op.artifactDigest) fail('archive_digest');
  const entries = command('/usr/bin/unzip', ['-Z1', archive]).trim().split('\n').sort();
  if (!equal(entries, ['release-manifest.json', 'release-manifest.sha256']))
    fail('archive_inventory');
  const bytes = command('/usr/bin/unzip', ['-p', archive, 'release-manifest.json'], {
    encoding: null,
  });
  const checksum = command('/usr/bin/unzip', ['-p', archive, 'release-manifest.sha256']);
  if (hash(bytes) !== op.manifestSha256 || checksum !== `${hash(bytes)}  release-manifest.json\n`)
    fail('manifest_checksum');
  const manifest = JSON.parse(bytes);
  validateCanonicalManifest(manifest, {
    expectedPublication: {
      workflowSha: op.candidateSha,
      runId: op.publicationRunId,
      runAttempt: '1',
    },
    expectedBaseLockPath: `${SOURCE}/deploy/timeweb/base-images.lock.json`,
  });
  if (manifest.gitCommit !== op.candidateSha || manifest.gitTree !== op.candidateTree)
    fail('manifest_source');
  return manifest;
}
function imagePresent(ref, source) {
  const v = JSON.parse(docker(['image', 'inspect', ref]))[0];
  if (
    v.Os !== 'linux' ||
    v.Architecture !== 'amd64' ||
    !v.RepoDigests?.includes(ref) ||
    v.Config.Labels?.['org.opencontainers.image.revision'] !== source
  )
    fail('image_identity');
}
async function probe(service, publicProbe = false) {
  const url = publicProbe
    ? `https://lk2.padlhub.su/${service === 'api' ? 'health/ready' : ''}`
    : service === 'api'
      ? 'http://172.30.26.12:3000/health/ready'
      : 'http://172.30.26.11:8080/';
  const started = performance.now();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  if (response.status !== 200 || (service === 'web' && !body.includes('<div id="phub-app"></div>')))
    fail('probe_failed');
  return performance.now() - started;
}
async function wait(service, expected) {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const v = inspect(service);
      if (
        v.image !== expected.image ||
        v.releaseId !== expected.releaseId ||
        v.revision !== expected.releaseId.slice(0, 40) ||
        v.restarts !== 0
      )
        fail('runtime_identity');
      await probe(service);
      return v;
    } catch {
      await delay(2000);
    }
  }
  fail('readiness_timeout');
}
function validateBackupProof(directory, previous) {
  // Current backup and independent isolated restore proof are prerequisites, never an implicit production DB restore.
  const path = `${directory}/database-backup-receipt.json`;
  const v = JSON.parse(read(path));
  exact(v, [
    'schema',
    'baselineReleaseId',
    'completedAt',
    'backupFile',
    'backupSha256',
    'restoreVerified',
    'restoreImage',
    'restoredLedgerSha256',
    'sourceLedgerSha256',
  ]);
  if (
    v.schema !== 'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1' ||
    v.baselineReleaseId !== previous.releaseId ||
    v.restoreVerified !== true ||
    !/^docker\.io\/library\/postgres@sha256:[a-f0-9]{64}$/.test(v.restoreImage ?? '') ||
    !HASH.test(v.restoredLedgerSha256 ?? '') ||
    v.restoredLedgerSha256 !== v.sourceLedgerSha256 ||
    v.backupFile !== `${directory}/database.pgcustom` ||
    !HASH.test(v.backupSha256 ?? '') ||
    !Number.isFinite(Date.parse(v.completedAt)) ||
    Date.now() - Date.parse(v.completedAt) < 0 ||
    Date.now() - Date.parse(v.completedAt) > 3600000 ||
    hashBackupFile(v.backupFile) !== v.backupSha256
  )
    fail('backup_restore_proof');
  return { path, sha256: hash(read(path)) };
}
export function validateUpgradeMonitoring(provider, alerts, contract, observedAt) {
  const monitors = validateTimewebMonitorReadback(provider, contract, observedAt);
  const alertTest = validateTimewebAlertReadback(alerts, contract);
  validateTimewebMonitoringEvidence({ monitors, alertTest }, contract, observedAt);
}
function validateMonitoring(transaction) {
  const providerPath = `${ROOT}/observability/timeweb-monitor-readback.json`;
  const alertPath = `${ROOT}/observability/alert-test-readback.json`;
  const provider = read(providerPath),
    alerts = read(alertPath);
  const contract = JSON.parse(
    read(`${SOURCE}/deploy/timeweb/api-web-observability.v1.json`, 0o644),
  );
  validateUpgradeMonitoring(
    JSON.parse(provider),
    JSON.parse(alerts),
    contract,
    new Date().toISOString(),
  );
  return { providerSha256: hash(provider), alertSha256: hash(alerts), provider, alerts };
}
export function overlayBytes(plan, name) {
  if (name === 'candidate')
    return `PHUB_RELEASE_ID=${plan.candidate.api.releaseId}\nAPI_IMAGE_DIGEST=${plan.candidate.api.image.split('@')[1]}\nWEB_IMAGE_DIGEST=${plan.candidate.web.image.split('@')[1]}\n`;
  const service =
    name === 'previous-api' ? 'api' : name === 'previous-web' ? 'web' : fail('overlay_name');
  return `PHUB_RELEASE_ID=${plan.previous[service].releaseId}\n${service.toUpperCase()}_IMAGE_DIGEST=${plan.previous[service].image.split('@')[1]}\n`;
}
export function assertOverlayBytes(plan, name, bytes) {
  if (!Buffer.from(bytes).equals(Buffer.from(overlayBytes(plan, name)))) fail('overlay_drift');
}
export function validateRuntimeDelta(paths) {
  if (
    paths.some(
      (path) =>
        /^(?:deploy\/timeweb\/(?!operator-entry|run-standard)|contracts\/|packages\/database\/migrations\/|openapi\.yaml$)/.test(
          path,
        ) ||
        [
          'apps/api/Dockerfile',
          'apps/web/Dockerfile',
          'apps/worker/Dockerfile',
          'apps/realtime/Dockerfile',
          'apps/migrator/Dockerfile',
          'scripts/render-timeweb-beta-release-env.js',
          'scripts/timeweb-release-manifest-contract.js',
          'scripts/verify-source-ci.js',
          'scripts/timeweb-standard-policy.js',
          'scripts/produce-timeweb-api-web-observability-evidence.js',
          'scripts/produce-timeweb-api-web-observability-evidence.d.ts',
          'scripts/verify-timeweb-api-web-observability.js',
          'scripts/verify-timeweb-api-web-observability.d.ts',
        ].includes(path),
    )
  )
    fail('runtime_definition_changed');
}
export function validateUpgradeReceipt(receipt, planSha256) {
  const keys = ['schema', 'status', 'planSha256', 'observedAt'];
  if (
    receipt.status === 'SUCCESS' ||
    (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS')
  )
    keys.push(
      'installedBaselineSha256',
      'observationSha256',
      'providerReadbackSha256',
      'alertReadbackSha256',
    );
  if (receipt.status === 'RECONCILED') keys.push('reconciledStatus');
  exact(receipt, keys);
  if (
    receipt.schema !== 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1' ||
    receipt.planSha256 !== planSha256 ||
    !HASH.test(planSha256) ||
    !Number.isFinite(Date.parse(receipt.observedAt)) ||
    ![
      'PREPARING',
      'PREPARED',
      'API_INTENT',
      'API_ACTIVE',
      'WEB_INTENT',
      'OBSERVING',
      'SUCCESS',
      'ROLLBACK_INTENT',
      'ROLLED_BACK',
      'ROLLBACK_FAILED',
      'ABORTED',
      'RECONCILED',
    ].includes(receipt.status) ||
    (receipt.status === 'RECONCILED' &&
      !['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(receipt.reconciledStatus)) ||
    (keys.includes('installedBaselineSha256') &&
      [
        'installedBaselineSha256',
        'observationSha256',
        'providerReadbackSha256',
        'alertReadbackSha256',
      ].some((key) => !HASH.test(receipt[key] ?? '')))
  )
    fail('invalid_receipt');
  return receipt;
}
export function readInstalledApiBaseline(releaseId) {
  if (!ID.test(releaseId)) fail('baseline_release_id');
  const directory = `${ROOT}/releases/${releaseId}`;
  const installed = `${directory}/installed-components.env`;
  const path = existsSync(installed) ? installed : `${directory}/release.env`;
  const bytes = read(path);
  const values = parseEnv(bytes);
  if (values.PHUB_RELEASE_ID !== releaseId) fail('baseline_release_id');
  if (existsSync(installed)) {
    if (
      values.PHUB_TIMEWEB_RELEASE_ENV_SCHEMA !== 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1' ||
      values.PHUB_COMPONENT_ROLLOUT_RECEIPT !==
        `${ROOT}/backups/${releaseId}-api-web/rollout-receipt.json`
    )
      fail('installed_baseline_identity');
    const receipt = JSON.parse(read(values.PHUB_COMPONENT_ROLLOUT_RECEIPT));
    const plan = read(`${ROOT}/backups/${releaseId}-api-web/plan.json`);
    validateUpgradeReceipt(receipt, hash(plan));
    const transaction = `${ROOT}/backups/${releaseId}-api-web`;
    for (const [file, key] of [
      ['observation.json', 'observationSha256'],
      ['timeweb-monitor-readback.json', 'providerReadbackSha256'],
      ['alert-test-readback.json', 'alertReadbackSha256'],
    ])
      if (hash(read(`${transaction}/${file}`)) !== receipt[key]) fail('installed_evidence_drift');
    if (
      receipt.schema !== 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1' ||
      !(
        receipt.status === 'SUCCESS' ||
        (receipt.status === 'RECONCILED' && receipt.reconciledStatus === 'SUCCESS')
      ) ||
      receipt.installedBaselineSha256 !== hash(bytes)
    )
      fail('installed_baseline_receipt');
    validateTimewebRuntimeSecretPaths(RUNTIME, values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID);
  }
  return {
    path,
    bytes,
    values,
    secretSetReleaseId: values.PHUB_RUNTIME_SECRET_SET_RELEASE_ID ?? releaseId,
  };
}
export async function runManualApiWebUpgrade(mode, requestPath) {
  if (
    !['deploy', 'recover', 'reconcile'].includes(mode) ||
    requestPath !== REQUEST ||
    process.getuid?.() !== 0
  )
    fail('manual_entry');
  secure(SOURCE);
  secure(`${SOURCE}/.git`);
  const config = JSON.parse(read(CONFIG));
  let recoveredTransaction;
  if (mode !== 'deploy') {
    const pointer = read(LOCK).toString();
    if (
      !/^\/opt\/phub\/timeweb-beta\/backups\/[a-f0-9]{40}-[1-9][0-9]*-1-api-web\/plan\.json\n$/.test(
        pointer,
      )
    )
      fail('lock_pointer');
    recoveredTransaction = dirname(pointer.trim());
  }
  const opBytes = read(recoveredTransaction ? `${recoveredTransaction}/operation.json` : REQUEST);
  const op = validateApiWebOperation(JSON.parse(opBytes));
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    config.controllerSha !== op.controllerSha ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail('controller_identity');
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secure(`${SOURCE}/${path}`);
  try {
    git(['merge-base', '--is-ancestor', op.candidateSha, op.controllerSha]);
  } catch {
    fail('candidate_controller_ancestry');
  }
  if (git(['rev-parse', `${op.candidateSha}^{tree}`]) !== op.candidateTree) fail('candidate_tree');
  const delta = (from, to) => {
    const parts = git(['diff', '--no-renames', '--name-status', '-z', from, to])
      .split('\0')
      .filter(Boolean);
    if (parts.length % 2) fail('invalid_controller_delta');
    return Array.from({ length: parts.length / 2 }, (_, i) => ({
      status: parts[i * 2],
      path: parts[i * 2 + 1],
    }));
  };
  if (op.candidateSha !== op.controllerSha) {
    const entries = delta(op.candidateSha, op.controllerSha);
    if (entries.every((v) => CONTROLLER_FILES.has(v.path))) validateControllerDelta(entries);
    else {
      git(['merge-base', '--is-ancestor', INERT_CONTROLLER_BRIDGE.sha, op.controllerSha]);
      const bridgeEntries = delta(op.candidateSha, INERT_CONTROLLER_BRIDGE.sha).map((v) => {
        const line = git(['ls-tree', INERT_CONTROLLER_BRIDGE.sha, '--', v.path]);
        const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t/.exec(line);
        if (!match) fail('inert_controller_bridge');
        return { ...v, mode: match[1], type: match[2], oid: match[3] };
      });
      validateControllerBridge(op.candidateSha, INERT_CONTROLLER_BRIDGE.sha, bridgeEntries);
      validateControllerDelta(delta(INERT_CONTROLLER_BRIDGE.sha, op.controllerSha));
    }
  }
  const id = `${op.candidateSha}-${op.publicationRunId}-1`;
  const directory = `${ROOT}/releases/${id}`;
  const transaction = `${ROOT}/backups/${id}-api-web`;
  secure(directory, 0o700);
  secure(transaction, 0o700);
  const journalPath = `${transaction}/rollout-receipt.json`;
  const planPath = `${transaction}/plan.json`;
  const previousApi = op.expectedApi,
    previousWeb = op.expectedWeb;
  const previousBaseline = readInstalledApiBaseline(previousApi.releaseId);
  const { path: baseline, bytes: baselineBytes, values, secretSetReleaseId } = previousBaseline;
  if (
    values.PHUB_RELEASE_ID !== previousApi.releaseId ||
    values.TIMEWEB_RUNTIME_ENV_ROOT !== RUNTIME ||
    previousApi.image !== `ghcr.io/z6v6e6r/phub-api@${values.API_IMAGE_DIGEST}` ||
    values.PHUB_MIGRATOR_ENABLED !== 'false'
  )
    fail('baseline_identity');
  validateTimewebRuntimeSecretPaths(RUNTIME, secretSetReleaseId);
  let plan;
  if (mode !== 'deploy') {
    secure(LOCK, 0o600);
    if (
      !existsSync(planPath) ||
      !existsSync(journalPath) ||
      !existsSync(`${transaction}/backup.complete`)
    ) {
      if (mode !== 'recover' || !read(LOCK).equals(Buffer.from(`${planPath}\n`)))
        fail('incomplete_preparation');
      if (existsSync(journalPath)) {
        const phase = JSON.parse(read(journalPath)).status;
        if (!['PREPARING', 'PREPARED'].includes(phase)) fail('incomplete_active_transaction');
      }
      if (existsSync(planPath) && JSON.parse(read(planPath)).operationSha256 !== hash(opBytes))
        fail('incomplete_plan_identity');
      for (const [service, expected] of [
        ['api', previousApi],
        ['web', previousWeb],
      ]) {
        const actual = inspect(service);
        if (
          actual.id !== expected.id ||
          actual.image !== expected.image ||
          actual.releaseId !== expected.releaseId ||
          actual.restarts !== 0
        )
          fail('incomplete_abort_baseline_changed');
      }
      excluded(); // Includes the no-migrator guard; no Docker mutation has been issued.
      for (const file of [
        'plan.json',
        'candidate.env',
        'previous-api.env',
        'previous-web.env',
        'backup.complete',
        'rollout-receipt.json',
      ]) {
        const path = `${transaction}/${file}`;
        if (existsSync(path)) {
          read(path);
          unlinkSync(path);
        }
      }
      durable(
        `${transaction}/preparation-aborted.json`,
        `${JSON.stringify({ schema: 'PHUB_TIMEWEB_API_WEB_PREPARATION_ABORT_V1', operationSha256: hash(opBytes), observedAt: new Date().toISOString(), runtimeMutated: false })}\n`,
      );
      unlinkSync(LOCK);
      const fd = openSync(dirname(LOCK), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        status: 'ABORTED',
        candidate: id,
        receipt: `${transaction}/preparation-aborted.json`,
      };
    }
    plan = JSON.parse(read(planPath));
    const receipt = validateUpgradeReceipt(JSON.parse(read(journalPath)), hash(read(planPath)));
    if (
      plan.operationSha256 !== hash(opBytes) ||
      receipt.planSha256 !== hash(read(planPath)) ||
      receipt.schema !== 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1' ||
      ![
        'PREPARING',
        'PREPARED',
        'API_INTENT',
        'API_ACTIVE',
        'WEB_INTENT',
        'OBSERVING',
        'SUCCESS',
        'ROLLBACK_INTENT',
        'ROLLED_BACK',
        'ROLLBACK_FAILED',
        'ABORTED',
        'RECONCILED',
      ].includes(receipt.status) ||
      !read(LOCK).equals(Buffer.from(`${planPath}\n`))
    )
      fail('recovery_identity');
  } else {
    if (existsSync(LOCK) || existsSync(planPath) || existsSync(journalPath))
      fail('unreconciled_transaction');
    await verifyCi(op.sourceCiRunId, op.candidateSha);
    for (const previous of [previousApi, previousWeb]) {
      git(['merge-base', '--is-ancestor', previous.releaseId.slice(0, 40), op.candidateSha]);
      validateRuntimeDelta(
        git([
          'diff',
          '--no-renames',
          '--name-only',
          '-z',
          previous.releaseId.slice(0, 40),
          op.candidateSha,
        ])
          .split('\0')
          .filter(Boolean),
      );
    }
    const manifest = await candidateAuthority(op, directory);
    const api = inspect('api'),
      web = inspect('web');
    for (const [actual, expected] of [
      [api, previousApi],
      [web, previousWeb],
    ]) {
      if (
        actual.id !== expected.id ||
        actual.image !== expected.image ||
        actual.releaseId !== expected.releaseId ||
        actual.restarts !== 0
      )
        fail('baseline_drift');
    }
    const backup = validateBackupProof(transaction, previousApi);
    validateMonitoring(transaction);
    plan = {
      schema: 'PHUB_TIMEWEB_API_WEB_PLAN_V1',
      operationSha256: hash(opBytes),
      controllerSha: op.controllerSha,
      manifestSha256: op.manifestSha256,
      artifactDigest: op.artifactDigest,
      composeSha256: hash(read(COMPOSE, 0o644)),
      previous: { api, web },
      candidate: Object.fromEntries(
        ['api', 'web'].map((service) => [
          service,
          {
            image: `ghcr.io/z6v6e6r/phub-${service}@${manifest.images.find((v) => v.component === service).digest}`,
            releaseId: id,
          },
        ]),
      ),
      excluded: excluded(),
      unchangedServiceImages: Object.fromEntries(
        ['worker', 'realtime'].map((service) => [
          service,
          inspect(service, 'phub-timeweb-beta', true)?.image ?? null,
        ]),
      ),
      secretSetReleaseId,
      baselineSha256: hash(baselineBytes),
      secretHashes: secretHashes(),
      backup,
      createdAt: new Date().toISOString(),
    };
    validateUnchangedImages(plan.unchangedServiceImages);
    for (const service of ['api', 'web'])
      if (
        plan.candidate[service].releaseId === plan.previous[service].releaseId ||
        plan.candidate[service].image === plan.previous[service].image
      )
        fail('no_op_upgrade');
    const operationCopy = `${transaction}/operation.json`;
    if (existsSync(operationCopy)) {
      if (!read(operationCopy).equals(opBytes)) fail('operation_copy_drift');
    } else durable(operationCopy, opBytes, true);
    durable(LOCK, `${planPath}\n`, true);
    durable(planPath, `${JSON.stringify(plan)}\n`, true);
    for (const name of ['candidate', 'previous-api', 'previous-web'])
      durable(`${transaction}/${name}.env`, overlayBytes(plan, name), true);
    durable(`${transaction}/backup.complete`, `${hash(read(planPath))}\n`, true);
    durable(
      journalPath,
      `${JSON.stringify({ schema: 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1', status: 'PREPARING', planSha256: hash(read(planPath)), observedAt: new Date().toISOString() })}\n`,
      true,
    );
  }
  if (
    plan.schema !== 'PHUB_TIMEWEB_API_WEB_PLAN_V1' ||
    plan.controllerSha !== op.controllerSha ||
    !equal(plan.previous.api.image, previousApi.image) ||
    plan.previous.api.releaseId !== previousApi.releaseId ||
    plan.previous.web.image !== previousWeb.image ||
    plan.previous.web.releaseId !== previousWeb.releaseId
  )
    fail('plan_identity');
  exact(plan, [
    'schema',
    'operationSha256',
    'controllerSha',
    'manifestSha256',
    'artifactDigest',
    'composeSha256',
    'previous',
    'candidate',
    'excluded',
    'unchangedServiceImages',
    'secretSetReleaseId',
    'baselineSha256',
    'secretHashes',
    'backup',
    'createdAt',
  ]);
  for (const service of ['api', 'web']) {
    exact(plan.candidate[service], ['image', 'releaseId']);
    if (
      plan.candidate[service].releaseId !== id ||
      !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(
        plan.candidate[service].image,
      )
    )
      fail('plan_candidate_identity');
  }
  if (
    plan.secretSetReleaseId !== secretSetReleaseId ||
    plan.manifestSha256 !== op.manifestSha256 ||
    plan.artifactDigest !== op.artifactDigest
  )
    fail('plan_identity');
  validateUnchangedImages(plan.unchangedServiceImages);
  for (const service of ['api', 'web'])
    if (
      plan.candidate[service].releaseId === plan.previous[service].releaseId ||
      plan.candidate[service].image === plan.previous[service].image
    )
      fail('no_op_upgrade');
  const planSha256 = hash(read(planPath));
  if (!read(`${transaction}/backup.complete`).equals(Buffer.from(`${planSha256}\n`)))
    fail('backup_incomplete');
  const compose = (name, action, service) => {
    const path = `${transaction}/${name}.env`;
    assertOverlayBytes(plan, name, read(path));
    if (
      hash(read(COMPOSE, 0o644)) !== plan.composeSha256 ||
      hash(read(baseline)) !== plan.baselineSha256 ||
      !equal(secretHashes(), plan.secretHashes)
    )
      fail('compose_input_drift');
    return docker(apiWebComposeArgs(baseline, path, action, service));
  };
  const attest = () => {
    if (
      hash(read(COMPOSE, 0o644)) !== plan.composeSha256 ||
      !equal(excluded(), plan.excluded) ||
      hash(read(baseline)) !== plan.baselineSha256 ||
      !equal(secretHashes(), plan.secretHashes) ||
      !['candidate', 'previous-api', 'previous-web'].every((name) =>
        read(`${transaction}/${name}.env`).equals(Buffer.from(overlayBytes(plan, name))),
      )
    )
      fail('excluded_or_configuration_drift');
  };
  let installedBaselineSha256;
  const journal = async (status) =>
    durable(
      journalPath,
      `${JSON.stringify({
        schema: 'PHUB_TIMEWEB_API_WEB_RECEIPT_V1',
        status,
        planSha256,
        ...(status === 'SUCCESS'
          ? {
              installedBaselineSha256,
              observationSha256: hash(read(`${transaction}/observation.json`)),
              providerReadbackSha256: hash(read(`${transaction}/timeweb-monitor-readback.json`)),
              alertReadbackSha256: hash(read(`${transaction}/alert-test-readback.json`)),
            }
          : {}),
        observedAt: new Date().toISOString(),
      })}\n`,
    );
  const releaseLock = () => {
    if (!read(LOCK).equals(Buffer.from(`${planPath}\n`))) fail('lock_drift');
    unlinkSync(LOCK);
    const fd = openSync(dirname(LOCK), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const ops = {
    journal,
    attestRestored: async () => {
      attest();
    },
    abort: async () => {
      attest();
      for (const service of ['api', 'web'])
        if (!equal(inspect(service), plan.previous[service])) fail('abort_baseline_changed');
    },
    installBaseline: async () => {
      const next = {
        ...values,
        PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
        PHUB_RELEASE_ID: id,
        PHUB_RUNTIME_SECRET_SET_RELEASE_ID: plan.secretSetReleaseId,
        PHUB_COMPONENT_ROLLOUT_RECEIPT: journalPath,
        API_IMAGE_DIGEST: plan.candidate.api.image.split('@')[1],
        WEB_IMAGE_DIGEST: plan.candidate.web.image.split('@')[1],
      };
      for (const service of ['worker', 'realtime'])
        if (plan.unchangedServiceImages[service])
          next[`${service.toUpperCase()}_IMAGE_DIGEST`] =
            plan.unchangedServiceImages[service].split('@')[1];
      // This is an installed-component descriptor, never a new/mixed canonical manifest.
      for (const key of Object.keys(next))
        if (
          key.startsWith('PHUB_CANONICAL_') ||
          key.startsWith('PHUB_PUBLICATION_') ||
          key.endsWith('_RUNTIME_DIGEST') ||
          key === 'PHUB_RELEASE_SOURCE_SHA' ||
          key === 'PHUB_RELEASE_SOURCE_TREE'
        )
          delete next[key];
      const bytes = Buffer.from(
        Object.entries(next)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
      );
      durable(`${directory}/installed-components.env`, bytes, true);
      installedBaselineSha256 = hash(bytes);
    },
    attest: async () => {
      attest();
      for (const service of Object.keys(active))
        if (!equal(inspect(service), active[service])) fail('candidate_changed_before_success');
    },
    preflight: async () => {
      attest();
      for (const s of ['api', 'web']) {
        if (!equal(inspect(s), plan.previous[s])) fail('baseline_drift');
        imagePresent(plan.previous[s].image, plan.previous[s].releaseId.slice(0, 40));
        const rendered = JSON.parse(compose('candidate', 'config', s));
        for (const component of ['api', 'web', 'realtime', 'worker', 'migrator']) {
          const expected = ['api', 'web'].includes(component)
            ? plan.candidate[component].image
            : `ghcr.io/z6v6e6r/phub-${component}@${values[`${component.toUpperCase()}_IMAGE_DIGEST`]}`;
          if (rendered.services[component].image !== expected) fail('compose_image_identity');
        }
        await probe(s);
        await probe(s, true);
      }
    },
    pullAndSmoke: async () => {
      for (const s of ['api', 'web']) {
        compose('candidate', 'pull', s);
        imagePresent(plan.candidate[s].image, op.candidateSha);
        docker([
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--entrypoint',
          s === 'api' ? 'node' : '/bin/sh',
          plan.candidate[s].image,
          ...(s === 'api'
            ? ['--check', '/app/apps/api/dist/main.js']
            : ['-ec', 'nginx -t && test -s /usr/share/nginx/html/index.html']),
        ]);
      }
      attest();
    },
    activate: async (s) => {
      attest();
      compose('candidate', 'up', s);
      active[s] = await wait(s, plan.candidate[s]);
      attest();
      if (s === 'api' && !equal(inspect('web'), plan.previous.web))
        fail('web_changed_before_activation');
      if (s === 'web' && !equal(inspect('api'), active.api)) fail('api_changed_during_activation');
    },
    observe: async () => {
      const times = { api: [], web: [] };
      for (let round = 0; round <= 60; round++) {
        for (const s of ['api', 'web']) {
          if (!equal(inspect(s), active[s])) fail('candidate_restarted');
          times[s].push(await probe(s));
          await probe(s, true);
        }
        attest();
        validateMonitoring(transaction);
        if (round < 60) await delay(15000);
      }
      for (const s of ['api', 'web']) {
        const sorted = times[s].sort((a, b) => a - b);
        if (sorted[Math.ceil(sorted.length * 0.95) - 1] > (s === 'api' ? 1500 : 1000))
          fail('latency_threshold');
      }
      const finalMonitoring = validateMonitoring(transaction);
      durable(`${transaction}/timeweb-monitor-readback.json`, finalMonitoring.provider, true);
      durable(`${transaction}/alert-test-readback.json`, finalMonitoring.alerts, true);
      durable(
        `${transaction}/observation.json`,
        `${JSON.stringify({ windowSeconds: 900, samplesPerService: 61, latencyMs: times, serverErrors: 0, completedAt: new Date().toISOString() })}\n`,
        true,
      );
    },
    restore: async (s) => {
      // Only exact recorded candidate/previous images may be replaced by recovery.
      const ids = docker([
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=phub-timeweb-beta',
        '--filter',
        `label=com.docker.compose.service=${s}`,
      ])
        .trim()
        .split('\n')
        .filter(Boolean);
      if (ids.length !== 1) fail('recovery_service_count');
      const actual = JSON.parse(docker(['inspect', ids[0]]))[0];
      if (
        ![plan.previous[s], plan.candidate[s]].some(
          (v) =>
            v.image === actual.Config.Image &&
            v.releaseId === actual.Config.Labels['phub.release-id'],
        )
      )
        fail('foreign_recovery_image');
      imagePresent(plan.previous[s].image, plan.previous[s].releaseId.slice(0, 40));
      compose(`previous-${s}`, 'up', s);
      await wait(s, plan.previous[s]);
    },
  };
  const active = {};
  const receipt = validateUpgradeReceipt(JSON.parse(read(journalPath)), planSha256);
  if (mode === 'reconcile') {
    await reconcileApiWebPhase(receipt, {
      attestTerminal: async (terminal) => {
        attest();
        for (const service of ['api', 'web'])
          await wait(
            service,
            terminal === 'SUCCESS' ? plan.candidate[service] : plan.previous[service],
          );
        if (terminal === 'SUCCESS') {
          const installed = readInstalledApiBaseline(id);
          if (hash(installed.bytes) !== receipt.installedBaselineSha256)
            fail('installed_baseline_drift');
        }
      },
      journalReconciled: async (terminal) =>
        durable(
          journalPath,
          `${JSON.stringify({ ...receipt, status: 'RECONCILED', reconciledStatus: terminal, observedAt: new Date().toISOString() })}\n`,
        ),
      releaseLock: async () => releaseLock(),
    });
    return { status: 'RECONCILED', candidate: id, receipt: journalPath };
  }
  let recoveredStatus;
  if (mode === 'recover') {
    if (['SUCCESS', 'ROLLED_BACK', 'ABORTED', 'RECONCILED'].includes(receipt.status))
      fail('use_terminal_reconciliation');
    recoveredStatus = await recoverApiWebPhase(receipt.status, ops);
  } else {
    try {
      await runApiWebTransition(ops);
    } catch (error) {
      if (JSON.parse(read(journalPath)).status === 'ABORTED') releaseLock();
      throw error;
    }
    releaseLock();
  }
  return {
    status: mode === 'recover' ? recoveredStatus : 'SUCCESS',
    candidate: id,
    receipt: journalPath,
  };
}
