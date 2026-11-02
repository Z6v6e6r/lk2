import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

// These are existing suites, not a replacement acceptance model. Enumeration changes
// require a deliberate update here so a newly skipped/missing case cannot pass CI.
export const suites = [
  {
    id: 'lifecycle',
    resource: 'postgres',
    file: 'apps/api/src/games/game-lifecycle-http-postgres.test.ts',
    env: 'GAME_LIFECYCLE_HTTP_TEST_DATABASE_URL',
    physical: 'FREE/LOCAL game lifecycle through HTTP and PostgreSQL',
    guard: 'game lifecycle PostgreSQL verifier guard',
    cases: [
      'creates durably, replays the exact command, and rejects invalid or changed-key requests',
      'rolls back every create side effect when the transactional outbox write fails',
      'enforces join revisions, retries, permission and actor-scoped operation readback',
      ...['SPLIT', 'SUBSCRIPTION'].map(
        (mode) => `fails closed concurrent ${mode} joins before every paid reservation side effect`,
      ),
      'serializes two HTTP joins for the final free seat without overflow or duplicates',
      'serializes same-user concurrent joins without duplicate membership',
      'serializes join versus cancel into one durable order without post-cancel admission',
      'proves both serialized join-before-cancel and cancel-before-join orders',
      'serializes waitlist promotion versus cancel and makes post-cancel promotion a no-op',
      'proves both serialized promotion-before-cancel and cancel-before-promotion orders',
      'rejects cancellation after start and from a finished terminal state',
      'advertises local CANCEL only from the same tenant and canonical projection revision',
      'leaves and cancels with idempotent terminal state and owner-only authorization',
    ],
    guards: [
      'accepts a query-free loopback disposable database URL',
      ...[
        'https://127.0.0.1/lifecycle_verify',
        'postgresql://verify@127.0.0.1/lifecycle_verify?host=database.example',
        'postgresql://verify@127.0.0.1/lifecycle_verify#override',
        'postgresql://verify@database.example/lifecycle_verify',
        'postgresql://verify@127.0.0.1/lifecycle',
      ].map((url) => `rejects unsafe verifier URL ${url}`),
    ],
  },
  {
    id: 'comms',
    resource: 'postgres',
    file: 'apps/worker/src/game-comms-integration-postgres.test.ts',
    env: 'GAME_COMMS_INTEGRATION_TEST_DATABASE_URL',
    physical: 'GAME lifecycle -> notification -> chat real PostgreSQL integration',
    guard: 'GAME communications PostgreSQL verifier guard',
    cases: [
      'JOIN reads its canonical outbox event, projects exactly once on replay, and grants GAME chat',
      'LEAVE projects its canonical event and denies every effective chat surface despite stale member storage',
      'CANCEL projects its canonical event, rejects new/replayed GAME chat, and leaves no effective authorization',
      'projects the current rejoined roster when an older leave event arrives late',
      ...['leave', 'cancel'].flatMap((transition) => [
        `physically serializes real ${transition} vs send without deadlock or post-transition message`,
        `serializes a real ${transition} that already changed GAME before a waiting send`,
        `preserves a send committed before ${transition} and converges all later access`,
      ]),
    ],
    guards: ['accepts only a query-free loopback disposable database URL'],
  },
  {
    id: 'rabbit',
    resource: 'rabbit',
    file: 'apps/worker/src/game-messaging-membership-rabbitmq.test.ts',
    env: 'GAME_MESSAGING_MEMBERSHIP_TEST_RABBITMQ_URL',
    physical: 'GAME messaging membership RabbitMQ physical resilience',
    guard: 'GAME messaging RabbitMQ verifier guard',
    cases: [
      'routes every exact catalog event to the registered consumer and ACKs success',
      'dead-letters poison contracts without a repository call',
      'bounds transient retry into the DLQ through quorum delivery-limit',
      'redelivers after channel loss and accepts the idempotent no-op replay',
    ],
    guards: ['accepts only a query-free loopback disposable vhost'],
  },
  {
    id: 'notification_pg',
    resource: 'postgres',
    file: 'apps/worker/src/notification-resilience-postgres.test.ts',
    env: 'NOTIFICATION_RESILIENCE_TEST_DATABASE_URL',
    physical: 'GAME notification real PostgreSQL resilience',
    guard: '',
    cases: [
      'applies the exact same event 2, 10 and 100 times without duplicate projection',
      'suppresses an old event after a newer projection and rolls back a failed projection for replay',
      'serializes two projector processes and keeps recipients and tenants isolated',
      'keeps the first multi-tab read cursor monotonic and a later arrival unread',
    ],
    guards: [],
  },
  {
    id: 'notification_rabbit',
    resource: 'rabbit',
    file: 'apps/worker/src/notification-resilience-rabbitmq.test.ts',
    env: 'NOTIFICATION_RESILIENCE_TEST_RABBITMQ_URL',
    physical: 'notification RabbitMQ physical resilience',
    guard: '',
    cases: [
      'recreates required queues and provisions the exact topology twice',
      'rejects wrong queue arguments and wrong DLX instead of silently accepting drift',
      'redelivers an unacked delivery after worker loss',
      'bounds retry into DLQ and supports an explicit replay fixture',
    ],
    guards: [],
  },
] as const;
type Suite = (typeof suites)[number];
type Environment = NodeJS.ProcessEnv;
function fail(reason: string): never {
  throw new Error(`REQUIRED_GAME_CI_${reason}`);
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('INVALID_OBJECT');

export function validateContext(env: Environment): {
  postgres: string;
  rabbit: string;
  container: string;
  marker: string;
} {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'Z6v6e6r/lk2' ||
    env.GITHUB_JOB !== 'quality-full' ||
    env.APP_ENV !== 'ci' ||
    env.VIVA_MODE !== 'mock' ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^[a-f0-9]{64}$/.test(env.CI_GAME_RABBIT_CONTAINER ?? '')
  )
    fail('UNSAFE_CONTEXT');
  // Never inherit alternate endpoints/options or fixture targets from the caller.
  if (
    Object.keys(env).some(
      (key) => /^(PG|DOCKER_|GAME_.*TEST_|NOTIFICATION_RESILIENCE_TEST_)/.test(key) && env[key],
    )
  )
    fail('AMBIENT_OVERRIDE');
  const endpoint = (
    raw: string | undefined,
    protocol: string,
    port: string,
    user: string,
    password: string,
    path: string,
  ) => {
    const url = new URL(raw ?? '');
    if (
      url.protocol !== protocol ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== port ||
      url.username !== user ||
      url.password !== password ||
      url.pathname !== path ||
      url.search ||
      url.hash
    )
      fail('UNSAFE_ENDPOINT');
    url.hostname = '127.0.0.1';
    return url.toString();
  };
  return {
    postgres: endpoint(env.DATABASE_URL, 'postgresql:', '5432', 'phub', 'ci-password', '/phub'),
    rabbit: endpoint(env.RABBITMQ_URL, 'amqp:', '5672', 'guest', 'guest', ''),
    container: env.CI_GAME_RABBIT_CONTAINER!,
    marker: `lk2_game_${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}`,
  };
}

