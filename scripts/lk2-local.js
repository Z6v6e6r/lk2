import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const label = 'dev.padlhub.worktree';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => {
  throw new Error(message);
};
export function atomicPrivateFile(path, content) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
export const atomicJson = (path, value) => atomicPrivateFile(path, JSON.stringify(value, null, 2));
export function finishOperation(guard, uncertain) {
  if (!uncertain) rmSync(guard, { recursive: true });
  else
    console.error(
      'Docker operation ended without confirmed completion; operation.lock is retained. Inspect owned containers and active CLI before manual recovery.',
    );
}
export function assertPrivatePath(path, directory = false) {
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (!directory && info.nlink !== 1)
  )
    fail('Local state custody requires owned private regular files and directories.');
}
export const uncertainCompletion = (result) =>
  Boolean(
    result.signal ||
    result.error?.code === 'ETIMEDOUT' ||
    (!result.error && result.status === null),
  );
export function assertResumeVolumes(expected, observed) {
  if (!Array.isArray(expected) || !expected.length) fail('Missing persistent-volume receipt.');
  for (const saved of expected) {
    const found = observed.find((item) => item.Name === saved.name);
    if (
      !found ||
      found.CreatedAt !== saved.createdAt ||
      found.Labels?.['dev.padlhub.volume-id'] !== saved.identity
    )
      fail(`Persistent volume missing or replaced: ${saved.name}. Refusing recreation.`);
  }
}
export function previewReady(containers, initialized) {
  return (
    initialized === true &&
    ['postgres', 'redis', 'api', 'web'].every((service) => {
      const matches = containers.filter(
        (item) => item.Config?.Labels?.['com.docker.compose.service'] === service,
      );
      return (
        matches.length === 1 &&
        matches[0].State?.Running === true &&
        matches[0].State?.Health?.Status === 'healthy'
      );
    })
  );
}
export const projectFor = (root) => `lk2-local-${hash(root).slice(0, 12)}`;
export function validateEndpoint(context, endpoint) {
  const allowed =
    (context === 'default' && endpoint === 'unix:///var/run/docker.sock') ||
    (context === 'desktop-linux' &&
      endpoint === `unix://${process.env.HOME}/.docker/run/docker.sock`);
  if (!allowed)
    fail(
      'Docker context/endpoint is remote or unknown; select a verified local default or desktop-linux context explicitly.',
    );
}
export function assertOwned(items, root, project, kind) {
  for (const item of items) {
    const labels = item.Labels ?? item.Config?.Labels ?? {};
    if (labels[label] !== root || labels['com.docker.compose.project'] !== project) {
      fail(`Ownership conflict (${kind}): ${item.Name ?? item.Id}. No resources changed.`);
    }
  }
}
const localEnv = {
  APP_ENV: 'local',
  NODE_ENV: 'development',
  VIVA_MODE: 'mock',
  HOME_READ_MODE: 'mock',
  COMMUNITIES_READ_MODE: 'mock',
  PROMOTIONS_READ_MODE: 'mock',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://phub:local-synthetic-only@postgres:5432/phub',
  REDIS_URL: 'redis://redis:6379',
  RABBITMQ_URL: 'amqp://unused:unused@127.0.0.1:5672',
  JWT_AUDIENCE: 'phub-api',
  AUTH_COOKIE_SECURE: 'false',
  AUTH_DEV_PHONE_E164: '+79990000001',
  AUTH_DEV_OTP_CODE: '0000',
  PHUB_DEV_API_PROXY_TARGET: 'http://api:3000',
  PHUB_DEV_REALTIME_PROXY_TARGET: 'ws://127.0.0.1:3001',
};

