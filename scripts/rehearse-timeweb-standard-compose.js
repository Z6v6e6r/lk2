// Disposable Docker-only rehearsal: no host credentials, shared endpoints, ports or volumes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebTransition, standardWebComposeArgs } from './timeweb-standard-policy.js';

if (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')
  throw new Error('Explicit fixture opt-in required');
const directory = mkdtempSync(join(tmpdir(), 'lk2-standard-fixture-'));
const project = `lk2-standard-fixture-${process.pid}`;
const lock = JSON.parse(readFileSync('deploy/timeweb/base-images.lock.json'));
const image = `nginx@${lock.images.find((item) => item.id === 'nginx-web-runtime').indexDigest}`;
const composeFile = join(directory, 'compose.json');
const baseline = join(directory, 'baseline.env');
const candidate = join(directory, 'candidate.env');
writeFileSync(baseline, 'RELEASE=previous\n');
writeFileSync(candidate, 'RELEASE=candidate\n');
writeFileSync(
  composeFile,
  JSON.stringify({
    name: project,
    services: {
      api: { image, labels: { 'fixture.owner': project } },
      web: { image, labels: { 'fixture.owner': project, 'phub.release-id': '${RELEASE}' } },
    },
    networks: { default: { internal: true } },
  }),
);
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
const compose = (env, action) => docker(standardWebComposeArgs(composeFile, baseline, env, action));
const inspect = (service) => {
  const id = docker([
    'compose',
    '--env-file',
    baseline,
    '-f',
    composeFile,
    'ps',
    '-q',
    service,
  ]).trim();
  return JSON.parse(docker(['inspect', id]))[0];
};
// `activate` proves only that the container exists with the expected label; it does not prove
// nginx is serving yet. Probing once therefore raced container startup and made this rehearsal the
// only observed flaky failure on main. Retry within a fixed budget so a slow start is tolerated
// while a genuinely broken release still fails.
const READINESS_ATTEMPTS = 30;
const READINESS_DELAY_MS = 1000;
const probeWeb = async () => {
  let lastError;
  for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
    try {
      docker(['exec', inspect('web').Id, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < READINESS_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, READINESS_DELAY_MS));
      }
    }
  }
  throw lastError;
};
const journal = [];
try {
  docker(['compose', '--env-file', baseline, '-f', composeFile, 'up', '-d']);
  const apiBefore = inspect('api').Id;
  const previousImage = inspect('web').Image;
  const attestBackend = async () => {
    if (inspect('api').Id !== apiBefore) throw Error('Backend restarted');
  };
  const activate = async () => {
    compose(candidate, 'up');
    if (inspect('web').Config.Labels['phub.release-id'] !== 'candidate')
      throw Error('Candidate not active');
  };
  const rollback = async () => {
    compose(baseline, 'up');
    const web = inspect('web');
    if (web.Image !== previousImage || web.Config.Labels['phub.release-id'] !== 'previous')
      throw Error('Wrong rollback digest/identity');
  };
  const operations = {
    preflight: attestBackend,
    pull: async () => {
      compose(candidate, 'pull');
    },
    artifactSmoke: async () => {
      docker(['run', '--rm', '--network', 'none', '--entrypoint', 'nginx', image, '-t']);
    },
    activate,
    observe: async () => {
      await probeWeb();
    },
    attestBackend,
    rollback,
    journal: async (status) => {
      journal.push(status);
    },
  };
  await runWebTransition(operations);
  await rollback();
  let rejected = false;
  try {
    await runWebTransition({
      ...operations,
      observe: async () => {
        throw Error('Injected observation failure');
      },
    });
  } catch {
    rejected = true;
  }
  if (
    !rejected ||
    JSON.stringify(journal) !== JSON.stringify(['pending', 'success', 'pending', 'rolled-back'])
  )
    throw Error('Wrong transition result');
  await attestBackend();
  process.stdout.write(
    'STANDARD_COMPOSE_REHEARSAL_PASS success_and_forced_rollback=true backend_unchanged=true same_digest_rollback=true\n',
  );
} finally {
  docker(['compose', '--env-file', baseline, '-f', composeFile, 'down', '--remove-orphans']);
  rmSync(directory, { recursive: true });
}