export function fixtureName(nonce: string, id: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce) || !suites.some((suite) => suite.id === id))
    fail('UNSAFE_IDENTIFIER');
  return `lk2_${nonce}_${id}_verify`;
}

export function verifyReport(raw: string, suite: Suite, cwd: string, startedAt: number): void {
  const report = object(JSON.parse(raw));
  const total = suite.cases.length + suite.guards.length;
  if (
    report.success !== true ||
    report.numTotalTests !== total ||
    report.numPassedTests !== total ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    typeof report.startTime !== 'number' ||
    report.startTime < startedAt ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  )
    fail('REPORT_SUMMARY');
  const result = object(report.testResults[0]);
  if (
    result.name !== resolve(cwd, suite.file) ||
    result.status !== 'passed' ||
    result.message !== '' ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length !== total
  )
    fail('REPORT_FILE');
  const expected = new Set([
    ...suite.cases.map((title) => `${suite.physical}\n${title}`),
    ...suite.guards.map((title) => `${suite.guard}\n${title}`),
  ]);
  for (const rawAssertion of result.assertionResults) {
    const assertion = object(rawAssertion);
    const ancestors = assertion.ancestorTitles;
    if (
      !Array.isArray(ancestors) ||
      ancestors.length !== 1 ||
      typeof assertion.title !== 'string' ||
      assertion.status !== 'passed' ||
      !Array.isArray(assertion.failureMessages) ||
      assertion.failureMessages.length ||
      typeof assertion.duration !== 'number' ||
      assertion.duration < 0 ||
      assertion.fullName !== `${ancestors[0]} ${assertion.title}` ||
      !expected.delete(`${ancestors[0]}\n${assertion.title}`)
    )
      fail('REPORT_ENUMERATION');
  }
  if (expected.size) fail('REPORT_MISSING_CASE');
}