// Derive the minimal API/Web contour from the canonical development Compose, not deploy files.
export function makeModel(base, root, nodeImage, lock, environment = localEnv) {
  const project = projectFor(root);
  const labels = { [label]: root };
  const volumes = {
    postgres_data: { labels },
    redis_data: { labels },
    workspace_node_modules: { labels },
  };
  const mounts = [
    `${root}:/workspace`,
    'workspace_node_modules:/workspace/node_modules',
    `${root}/.lk2-local/local.env:/workspace/.env:ro`,
    `${root}/.lk2-local/mask:/workspace/.lk2-local:ro`,
  ];
  const nested = new Set(
    Object.keys(lock.packages).flatMap((key) => {
      const match = /^(apps\/[^/]+|packages\/[^/]+)\/node_modules\//.exec(key);
      return match ? [match[1]] : [];
    }),
  );
  for (const path of nested) {
    const name = `modules_${path.replaceAll('/', '_').replaceAll('-', '_')}`;
    volumes[name] = { labels };
    mounts.push(`${name}:/workspace/${path}/node_modules`);
  }
  const nodeService = (service) => {
    const { command, healthcheck } = base.services[service];
    return {
      image: nodeImage,
      working_dir: '/workspace',
      command,
      ...(healthcheck ? { healthcheck } : {}),
      environment,
      volumes: mounts,
      networks: ['data'],
      labels,
      restart: 'no',
    };
  };
  const postgres = structuredClone(base.services.postgres);
  postgres.environment = {
    POSTGRES_DB: 'phub',
    POSTGRES_USER: 'phub',
    POSTGRES_PASSWORD: 'local-synthetic-only',
  };
  postgres.healthcheck.test = ['CMD', 'pg_isready', '-U', 'phub', '-d', 'phub'];
  const redis = structuredClone(base.services.redis);
  for (const service of [postgres, redis]) {
    service.ports = [];
    service.labels = labels;
    service.restart = 'no';
  }
  const api = nodeService('api');
  api.depends_on = base.services.api.depends_on;
  const web = nodeService('web');
  web.environment = {
    NODE_ENV: 'development',
    PHUB_DEV_API_PROXY_TARGET: 'http://api:3000',
    PHUB_DEV_REALTIME_PROXY_TARGET: 'ws://127.0.0.1:3001',
  };
  web.ports = ['127.0.0.1:5173:5173'];
  web.networks = ['data', 'edge'];
  web.healthcheck = {
    test: [
      'CMD',
      'node',
      '-e',
      "fetch('http://127.0.0.1:5173').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ],
    interval: '5s',
    timeout: '3s',
    retries: 12,
  };
  const setup = nodeService('migrator');
  setup.environment = { NODE_ENV: 'development' };
  setup.networks = ['install'];
  setup.profiles = ['tools'];
  delete setup.healthcheck;
  const migrator = nodeService('migrator');
  migrator.profiles = ['tools'];
  migrator.environment = {
    DATABASE_URL: localEnv.DATABASE_URL,
    CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
  };
  return {
    name: project,
    services: { postgres, redis, api, web, setup, migrator },
    networks: { data: { internal: true, labels }, install: { labels }, edge: { labels } },
    volumes,
  };
}

async function previewResponds() {
  try {
    return (await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}
async function portFree(port) {
  await new Promise((yes, no) => {
    const server = createServer();
    server.once('error', () =>
      no(
        new Error(
          `Preview port ${port} is occupied or unavailable; the existing preview is untouched.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(yes));
  });
}

export async function main(args = process.argv.slice(2)) {
  const [action, flag] = args;
  if (
    !['up', 'status', 'stop', 'config'].includes(action) ||
    args.length > 2 ||
    (flag && (action !== 'up' || flag !== '--fresh-db'))
  ) {
    fail(
      'Usage: npm run local:{up,status,stop,config}; first start: npm run local:up -- --fresh-db',
    );
  }
  const root = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));
  const dir = resolve(root, '.lk2-local');
  const statePath = resolve(dir, 'state.json');
  const project = projectFor(root);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    COMPOSE_DISABLE_ENV_FILE: '1',
  };
  let operationUncertain = false;
  const run = (bin, argv, options = {}) => {
    const result = spawnSync(bin, argv, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    if (uncertainCompletion(result)) operationUncertain = true;
    if (result.error || result.status !== 0)
      fail(
        `${bin} ${argv.slice(0, 3).join(' ')} failed (${result.error?.code ?? result.status}); output withheld to protect environment values.`,
      );
    return result.stdout?.trim() ?? '';
  };
  if (
    Object.keys(process.env).some(
      (key) => key.startsWith('DOCKER_') && key !== 'DOCKER_CONTEXT' && process.env[key],
    )
  )
    fail('Ambient DOCKER_* override is unsupported; clear it before using the local launcher.');
  const context = process.env.DOCKER_CONTEXT || run('docker', ['context', 'show']);
  const endpoint = JSON.parse(run('docker', ['context', 'inspect', context]))[0]?.Endpoints?.docker
    ?.Host;
  validateEndpoint(context, endpoint);
  const docker = (argv, options) => run('docker', ['--host', endpoint, ...argv], options);
  console.log(
    `LOCAL Docker context=${context} endpoint=${endpoint}; worktree=${root}; project=${project}`,
  );
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
  if (!info.ID || info.OSType !== 'linux')
    fail('A reachable local Linux Docker engine is required.');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (
    state &&
    (state.root !== root ||
      state.project !== project ||
      state.daemon !== info.ID ||
      state.endpoint !== endpoint)
  )
    fail('Local state belongs to another worktree or Docker engine.');
  const inspect = (kind, ids) => (ids.length ? JSON.parse(docker([kind, 'inspect', ...ids])) : []);
  const ids = (kind, filter) =>
    docker([kind, 'ls', '-q', '--filter', filter]).split(/\s+/).filter(Boolean);
  const containers = inspect(
    'container',
    docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
      .split(/\s+/)
      .filter(Boolean),
  );
  const resources = [
    ...containers,
    ...inspect('volume', ids('volume', `label=com.docker.compose.project=${project}`)),
    ...inspect('network', ids('network', `label=com.docker.compose.project=${project}`)),
  ];
  assertOwned(resources, root, project, 'project resource');
  if (!state && resources.length)
    fail('Resources exist without a local ownership receipt; refusing adoption.');
  if (action === 'status') {
    if (state?.initialized) {
      if (state.branch !== run('git', ['branch', '--show-current']))
        fail('Preview task branch does not match its retained database.');
      assertResumeVolumes(state.volumes, resources);
    }
    for (const item of containers)
      console.log(`${item.Name}: ${item.State.Status} ${item.State.Health?.Status ?? ''}`);
    console.log(
      previewReady(containers, state?.initialized) && (await previewResponds())
        ? 'Preview: http://127.0.0.1:5173 (LOCAL mock)'
        : 'Preview is not ready.',
    );
    return;
  }
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()))
    fail('Local state path must be a real directory.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivatePath(dir, true);
  const guard = resolve(dir, 'operation.lock');
  try {
    mkdirSync(guard);
  } catch {
    fail(
      'Another local operation is active (operation.lock); inspect its owner before manual recovery.',
    );
  }
  try {
    if (action === 'stop') {
      if (containers.length) docker(['stop', ...containers.map((item) => item.Id)]);
      console.log('Owned containers stopped. All volumes and database contents preserved.');
      return;
    }
    const branch = run('git', ['branch', '--show-current']);
    if (state?.initialized && state.branch !== branch)
      fail('The retained database belongs to another task branch.');
    if (!/^(codex|agent)\//.test(branch))
      fail('Use your dedicated codex/* or agent/* task branch.');
    for (const app of ['web', 'api']) {
      if (readdirSync(resolve(root, 'apps', app)).some((name) => /^\.env(?:\.|$)/.test(name)))
        fail(
          `apps/${app}/.env* exists; review its local configuration before using this isolated launcher.`,
        );
    }
    const lockBytes = readFileSync(resolve(root, 'package-lock.json'), 'utf8');
    const lock = JSON.parse(lockBytes);
    const base = parse(readFileSync(resolve(root, 'compose.yaml'), 'utf8'));
    const nodeImage = /^FROM (\S+)$/m.exec(
      readFileSync(resolve(root, 'infra/docker/Dockerfile.dev'), 'utf8'),
    )?.[1];
    if (!nodeImage?.startsWith('node:') || nodeImage.endsWith(':latest'))
      fail('Unsupported development Node image.');
    const credentialsPath = resolve(dir, 'credentials.json');
    if (!existsSync(credentialsPath))
      atomicJson(credentialsPath, {
        access: randomBytes(32).toString('hex'),
        refresh: randomBytes(32).toString('hex'),
      });
    assertPrivatePath(credentialsPath);
    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    if (
      ![credentials.access, credentials.refresh].every(
        (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
      )
    )
      fail('Invalid local credentials.');
    const environment = {
      ...localEnv,
      JWT_ISSUER: project,
      JWT_ACCESS_SECRET: credentials.access,
      JWT_REFRESH_SECRET: credentials.refresh,
    };
    const model = makeModel(base, root, nodeImage, lock, environment);
    if (state?.initialized) assertResumeVolumes(state.volumes, resources);
    for (const kind of ['volume', 'network']) {
      for (const name of Object.keys(model[`${kind}s`])) {
        const found = ids(kind, `name=^${project}_${name}$`);
        const items = inspect(kind, found);
        assertOwned(items, root, project, kind);
        if (!state && items.length) fail(`Existing ${kind} conflicts with a fresh environment.`);
      }
    }
    const migrationHash = hash(
      readdirSync(resolve(root, 'packages/database/migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map(
          (name) =>
            name + readFileSync(resolve(root, 'packages/database/migrations', name), 'utf8'),
        )
        .join('\n'),
    );
    const configFile = resolve(dir, 'compose.json');
    mkdirSync(resolve(dir, 'mask'), { recursive: true, mode: 0o700 });
    if (
      lstatSync(resolve(dir, 'mask')).isSymbolicLink() ||
      readdirSync(resolve(dir, 'mask')).length
    )
      fail('Local state mask must be an empty real directory.');
    atomicPrivateFile(
      resolve(dir, 'local.env'),
      '# Local launcher: configuration is provided per service.\n',
    );
    atomicJson(configFile, model);
    const compose = (argv, options) =>
      docker(
        [
          'compose',
          '--project-directory',
          root,
          '--env-file',
          resolve(dir, 'local.env'),
          '-p',
          project,
          '-f',
          configFile,
          ...argv,
        ],
        options,
      );
    compose(['config', '--quiet']);
    if (action === 'config') {
      console.log('Derived local Compose is valid; no containers started.');
      return;
    }
    if (containers.some((item) => item.State.Running))
      fail(
        'This preview is already running or partially started. Use local:status, then local:stop before restarting.',
      );
    const fresh = !state?.initialized;
    const databaseExists = resources.some(
      (item) =>
        item.Name === `${project}_postgres_data` ||
        item.Config?.Labels?.['com.docker.compose.service'] === 'postgres',
    );
    if (fresh && flag !== '--fresh-db')
      fail('First start requires explicit --fresh-db for a new disposable local database.');
    if (flag && (!fresh || databaseExists))
      fail('--fresh-db cannot migrate or reset an existing database.');
    if (state && ((!state.initialized && databaseExists) || state.migrationHash !== migrationHash))
      fail(
        'Database initialization is incomplete or migrations changed; preserve this DB and use a new task worktree for an explicitly approved fresh rehearsal.',
      );
    // No infrastructure ports are published. All worktrees deliberately share one preview port.
    const published = docker(['ps', '--format', '{{json .}}'])
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (published.some((item) => /(?:^|[, :])5173->/.test(item.Ports)))
      fail('Preview port 5173 belongs to an existing Docker container; no resources changed.');
    await portFree(5173);
    const receipt = state ?? {
      root,
      project,
      endpoint,
      daemon: info.ID,
      initialized: false,
      migrationHash,
    };
    receipt.branch = branch;
    receipt.volumeIdentity ??= randomBytes(16).toString('hex');
    for (const volume of Object.values(model.volumes))
      volume.labels['dev.padlhub.volume-id'] = receipt.volumeIdentity;
    atomicJson(configFile, model);
    atomicJson(statePath, receipt);
    if (receipt.lockHash !== hash(lockBytes)) {
      console.log('LOCAL: installing locked dependencies into owned module volumes.');
      compose(['run', '--rm', '--no-deps', 'setup', 'npm', 'ci', '--no-audit', '--no-fund'], {
        timeout: 600_000,
      });
      compose(['run', '--rm', '--no-deps', 'setup', 'npm', 'run', 'contracts:generate']);
      receipt.lockHash = hash(lockBytes);
      atomicJson(statePath, receipt);
    }
    console.log('LOCAL: starting owned PostgreSQL/Redis and waiting for readiness.');
    compose(['up', '-d', '--wait', '--wait-timeout', '90', 'postgres', 'redis']);
    if (fresh) {
      const empty = compose([
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'phub',
        '-d',
        'phub',
        '-Atc',
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')",
      ]);
      if (empty !== '0') fail('New database is not empty; refusing migrations.');
      console.log('LOCAL: applying migrations only to the verified new empty database.');
      compose(['run', '--rm', '--no-deps', 'migrator'], { timeout: 300_000 });
      receipt.volumes = inspect(
        'volume',
        ids('volume', `label=com.docker.compose.project=${project}`),
      ).map((item) => ({
        name: item.Name,
        createdAt: item.CreatedAt,
        identity: item.Labels['dev.padlhub.volume-id'],
      }));
      receipt.initialized = true;
      atomicJson(statePath, receipt);
    }
    console.log('LOCAL: starting current-task API/Web and waiting for readiness.');
    compose(['up', '-d', '--wait', '--wait-timeout', '120', 'api', 'web'], { timeout: 150_000 });
    if (!(await previewResponds()))
      fail('Services are healthy internally but the host preview is unreachable.');
    console.log(
      `Preview: http://127.0.0.1:5173 (LOCAL mock, source ${branch}@${run('git', ['rev-parse', 'HEAD'])}).`,
    );
    console.log(
      'Only API/Web, PostgreSQL and Redis run. Worker, Realtime, provider calls and release operations are outside this contour.',
    );
  } finally {
    finishOperation(guard, operationUncertain);
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
