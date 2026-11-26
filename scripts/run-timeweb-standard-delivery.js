// Installed once, root-owned, in the enrolled controller checkout. Never execute a candidate's
// copy of this program or npm scripts on the operator. No PR checkout on the privileged runner.
import { execFileSync } from 'node:child_process';
import { runCriticalWeb } from './timeweb-critical-web.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCanonicalManifest } from './timeweb-release-manifest-contract.js';
import { verifySourceCi } from './verify-source-ci.js';
import {
  acquireApiWorkerExecutor,
  runManualApiWorkerUpgrade,
} from './timeweb-api-worker-upgrade.js';
import {
  runManualApiWorkerMigration,
  runManualNotificationMigratorPrefetch,
} from './timeweb-api-worker-migration.js';
import { readInstalledApiBaseline, runManualApiWebUpgrade } from './timeweb-api-web-upgrade.js';
import {
  createStandardDeliveryDiagnostic,
  standardDeliveryGuardError,
} from './timeweb-standard-diagnostic.js';
import {
  runWebTransition,
  standardRange,
  standardWebComposeArgs,
} from './timeweb-standard-policy.js';

import { parseStrictJson } from './strict-json.js';
import {
  createCup0119LockCustody,
  createGameInvitations0120LockCustody,
} from './r1-tail-migration-locks.js';
import {
  buildCup0119Sql,
  CUP_0119,
  CUP_0119_BACKUP,
  CUP_0119_TARGET,
  validateCup0119Request,
  validateCup0119RetainedBackup,
} from './timeweb-cup-0119-migration.js';
import {
  buildGameInvitations0120Sql,
  GAME_INVITATIONS_0120,
  GAME_INVITATIONS_0120_TARGET,
  validateGameInvitations0120Backup,
  validateGameInvitations0120Request,
  verifyGameInvitations0120Predecessor,
} from './timeweb-game-invitations-migration.js';

const ROOT = '/opt/phub/timeweb-beta';
const SOURCE = `${ROOT}/standard/source`;
// Deliberately outside /etc/phub/timeweb-beta: the critical runtime-secret provisioner requires
// that directory to contain exactly its four service env files plus the release identity, so any
// extra entry there would stop every future critical release.
const CONFIG = '/etc/phub/timeweb-beta-standard-delivery.json';
const REPOSITORY = 'Z6v6e6r/lk2';
const PUBLISHER = 'publish-timeweb-amd64-images.yaml';
const COMPOSE = `${SOURCE}/deploy/timeweb/compose.beta.yaml`;
const cleanEnvironment = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  DOCKER_CONFIG: '/root/.docker',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  COMPOSE_PROFILES: '',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let diagnostic;
const diagnosticStage = (stage, context) => diagnostic?.stage(stage, context);
const diagnosticBoundary = (stage, operation) =>
  diagnostic ? diagnostic.boundary(stage, operation) : operation();
