// Installed once, root-owned, in the enrolled controller checkout. Never execute a candidate's
// copy of this program or npm scripts on the operator. No PR checkout on the privileged runner.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCanonicalManifest } from './timeweb-release-manifest-contract.js';
import { verifySourceCi } from './verify-source-ci.js';
import {
  runWebTransition,
  standardRange,
  standardWebComposeArgs,
} from './timeweb-standard-policy.js';

const ROOT = '/opt/phub/timeweb-beta';
const SOURCE = `${ROOT}/standard/source`;
const CONFIG = '/etc/phub/timeweb-beta/standard-delivery.json';
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
const fail = (message) => {
  throw new Error(message);
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
function assertInactiveWriters() {
  for (const service of ['worker', 'migrator']) {
    if (
      docker([
        'ps',
        '-q',
        '--filter',
        'label=com.docker.compose.project=phub-timeweb-beta',
        '--filter',
        `label=com.docker.compose.service=${service}`,
      ]).trim()
    )
      fail('Unexpected active writer');
  }
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
  const config = JSON.parse(readSecure(CONFIG));
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    !config.owner ||
    !/^[a-f0-9]{40}$/.test(config.controllerSha)
  )
    fail('Standard delivery not enrolled');
  secure(SOURCE);
  secure(`${SOURCE}/.git`);
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secure(`${SOURCE}/${path}`);
  for (const path of [
    'node_modules/typescript/lib/typescript.js',
    'node_modules/postcss/lib/postcss.js',
  ])
    secure(`${SOURCE}/${path}`);
  if (
    git(['rev-parse', 'HEAD']) !== config.controllerSha ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail('Enrolled controller changed');
  const run = await github(`actions/runs/${ciRunId}`);
  const jobs = await github(`actions/runs/${ciRunId}/attempts/1/jobs?per_page=100`);
  if (jobs.total_count !== jobs.jobs.length) fail('Truncated source jobs');
  const sha = run.head_sha;
  verifySourceCi(run, jobs.jobs, sha);
  git(['fetch', '--no-tags', 'https://github.com/Z6v6e6r/lk2.git', 'main']);
  if (git(['rev-parse', 'FETCH_HEAD']) !== sha)
    fail('Main moved; next successful main run owns the release');
  assertInactiveWriters();
  const api = inspect('api');
  const web = inspect('web');
  const realtime = inspectOptionalRealtime();
  const baselineId = releaseId(api.releaseId);
  const previousWebId = releaseId(web.releaseId);
  if (previousWebId.startsWith(`${sha}-`))
    fail('Already installed source requires successful-receipt reconciliation');
  for (const base of [config.controllerSha, baselineId.slice(0, 40), previousWebId.slice(0, 40)]) {
    const plan = standardRange(base, sha);
    if (!plan.eligible) fail(`Standard release ineligible: ${plan.reason}`);
  }
  const baselineEnv = `${ROOT}/releases/${baselineId}/release.env`;
  const baselineBytes = readSecure(baselineEnv);
  const values = parseEnv(baselineBytes);
  if (
    values.PHUB_RELEASE_ID !== baselineId ||
    api.image !== `ghcr.io/z6v6e6r/phub-api@${values.API_IMAGE_DIGEST}` ||
    (realtime &&
      realtime.image !== `ghcr.io/z6v6e6r/phub-realtime@${values.REALTIME_IMAGE_DIGEST}`) ||
    values.PHUB_WORKER_ENABLED !== 'false' ||
    values.PHUB_MIGRATOR_ENABLED !== 'false'
  )
    fail('Installed baseline drift');
  const assertBackend = () => {
    assertInactiveWriters();
    if (
      JSON.stringify(inspect('api')) !== JSON.stringify(api) ||
      JSON.stringify(inspectOptionalRealtime()) !== JSON.stringify(realtime) ||
      !readSecure(baselineEnv).equals(baselineBytes)
    )
      fail('Backend/configuration changed');
  };
  const lock = `${ROOT}/standard/active`;
  mkdirSync(lock, { mode: 0o700 }); // Local exclusion also covers non-workflow invocation.
  let finished = false;
  try {
    const runId = await publish(sha, ciRunId);
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
      preflight: async () => {
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
      },
      pull: async () => {
        compose(overlay, 'pull');
      },
      artifactSmoke: async () => {
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
      },
      journal: async (status) =>
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
      activate: async () => {
        compose(overlay, 'up');
        await waitWeb(candidateRef, id);
        activatedWeb = inspect('web');
        if (activatedWeb.restarts !== 0) fail('Web restarted during initial readiness');
      },
      observe: async () => {
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
      },
      attestBackend: async () => {
        assertBackend();
      },
      rollback: async () => {
        compose(rollback, 'up');
        await waitWeb(web.image, previousWebId);
      },
    });
    finished = true;
    process.stdout.write(
      `STANDARD_WEB_DELIVERY_SUCCESS source=${sha} publication=${runId} user_feedback=pending\n`,
    );
  } finally {
    // Any uncertainty stops future propagation until the owner reconciles the receipt/run.
    if (finished) rmSync(lock, { recursive: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(() => {
    // External command errors may contain runtime environment; never print raw error/stdout.
    process.stderr.write(
      'STANDARD_WEB_DELIVERY_STOP: inspect the root-only receipt and workflow status; no automatic retry\n',
    );
    process.exitCode = 1;
  });
}
