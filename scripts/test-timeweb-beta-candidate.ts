#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertDistinctCandidatePair,
  assertForwardOnlyRollback,
  assertRehearsalProjectName,
  assertRuntimeSnapshot,
  buildSyntheticRuntimeEnvironments,
  loadTimewebRuntimeContracts,
  readCandidateArtifact,
  serializeEnvironment,
  TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK,
  type CandidateIdentity,
  type RuntimeComponentSnapshot,
} from './timeweb-beta-candidate-contract.js';
import { runTimewebBrowserSmoke } from './timeweb-beta-browser-smoke.js';
import { verifyDeploymentContract } from './verify-timeweb-deployment-contract.js';

export interface Options {
  readonly contractOnly: boolean;
  readonly skipBrowser: boolean;
  readonly manifestDirectory?: string;
  readonly expectedSourceSha?: string;
  readonly expectedSourceTree?: string;
  readonly expectedPublicationRunId?: string;
  readonly expectedManifestChecksum?: string;
  readonly previousManifestDirectory?: string;
  readonly expectedPreviousSourceSha?: string;
  readonly expectedPreviousSourceTree?: string;
  readonly expectedPreviousPublicationRunId?: string;
  readonly expectedPreviousManifestChecksum?: string;
}

export function parseTimewebBetaCandidateArguments(argv: readonly string[]): Options {
  let contractOnly = false;
  let skipBrowser = false;
  let manifestDirectory: string | undefined;
  let expectedSourceSha: string | undefined;
  let expectedSourceTree: string | undefined;
  let expectedPublicationRunId: string | undefined;
  let expectedManifestChecksum: string | undefined;
  let previousManifestDirectory: string | undefined;
  let expectedPreviousSourceSha: string | undefined;
  let expectedPreviousSourceTree: string | undefined;
  let expectedPreviousPublicationRunId: string | undefined;
  let expectedPreviousManifestChecksum: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--contract-only') contractOnly = true;
    else if (argument === '--skip-browser') skipBrowser = true;
    else if (
      argument === '--manifest-dir' ||
      argument === '--expected-source-sha' ||
      argument === '--expected-source-tree' ||
      argument === '--expected-publication-run-id' ||
      argument === '--expected-manifest-checksum' ||
      argument === '--previous-manifest-dir' ||
      argument === '--expected-previous-source-sha' ||
      argument === '--expected-previous-source-tree' ||
      argument === '--expected-previous-publication-run-id' ||
      argument === '--expected-previous-manifest-checksum'
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing value for ${argument}`);
      if (argument === '--manifest-dir') manifestDirectory = resolve(value);
      else if (argument === '--expected-source-sha') expectedSourceSha = value;
      else if (argument === '--expected-source-tree') expectedSourceTree = value;
      else if (argument === '--expected-publication-run-id') expectedPublicationRunId = value;
      else if (argument === '--expected-manifest-checksum') expectedManifestChecksum = value;
      else if (argument === '--previous-manifest-dir') previousManifestDirectory = resolve(value);
      else if (argument === '--expected-previous-source-sha') expectedPreviousSourceSha = value;
      else if (argument === '--expected-previous-source-tree') expectedPreviousSourceTree = value;
      else if (argument === '--expected-previous-publication-run-id')
        expectedPreviousPublicationRunId = value;
      else expectedPreviousManifestChecksum = value;
      index += 1;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  const candidateValues = [
    manifestDirectory,
    expectedSourceSha,
    expectedSourceTree,
    expectedPublicationRunId,
    expectedManifestChecksum,
  ];
  if (candidateValues.some(Boolean) && !candidateValues.every(Boolean)) {
    throw new Error(
      '--manifest-dir requires source SHA/tree, publication run ID and manifest checksum',
    );
  }
  const previousValues = [
    previousManifestDirectory,
    expectedPreviousSourceSha,
    expectedPreviousSourceTree,
    expectedPreviousPublicationRunId,
    expectedPreviousManifestChecksum,
  ];
  if (previousValues.some(Boolean) && !previousValues.every(Boolean)) {
    throw new Error(
      '--previous-manifest-dir requires previous source SHA/tree, publication run ID and manifest checksum',
    );
  }
  if (previousManifestDirectory && !manifestDirectory)
    throw new Error('--previous-manifest-dir requires an exact candidate manifest');
  if (!contractOnly && !manifestDirectory)
    throw new Error('full rehearsal requires an exact verified candidate manifest');
  if (!contractOnly && !previousManifestDirectory)
    throw new Error('full rehearsal requires a distinct verified previous candidate manifest');
  return {
    contractOnly,
    skipBrowser,
    ...(manifestDirectory ? { manifestDirectory } : {}),
    ...(expectedSourceSha ? { expectedSourceSha } : {}),
    ...(expectedSourceTree ? { expectedSourceTree } : {}),
    ...(expectedPublicationRunId ? { expectedPublicationRunId } : {}),
    ...(expectedManifestChecksum ? { expectedManifestChecksum } : {}),
    ...(previousManifestDirectory ? { previousManifestDirectory } : {}),
    ...(expectedPreviousSourceSha ? { expectedPreviousSourceSha } : {}),
    ...(expectedPreviousSourceTree ? { expectedPreviousSourceTree } : {}),
    ...(expectedPreviousPublicationRunId ? { expectedPreviousPublicationRunId } : {}),
    ...(expectedPreviousManifestChecksum ? { expectedPreviousManifestChecksum } : {}),
  };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function sanitizedHostEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TMPDIR',
    'USER',
    'XDG_RUNTIME_DIR',
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

const HOST_ENVIRONMENT = sanitizedHostEnvironment();

function assertLocalDockerEndpoint(): void {
  const overrides = Object.keys(process.env).filter(
    (key) => key.startsWith('DOCKER_') || key.startsWith('COMPOSE_'),
  );
  if (overrides.length > 0)
    throw new Error(
      `ambient Docker/Compose overrides are forbidden: ${overrides.sort().join(',')}`,
    );
  const endpoint = run(
    'docker',
    ['context', 'inspect', '--format', '{{ (index .Endpoints "docker").Host }}'],
    { capture: true },
  );
  if (!endpoint.startsWith('unix://'))
    throw new Error(`rehearsal requires a local Unix-socket Docker endpoint, got ${endpoint}`);
  run('docker', ['info', '--format', '{{.ID}}'], { capture: true });
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly environment?: NodeJS.ProcessEnv; readonly capture?: boolean } = {},
): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: options.environment ?? HOST_ENVIRONMENT,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = options.capture ? (result.stderr ?? '').trim().slice(0, 2_000) : '';
    throw new Error(
      `${command} ${args[0] ?? ''} failed (${result.status})${stderr ? `: ${stderr}` : ''}`,
    );
  }
  return options.capture ? (result.stdout ?? '').trim() : '';
}

async function waitFor(
  description: string,
  operation: () => boolean | Promise<boolean>,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${description} timed out`);
}

