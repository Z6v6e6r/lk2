// Disposable Docker-only rehearsal: no host credentials, shared endpoints, ports or volumes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebTransition, standardWebComposeArgs } from './timeweb-standard-policy.js';
import {
  apiWebComposeArgs,
  runApiWebTransition,
  recoverApiWebTransition,
} from './timeweb-api-web-upgrade.js';

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
      api: {
        image,
        labels: { 'fixture.owner': project, 'phub.release-id': '${API_RELEASE:-api-previous}' },
      },
      worker: { image, labels: { 'fixture.owner': project } },
      realtime: { image, labels: { 'fixture.owner': project } },
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
      docker(['exec', inspect('web').Id, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
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
  const criticalPrevious = join(directory, 'critical-previous.env');
  const criticalCandidate = join(directory, 'critical-candidate.env');
  writeFileSync(criticalPrevious, 'RELEASE=web-previous\nAPI_RELEASE=api-previous\n');
  writeFileSync(criticalCandidate, 'RELEASE=web-candidate\nAPI_RELEASE=api-candidate\n');
  const criticalCompose = (env, action, service) => {
    const args = apiWebComposeArgs(baseline, env, action, service);
    args[args.indexOf('-f') + 1] = composeFile;
    return docker(args);
  };
  for (const service of ['web', 'api']) criticalCompose(criticalPrevious, 'up', service);
  const outside = Object.fromEntries(
    ['worker', 'realtime'].map((service) => [service, inspect(service).Id]),
  );
  const unchanged = async () => {
    for (const service of ['worker', 'realtime'])
      if (inspect(service).Id !== outside[service]) throw Error('Excluded service changed');
  };
  const criticalJournal = [];
  const criticalOps = {
    preflight: unchanged,
    pullAndSmoke: async () => {
      await unchanged();
    },
    journal: async (status) => criticalJournal.push(status),
    activate: async (service) => {
      criticalCompose(criticalCandidate, 'up', service);
      if (inspect(service).Config.Labels['phub.release-id'] !== `${service}-candidate`)
        throw Error('Wrong candidate');
      await unchanged();
    },
    observe: async () => {
      for (const service of ['api', 'web'])
        docker(['exec', inspect(service).Id, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
    },
    attest: unchanged,
    abort: async () => {
      for (const service of ['api', 'web'])
        if (inspect(service).Config.Labels['phub.release-id'] !== `${service}-previous`)
          throw Error('Unsafe abort');
      await unchanged();
    },
    installBaseline: async () => {},
    restore: async (service) => {
      criticalCompose(criticalPrevious, 'up', service);
      const value = inspect(service);
      if (
        value.Image !== previousImage ||
        value.Config.Labels['phub.release-id'] !== `${service}-previous`
      )
        throw Error('Wrong independent rollback');
    },
  };
  await runApiWebTransition(criticalOps);
  await recoverApiWebTransition(criticalOps);
  for (const failure of ['preflight', 'pullAndSmoke', 'api', 'web', 'observe', 'installBaseline']) {
    let rejected = false;
    try {
      await runApiWebTransition({
        ...criticalOps,
        ...(failure === 'api' || failure === 'web'
          ? {
              activate: async (service) => {
                await criticalOps.activate(service);
                if (service === failure) throw Error('Injected after up');
              },
            }
          : {
              [failure]: async () => {
                throw Error('Injected boundary failure');
              },
            }),
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error('Failure was not rejected');
    for (const service of ['api', 'web'])
      if (inspect(service).Config.Labels['phub.release-id'] !== `${service}-previous`)
        throw Error('Previous pair not restored');
    await unchanged();
  }
  // Simulate abrupt process loss with an activated pair, then converge using only previous inputs.
  await criticalOps.activate('api');
  await criticalOps.activate('web');
  await recoverApiWebTransition(criticalOps);
  if (
    !criticalJournal.includes('ABORTED') ||
    !criticalJournal.includes('ROLLED_BACK') ||
    !criticalJournal.includes('SUCCESS')
  )
    throw Error('Missing recovery phases');
  process.stdout.write(
    'API_WEB_COMPOSE_REHEARSAL_PASS independent_previous_labels=true partial_activation_and_crash_recovery=true excluded_unchanged=true\n',
  );
  process.stdout.write(
    'STANDARD_COMPOSE_REHEARSAL_PASS success_and_forced_rollback=true backend_unchanged=true same_digest_rollback=true\n',
  );
} finally {
  docker(['compose', '--env-file', baseline, '-f', composeFile, 'down', '--remove-orphans']);
  rmSync(directory, { recursive: true });
}