export interface CommandResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr?: string;
  orphaned?: boolean;
}
export type Command = (
  args: readonly string[],
  env: Environment,
  timeout: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

class UnconfirmedProcessGroup extends Error {
  constructor() {
    super('REQUIRED_GAME_CI_PROCESS_GROUP_UNCONFIRMED');
  }
}

export function hasLiveGroupMembers(snapshot: string, pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new UnconfirmedProcessGroup();
  const rows = snapshot
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*([0-9]+)\s+([A-Za-z][^\s]*)\s*$/.exec(line);
      if (!match) throw new UnconfirmedProcessGroup();
      return { group: Number(match[1]), state: match[2]! };
    });
  // Linux orphan zombies can remain visible until PID1 reaps them. They cannot
  // execute or reconnect; kill(0) alone would misclassify them as live workers.
  return rows.some((row) => row.group === pgid && !/^[ZX]/.test(row.state));
}

export function ownedGroupIsLive(pgid: number): boolean {
  const snapshot = spawnSync('ps', ['-eo', 'pgid=,stat='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1_000_000,
  });
  if (snapshot.error || snapshot.status !== 0 || !snapshot.stdout.trim())
    throw new UnconfirmedProcessGroup();
  return hasLiveGroupMembers(snapshot.stdout, pgid);
}

// Every process has its own process group. Timeout/cancellation never targets another
// suite or service. Resolve only after close; cleanup cannot race a live child.
export const command: Command = (args, env, timeout, signal) =>
  new Promise((resolveResult, reject) => {
    if (signal?.aborted) {
      reject(new Error('REQUIRED_GAME_CI_ABORTED'));
      return;
    }
    const child = spawn(args[0]!, args.slice(1), {
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let processError: Error | undefined;
    let timedOut = false;
    let overflow = false;
    let stoppedAt: number | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (force: boolean) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          processError = error instanceof Error ? error : new Error('Child termination failed');
      }
    };
    const stop = () => {
      if (killTimer) return;
      stoppedAt = Date.now();
      kill(false);
      killTimer = setTimeout(() => kill(true), 3000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    const collect = (data: Buffer) => {
      if (stdout.length + data.length > 2_000_000) {
        overflow = true;
        stop();
      } else stdout += data.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length + data.length > 2_000_000) {
        overflow = true;
        stop();
      } else stderr += data.toString();
    });
    // Even a process error must observe close before cleanup may proceed.
    child.on('error', (error) => {
      processError = error;
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      // close only covers the direct child and its stdio. Fence the retained,
      // task-created PGID as well, including descendants with ignored stdio.
      const finish = async () => {
        let orphaned = false;
        if (child.pid && ownedGroupIsLive(child.pid)) {
          orphaned = stoppedAt === undefined;
          stop();
          const deadline = stoppedAt! + 5000;
          while (ownedGroupIsLive(child.pid)) {
            if (Date.now() >= deadline) throw new UnconfirmedProcessGroup();
            await new Promise<void>((done) => setTimeout(done, 100));
          }
        }
        if (processError) throw processError;
        return {
          code,
          signal: exitSignal,
          timedOut: timedOut || overflow || signal?.aborted === true,
          stdout,
          stderr,
          orphaned,
        };
      };
      void finish()
        .then(resolveResult, reject)
        .finally(() => {
          if (killTimer) clearTimeout(killTimer);
        });
    });
  });