const fail = (message) => {
  throw standardDeliveryGuardError(message);
};
function command(program, args, options = {}) {
  return execFileSync(program, args, {
    cwd: SOURCE,
    env: cleanEnvironment,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
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
function secure(path, mode) {
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    info.gid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    (mode !== undefined && (info.mode & 0o777) !== mode)
  )
    fail('Insecure enrolled path');
  if (path !== '/') secure(dirname(path));
}
function readSecure(path) {
  secure(path, 0o600);
  return readFileSync(path);
}
function writeDurable(path, value) {
  const temporary = `${path}.new`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
async function github(path, body) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) fail(`GitHub operation failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
function releaseId(value) {
  if (!/^[a-f0-9]{40}-[1-9][0-9]*-1$/.test(value ?? '')) fail('Invalid installed release identity');
  return value;
}
function runningServiceIds(service) {
  return docker([
    'ps',
    '-q',
    '--filter',
    'label=com.docker.compose.project=phub-timeweb-beta',
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ]).trim();
}

/**
 * The migrator is a migration writer and never runs while a Web release is delivered. A worker may
 * run: this route installs nothing but Web, and the baseline check below binds a running worker to
 * the installed release image and requires it to stay identical through the whole transition.
 */
function assertNoMigrator() {
  if (runningServiceIds('migrator')) fail('Unexpected active writer');
}

export function inspectOptionalWorker(
  readRunningIds = () => runningServiceIds('worker'),
  inspectRunning = inspect,
) {
  return readRunningIds().trim() ? inspectRunning('worker') : null;
}

/**
 * The canonical renderer always declares the worker while Compose keeps it behind its own profile,
 * so whether a baseline runs it is a property of that baseline, not of this Web-only route. What the
 * route does require is that a running worker is exactly the image the installed release declared:
 * any other image is drift, and `assertBackend` additionally rejects a worker that appears,
 * disappears or restarts while the release is delivered.
 */
export function workerBaselineIsConsistent(values, worker) {
  return !worker || worker.image === `ghcr.io/z6v6e6r/phub-worker@${values.WORKER_IMAGE_DIGEST}`;
}

export function inspectOptionalRealtime(
  readRunningIds = () =>
    docker([
      'ps',
      '-q',
      '--filter',
      'label=com.docker.compose.project=phub-timeweb-beta',
      '--filter',
      'label=com.docker.compose.service=realtime',
    ]),
  inspectRunning = inspect,
) {
  return readRunningIds().trim() ? inspectRunning('realtime') : null;
}

function inspect(service) {
  const ids = docker([
    'ps',
    '-q',
    '--filter',
    'label=com.docker.compose.project=phub-timeweb-beta',
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) fail(`Expected one running ${service}`);
  const value = JSON.parse(docker(['inspect', ids[0]]))[0];
  if (
    value.State.Status !== 'running' ||
    value.State.Health?.Status !== 'healthy' ||
    !new RegExp(`^ghcr.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(value.Config.Image)
  )
    fail(`Unhealthy or mutable ${service}`);
  return {
    id: value.Id,
    imageId: value.Image,
    image: value.Config.Image,
    releaseId: value.Config.Labels['phub.release-id'] ?? null,
    restarts: value.RestartCount,
    // A stop/start of the same container keeps its id and increments no restart-policy counter, so
    // the start time is what makes such a swap visible to `assertBackend`.
    startedAt: value.State.StartedAt,
  };
}
function parseEnv(bytes) {
  const values = {};
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([A-Z_0-9]+)=([a-zA-Z0-9_./:@-]*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('Noncanonical baseline environment');
    values[match[1]] = match[2];
  }
  return values;
}
async function downloadPublication(sha, runId) {
  const run = await github(`actions/runs/${runId}`);
  if (
    run.head_sha !== sha ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== `.github/workflows/${PUBLISHER}`
  )
    fail('Invalid canonical publication run');
  const inventory = await github(`actions/runs/${runId}/artifacts?per_page=100`);
  if (inventory.total_count !== inventory.artifacts.length) fail('Truncated artifact inventory');
  const name = `timeweb-amd64-canonical-release-${sha}-${runId}-1`;
  const matches = inventory.artifacts.filter((item) => item.name === name && !item.expired);
  if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? ''))
    fail('Invalid canonical artifact');
  const artifact = matches[0];
  const directory = `${ROOT}/releases/${sha}-${runId}-1/artifact`;
  if (existsSync(directory)) fail('Existing candidate directory requires reconciliation');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  secure(directory, 0o700);
  // gh performs authenticated GitHub artifact redirect handling without forwarding credentials
  // into downloaded code. Validate the GitHub archive digest before reading its fixed entries.
  const archive = command(
    '/usr/bin/gh',
    ['api', `repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`],
    {
      encoding: null,
      env: { ...cleanEnvironment, GH_TOKEN: process.env.GH_TOKEN },
    },
  );
  if (`sha256:${sha256(archive)}` !== artifact.digest) fail('Canonical archive digest mismatch');
  const archivePath = `${directory}/canonical-artifact.zip`;
  writeFileSync(archivePath, archive, { mode: 0o600, flag: 'wx' });
  const entries = command('/usr/bin/unzip', ['-Z1', archivePath]).trim().split('\n').sort();
  if (
    JSON.stringify(entries) !== JSON.stringify(['release-manifest.json', 'release-manifest.sha256'])
  )
    fail('Canonical archive inventory mismatch');
  for (const entry of entries)
    writeFileSync(
      `${directory}/${entry}`,
      command('/usr/bin/unzip', ['-p', archivePath, entry], { encoding: null }),
      { mode: 0o600, flag: 'wx' },
    );
  const bytes = readSecure(`${directory}/release-manifest.json`);
  if (
    readSecure(`${directory}/release-manifest.sha256`).toString() !==
    `${sha256(bytes)}  release-manifest.json\n`
  )
    fail('Canonical manifest checksum mismatch');
  const manifest = JSON.parse(bytes);
  validateCanonicalManifest(manifest, {
    expectedPublication: { workflowSha: sha, runId: String(runId), runAttempt: '1' },
    expectedBaseLockPath: `${SOURCE}/deploy/timeweb/base-images.lock.json`,
  });
  if (manifest.gitCommit !== sha) fail('Canonical source mismatch');
  return {
    directory: dirname(directory),
    manifest,
    checksum: sha256(bytes),
    artifactDigest: artifact.digest,
  };
}
async function publish(sha, ciRunId) {
  const query = `actions/workflows/${PUBLISHER}/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`;
  const before = await github(query);
  if (before.total_count !== 0)
    fail('Publication already exists; reconcile it instead of automatic retry');
  await github(`actions/workflows/${PUBLISHER}/dispatches`, {
    ref: 'main',
    inputs: {
      operation: 'publish',
      expected_source_sha: sha,
      expected_workflow_sha: sha,
      source_ci_run_id: ciRunId,
      confirmation: `PUBLISH_TIMEWEB_AMD64_${sha.slice(0, 12).toUpperCase()}`,
    },
  });
  for (let index = 0; index < 180; index += 1) {
    await delay(10000);
    const runs = await github(query);
    if (runs.total_count > 1) fail('Ambiguous publication identity');
    const run = runs.workflow_runs[0];
    if (!run) continue;
    if (run.run_attempt !== 1) fail('Publication rerun is not eligible');
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') fail('Publication failed; no automatic retry');
      return String(run.id);
    }
  }
  fail('Publication timed out; reconcile before any next publication');
}
async function probe(url, expected) {
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  const text = await response.text();
  if (response.status !== 200 || (expected && !text.includes(expected)))
    fail('Runtime probe failed');
  return performance.now() - started;
}
async function main(ciRunId) {
  if (process.getuid?.() !== 0 || !/^[1-9][0-9]*$/.test(ciRunId ?? '') || !process.env.GH_TOKEN)
    fail('Enrolled root controller and numeric CI run required');
  if (resolve(dirname(fileURLToPath(import.meta.url)), '..') !== SOURCE)
    fail('Controller must run from enrolled path');
  process.chdir(SOURCE);
  secure(`${ROOT}/standard`);
  secure(SOURCE);
  secure(`${SOURCE}/.git`);
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secure(`${SOURCE}/${path}`);
  for (const path of [
    'node_modules/typescript/lib/typescript.js',
    'node_modules/postcss/lib/postcss.js',
  ])
    secure(`${SOURCE}/${path}`);
  const controllerSha = git(['rev-parse', 'HEAD']);
  try {
    diagnostic = createStandardDeliveryDiagnostic(`${ROOT}/standard/attempts`, {
      sourceCiRunId: ciRunId,
      controllerSha,
    });
  } catch {
    /* Diagnostic I/O cannot change the existing delivery outcome; no readback claim. */
  }
  diagnosticStage('enrollment');
  const config = JSON.parse(readSecure(CONFIG));
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    !config.owner ||
    !/^[a-f0-9]{40}$/.test(config.controllerSha)
  )
    fail('Standard delivery not enrolled');
  diagnosticStage('controller');
  if (
    git(['rev-parse', 'HEAD']) !== config.controllerSha ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail('Enrolled controller changed');
  diagnosticStage('source-ci');
  const run = await github(`actions/runs/${ciRunId}`);
  const jobs = await github(`actions/runs/${ciRunId}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs.length) fail('Truncated source jobs');
  const sha = run.head_sha;
  verifySourceCi(run, jobs.jobs, sha);
  diagnosticStage('source-fetch', { candidateSha: sha });
  git(['fetch', '--no-tags', 'https://github.com/Z6v6e6r/lk2.git', 'main']);
  if (git(['rev-parse', 'FETCH_HEAD']) !== sha)
    fail('Main moved; next successful main run owns the release');
  diagnosticStage('runtime-baseline');
  assertNoMigrator();
  const api = inspect('api');
  const web = inspect('web');
  const realtime = inspectOptionalRealtime();
  const worker = inspectOptionalWorker();
  const baselineId = releaseId(api.releaseId);
  const previousWebId = releaseId(web.releaseId);
  if (previousWebId.startsWith(`${sha}-`))
    fail('Already installed source requires successful-receipt reconciliation');
  diagnosticStage('eligibility');
  for (const base of [config.controllerSha, baselineId.slice(0, 40), previousWebId.slice(0, 40)]) {
    const plan = standardRange(base, sha);
    if (!plan.eligible) fail(`Standard release ineligible: ${plan.reason}`);
  }
  diagnosticStage('runtime-baseline');
  const installedBaseline = readInstalledApiBaseline(baselineId);
  const baselineEnv = installedBaseline.path;
  const baselineBytes = installedBaseline.bytes;
  const values = parseEnv(baselineBytes);
  // A running worker must be exactly the image this release declared. Whether the baseline runs one
  // at all is its own business: the canonical renderer always declares it while Compose keeps it
  // behind a profile, so presence is not an assertion this route may make.
  if (
    values.PHUB_RELEASE_ID !== baselineId ||
    api.image !== `ghcr.io/z6v6e6r/phub-api@${values.API_IMAGE_DIGEST}` ||
    (realtime &&
      realtime.image !== `ghcr.io/z6v6e6r/phub-realtime@${values.REALTIME_IMAGE_DIGEST}`) ||
    values.PHUB_MIGRATOR_ENABLED !== 'false' ||
    !workerBaselineIsConsistent(values, worker)
  )
    fail('Installed baseline drift');
  const assertBackend = () => {
    assertNoMigrator();
    if (
      JSON.stringify(inspect('api')) !== JSON.stringify(api) ||
      JSON.stringify(inspectOptionalRealtime()) !== JSON.stringify(realtime) ||
      JSON.stringify(inspectOptionalWorker()) !== JSON.stringify(worker) ||
      !readSecure(baselineEnv).equals(baselineBytes)
    )
      fail('Backend/configuration changed');
  };
  const lock = `${ROOT}/standard/active`;
  diagnosticStage('lock');
  mkdirSync(lock, { mode: 0o700 }); // Local exclusion also covers non-workflow invocation.
  let finished = false;
  try {
    diagnosticStage('publication');
    const runId = await publish(sha, ciRunId);
    diagnosticStage('artifact', { publicationRunId: String(runId) });
    const candidate = await downloadPublication(sha, runId);
    const id = releaseId(`${sha}-${runId}-1`);
    const image = candidate.manifest.images.find((item) => item.component === 'web');
    const candidateRef = `${image.repository}@${image.digest}`;
    const overlay = `${candidate.directory}/web-override.env`;
    const rollback = `${candidate.directory}/web-previous.env`;
    writeFileSync(overlay, `PHUB_RELEASE_ID=${id}\nWEB_IMAGE_DIGEST=${image.digest}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(
      rollback,
      `PHUB_RELEASE_ID=${previousWebId}\nWEB_IMAGE_DIGEST=${web.image.split('@')[1]}\n`,
      { mode: 0o600, flag: 'wx' },
    );
    const compose = (file, operation) =>
      docker(standardWebComposeArgs(COMPOSE, baselineEnv, file, operation));
    let activatedWeb;
    const attestWeb = (ref, identity) => {
      const actual = inspect('web');
      if (
        activatedWeb &&
        ref === candidateRef &&
        identity === id &&
        JSON.stringify(actual) !== JSON.stringify(activatedWeb)
      )
        fail('Web restarted or changed during observation');
      if (actual.image !== ref || actual.releaseId !== identity)
        fail('Web runtime identity mismatch');
    };
    const waitWeb = async (ref, identity) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          attestWeb(ref, identity);
          return;
        } catch {
          await delay(2000);
        }
      }
      fail('Web readiness timeout');
    };
    await runWebTransition({
      preflight: () =>
        diagnosticBoundary('preflight', async () => {
          assertBackend();
          if (
            git(['ls-remote', 'https://github.com/Z6v6e6r/lk2.git', 'refs/heads/main']).split(
              /\s/,
            )[0] !== sha
          )
            fail('Main changed before deployment');
          const rendered = JSON.parse(compose(overlay, 'config'));
          if (rendered.services.web.image !== candidateRef) fail('Web Compose reference mismatch');
          await probe('http://172.30.26.12:3000/health/ready');
        }),
      pull: () =>
        diagnosticBoundary('pull', async () => {
          compose(overlay, 'pull');
        }),
      artifactSmoke: () =>
        diagnosticBoundary('artifact-smoke', async () => {
          docker([
            'run',
            '--rm',
            '--network',
            'none',
            '--entrypoint',
            '/bin/sh',
            candidateRef,
            '-ec',
            'nginx -t && test -s /usr/share/nginx/html/index.html',
          ]);
        }),
      journal: async (status) =>
        diagnosticBoundary('rollout-journal', async () =>
          writeDurable(
            `${candidate.directory}/web-rollout-receipt.json`,
            JSON.stringify(
              {
                schema: 1,
                status,
                owner: config.owner,
                sourceCiRunId: ciRunId,
                candidateManifestSha256: candidate.checksum,
                candidateArtifactDigest: candidate.artifactDigest,
                candidateSource: sha,
                candidatePublicationRunId: runId,
                // Preserve component origin; this receipt is not a fabricated mixed canonical manifest.
                installedBackend: {
                  api,
                  realtime,
                  // A running worker is attested too, so the receipt states what actually stayed
                  // unchanged instead of implying an all-off baseline.
                  worker,
                  baselineId,
                  baselineEnvSha256: sha256(baselineBytes),
                },
                previousWeb: web,
                candidateWeb: { image: candidateRef, releaseId: id },
                observedAt: new Date().toISOString(),
                requestsPerService: status === 'success' ? 60 : 0,
                userOutcome: 'requires-product-feedback',
              },
              null,
              2,
            ) + '\n',
          ),
        ),
      activate: () =>
        diagnosticBoundary('activate', async () => {
          compose(overlay, 'up');
          diagnosticStage('initial-readiness');
          await waitWeb(candidateRef, id);
          activatedWeb = inspect('web');
          if (activatedWeb.restarts !== 0) fail('Web restarted during initial readiness');
        }),
      observe: () =>
        diagnosticBoundary('observe', async () => {
          const apiTimes = [],
            webTimes = [];
          for (let round = 0; round < 60; round += 1) {
            apiTimes.push(await probe('http://172.30.26.12:3000/health/ready'));
            webTimes.push(await probe('http://172.30.26.11:8080/', '<div id="phub-app"></div>'));
            attestWeb(candidateRef, id);
            assertBackend();
            await delay(1000);
          }
          const p95 = (times) => times.sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1];
          attestWeb(candidateRef, id);
          if (p95(apiTimes) > 1500 || p95(webTimes) > 1000) fail('Web release latency threshold');
        }),
      attestBackend: () =>
        diagnosticBoundary('attest-backend', async () => {
          assertBackend();
        }),
      rollback: () =>
        diagnosticBoundary('rollback', async () => {
          compose(rollback, 'up');
          await waitWeb(web.image, previousWebId);
        }),
    });
    finished = true;
    let pointer = 'unavailable';
    try {
      diagnosticStage('complete');
      if (diagnostic) pointer = JSON.stringify(diagnostic.success());
    } catch {
      /* Canonical success and lock release are independent of diagnostic persistence. */
    }
    process.stdout.write(
      `STANDARD_WEB_DELIVERY_SUCCESS source=${sha} publication=${runId} user_feedback=pending diagnostic=${pointer}\n`,
    );
  } finally {
    // Any uncertainty stops future propagation until the owner reconciles the receipt/run.
    if (finished) rmSync(lock, { recursive: true });
  }
}
const CUP_0119_PROFILE = Object.freeze({
  name: 'CUP_0119',
  directory: 'cup-0119',
  receiptSchema: 'PHUB_TIMEWEB_CUP_0119_RECEIPT_V1',
  migration: CUP_0119,
  target: { ...CUP_0119_TARGET, operator: CUP_0119_TARGET.projectionOwner },
  baselineReleaseId: CUP_0119_BACKUP.releaseId,
  backupReleaseId: () => CUP_0119_BACKUP.releaseId,
  validateRequest: validateCup0119Request,
  validateBackup: validateCup0119RetainedBackup,
  buildSql: buildCup0119Sql,
  lockCustody: createCup0119LockCustody,
});

