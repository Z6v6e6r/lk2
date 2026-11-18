// Disposable Docker-only rehearsal: no host credentials, shared endpoints, ports or volumes.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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

export function requireOwnedFixtureResources(project, containers, networks) {
  if (!/^lk2-standard-fixture-[1-9][0-9]*$/.test(project)) throw Error('Invalid fixture project');
  for (const row of containers) {
    const labels = row?.Config?.Labels;
    if (
      !/^[a-f0-9]{64}$/.test(row?.Id ?? '') ||
      labels?.['fixture.owner'] !== project ||
      (labels['com.docker.compose.project'] !== undefined &&
        labels['com.docker.compose.project'] !== project)
    )
      throw Error('Fixture container ownership lost');
  }
  for (const row of networks) {
    if (
      !/^[a-f0-9]{64}$/.test(row?.Id ?? '') ||
      row?.Labels?.['fixture.owner'] !== project ||
      row.Labels['com.docker.compose.project'] !== project ||
      row.Internal !== true
    )
      throw Error('Fixture network ownership lost');
  }
}

function cleanupOwnedFixture(project, directory) {
  const started = performance.now();
  if (
    !/^lk2-standard-fixture-[1-9][0-9]*$/.test(project) ||
    !/^lk2-standard-fixture-[A-Za-z0-9]+$/.test(basename(directory))
  )
    throw Error('Invalid fixture cleanup identity');
  const composeFile = join(directory, 'compose.json');
  const baseline = join(directory, 'baseline.env');
  if (existsSync(directory)) {
    if (
      directory !== resolve(directory) ||
      !lstatSync(directory).isDirectory() ||
      lstatSync(directory).isSymbolicLink()
    )
      throw Error('Fixture directory ownership lost');
    const model = JSON.parse(readFileSync(composeFile, 'utf8'));
    if (
      model.name !== project ||
      !model.services ||
      Object.values(model.services).some((service) => service.labels?.['fixture.owner'] !== project)
    )
      throw Error('Fixture model ownership lost');
  }
  const docker = (args) => {
    const remaining = 20000 - (performance.now() - started);
    if (remaining <= 0) throw Error('Fixture cleanup budget exhausted');
    return execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: Math.floor(remaining),
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const ids = (args) => docker(args).trim().split('\n').filter(Boolean);
  const containerIds = () => [
    ...new Set([
      ...ids(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]),
      ...ids(['ps', '-aq', '--filter', `label=fixture.owner=${project}`]),
    ]),
  ];
  const networkIds = () => [
    ...new Set([
      ...ids(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]),
      ...ids(['network', 'ls', '-q', '--filter', `label=fixture.owner=${project}`]),
    ]),
  ];
  const containers = containerIds();
  const networks = networkIds();
  requireOwnedFixtureResources(
    project,
    containers.length ? JSON.parse(docker(['inspect', ...containers])) : [],
    networks.length ? JSON.parse(docker(['network', 'inspect', ...networks])) : [],
  );
  if (containers.length || networks.length) {
    if (readFileSync(join(directory, 'admitted'), 'utf8') !== project)
      throw Error('Fixture creation was not admitted');
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
    // A killed Docker CLI does not remove a daemon-side --rm smoke container until it exits.
    const smoke = containerIds();
    if (smoke.length) {
      requireOwnedFixtureResources(project, JSON.parse(docker(['inspect', ...smoke])), []);
      docker(['rm', '-f', ...smoke]);
    }
  }
  if (containerIds().length || networkIds().length) throw Error('Fixture cleanup unconfirmed');
  rmSync(directory, { recursive: true, force: true });
  process.stdout.write(
    `FIXTURE_CLEANUP_PASS containers=0 networks=0 duration_ms=${Math.round(performance.now() - started)}\n`,
  );
}