function writeSyntheticEnvironments(root: string): void {
  const environments = buildSyntheticRuntimeEnvironments();
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  for (const [service, values] of Object.entries(environments)) {
    writeFileSync(join(root, `${service}.env`), serializeEnvironment(values), {
      mode: 0o600,
      flag: 'wx',
    });
  }
}

function imageNames(sourceSha: string, candidate: CandidateIdentity): Record<string, string> {
  return {
    web: candidate.images.web,
    api: candidate.images.api,
    realtime: candidate.images.realtime,
    worker: candidate.images.worker,
    migrator: candidate.images.migrator,
    proxy: `phub-timeweb-rehearsal-proxy:${sourceSha.slice(0, 12)}`,
  };
}

function composeEnvironment(input: {
  project: string;
  envRoot: string;
  sourceSha: string;
  sourceTree: string;
  releaseId: string;
  images: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  return {
    ...HOST_ENVIRONMENT,
    TIMEWEB_REHEARSAL_PROJECT: input.project,
    TIMEWEB_REHEARSAL_ENV_ROOT: input.envRoot,
    TIMEWEB_REHEARSAL_SOURCE_SHA: input.sourceSha,
    TIMEWEB_REHEARSAL_SOURCE_TREE: input.sourceTree,
    TIMEWEB_REHEARSAL_RELEASE_ID: input.releaseId,
    TIMEWEB_REHEARSAL_WEB_IMAGE: input.images.web,
    TIMEWEB_REHEARSAL_API_IMAGE: input.images.api,
    TIMEWEB_REHEARSAL_REALTIME_IMAGE: input.images.realtime,
    TIMEWEB_REHEARSAL_WORKER_IMAGE: input.images.worker,
    TIMEWEB_REHEARSAL_MIGRATOR_IMAGE: input.images.migrator,
    TIMEWEB_REHEARSAL_PROXY_IMAGE: input.images.proxy,
  };
}

function containerId(
  compose: readonly string[],
  environment: NodeJS.ProcessEnv,
  service: string,
): string {
  const id = run('docker', [...compose, 'ps', '--all', '-q', service], {
    environment,
    capture: true,
  });
  if (!/^[0-9a-f]{12,64}$/u.test(id)) throw new Error(`container id missing for ${service}`);
  return id;
}

interface DockerInspection {
  readonly Config: {
    readonly Image: string;
    readonly Labels: Record<string, string> | null;
  };
  readonly State: {
    readonly Running: boolean;
    readonly ExitCode: number;
    readonly StartedAt: string;
    readonly Health?: { readonly Status?: string };
  };
}

function inspectContainer(id: string): DockerInspection {
  const output = run('docker', ['inspect', id], { capture: true });
  const parsed = JSON.parse(output) as DockerInspection[];
  const inspection = parsed[0];
  if (!inspection) throw new Error(`Docker inspection missing for ${id}`);
  return inspection;
}

async function waitForHealthy(id: string): Promise<void> {
  await waitFor(`container ${id} health`, () => {
    try {
      const state = inspectContainer(id).State;
      return state.Running && state.Health?.Status === 'healthy';
    } catch {
      return false;
    }
  });
}

function runtimeSnapshots(
  compose: readonly string[],
  environment: NodeJS.ProcessEnv,
): RuntimeComponentSnapshot[] {
  return (['web', 'api', 'realtime', 'worker'] as const).map((component) => {
    const inspection = inspectContainer(containerId(compose, environment, component));
    return {
      component,
      configuredImage: inspection.Config.Image,
      labels: inspection.Config.Labels ?? {},
      healthy: inspection.State.Running && inspection.State.Health?.Status === 'healthy',
    };
  });
}

interface LedgerSnapshot {
  readonly count: number;
  readonly sha256: string;
  readonly rows: string;
}

function ledgerSnapshot(
  compose: readonly string[],
  environment: NodeJS.ProcessEnv,
  database = 'phub',
): LedgerSnapshot {
  const output = run(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'phub',
      '-d',
      database,
      '-Atc',
      `select filename || '|' || checksum from public.schema_migrations order by filename`,
    ],
    { environment, capture: true },
  );
  const rows = output.trim();
  const entries = rows.split('\n').filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => !/^\d+[^|]*\.sql\|[0-9a-f]{64}$/u.test(entry))
  )
    throw new Error(`migration ledger invalid for ${database}`);
  return {
    count: entries.length,
    sha256: createHash('sha256').update(`${rows}\n`).digest('hex'),
    rows,
  };
}