const GAME_INVITATIONS_0120_PROFILE = Object.freeze({
  name: 'GAME_INVITATIONS_0120',
  directory: 'game-invitations-0120',
  receiptSchema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_RECEIPT_V1',
  migration: GAME_INVITATIONS_0120,
  target: GAME_INVITATIONS_0120_TARGET,
  baselineReleaseId: GAME_INVITATIONS_0120.baselineReleaseId,
  backupReleaseId: (op) => op.backupReleaseId,
  validateRequest: validateGameInvitations0120Request,
  validateBackup: validateGameInvitations0120Backup,
  buildSql: buildGameInvitations0120Sql,
  lockCustody: createGameInvitations0120LockCustody,
  restoreDecisionFile: `${ROOT}/operator/game-invitations-0120-restore-waiver.txt`,
  priorMigrationReceipt: Object.freeze({
    path: `${ROOT}/operator/cup-0119-96227dc8-fe36-46ed-b4e2-aba4a0a4df9e/receipt.json`,
    sha256: '4369a9c3f945754e3adfb028fbf066915c5a93d31de3368dd51ce3335a66c3fa',
  }),
  applicationIdentity: () =>
    verifyGameInvitations0120Predecessor({
      api: inspect('api'),
      web: inspect('web'),
      worker: inspect('worker'),
      realtime: inspect('realtime'),
    }),
  runtimeProbe: `begin read only;
set local statement_timeout='5s';
set local role phub_runtime;
select exists(select from games.friend_invitations limit 1);
rollback;`,
});