// Importing the pure fixture proofs must never provision or run a Docker fixture.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain && process.argv[2] === '--cleanup') {
  cleanupOwnedFixture(process.argv[3], process.argv[4]);
} else if (isMain && process.argv[2] === '--cleanup-record') {
  const path = process.argv[3];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048)
    throw Error('Invalid fixture ownership record');
  const bytes = readFileSync(path, 'utf8');
  const record = JSON.parse(bytes);
  if (
    Object.keys(record).sort().join(',') !== 'directory,project' ||
    typeof record.project !== 'string' ||
    typeof record.directory !== 'string'
  )
    throw Error('Invalid fixture ownership record');
  cleanupOwnedFixture(record.project, record.directory);
  if (readFileSync(path, 'utf8') !== bytes) throw Error('Fixture ownership record changed');
  rmSync(path);
} else if (isMain) {
  if (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')
    throw new Error('Explicit fixture opt-in required');
  const directory =
    process.env.TIMEWEB_STANDARD_FIXTURE_DIRECTORY ??
    mkdtempSync(join(tmpdir(), 'lk2-standard-fixture-'));
  const project =
    process.env.TIMEWEB_STANDARD_FIXTURE_PROJECT ?? `lk2-standard-fixture-${process.pid}`;
  if (
    !/^lk2-standard-fixture-[1-9][0-9]*$/.test(project) ||
    !/^lk2-standard-fixture-[A-Za-z0-9]+$/.test(basename(directory)) ||
    directory !== resolve(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink() ||
    readdirSync(directory).length
  )
    throw Error('Invalid fresh fixture identity');
  const started = performance.now();
  let stage = 'prepare';
  let stageStarted = started;
  const setStage = (next) => {
    process.stdout.write(
      `FIXTURE_STAGE ${stage} duration_ms=${Math.round(performance.now() - stageStarted)} elapsed_ms=${Math.round(performance.now() - started)}\n`,
    );
    stage = next;
    stageStarted = performance.now();
    process.stdout.write(`FIXTURE_STAGE_START ${stage}\n`);
  };
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
      networks: { default: { internal: true, labels: { 'fixture.owner': project } } },
    }),
  );
  process.stdout.write(`FIXTURE_IDENTITY ${JSON.stringify({ project, directory })}\n`);
  // In CI the outer supervisor owns cleanup after the complete test PGID is confirmed stopped.
  // The rehearsal never detaches: a killed worker cannot leave an untracked fixture process group.
  const ownershipRecord = process.env.CI_TEST_DIAGNOSTICS_DIR
    ? join(process.env.CI_TEST_DIAGNOSTICS_DIR, 'compose-fixture-owner.json')
    : undefined;
  if (ownershipRecord)
    writeFileSync(ownershipRecord, JSON.stringify({ project, directory }), {
      flag: 'wx',
      mode: 0o600,
    });
  const docker = (args) => {
    const commandStarted = performance.now();
    try {
      // Measured full cold-image rehearsal: 252 s, including real Compose and 61 probe rounds.
      // Reserve cleanup separately: 270 s body + 20 s cleanup < 300 s parent deadline.
      const remaining = started + 270000 - commandStarted;
      if (remaining <= 0) throw new Error(`FIXTURE_STAGE_BUDGET_EXHAUSTED:${stage}`);
      return execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: Math.min(120000, Math.floor(remaining)),
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      process.stderr.write(
        `FIXTURE_COMMAND_ERROR ${JSON.stringify({ stage, command: args[0], status: error.status ?? null, signal: error.signal ?? null, error: tail(error.code ?? error.message), stdout: tail(error.stdout), stderr: tail(error.stderr) })}\n`,
      );
      throw error;
    } finally {
      const duration = Math.round(performance.now() - commandStarted);
      if (duration >= 500)
        process.stdout.write(
          `FIXTURE_COMMAND stage=${stage} command=${args[0]} action=${args.find((arg) => ['pull', 'up', 'down'].includes(arg)) ?? args[0]} duration_ms=${duration}\n`,
        );
    }
  };
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
    setStage('initial-compose-readiness');
    if (
      docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim() ||
      docker([
        'network',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${project}`,
      ]).trim()
    )
      throw Error('Fixture project already exists');
    writeFileSync(join(directory, 'admitted'), project, { flag: 'wx' });
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
    setStage('delayed-readiness');
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
    setStage('unavailable-readiness-and-restore');
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
    setStage('web-success-and-rollback');
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
        docker([
          'run',
          '--rm',
          '--label',
          `fixture.owner=${project}`,
          '--network',
          'none',
          '--entrypoint',
          'nginx',
          image,
          '-t',
        ]);
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
    setStage('critical-web-recovery');
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
    setStage('api-web-success');
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
    setStage('direct-observation');
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
    setStage('direct-rollback');
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
    setStage('api-web-boundary-recovery');
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
    setStage('crash-recovery');
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
    setStage('cleanup');
    if (ownershipRecord) process.stdout.write('FIXTURE_CLEANUP_DEFERRED_TO_OUTER_SUPERVISOR\n');
    else cleanupOwnedFixture(project, directory);
    setStage('complete');
  }
}