function assertSameLedger(
  actual: LedgerSnapshot,
  expected: LedgerSnapshot,
  description: string,
): void {
  if (actual.sha256 !== expected.sha256 || actual.rows !== expected.rows)
    throw new Error(`${description}: exact filename/checksum ledger changed`);
}

async function verifyHttpOnce(baseUrl: string): Promise<void> {
  const ready = await fetch(new URL('/health/ready', baseUrl));
  if (ready.status !== 200 || ((await ready.json()) as { status?: string }).status !== 'ready')
    throw new Error('API readiness through rehearsal proxy failed');
  const web = await fetch(new URL('/', baseUrl));
  if (web.status !== 200 || !(await web.text()).includes('phub-app'))
    throw new Error('Web root through rehearsal proxy failed');
  const realtime = await fetch(new URL('/realtime/health/ready', baseUrl));
  if (
    realtime.status !== 200 ||
    ((await realtime.json()) as { status?: string }).status !== 'ready'
  )
    throw new Error('Realtime readiness through rehearsal proxy failed');
  const boundary = await fetch(new URL('/public/api/v1/__smoke_invalid__/games', baseUrl));
  const body = (await boundary.json()) as { code?: string };
  if (boundary.status !== 400 || body.code !== 'TENANT_KEY_INVALID')
    throw new Error('critical read-only API boundary failed');
}