function syncParent(path) {
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeExclusive(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncParent(path);
}

function migrationLockIO(attempt, name) {
  const info = (path) => {
    secure(path, 0o600);
    const st = lstatSync(path);
    if (!st.isFile() || ![1, 2].includes(st.nlink)) fail(`${name}_LOCK_METADATA`);
    return st;
  };
  const read = (path) => {
    const st = info(path);
    if (st.nlink !== 1) fail(`${name}_LOCK_LINK_COUNT`);
    return readFileSync(path);
  };
  return {
    info,
    read,
    rawRead: readFileSync,
    durable: writeExclusive,
    syncParent,
    link: linkSync,
    unlink: unlinkSync,
    stage: (path, marker) => {
      const file = `${path}.incoming-${randomBytes(12).toString('hex')}`;
      writeExclusive(file, marker);
      return file;
    },
    present: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    // Only used after the shared custody helper verified that the sealed staged name
    // is the second link of this operation's inode.
    normalize: (path) => {
      const { locks } = parseStrictJson(read(`${attempt}/ownership.json`));
      const staged = locks[path].stage;
      unlinkSync(staged);
      syncParent(staged);
    },
  };
}

function migrationArchiveDigest(path, admitted, name) {
  const same = (info) =>
    info.isFile() &&
    ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(
      (key) => admitted[key] === info[key],
    );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(fstatSync(fd))) fail(`${name}_BACKUP_DRIFT`);
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    for (let remaining = admitted.size; remaining > 0;) {
      const count = readSync(fd, chunk, 0, Math.min(remaining, chunk.length), null);
      if (count < 1) fail(`${name}_BACKUP_DRIFT`);
      hash.update(chunk.subarray(0, count));
      remaining -= count;
    }
    if (!same(fstatSync(fd)) || !same(lstatSync(path))) fail(`${name}_BACKUP_DRIFT`);
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function prepareGameInvitations0120Request(backupReleaseId) {
  if (
    process.getuid?.() !== 0 ||
    fileURLToPath(import.meta.url) !== `${SOURCE}/scripts/run-timeweb-standard-delivery.js` ||
    !/^[a-f0-9]{40}-[1-9][0-9]*-1$/.test(backupReleaseId)
  )
    fail('GAME_INVITATIONS_0120_ENTRY');
  secure(SOURCE);
  secure(`${ROOT}/operator`, 0o700);
  const enrollment = parseStrictJson(readSecure(CONFIG));
  if (
    enrollment.schema !== 1 ||
    enrollment.enabled !== true ||
    enrollment.controllerSha !== git(['rev-parse', 'HEAD']) ||
    git(['status', '--porcelain', '--untracked-files=all']) !== ''
  )
    fail('GAME_INVITATIONS_0120_ENROLLMENT');
  const backup = `${ROOT}/backups/${backupReleaseId}-api-web`;
  const operation = parseStrictJson(readSecure(`${backup}/backup-operation.json`));
  const ownerDecision = readSecure(`${backup}/owner-restore-decision.json`);
  const receipt = readSecure(`${backup}/database-backup-receipt.json`);
  const request = validateGameInvitations0120Request(
    {
      schema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_REQUEST_V1',
      attemptId: randomUUID(),
      controllerSha: enrollment.controllerSha,
      migrationSourceSha: operation.candidateSha,
      postgresContainerId: operation.expectedPostgres?.id,
      expiresAt: operation.expiresAt,
      backupReleaseId,
      retainedBackupReceiptSha256: sha256(receipt),
      externalRestoreDecision: {
        status: GAME_INVITATIONS_0120.restoreDecision,
        owner: enrollment.owner,
        referenceSha256: operation.ownerRestoreDecision?.messageSha256,
        backupDecisionSha256: sha256(ownerDecision),
      },
    },
    enrollment,
    Date.now(),
  );
  return request;
}

async function runManualClosedMigration(mode, requestPath, profile) {
  const { name, directory, migration: selected, target } = profile;
  if (
    requestPath !== `${ROOT}/operator/${directory}-migration.json` ||
    process.getuid?.() !== 0 ||
    fileURLToPath(import.meta.url) !== `${SOURCE}/scripts/run-timeweb-standard-delivery.js` ||
    !['apply', 'reconcile'].includes(mode)
  )
    fail(`${name}_ENTRY`);
  secure(SOURCE);
  secure(`${ROOT}/operator`, 0o700);
  const configBytes = readSecure(CONFIG);
  const config = parseStrictJson(configBytes);
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    config.controllerSha !== git(['rev-parse', 'HEAD']) ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail(`${name}_ENROLLMENT`);

  const requestBytes = readSecure(requestPath);
  const op = profile.validateRequest(
    parseStrictJson(requestBytes),
    config,
    mode === 'apply' ? Date.now() : undefined,
  );
  const migration = command(
    '/usr/bin/git',
    ['show', `${op.migrationSourceSha}:packages/database/migrations/${selected.filename}`],
    { encoding: 'buffer' },
  );
  const readbackSql = profile.buildSql(migration, target, 'readback');
  const attempt = `${ROOT}/operator/${directory}-${op.attemptId}`;
  const marker = Buffer.from(`${attempt}/intent.json\n`);
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`);
  const io = migrationLockIO(attempt, name);
  const locks = profile.lockCustody(attempt, marker, owner, io);
  const started = `${attempt}/sql-started.json`;
  let postgresStartedAt;
  let application;
  const bound = () => {
    owner.assertOwned();
    assertNoMigrator();
    if (
      git(['rev-parse', 'HEAD']) !== op.controllerSha ||
      git(['status', '--porcelain', '--untracked-files=no']) !== '' ||
      !readSecure(CONFIG).equals(configBytes) ||
      !readSecure(requestPath).equals(requestBytes)
    )
      fail(`${name}_OPERATION_DRIFT`);
    const postgres = JSON.parse(docker(['inspect', op.postgresContainerId]))[0];
    if (
      postgres.Id !== op.postgresContainerId ||
      postgres.Name !== '/phub-timeweb-beta-dependencies-postgres-1' ||
      postgres.State.Status !== 'running' ||
      postgres.State.Health?.Status !== 'healthy' ||
      (postgresStartedAt && postgres.State.StartedAt !== postgresStartedAt)
    )
      fail(`${name}_DATABASE_CONTAINER`);
    postgresStartedAt ??= postgres.State.StartedAt;
    if (application && JSON.stringify(profile.applicationIdentity()) !== application)
      fail(`${name}_APPLICATION_DRIFT`);
  };
  const query = (sql) =>
    command(
      '/usr/bin/docker',
      [
        'exec',
        '-i',
        op.postgresContainerId,
        '/usr/local/bin/psql',
        '-XqAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        '/var/run/postgresql',
        '-U',
        target.operator,
        '-d',
        target.database,
      ],
      { input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 100000, maxBuffer: 8192 },
    ).trim();
  const readback = () => {
    const value = parseStrictJson(query(readbackSql));
    if (
      !['PREIMAGE', 'COMMITTED', 'DRIFT'].includes(value.state) ||
      !/^[a-f0-9]{64}$/.test(value.catalogSha256)
    )
      fail(`${name}_READBACK`);
    return value;
  };
  const verifyRuntime = (state) => {
    if (state === 'COMMITTED' && profile.runtimeProbe && query(profile.runtimeProbe) !== 'f')
      fail(`${name}_RUNTIME_READBACK`);
  };
  const result = (state, catalogSha256) => ({
    schema: profile.receiptSchema,
    attemptId: op.attemptId,
    requestSha256: sha256(requestBytes),
    migrationSha256: selected.checksum,
    state,
    catalogSha256,
  });
  const sealReceipt = (state, catalogSha256) => {
    bound();
    verifyRuntime(state);
    const receipt = result(state, catalogSha256);
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    const path = `${attempt}/receipt.json`;
    if (io.present(path)) {
      if (!readSecure(path).equals(bytes)) fail(`${name}_RECEIPT_CONFLICT`);
    } else {
      const staged = `${path}.incoming-${randomBytes(12).toString('hex')}`;
      writeExclusive(staged, bytes);
      linkSync(staged, path);
      syncParent(path);
      unlinkSync(staged);
      syncParent(staged);
    }
    locks.release();
    return receipt;
  };
  const assertRetainedBackup = () => {
    const api = inspect('api');
    if (api.releaseId !== profile.baselineReleaseId) fail(`${name}_BASELINE`);
    const backupDir = `${ROOT}/backups/${profile.backupReleaseId(op)}-api-web`;
    const backupPath = `${backupDir}/database.pgcustom`;
    const receipt = readSecure(`${backupDir}/database-backup-receipt.json`);
    secure(backupPath, 0o600);
    if (sha256(receipt) !== op.retainedBackupReceiptSha256) fail(`${name}_BACKUP_RECEIPT`);
    const backup = parseStrictJson(receipt);
    const archive = lstatSync(backupPath);
    profile.validateBackup(backup, archive, backupPath, Date.now());
    if (profile.restoreDecisionFile) {
      const operationBytes = readSecure(`${backupDir}/backup-operation.json`);
      const operation = parseStrictJson(operationBytes);
      const services = profile.applicationIdentity();
      const sameService = (actual, expected) =>
        ['id', 'image', 'imageId', 'releaseId', 'restarts', 'startedAt'].every(
          (field) => actual[field] === expected?.[field],
        );
      const terminal = parseStrictJson(
        readSecure(`${backupDir}/FRESH_DUMP_INTEGRITY_VERIFIED.json`),
      );
      if (
        operation.schema !== 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_FRESH_BACKUP_V1' ||
        operation.releaseId !== op.backupReleaseId ||
        operation.controllerSha !== op.controllerSha ||
        !sameService(services.api, operation.expectedApi) ||
        !sameService(services.web, operation.expectedWeb) ||
        operation.expectedPostgres?.id !== op.postgresContainerId ||
        operation.expectedPostgres?.startedAt !== postgresStartedAt ||
        operation.ownerRestoreDecision?.messageSha256 !==
          op.externalRestoreDecision.referenceSha256 ||
        sha256(operationBytes) !== backup.operationSha256 ||
        sha256(readSecure(`${backupDir}/snapshot-witness.json`)) !== backup.snapshotWitnessSha256 ||
        terminal.phase !== 'FRESH_DUMP_INTEGRITY_VERIFIED' ||
        terminal.operationSha256 !== backup.operationSha256 ||
        terminal.receiptSha256 !== op.retainedBackupReceiptSha256 ||
        backup.policySha256 !== op.externalRestoreDecision.backupDecisionSha256 ||
        sha256(readSecure(`${backupDir}/owner-restore-decision.json`)) !== backup.policySha256 ||
        operation.expiresAt !== op.expiresAt
      )
        fail(`${name}_BACKUP_CUSTODY`);
    }
    if (migrationArchiveDigest(backupPath, archive, name) !== backup.backupSha256)
      fail(`${name}_BACKUP_CHECKSUM`);
    return api;
  };
  try {
    bound();
    if (mode === 'reconcile') {
      if (!readSecure(`${attempt}/intent.json`).equals(requestBytes)) fail(`${name}_INTENT`);
      locks.load();
      locks.assert(false);
      const { state, catalogSha256 } = readback();
      if (!io.present(started)) {
        if (state === 'PREIMAGE') return sealReceipt('ABORTED_BEFORE_SQL', catalogSha256);
        return result('UNRESOLVED_DRIFT', catalogSha256);
      }
      const witness = parseStrictJson(readSecure(started));
      const api = inspect('api');
      if (
        witness.requestSha256 !== sha256(requestBytes) ||
        witness.catalogSha256 !== catalogSha256 ||
        witness.apiId !== api.id ||
        witness.apiStartedAt !== api.startedAt ||
        witness.postgresStartedAt !== postgresStartedAt ||
        (profile.applicationIdentity &&
          witness.application !== JSON.stringify(profile.applicationIdentity()))
      )
        return result('UNRESOLVED_DRIFT', catalogSha256);
      if (profile.applicationIdentity) application = witness.application;
      if (state === 'COMMITTED') return sealReceipt(state, catalogSha256);
      if (state === 'PREIMAGE' && io.present(`${attempt}/receipt.json`))
        return sealReceipt('ROLLED_BACK', catalogSha256);
      return result(`UNRESOLVED_${state === 'PREIMAGE' ? 'PREIMAGE' : 'DRIFT'}`, catalogSha256);
    }

    const api = inspect('api');
    if (profile.applicationIdentity) {
      application = JSON.stringify(profile.applicationIdentity());
      if (io.present(attempt)) {
        if (!readSecure(`${attempt}/intent.json`).equals(requestBytes)) fail(`${name}_INTENT`);
        const { state, catalogSha256 } = readback();
        const receipt = result(state, catalogSha256);
        if (
          state !== 'COMMITTED' ||
          !readSecure(`${attempt}/receipt.json`).equals(Buffer.from(JSON.stringify(receipt) + '\n'))
        )
          fail(`${name}_RECONCILIATION_REQUIRED`);
        bound();
        verifyRuntime(state);
        return receipt;
      }
      if (readback().state !== 'PREIMAGE') fail(`${name}_PREIMAGE`);
    }
    if (
      profile.restoreDecisionFile &&
      sha256(readSecure(profile.restoreDecisionFile)) !== op.externalRestoreDecision.referenceSha256
    )
      fail(`${name}_RESTORE_DECISION`);
    if (
      profile.priorMigrationReceipt &&
      sha256(readSecure(profile.priorMigrationReceipt.path)) !==
        profile.priorMigrationReceipt.sha256
    )
      fail(`${name}_PRIOR_MIGRATION`);
    mkdirSync(attempt, { mode: 0o700 });
    syncParent(attempt);
    writeExclusive(`${attempt}/intent.json`, requestBytes);
    locks.claim(bound);
    locks.assert(true);
    bound();
    const preimage = readback();
    if (preimage.state !== 'PREIMAGE') fail(`${name}_PREIMAGE`);
    locks.assert(true);
    bound();
    if (JSON.stringify(assertRetainedBackup()) !== JSON.stringify(api)) fail(`${name}_BASELINE`);
    profile.validateRequest(op, config, Date.now());
    locks.assert(true);
    bound();
    writeExclusive(
      started,
      Buffer.from(
        JSON.stringify({
          requestSha256: sha256(requestBytes),
          catalogSha256: preimage.catalogSha256,
          apiId: api.id,
          apiStartedAt: api.startedAt,
          postgresStartedAt,
          ...(application ? { application } : {}),
        }) + '\n',
      ),
    );
    try {
      query(profile.buildSql(migration, target, 'apply', preimage.catalogSha256));
    } catch (error) {
      // A normal ON_ERROR_STOP exit is a confirmed server error. Transport loss or
      // timeout leaves the markers in place until reconciliation.
      if (error.status === 3 && !error.signal) {
        const state = readback();
        if (state.state === 'PREIMAGE' && state.catalogSha256 === preimage.catalogSha256)
          return sealReceipt('ROLLED_BACK', state.catalogSha256);
      }
      throw error;
    }
    bound();
    const postimage = readback();
    if (
      postimage.state !== 'COMMITTED' ||
      postimage.catalogSha256 !== preimage.catalogSha256 ||
      JSON.stringify(inspect('api')) !== JSON.stringify(api)
    )
      fail(`${name}_UNCERTAIN`);
    return sealReceipt('COMMITTED', postimage.catalogSha256);
  } finally {
    owner.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const manual =
    args.length === 2 &&
    ['--critical-api-web', '--critical-api-web-recover', '--critical-api-web-reconcile'].includes(
      args[0],
    );
  const criticalWeb =
    args.length === 2 &&
    ['--critical-web', '--critical-web-recover', '--critical-web-reconcile'].includes(args[0]);
  const apiWorker =
    args.length === 2 &&
    [
      '--critical-api-worker',
      '--critical-api-worker-recover',
      '--critical-api-worker-reconcile',
    ].includes(args[0]);
  const apiWorkerMigration =
    args.length === 2 &&
    ['--critical-api-worker-migration', '--critical-api-worker-migration-reconcile'].includes(
      args[0],
    );
  const notificationPrefetch =
    args.length === 2 &&
    [
      '--critical-notification-migrator-prefetch',
      '--critical-notification-migrator-prefetch-reconcile',
    ].includes(args[0]);
  const cup0119 =
    args.length === 2 && ['--critical-cup-0119', '--critical-cup-0119-reconcile'].includes(args[0]);
  const gameInvitations0120 =
    args.length === 2 &&
    ['--critical-game-invitations-0120', '--critical-game-invitations-0120-reconcile'].includes(
      args[0],
    );
  const prepare0120 = args.length === 2 && args[0] === '--critical-game-invitations-0120-prepare';
  const closedMigration = cup0119
    ? CUP_0119_PROFILE
    : gameInvitations0120 || prepare0120
      ? GAME_INVITATIONS_0120_PROFILE
      : null;
  const operation = closedMigration
    ? (prepare0120
        ? Promise.resolve().then(() => prepareGameInvitations0120Request(args[1]))
        : runManualClosedMigration(
            args[0].endsWith('-reconcile') ? 'reconcile' : 'apply',
            args[1],
            closedMigration,
          )
      ).then((receipt) => {
        process.stdout.write(JSON.stringify(receipt) + '\n');
        if (!prepare0120 && receipt.state !== 'COMMITTED') process.exitCode = 1;
      })
    : notificationPrefetch
      ? runManualNotificationMigratorPrefetch(
          args[0] === '--critical-notification-migrator-prefetch' ? 'pull' : 'reconcile',
          args[1],
        ).then((receipt) => {
          process.stdout.write(JSON.stringify(receipt) + '\n');
        })
      : apiWorkerMigration
        ? runManualApiWorkerMigration(
            args[0] === '--critical-api-worker-migration' ? 'deploy' : 'reconcile',
            args[1],
          ).then((receipt) => {
            process.stdout.write(JSON.stringify(receipt) + '\n');
          })
        : apiWorker
          ? runManualApiWorkerUpgrade(
              args[0] === '--critical-api-worker'
                ? 'deploy'
                : args[0] === '--critical-api-worker-recover'
                  ? 'recover'
                  : 'reconcile',
              args[1],
            ).then((receipt) => {
              process.stdout.write(JSON.stringify(receipt) + '\n');
            })
          : criticalWeb
            ? runCriticalWeb(
                args[0] === '--critical-web'
                  ? 'deploy'
                  : args[0] === '--critical-web-recover'
                    ? 'recover'
                    : 'reconcile',
                args[1],
              ).then((receipt) => {
                process.stdout.write(JSON.stringify(receipt) + '\n');
              })
            : manual
              ? runManualApiWebUpgrade(
                  args[0] === '--critical-api-web'
                    ? 'deploy'
                    : args[0] === '--critical-api-web-recover'
                      ? 'recover'
                      : 'reconcile',
                  args[1],
                ).then((receipt) => {
                  process.stdout.write(JSON.stringify(receipt) + '\n');
                })
              : args.length === 1
                ? main(args[0])
                : Promise.reject(new Error('Invalid controller arguments'));
  operation.catch((error) => {
    // External command errors may contain runtime environment; never print raw error/stdout.
    let pointer = 'unavailable';
    try {
      if (diagnostic) pointer = JSON.stringify(diagnostic.stop(error));
    } catch {
      /* No receipt claim without durable readback. */
    }
    process.stderr.write(
      `STANDARD_WEB_DELIVERY_STOP diagnostic=${pointer}; inspect the root-only receipt and workflow status; no automatic retry\n`,
    );
    process.exitCode = 1;
  });
}