export function requireSuccess(result: CommandResult): void {
  if (result.code !== 0 || result.signal !== null || result.timedOut || result.orphaned)
    fail('CHILD_FAILED');
}

interface DatabaseIdentity {
  name: string;
  oid: number;
  owner: string;
  marker: string | null;
}
export function requireDatabaseOwnership(
  actual: DatabaseIdentity | undefined,
  expected: DatabaseIdentity | undefined,
): void {
  if (
    !actual ||
    !expected ||
    !/^[a-f0-9]{32}$/.test(expected.name.split('_')[1] ?? '') ||
    !/^lk2_[a-f0-9]{32}_(lifecycle|comms|notification_pg)_verify$/.test(expected.name) ||
    !/^lk2_game_[0-9]+_[0-9]+_[a-f0-9]{32}$/.test(expected.marker ?? '') ||
    expected.owner !== 'phub' ||
    !Number.isSafeInteger(expected.oid) ||
    expected.oid <= 0 ||
    actual.name !== expected.name ||
    actual.oid !== expected.oid ||
    actual.owner !== expected.owner ||
    actual.marker !== expected.marker
  )
    fail('DATABASE_OWNERSHIP_LOST');
}

export function requireRabbitService(raw: string, container: string): void {
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length !== 1) fail('SERVICE_IDENTITY');
  const row = object(rows[0]);
  const config = object(row.Config);
  const state = object(row.State);
  const bindings = object(object(row.NetworkSettings).Ports)['5672/tcp'];
  if (
    row.Id !== container ||
    config.Image !== 'rabbitmq:4-alpine' ||
    state.Running !== true ||
    !Array.isArray(bindings) ||
    !bindings.length ||
    bindings.some((binding) => object(binding).HostPort !== '5672')
  )
    fail('SERVICE_IDENTITY');
}

export function requireVhostOwnership(
  rows: unknown,
  name: string,
  marker: string,
  acknowledged: boolean,
): void {
  if (
    !/^lk2_[a-f0-9]{32}_(rabbit|notification_rabbit)_verify$/.test(name) ||
    !/^lk2_game_[0-9]+_[0-9]+_[a-f0-9]{32}$/.test(marker) ||
    !acknowledged ||
    !Array.isArray(rows)
  )
    fail('VHOST_OWNERSHIP_LOST');
  const matching = rows.map(object).filter((row) => row.name === name);
  if (matching.length !== 1 || matching[0]?.description !== marker) fail('VHOST_OWNERSHIP_LOST');
}

export async function withCleanup(
  body: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await body();
  } catch (error) {
    // A surviving or uninspectable owned group may reconnect after an idle
    // snapshot. Retain the fixture rather than attempting cleanup in that case.
    if (error instanceof UnconfirmedProcessGroup) throw error;
    failures.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, 'REQUIRED_GAME_CI_FAILED_OR_CLEANUP_REFUSED');
}

export async function waitIdle(
  readCount: () => Promise<number>,
  pause = () => new Promise<void>((done) => setTimeout(done, 500)),
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const count = await readCount();
    if (!Number.isSafeInteger(count) || count < 0) fail('INVALID_CLIENT_COUNT');
    if (count === 0) return;
    await pause();
  }
  fail('ACTIVE_CLIENTS_RETAIN_FIXTURE');
}