async function waitForHttp(resolveBaseUrl: () => string): Promise<void> {
  let lastFailure = 'HTTP verification was not attempted';
  try {
    await waitFor('rehearsal HTTP readiness', async () => {
      try {
        const baseUrl = resolveBaseUrl();
        await verifyHttpOnce(baseUrl);
        return true;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : 'unknown HTTP verification failure';
        return false;
      }
    });
  } catch {
    throw new Error(`rehearsal HTTP readiness timed out: ${lastFailure}`);
  }
}

function proxyBaseUrl(compose: readonly string[], environment: NodeJS.ProcessEnv): string {
  const proxyPort = run('docker', [...compose, 'port', 'proxy', '8080'], {
    environment,
    capture: true,
  });
  if (!/^127\.0\.0\.1:[1-9][0-9]*$/u.test(proxyPort))
    throw new Error(`invalid dynamic proxy port: ${proxyPort}`);
  return `http://${proxyPort}`;
}

async function main(): Promise<void> {
  const options = parseTimewebBetaCandidateArguments(process.argv.slice(2));
  const contracts = loadTimewebRuntimeContracts();
  buildSyntheticRuntimeEnvironments(contracts);
  verifyDeploymentContract();
  if (options.contractOnly) {
    process.stdout.write('TIMEWEB_BETA_CANDIDATE_CONTRACT=PASS\n');
    return;
  }

  const manifestDirectory = options.manifestDirectory!;
  const previousManifestDirectory = options.previousManifestDirectory!;
  assertLocalDockerEndpoint();
  if (git('status', '--porcelain') !== '') {
    throw new Error('full rehearsal requires a clean candidate worktree');
  }
  const sourceSha = options.expectedSourceSha!;
  const sourceTree = options.expectedSourceTree!;
  const candidate = readCandidateArtifact(join(manifestDirectory, 'release-manifest.json'), {
    sourceSha,
    sourceTree,
    publicationRunId: options.expectedPublicationRunId!,
    manifestSha256: options.expectedManifestChecksum!,
  });
  const previousCandidate = readCandidateArtifact(
    join(previousManifestDirectory, 'release-manifest.json'),
    {
      sourceSha: options.expectedPreviousSourceSha!,
      sourceTree: options.expectedPreviousSourceTree!,
      publicationRunId: options.expectedPreviousPublicationRunId!,
      manifestSha256: options.expectedPreviousManifestChecksum!,
    },
  );
  assertDistinctCandidatePair(candidate, previousCandidate);
  const releaseId = `${candidate.sourceSha}-${candidate.runId}-${candidate.runAttempt}`;
  const previousReleaseId = `${previousCandidate.sourceSha}-${previousCandidate.runId}-${previousCandidate.runAttempt}`;
  assertForwardOnlyRollback({
    candidateReleaseId: releaseId,
    previousReleaseId,
    databaseCommands: [],
  });

  const temporaryRoot = mkdtempSync(
    join(realpathSync(tmpdir()), 'phub-timeweb-candidate-rehearsal-'),
  );
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  let cleanupCompose: readonly string[] | undefined;
  let cleanupEnvironment: NodeJS.ProcessEnv | undefined;
  let primaryFailure: unknown;
  let cleanupFailure: Error | undefined;
  try {
    const envRoot = join(temporaryRoot, 'runtime-env');
    const project = assertRehearsalProjectName(
      `phub-tw-rehearsal-${process.pid.toString(36)}-${Date.now().toString(36)}`,
    );
    const images = imageNames(sourceSha, candidate);
    const previousImages: Record<string, string> = {
      ...imageNames(previousCandidate.sourceSha, previousCandidate),
      proxy: images.proxy!,
    };
    const composeFile = resolve('deploy/timeweb/compose.rehearsal.yaml');
    const compose = [
      'compose',
      '-f',
      composeFile,
      '--project-name',
      project,
      '--profile',
      'background',
      '--profile',
      'migration',
    ] as const;
    cleanupCompose = compose;
    writeSyntheticEnvironments(envRoot);
    const environment = composeEnvironment({
      project,
      envRoot,
      sourceSha,
      sourceTree,
      releaseId,
      images,
    });
    cleanupEnvironment = environment;
    process.env.RUNNER_TEMP = temporaryRoot;
    verifyDeploymentContract({
      target: resolve('deploy/timeweb/target.json'),
      caddyfile: resolve('deploy/timeweb/Caddyfile'),
      publicBetaCaddyfile: resolve('deploy/timeweb/Caddyfile.yandex-public-beta'),
      publicBetaIngress: resolve('deploy/timeweb/yandex-public-beta-ingress.json'),
      ingress: resolve('deploy/timeweb/compose.ingress.yaml'),
      application: resolve('deploy/timeweb/compose.beta.yaml'),
      runtime: resolve('deploy/timeweb/runtime-environment.contract.json'),
      nodeBootstrap: resolve('deploy/timeweb/operator-node-bootstrap.v1.json'),
      observability: resolve('deploy/timeweb/api-web-observability.v1.json'),
      runbook: resolve('docs/runbooks/timeweb-lk2-beta.md'),
      envRoot,
    });

    run('docker', [...compose, 'config', '--quiet'], { environment });
    run('docker', [...compose, 'build', 'proxy'], { environment });
    run('docker', [...compose, 'pull', 'api', 'realtime', 'worker', 'web', 'migrator'], {
      environment,
    });
    const previousPullEnvironment = composeEnvironment({
      project,
      envRoot,
      sourceSha: previousCandidate.sourceSha,
      sourceTree: previousCandidate.sourceTree,
      releaseId: previousReleaseId,
      images: previousImages,
    });
    run('docker', [...compose, 'pull', 'api', 'realtime', 'worker', 'web', 'migrator'], {
      environment: previousPullEnvironment,
    });

    run('docker', [...compose, 'up', '-d', '--no-deps', 'api'], { environment });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const wrongOrderState = inspectContainer(containerId(compose, environment, 'api')).State;
    if (wrongOrderState.Health?.Status === 'healthy')
      throw new Error('API unexpectedly became healthy before dependencies');
    run('docker', [...compose, 'rm', '-s', '-f', 'api'], { environment });
    process.stdout.write('START_ORDER_NEGATIVE=PASS\n');

    run(
      'docker',
      [...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'rabbitmq'],
      {
        environment,
      },
    );

    const emptyMigration = run(
      'docker',
      [
        ...compose,
        'run',
        '--rm',
        '-T',
        '-e',
        `CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=${TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK}`,
        'migrator',
      ],
      { environment, capture: true },
    );
    if (!emptyMigration.includes('Applied '))
      throw new Error('empty database migration applied nothing');
    const emptyNoOp = run('docker', [...compose, 'run', '--rm', '-T', 'migrator'], {
      environment,
      capture: true,
    });
    if (emptyNoOp.includes('Applied ')) throw new Error('second migration run was not a no-op');
    const candidateLedger = ledgerSnapshot(compose, environment);
    assertSameLedger(
      ledgerSnapshot(compose, environment),
      candidateLedger,
      'empty database second no-op',
    );

    const previousDatabaseUrl =
      'postgresql://phub:synthetic-rehearsal-postgres@postgres:5432/phub_previous';
    const previousEnvironment = composeEnvironment({
      project,
      envRoot,
      sourceSha: previousCandidate.sourceSha,
      sourceTree: previousCandidate.sourceTree,
      releaseId: previousReleaseId,
      images: previousImages,
    });
    const previousMigration = run(
      'docker',
      [
        ...compose,
        'run',
        '--rm',
        '-T',
        '-e',
        `DATABASE_URL=${previousDatabaseUrl}`,
        '-e',
        `CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=${TIMEWEB_EMPTY_DATABASE_MIGRATION_ACK}`,
        'migrator',
      ],
      { environment: previousEnvironment, capture: true },
    );
    if (!previousMigration.includes('Applied '))
      throw new Error('exact previous migrator applied nothing to the isolated empty database');
    run(
      'docker',
      [...compose, 'run', '--rm', '-T', '-e', `DATABASE_URL=${previousDatabaseUrl}`, 'migrator'],
      { environment, capture: true },
    );
    const upgradedPreviousLedger = ledgerSnapshot(compose, environment, 'phub_previous');
    assertSameLedger(upgradedPreviousLedger, candidateLedger, 'previous-to-candidate upgrade');
    const upgradedPreviousNoOp = run(
      'docker',
      [...compose, 'run', '--rm', '-T', '-e', `DATABASE_URL=${previousDatabaseUrl}`, 'migrator'],
      { environment, capture: true },
    );
    if (upgradedPreviousNoOp.includes('Applied '))
      throw new Error('upgraded previous database second migration was not a no-op');
    assertSameLedger(
      ledgerSnapshot(compose, environment, 'phub_previous'),
      candidateLedger,
      'upgraded previous database second no-op',
    );

    run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'api', 'realtime'], {
      environment,
    });
    const runningBeforeWorker = run(
      'docker',
      [...compose, 'ps', '--status', 'running', '--services'],
      {
        environment,
        capture: true,
      },
    )
      .split('\n')
      .filter(Boolean);
    if (runningBeforeWorker.includes('worker')) throw new Error('worker was not default-off');
    process.stdout.write('WORKER_DEFAULT_OFF=PASS\n');

    run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'web', 'proxy'], {
      environment,
    });
    run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180', 'worker'], {
      environment,
    });
    assertRuntimeSnapshot(runtimeSnapshots(compose, environment), {
      releaseId,
      sourceSha,
      sourceTree,
      images: {
        web: images.web!,
        api: images.api!,
        realtime: images.realtime!,
        worker: images.worker!,
      },
    });

    await waitForHttp(() => proxyBaseUrl(compose, environment));
    const baseUrl = proxyBaseUrl(compose, environment);
    if (!options.skipBrowser) {
      const counters = await runTimewebBrowserSmoke(baseUrl);
      for (const [key, value] of Object.entries(counters)) {
        process.stdout.write(`${key}=${value}\n`);
      }
      process.stdout.write('BROWSER_SMOKE=PASS\n');
    } else {
      process.stdout.write('BROWSER_SMOKE=SKIPPED\n');
    }

    const runtimeServices = ['api', 'realtime', 'worker', 'web', 'proxy'] as const;
    const runtimeIds = Object.fromEntries(
      runtimeServices.map((service) => [service, containerId(compose, environment, service)]),
    ) as Record<(typeof runtimeServices)[number], string>;
    const startsBeforeRestart = Object.fromEntries(
      runtimeServices.map((service) => [
        service,
        inspectContainer(runtimeIds[service]).State.StartedAt,
      ]),
    ) as Record<(typeof runtimeServices)[number], string>;
    run('docker', [...compose, 'restart', ...runtimeServices], { environment });
    await Promise.all(runtimeServices.map((service) => waitForHealthy(runtimeIds[service])));
    for (const service of runtimeServices) {
      if (inspectContainer(runtimeIds[service]).State.StartedAt === startsBeforeRestart[service])
        throw new Error(`restart timestamp did not advance for ${service}`);
    }
    await waitForHttp(() => proxyBaseUrl(compose, environment));

    const idsBeforeSecondStart = {
      postgres: containerId(compose, environment, 'postgres'),
      redis: containerId(compose, environment, 'redis'),
      rabbitmq: containerId(compose, environment, 'rabbitmq'),
      api: containerId(compose, environment, 'api'),
      realtime: containerId(compose, environment, 'realtime'),
      worker: containerId(compose, environment, 'worker'),
      web: containerId(compose, environment, 'web'),
      proxy: containerId(compose, environment, 'proxy'),
    };
    run(
      'docker',
      [
        ...compose,
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '180',
        'api',
        'realtime',
        'worker',
        'web',
        'proxy',
      ],
      {
        environment,
      },
    );
    for (const [service, expectedId] of Object.entries(idsBeforeSecondStart)) {
      if (containerId(compose, environment, service) !== expectedId)
        throw new Error(`second start recreated ${service}`);
    }

    run('docker', [...compose, 'stop', '-t', '60', ...runtimeServices], { environment });
    for (const service of runtimeServices) {
      const state = inspectContainer(runtimeIds[service]).State;
      if (state.Running || state.ExitCode !== 0)
        throw new Error(`graceful stop failed for ${service}`);
    }
    run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '180', ...runtimeServices], {
      environment,
    });

    const ledgerBeforeRollback = ledgerSnapshot(compose, environment);
    run('docker', [...compose, 'stop', '-t', '60', 'worker', 'realtime'], { environment });
    const rollbackEnvironment = composeEnvironment({
      project,
      envRoot,
      sourceSha: previousCandidate.sourceSha,
      sourceTree: previousCandidate.sourceTree,
      releaseId: previousReleaseId,
      images: previousImages,
    });
    run(
      'docker',
      [
        ...compose,
        'up',
        '-d',
        '--force-recreate',
        '--no-deps',
        'api',
        'realtime',
        'worker',
        'web',
        'proxy',
      ],
      {
        environment: rollbackEnvironment,
      },
    );
    await Promise.all(
      ['api', 'realtime', 'worker', 'web', 'proxy'].map((service) =>
        waitForHealthy(containerId(compose, rollbackEnvironment, service)),
      ),
    );
    assertRuntimeSnapshot(runtimeSnapshots(compose, rollbackEnvironment), {
      releaseId: previousReleaseId,
      sourceSha: previousCandidate.sourceSha,
      sourceTree: previousCandidate.sourceTree,
      images: {
        web: previousImages.web!,
        api: previousImages.api!,
        realtime: previousImages.realtime!,
        worker: previousImages.worker!,
      },
    });
    assertSameLedger(
      ledgerSnapshot(compose, rollbackEnvironment),
      ledgerBeforeRollback,
      'forward-only application rollback',
    );
    await waitForHttp(() => proxyBaseUrl(compose, rollbackEnvironment));

    process.stdout.write(`CANDIDATE_SOURCE_SHA=${sourceSha}\n`);
    process.stdout.write(`CANDIDATE_SOURCE_TREE=${sourceTree}\n`);
    process.stdout.write('IMMUTABLE_CANDIDATE=VERIFIED_WITH_CALLER_FROZEN_PUBLICATION_EVIDENCE\n');
    process.stdout.write(`PUBLICATION_RUN_ID=${candidate.runId}\n`);
    process.stdout.write(`MANIFEST_SHA256=${candidate.manifestSha256}\n`);
    process.stdout.write(`PREVIOUS_PUBLICATION_RUN_ID=${previousCandidate.runId}\n`);
    process.stdout.write(`PREVIOUS_MANIFEST_SHA256=${previousCandidate.manifestSha256}\n`);
    process.stdout.write('LOCAL_RELEASE_REHEARSAL=PASS\n');
    process.stdout.write('RELEASE_REHEARSAL=PASS\n');
    process.stdout.write('EMPTY_DB=PASS\n');
    process.stdout.write('PREVIOUS_SCHEMA=PASS\n');
    process.stdout.write('SECOND_MIGRATION_NOOP=PASS\n');
    process.stdout.write('MIGRATION_REHEARSAL=PASS_EXACT_PREVIOUS_MIGRATOR\n');
    process.stdout.write('RESTART_REHEARSAL=PASS\n');
    process.stdout.write('RESTART=PASS\n');
    process.stdout.write('SECOND_START_IDEMPOTENCY=PASS\n');
    process.stdout.write('GRACEFUL_STOP=PASS\n');
    process.stdout.write('ROLLBACK_REHEARSAL=PASS\n');
    process.stdout.write('ROLLBACK_BINARIES=PASS_EXACT_PREVIOUS_BINARIES\n');
    process.stdout.write('ROLLBACK_DATABASE_MODE=FORWARD_ONLY\n');
    process.stdout.write(`READ_ONLY_BROWSER_SMOKE=${options.skipBrowser ? 'SKIPPED' : 'PASS'}\n`);
    process.stdout.write('ONE_COMMAND_SMOKE=PASS\n');
    process.stdout.write(
      `ONE_COMMAND_GATE=${options.skipBrowser ? 'INCOMPLETE_BROWSER_SKIPPED' : 'READY'}\n`,
    );
    process.stdout.write('BROWSER_SMOKE_AUTOMATION=READY\n');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (cleanupCompose && cleanupEnvironment) {
        run(
          'docker',
          [...cleanupCompose, 'down', '--volumes', '--remove-orphans', '--timeout', '60'],
          { environment: cleanupEnvironment },
        );
      }
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error('unknown rehearsal cleanup failure');
      if (primaryFailure) {
        process.stderr.write(`TIMEWEB_REHEARSAL_CLEANUP_WARNING=${normalizedError.message}\n`);
      } else {
        cleanupFailure = normalizedError;
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}

if (process.argv[1]?.endsWith('/test-timeweb-beta-candidate.ts')) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`TIMEWEB_BETA_CANDIDATE=FAIL|reason=${message.replaceAll('\n', ' ')}\n`);
    process.exitCode = 1;
  });
}
