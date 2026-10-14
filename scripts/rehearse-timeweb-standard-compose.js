// Disposable Docker-only rehearsal: no host credentials, shared endpoints, ports or volumes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCriticalWebTransition,
  validateCriticalWebRecoveryImages,
} from './timeweb-critical-web.js';
import { runWebTransition, standardWebComposeArgs } from './timeweb-standard-policy.js';
import {
  apiWebComposeArgs,
  apiWebArtifactSmokeArgs,
  observeDirectApiWeb,
  runApiWebTransition,
  recoverApiWebTransition,
} from './timeweb-api-web-upgrade.js';

// Pure proof for the owned disposable Compose fixture, independent of CLI diagnostic text.
const tail = (value) =>
  String(value ?? '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .slice(-1200);

class OwnedFixtureHttpNotReady extends Error {
  constructor(service) {
    super(`Fixture ${service} HTTP not ready`);
    this.name = 'OWNED_FIXTURE_HTTP_NOT_READY';
  }
}

export function requireFixtureHttpReady(row, service) {
  if (row?.State?.Health?.Status !== 'healthy') throw new OwnedFixtureHttpNotReady(service);
}

export function requireUnavailableFixtureRejection(error, row, project, previousId) {
  const labels = row?.Config?.Labels;
  const ownedHttpRejection = error instanceof OwnedFixtureHttpNotReady;
  const rejected = ownedHttpRejection ? error.status == null : error?.status === 1;
  if (
    rejected &&
    !error?.signal &&
    /^lk2-standard-fixture-[1-9][0-9]*$/.test(project) &&
    /^[a-f0-9]{64}$/.test(row?.Id ?? '') &&
    /^[a-f0-9]{64}$/.test(previousId ?? '') &&
    row.Id !== previousId &&
    labels?.['com.docker.compose.project'] === project &&
    labels?.['com.docker.compose.service'] === 'web' &&
    labels?.['fixture.owner'] === project &&
    labels?.['phub.release-id'] === 'previous' &&
    JSON.stringify(row?.Config?.Cmd) === JSON.stringify(['sleep', '60']) &&
    row?.State?.Running === true &&
    row.State.Status === 'running' &&
    ['starting', 'unhealthy'].includes(row.State.Health?.Status)
  )
    return;
  throw new Error(
    'Unavailable fixture readiness rejection not proven: ' +
      JSON.stringify({
        exitStatus: error?.status ?? null,
        signal: error?.signal ?? null,
        containerId: row?.Id ?? null,
        command: row?.Config?.Cmd ?? null,
        state: row?.State?.Status ?? null,
        health: row?.State?.Health?.Status ?? null,
        stdout: tail(error?.stdout),
        stderr: tail(error?.stderr),
      }),
  );
}

// Importing the pure fixture proof must never provision or run a Docker fixture.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')
    throw new Error('Explicit fixture opt-in required');
  const directory = mkdtempSync(join(tmpdir(), 'lk2-standard-fixture-'));
  const project = `lk2-standard-fixture-${process.pid}`;
  const lock = JSON.parse(readFileSync('deploy/timeweb/base-images.lock.json'));
  const nginxDigest = lock.images.find((item) => item.id === 'nginx-web-runtime').indexDigest;
  const image = `nginx@${nginxDigest}`;
  const fixtureHttp = {
    healthcheck: {
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/'],
      interval: '1s',
      timeout: '1s',
      retries: 5,
      start_period: '2s',
      start_interval: '100ms',
    },
  };
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
          ...fixtureHttp,
          labels: { 'fixture.owner': project, 'phub.release-id': '${API_RELEASE:-api-previous}' },
        },
        worker: { image, profiles: ['background'], labels: { 'fixture.owner': project } },
        migrator: { image, profiles: ['migration'], labels: { 'fixture.owner': project } },
        realtime: { image, labels: { 'fixture.owner': project } },
        web: {
          image,
          ...fixtureHttp,
          labels: { 'fixture.owner': project, 'phub.release-id': '${RELEASE}' },
        },
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
  // Substitute only the fixture image: keep the production smoke arguments and nginx runtime
  // digest. These --rm, network-none containers receive no host credentials, ports or volumes.
  const smokeWebRuntimeBase = () => {
    const contractRef = `ghcr.io/z6v6e6r/phub-web@${nginxDigest}`;
    const args = apiWebArtifactSmokeArgs('web', contractRef);
    args[args.indexOf(contractRef)] = image;
    args.splice(1, 0, '--label', `fixture.owner=${project}`);
    const withoutScratch = args.filter(
      (value, index) => value !== '--tmpfs' && args[index - 1] !== '--tmpfs',
    );
    let rejectedReadOnly = false;
    try {
      docker(withoutScratch);
    } catch (error) {
      rejectedReadOnly = String(error.stderr).includes('Read-only file system');
    }
    if (!rejectedReadOnly) throw Error('Missing scratch paths did not reproduce nginx EROFS');
    docker(args);
  };
  // The fixture waits for nginx startup before exercising strict observation. Production args and
  // observation policy are unchanged; readiness failures still reject the disposable transition.
  const compose = (env, action) => {
    const args = standardWebComposeArgs(composeFile, baseline, env, action);
    if (action === 'up') args.push('--wait', '--wait-timeout', '30');
    const output = docker(args);
    if (action === 'up') assertFixtureHttp('web');
    return output;
  };
  const inspect = (service) => {
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
    if (ids.length !== 1) throw Error('Ambiguous fixture service');
    return JSON.parse(docker(['inspect', ids[0]]))[0];
  };
  const assertFixtureHttp = (service) => {
    requireFixtureHttpReady(inspect(service), service);
  };
  const journal = [];
  try {
    docker([
      'compose',
      '--env-file',
      baseline,
      '-f',
      composeFile,
      '--profile',
      'background',
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '30',
    ]);
    for (const service of ['api', 'web']) assertFixtureHttp(service);
    const apiBefore = inspect('api').Id;
    const previousImage = inspect('web').Image;
    // Exercise a delayed startup once, instead of imposing an unrelated delay on every recovery.
    const fixtureModel = JSON.parse(readFileSync(composeFile, 'utf8'));
    const delayedCompose = join(directory, 'delayed-compose.json');
    writeFileSync(
      delayedCompose,
      JSON.stringify({
        name: project,
        services: {
          web: {
            ...fixtureModel.services.web,
            command: ['/bin/sh', '-c', "sleep 1; exec nginx -g 'daemon off;'"],
          },
        },
        networks: fixtureModel.networks,
      }),
    );
    docker([
      ...standardWebComposeArgs(delayedCompose, baseline, baseline, 'up'),
      '--wait',
      '--wait-timeout',
      '30',
    ]);
    assertFixtureHttp('web');
    docker(['exec', inspect('web').Id, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
    // A container that stays running without HTTP must fail the bounded readiness gate. Use only
    // the owned Web fixture; the initial API/Worker/Realtime containers stay untouched.
    const unavailableCompose = join(directory, 'unavailable-compose.json');
    writeFileSync(
      unavailableCompose,
      JSON.stringify({
        name: project,
        services: { web: { ...fixtureModel.services.web, command: ['sleep', '60'] } },
        networks: fixtureModel.networks,
      }),
    );
    const availableFixtureId = inspect('web').Id;
    let readinessError;
    try {
      docker([
        ...standardWebComposeArgs(unavailableCompose, baseline, baseline, 'up'),
        '--wait',
        '--wait-timeout',
        '2',
      ]);
      // Compose may return before HTTP is healthy; the owned gate must still reject it.
      assertFixtureHttp('web');
    } catch (error) {
      readinessError = error;
    }
    requireUnavailableFixtureRejection(readinessError, inspect('web'), project, availableFixtureId);
    if (inspect('web').State.Health?.Status === 'healthy')
      throw Error('Unavailable fixture falsely healthy');
    compose(baseline, 'up');
    process.stdout.write(
      'COMPOSE_HTTP_READY_GUARD_PASS delayed_start=true unavailable_rejected=true\n',
    );
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
    // Exercise the new Web-only phase machine against real disposable Compose, including partial
    // activation that leaves two labeled Web containers. No production request/path is substituted.
    const criticalWebPlan = {
      candidate: { image, releaseId: 'candidate' },
      previous: { web: { image, releaseId: 'previous' } },
    };
    const targetRows = () => {
      const ids = docker([
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${project}`,
        '--filter',
        'label=com.docker.compose.service=web',
      ])
        .trim()
        .split('\n')
        .filter(Boolean);
      return ids.map((id) => JSON.parse(docker(['inspect', id]))[0]);
    };
    const webPhases = [];
    let released = false;
    let extra;
    const nonTargets = Object.fromEntries(
      ['api', 'worker', 'realtime'].map((service) => [service, inspect(service).Id]),
    );
    const unchangedWebBackend = async () => {
      for (const [service, id] of Object.entries(nonTargets))
        if (inspect(service).Id !== id) throw Error('Web-only changed another container');
    };
    const manualWebOps = {
      ...operations,
      attestBackend: unchangedWebBackend,
      attestPrevious: async () => {
        if (inspect('web').Config.Labels['phub.release-id'] !== 'previous')
          throw Error('Previous Web not restored');
      },
      attestCandidate: async () => {
        if (inspect('web').Config.Labels['phub.release-id'] !== 'candidate')
          throw Error('Candidate Web not active');
      },
      authorizeActivation: unchangedWebBackend,
      activate: async (markMutating) => {
        markMutating();
        await activate();
      },
      rollback: async () => {
        validateCriticalWebRecoveryImages(targetRows(), criticalWebPlan);
        await rollback();
      },
      journal: async (phase) => webPhases.push(phase),
      unlock: async () => {
        released = true;
      },
    };
    await runCriticalWebTransition(manualWebOps, 'deploy', 'PREPARED');
    if (!released) throw Error('Successful Web-only receipt did not release fixture');
    await rollback();
    released = false;
    try {
      await runCriticalWebTransition(
        {
          ...manualWebOps,
          activate: async (markMutating) => {
            markMutating();
            await activate();
            extra = docker([
              'run',
              '-d',
              '--network',
              'none',
              '--label',
              `fixture.owner=${project}`,
              '--label',
              `com.docker.compose.project=${project}`,
              '--label',
              'com.docker.compose.service=web',
              image,
            ]).trim();
            throw Error('Injected partial Compose activation');
          },
        },
        'deploy',
        'PREPARED',
      );
      throw Error('Partial activation unexpectedly accepted');
    } catch {
      if (!webPhases.includes('ROLLBACK_FAILED') || released)
        throw Error('Partial Web ambiguity did not retain fixture lock');
    }
    docker(['rm', '-f', extra]);
    await runCriticalWebTransition(manualWebOps, 'recover', 'ROLLBACK_FAILED');
    if (released || !webPhases.includes('ROLLED_BACK')) throw Error('Recovery custody incorrect');
    await runCriticalWebTransition(manualWebOps, 'reconcile', 'ROLLED_BACK');
    await unchangedWebBackend();
    process.stdout.write(
      'CRITICAL_WEB_COMPOSE_REHEARSAL_PASS success_partial_activation_recovery=true other_containers_unchanged=true\n',
    );
    const criticalPrevious = join(directory, 'critical-previous.env');
    const criticalCandidate = join(directory, 'critical-candidate.env');
    writeFileSync(criticalPrevious, 'RELEASE=web-previous\nAPI_RELEASE=api-previous\n');
    writeFileSync(criticalCandidate, 'RELEASE=web-candidate\nAPI_RELEASE=api-candidate\n');
    const criticalCompose = (env, action, service) => {
      const args = apiWebComposeArgs(baseline, env, action, service);
      args[args.indexOf('-f') + 1] = composeFile;
      if (action === 'up') args.push('--wait', '--wait-timeout', '30');
      const output = docker(args);
      if (action === 'up') assertFixtureHttp(service);
      return output;
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
      preflight: async () => {
        await unchanged();
        const configurationSnapshot = () =>
          ['api', 'web', 'worker', 'realtime'].map((service) => {
            const value = inspect(service);
            return [value.Id, value.Image, value.RestartCount, value.State.StartedAt];
          });
        const before = configurationSnapshot();
        const rendered = JSON.parse(criticalCompose(criticalCandidate, 'config', 'api'));
        if (Object.keys(rendered.services).sort().join(',') !== 'api,migrator,realtime,web,worker')
          throw Error('Unexpected read-only configuration services');
        for (const service of ['api', 'web', 'worker', 'realtime', 'migrator'])
          if (rendered.services[service]?.image !== image)
            throw Error('Profile service missing from read-only configuration');
        if (JSON.stringify(configurationSnapshot()) !== JSON.stringify(before))
          throw Error('Read-only configuration changed a container');
        if (
          docker([
            'ps',
            '-aq',
            '--filter',
            `label=com.docker.compose.project=${project}`,
            '--filter',
            'label=com.docker.compose.service=migrator',
          ]).trim()
        )
          throw Error('Migrator fixture activated');
      },
      pullAndSmoke: async () => {
        await unchanged();
        smokeWebRuntimeBase();
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
          docker([
            'exec',
            inspect(service).Id,
            'wget',
            '-q',
            '-O',
            '/dev/null',
            'http://127.0.0.1/',
          ]);
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
    // A virtual clock verifies the controller's 61-round shape without representing production's
    // required wall-clock observation; the real path has no injected clock or probe.
    let virtualNow = Date.parse('2026-10-03T00:00:00.000Z');
    const direct = await observeDirectApiWeb({
      inspectService: (service) => {
        if (inspect(service).Config.Labels['phub.release-id'] !== `${service}-candidate`)
          throw Error('Direct observation saw changed candidate');
      },
      probeService: async (service) => {
        docker(['exec', inspect(service).Id, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
        return 1;
      },
      attest: unchanged,
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms;
      },
    });
    if (direct.elapsedSeconds !== 900 || direct.samples.api.privateMs.length !== 61)
      throw Error('Wrong direct observation shape');
    await recoverApiWebTransition(criticalOps);
    const directRestoreOrder = [];
    let directRejected = false;
    try {
      await runApiWebTransition({
        ...criticalOps,
        observe: () =>
          observeDirectApiWeb({
            inspectService: (service) => {
              if (inspect(service).Config.Labels['phub.release-id'] !== `${service}-candidate`)
                throw Error('changed candidate');
            },
            probeService: async (service) => {
              docker([
                'exec',
                inspect(service).Id,
                'wget',
                '-q',
                '-O',
                '/dev/null',
                'http://127.0.0.1/',
              ]);
              return 1;
            },
            attest: async () => {
              await unchanged();
              throw Error('Injected direct owner observation drift');
            },
            now: () => virtualNow,
            sleep: async (ms) => {
              virtualNow += ms;
            },
          }),
        restore: async (service) => {
          directRestoreOrder.push(service);
          await criticalOps.restore(service);
        },
      });
    } catch {
      directRejected = true;
    }
    if (!directRejected || JSON.stringify(directRestoreOrder) !== JSON.stringify(['web', 'api']))
      throw Error('Direct failure did not restore exact previous pair');
    for (const service of ['api', 'web'])
      if (inspect(service).Config.Labels['phub.release-id'] !== `${service}-previous`)
        throw Error('Direct previous pair not restored');
    await unchanged();
    for (const failure of [
      'preflight',
      'pullAndSmoke',
      'api',
      'web',
      'observe',
      'installBaseline',
    ]) {
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
    docker([
      'compose',
      '--env-file',
      baseline,
      '-f',
      composeFile,
      '--profile',
      '*',
      'down',
      '--remove-orphans',
    ]);
    rmSync(directory, { recursive: true });
  }
}