export function failureCodes(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(failureCodes);
  if (error instanceof Error && /^REQUIRED_GAME_CI_[A-Z_]+$/.test(error.message))
    return [error.message];
  return ['REQUIRED_GAME_CI_UNEXPECTED_ERROR'];
}

export async function main(
  env: Environment = process.env,
  execute: Command = command,
): Promise<void> {
  const context = validateContext(env); // Before any connection, Docker call or fixture write.
  const nonce = randomBytes(16).toString('hex');
  const marker = `${context.marker}_${nonce}`;
  const artifact = resolve('.ci-artifacts/required-game', nonce);
  await mkdir(resolve('.ci-artifacts/required-game'), { recursive: true });
  await mkdir(artifact, { recursive: false });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  const journal: unknown[] = [];
  const record = async (entry: unknown) => {
    journal.push(entry);
    await writeFile(resolve(artifact, 'ownership.json'), JSON.stringify(journal, null, 2));
  };
  const run = async (args: string[], childEnv = env, timeout = 30_000, cleanup = false) => {
    const result = await execute(args, childEnv, timeout, cleanup ? undefined : controller.signal);
    await record({
      command: args[0] === 'docker' ? 'docker-service-command' : args[1],
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      orphaned: result.orphaned ?? false,
    });
    if (result.code !== 0 || result.timedOut || result.signal) {
      const redacted = `${result.stdout}\n${result.stderr ?? ''}`.replace(
        /\b(?:postgres(?:ql)?|amqps?):\/\/[^\s]+/gi,
        '[fixture endpoint redacted]',
      );
      await writeFile(resolve(artifact, `failed-command-${journal.length}.log`), redacted);
    }
    requireSuccess(result);
    return result.stdout;
  };
  const docker = (args: string[], cleanup = false) =>
    run(['docker', ...args], env, 20_000, cleanup);
  const service = async (cleanup = false) =>
    requireRabbitService(await docker(['inspect', context.container], cleanup), context.container);
  const rabbit = (args: string[], cleanup = false) =>
    docker(
      ['exec', context.container, 'rabbitmqctl', '--quiet', '--timeout', '10', ...args],
      cleanup,
    );
  const vhosts = async (cleanup = false): Promise<unknown> =>
    JSON.parse(
      await rabbit(['list_vhosts', 'name', 'description', '--formatter', 'json'], cleanup),
    );
  const test = async (suite: Suite, url: string) => {
    const report = resolve(artifact, `${suite.id}.json`);
    const startedAt = Date.now();
    const childEnv = { ...env, [suite.env]: url };
    await run(
      [
        process.execPath,
        'node_modules/vitest/vitest.mjs',
        'run',
        suite.file,
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      childEnv,
      120_000,
    );
    verifyReport(await readFile(report, 'utf8'), suite, process.cwd(), startedAt);
    await record({
      suite: suite.id,
      physicalPassed: suite.cases.length,
      guardsPassed: suite.guards.length,
      skipped: 0,
    });
    console.log(
      `REQUIRED_GAME_CI ${suite.id}: ${suite.cases.length} physical + ${suite.guards.length} guard cases PASSED, zero skipped`,
    );
  };
  let pool: Pool | undefined;
  try {
    await service();
    pool = new Pool({
      connectionString: context.postgres,
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
    const admin = pool;
    const server = await admin.query<{ database: string; owner: string; port: number }>(
      'select current_database() as database, current_user as owner, inet_server_port() as port',
    );
    if (
      server.rows[0]?.database !== 'phub' ||
      server.rows[0]?.owner !== 'phub' ||
      server.rows[0]?.port !== 5432
    )
      fail('DATABASE_SERVER');
    for (const suite of suites) {
      controller.signal.throwIfAborted();
      const name = fixtureName(nonce, suite.id);
      await record({ suite: suite.id, name, marker, phase: 'planned' });
      if (suite.resource === 'rabbit') {
        let attempted = false;
        let acknowledged = false;
        await withCleanup(
          async () => {
            await service();
            const before = await vhosts();
            if (!Array.isArray(before) || before.map(object).some((row) => row.name === name))
              fail('VHOST_ALREADY_EXISTS');
            controller.signal.throwIfAborted();
            attempted = true;
            await rabbit(['add_vhost', name, '--description', marker]);
            acknowledged = true;
            requireVhostOwnership(await vhosts(), name, marker, acknowledged);
            await rabbit(['set_permissions', '-p', name, 'guest', '.*', '.*', '.*']);
            const url = new URL(context.rabbit);
            url.pathname = `/${name}`;
            await test(suite, url.toString());
          },
          async () => {
            if (!attempted) return;
            await service(true);
            requireVhostOwnership(await vhosts(true), name, marker, acknowledged);
            await waitIdle(async () => {
              const connections: unknown = JSON.parse(
                await rabbit(['list_connections', 'vhost', '--formatter', 'json'], true),
              );
              if (
                !Array.isArray(connections) ||
                connections.some((row) => typeof object(row).vhost !== 'string')
              )
                fail('INVALID_CONNECTIONS');
              return connections.map(object).filter((row) => row.vhost === name).length;
            });
            requireVhostOwnership(await vhosts(true), name, marker, acknowledged);
            await rabbit(['delete_vhost', name], true);
            const remaining = await vhosts(true);
            if (!Array.isArray(remaining) || remaining.map(object).some((row) => row.name === name))
              fail('VHOST_CLEANUP_UNCONFIRMED');
            await record({ name, phase: 'owned-vhost-deleted' });
          },
        );
      } else {
        let attempted = false;
        let receipt: DatabaseIdentity | undefined;
        const identity = async (): Promise<DatabaseIdentity | undefined> =>
          (
            await admin.query<DatabaseIdentity>(
              "select datname as name, oid::int as oid, pg_get_userbyid(datdba) as owner, shobj_description(oid, 'pg_database') as marker from pg_database where datname = $1",
              [name],
            )
          ).rows[0];
        await withCleanup(
          async () => {
            if (await identity()) fail('DATABASE_ALREADY_EXISTS');
            controller.signal.throwIfAborted();
            attempted = true;
            await admin.query(`CREATE DATABASE "${name}"`);
            const created = await identity();
            if (!created || created.owner !== 'phub' || created.marker !== null)
              fail('DATABASE_CREATE_IDENTITY');
            await admin.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
            receipt = { ...created, marker };
            requireDatabaseOwnership(await identity(), receipt);
            await record({ ...receipt, phase: 'owned-database-created' });
            const url = new URL(context.postgres);
            url.pathname = `/${name}`;
            await run(
              [process.execPath, '--import', 'tsx', 'scripts/migrate.ts'],
              {
                ...env,
                DATABASE_URL: url.toString(),
                CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
              },
              90_000,
            );
            await test(suite, url.toString());
          },
          async () => {
            if (!attempted) return;
            requireDatabaseOwnership(await identity(), receipt);
            await waitIdle(async () =>
              Number(
                (
                  await admin.query<{ count: number }>(
                    'select count(*)::int as count from pg_stat_activity where datname = $1',
                    [name],
                  )
                ).rows[0]?.count,
              ),
            );
            requireDatabaseOwnership(await identity(), receipt);
            await admin.query(`DROP DATABASE "${name}"`); // No FORCE and no termination of clients.
            if (await identity()) fail('DATABASE_CLEANUP_UNCONFIRMED');
            await record({ name, phase: 'owned-database-deleted' });
          },
        );
      }
    }
  } catch (error) {
    await record({ phase: 'failed', reasons: failureCodes(error) });
    throw error;
  } finally {
    await pool?.end();
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Only stable error codes are logged; provider/connection strings are never emitted.
  main().catch((error: unknown) => {
    console.error(failureCodes(error).join('\n'));
    process.exitCode = 1;
  });
}
