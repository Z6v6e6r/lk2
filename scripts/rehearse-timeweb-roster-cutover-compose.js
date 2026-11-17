// Disposable three-service lifecycle fixture; never a host deployment entry.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiWebComposeArgs,
  runApiWebTransition,
  recoverApiWebTransition,
  containRosterCutoverWorker,
} from './timeweb-api-web-upgrade.js';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')
    throw Error('Explicit fixture opt-in required');
  const canonical = process.env.TIMEWEB_CANONICAL_ROSTER_FIXTURE === '1';
  const predecessorRevision = '4b8dbaa12c1ec3fea478a5e661465955e4b0c7c0';
  const candidateRevision = 'd'.repeat(40);
  const revisionEnv = (candidate = false) =>
    canonical ? `WORKER_REVISION=${candidate ? candidateRevision : predecessorRevision}\n` : '';
  const directory = mkdtempSync(join(tmpdir(), 'lk2-roster-fixture-'));
  const project = `lk2-roster-fixture-${process.pid}`;
  const pinned = JSON.parse(readFileSync('deploy/timeweb/base-images.lock.json'));
  const image = `nginx@${pinned.images.find((v) => v.id === 'nginx-web-runtime').indexDigest}`;
  const composeFile = join(directory, 'compose.json'),
    baseline = join(directory, 'baseline.env');
  writeFileSync(
    baseline,
    'RELEASE=web-previous\nAPI_RELEASE=api-previous\nWORKER_GENERATION=previous\n' + revisionEnv(),
  );
  const healthcheck = {
    test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/'],
    interval: '1s',
    timeout: '1s',
    retries: 5,
    start_period: '2s',
    start_interval: '100ms',
  };
  writeFileSync(
    composeFile,
    JSON.stringify({
      name: project,
      services: {
        api: {
          image,
          healthcheck,
          labels: { 'fixture.owner': project, 'phub.release-id': '${API_RELEASE}' },
        },
        web: {
          image,
          healthcheck,
          labels: { 'fixture.owner': project, 'phub.release-id': '${RELEASE}' },
        },
        worker: {
          image,
          healthcheck,
          profiles: ['background'],
          labels: {
            'fixture.owner': project,
            'fixture.worker-generation': '${WORKER_GENERATION}',
            ...(canonical ? { 'org.opencontainers.image.revision': '${WORKER_REVISION}' } : {}),
          },
        },
        realtime: { image, healthcheck, labels: { 'fixture.owner': project } },
      },
      networks: { default: { internal: true } },
    }),
  );
  const docker = (args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    if (inspect(service).State.Health?.Status !== 'healthy')
      throw Error('Unhealthy fixture service');
    docker(['exec', inspect(service).Id, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
  };
  const criticalCompose = (env, action, service, roster = false) => {
    const args = apiWebComposeArgs(baseline, env, action, service, roster);
    args[args.indexOf('-f') + 1] = composeFile;
    if (action === 'up') args.push('--wait', '--wait-timeout', '30');
    docker(args);
    if (action === 'up') assertFixtureHttp(service);
  };
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
    // The same owned, credential-free fixture exercises the three-service phase machine.
    // The pinned nginx base is a lifecycle fixture, not the published Worker artifact.
    const rosterPrevious = join(directory, 'roster-previous.env');
    const rosterCandidate = join(directory, 'roster-candidate.env');
    writeFileSync(
      rosterPrevious,
      'RELEASE=web-previous\nAPI_RELEASE=api-previous\nWORKER_GENERATION=previous\n' +
        revisionEnv(),
    );
    writeFileSync(
      rosterCandidate,
      'RELEASE=web-candidate\nAPI_RELEASE=api-candidate\nWORKER_GENERATION=candidate\n' +
        revisionEnv(true),
    );
    const realtimeId = inspect('realtime').Id;
    const worker = inspect('worker');
    const workerPlan = {
      previous: {
        worker: {
          image: worker.Config.Image,
          imageId: worker.Image,
          releaseId: worker.Config.Labels['phub.release-id'] ?? null,
          revision: worker.Config.Labels['org.opencontainers.image.revision'] ?? null,
        },
      },
      candidate: {
        worker: {
          image: worker.Config.Image,
          releaseId: worker.Config.Labels['phub.release-id'] ?? null,
          revision: canonical ? candidateRevision : null,
        },
      },
    };
    const rosterJournal = [];
    const rosterActions = [];
    const sameRealtime = async () => {
      if (inspect('realtime').Id !== realtimeId) throw Error('Roster fixture changed Realtime');
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
        throw Error('Roster fixture activated migrator');
    };
    const attestRoster = async (side) => {
      await sameRealtime();
      for (const service of ['api', 'worker', 'web']) {
        const value = inspect(service);
        assertFixtureHttp(service);
        if (value.Image !== worker.Image || value.RestartCount !== 0)
          throw Error('Roster fixture immutable identity drift');
        if (
          service === 'worker'
            ? value.Config.Labels['fixture.worker-generation'] !== side
            : value.Config.Labels['phub.release-id'] !== `${service}-${side}`
        )
          throw Error('Roster fixture generation drift');
        if (
          canonical &&
          service === 'worker' &&
          value.Config.Labels['org.opencontainers.image.revision'] !==
            (side === 'previous' ? predecessorRevision : candidateRevision)
        )
          throw Error('Canonical fixture OCI revision drift');
      }
    };
    const rosterOps = {
      workerMode: 'legacy-roster-cutover',
      preflight: () => attestRoster('previous'),
      pullAndSmoke: sameRealtime,
      journal: async (phase) => rosterJournal.push(phase),
      containWorker: async () => {
        rosterActions.push('contain');
        containRosterCutoverWorker(workerPlan, (args) =>
          docker(
            args.map((value) =>
              value === 'label=com.docker.compose.project=phub-timeweb-beta'
                ? `label=com.docker.compose.project=${project}`
                : value,
            ),
          ),
        );
        await sameRealtime();
      },
      activate: async (service) => {
        rosterActions.push('activate:' + service);
        criticalCompose(rosterCandidate, 'up', service, true);
        await sameRealtime();
      },
      observe: () => attestRoster('candidate'),
      attest: () => attestRoster('candidate'),
      installBaseline: async () => {},
      removeCandidateBaseline: async () => {},
      abort: () => attestRoster('previous'),
      restore: async (service) => {
        rosterActions.push('restore:' + service);
        criticalCompose(rosterPrevious, 'up', service, true);
        await sameRealtime();
      },
      attestRestored: () => attestRoster('previous'),
    };
    await runApiWebTransition(rosterOps);
    await recoverApiWebTransition(rosterOps);
    rosterActions.length = 0;
    let rosterRejected = false;
    try {
      await runApiWebTransition({
        ...rosterOps,
        activate: async (service) => {
          await rosterOps.activate(service);
          if (service === 'worker') throw Error('Injected lost Worker activation ACK');
        },
      });
    } catch {
      rosterRejected = true;
    }
    if (
      !rosterRejected ||
      JSON.stringify(rosterActions) !==
        JSON.stringify([
          'contain',
          'activate:api',
          'activate:worker',
          'contain',
          'restore:web',
          'restore:api',
          'restore:worker',
        ])
    )
      throw Error('Roster fixture containment/rollback order failed');
    await attestRoster('previous');
    if (
      !rosterJournal.includes('WORKER_STOP_INTENT') ||
      !rosterJournal.includes('WORKER_ACTIVE') ||
      !rosterJournal.includes('SUCCESS') ||
      !rosterJournal.includes('ROLLED_BACK')
    )
      throw Error('Roster fixture missing durable phases');
    process.stdout.write(
      `API_WORKER_WEB_COMPOSE_REHEARSAL_PASS canonical=${canonical} contained_first=true lost_worker_ack_recovered=true realtime_unchanged=true\n`,
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
