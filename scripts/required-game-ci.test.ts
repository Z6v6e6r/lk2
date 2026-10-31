import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  command,
  failureCodes,
  hasLiveGroupMembers,
  ownedGroupIsLive,
  fixtureName,
  main,
  requireDatabaseOwnership,
  requireRabbitService,
  requireSuccess,
  requireVhostOwnership,
  suites,
  validateContext,
  verifyReport,
  waitIdle,
  withCleanup,
  type Command,
} from './required-game-ci.js';

const database = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({
  Pool: class {
    query = database.query;
    end = database.end;
  },
}));

const container = 'a'.repeat(64);
const nonce = 'b'.repeat(32);
const env = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'Z6v6e6r/lk2',
  GITHUB_JOB: 'quality-full',
  GITHUB_RUN_ID: '41230000000',
  GITHUB_RUN_ATTEMPT: '1',
  APP_ENV: 'ci',
  VIVA_MODE: 'mock',
  CI_GAME_RABBIT_CONTAINER: container,
  DATABASE_URL: 'postgresql://phub:ci-password@localhost:5432/phub',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};
const service = () =>
  JSON.stringify([
    {
      Id: container,
      Config: { Image: 'rabbitmq:4-alpine' },
      State: { Running: true },
      NetworkSettings: { Ports: { '5672/tcp': [{ HostIp: '0.0.0.0', HostPort: '5672' }] } },
    },
  ]);
const ok = (stdout = '') => ({ code: 0, signal: null, timedOut: false, stdout });
const reportFor = (suite: (typeof suites)[number]) => {
  const assertions = [
    ...suite.cases.map((title) => [suite.physical, title]),
    ...suite.guards.map((title) => [suite.guard, title]),
  ].map(([ancestor, title]) => ({
    ancestorTitles: [ancestor],
    title,
    fullName: `${ancestor} ${title}`,
    status: 'passed',
    duration: 1,
    failureMessages: [],
  }));
  return {
    success: true,
    startTime: Date.now(),
    numTotalTests: assertions.length,
    numPassedTests: assertions.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: [
      { name: resolve(suite.file), status: 'passed', message: '', assertionResults: assertions },
    ],
  };
};
const artifacts = new Set<string>();
afterEach(async () => {
  for (const path of artifacts) await rm(path, { recursive: true, force: true });
  artifacts.clear();
  vi.clearAllMocks();
});

describe('required physical game CI boundary', () => {
  it('accepts only the exact CI repository/job and existing loopback services', () => {
    expect(validateContext(env).postgres).toContain('127.0.0.1:5432/phub');
    expect(suites.map((suite) => [suite.cases.length, suite.guards.length])).toEqual([
      [13, 6],
      [10, 1],
      [4, 1],
    ]);
  });
  it.each([
    ['GITHUB_ACTIONS', undefined],
    ['GITHUB_REPOSITORY', 'fork/lk2'],
    ['GITHUB_JOB', 'quality-web'],
    ['GITHUB_RUN_ID', '1;DROP'],
    ['GITHUB_RUN_ATTEMPT', '0'],
    ['APP_ENV', 'production'],
    ['VIVA_MODE', 'live'],
    ['CI_GAME_RABBIT_CONTAINER', 'rabbitmq'],
    ['DATABASE_URL', 'postgresql://phub:ci-password@remote:5432/phub'],
    ['DATABASE_URL', 'postgresql://phub:ci-password@localhost:5433/phub'],
    ['DATABASE_URL', 'postgresql://phub:ci-password@localhost:5432/other_verify'],
    ['DATABASE_URL', 'postgresql://phub:ci-password@localhost:5432/phub?host=remote'],
    ['RABBITMQ_URL', 'amqp://guest:guest@localhost:5672/other_verify'],
    ['RABBITMQ_URL', 'amqp://guest:guest@localhost:5673'],
    ['PGHOST', 'remote'],
    ['DOCKER_HOST', 'tcp://remote'],
    ['GAME_LIFECYCLE_HTTP_TEST_DATABASE_URL', env.DATABASE_URL],
  ])('denies unsafe context %s=%s before commands or database construction', async (key, value) => {
    const execute = vi.fn();
    await expect(main({ ...env, [key]: value }, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });
  it('validates generated identifiers before SQL/CLI interpolation', () => {
    expect(fixtureName(nonce, 'lifecycle')).toMatch(/^lk2_[a-f0-9]{32}_lifecycle_verify$/);
    for (const [random, id] of [
      [nonce, 'x;DROP'],
      ["';", 'rabbit'],
      ['A'.repeat(32), 'comms'],
    ]) {
      expect(() => fixtureName(random!, id!)).toThrow('UNSAFE_IDENTIFIER');
    }
  });
  it('checks exact container identity, image, running state and published port', () => {
    expect(() => requireRabbitService(service(), container)).not.toThrow();
    for (const raw of [
      service().replace(container, 'c'.repeat(64)),
      service().replace('rabbitmq:4-alpine', 'rabbitmq:3'),
      service().replace('true', 'false'),
      service().replace('"HostPort":"5672"', '"HostPort":"5673"'),
      '[]',
    ]) {
      expect(() => requireRabbitService(raw, container)).toThrow();
    }
  });
  it('refuses unacknowledged, missing, changed or ambiguous cleanup identities', () => {
    const expected = {
      name: fixtureName(nonce, 'lifecycle'),
      oid: 123,
      owner: 'phub',
      marker: `lk2_game_1_1_${nonce}`,
    };
    expect(() => requireDatabaseOwnership(expected, expected)).not.toThrow();
    for (const actual of [
      undefined,
      { ...expected, oid: 124 },
      { ...expected, owner: 'other' },
      { ...expected, marker: null },
    ]) {
      expect(() => requireDatabaseOwnership(actual, expected)).toThrow('OWNERSHIP_LOST');
    }
    expect(() => requireDatabaseOwnership(expected, undefined)).toThrow();
    const name = fixtureName(nonce, 'rabbit');
    const rows = [{ name, description: expected.marker }];
    expect(() => requireVhostOwnership(rows, name, expected.marker, true)).not.toThrow();
    for (const actual of [[], [...rows, ...rows], [{ name, description: 'other' }]]) {
      expect(() => requireVhostOwnership(actual, name, expected.marker, true)).toThrow();
    }
    expect(() => requireVhostOwnership(rows, name, expected.marker, false)).toThrow();
  });
  it.each(suites)(
    'requires every actual case in $id, not only successful aggregate statistics',
    (suite) => {
      expect(() =>
        verifyReport(JSON.stringify(reportFor(suite)), suite, process.cwd(), 0),
      ).not.toThrow();
      const mutations = [
        (r: ReturnType<typeof reportFor>) => {
          r.success = false;
        },
        (r: ReturnType<typeof reportFor>) => {
          r.testResults = [];
        },
        (r: ReturnType<typeof reportFor>) => {
          r.testResults[0]!.name = resolve('unrelated.test.ts');
        },
        (r: ReturnType<typeof reportFor>) => {
          r.testResults[0]!.assertionResults.pop();
        },
        (r: ReturnType<typeof reportFor>) => {
          r.testResults[0]!.assertionResults[0]!.status = 'skipped';
        },
        (r: ReturnType<typeof reportFor>) => {
          r.testResults[0]!.assertionResults[0]!.title = 'forged';
        },
        (r: ReturnType<typeof reportFor>) => {
          r.testResults[0]!.assertionResults[0] = r.testResults[0]!.assertionResults[1]!;
        },
        (r: ReturnType<typeof reportFor>) => {
          r.startTime = -1;
        },
      ];
      for (const mutate of mutations) {
        const report = reportFor(suite);
        mutate(report);
        expect(() => verifyReport(JSON.stringify(report), suite, process.cwd(), 0)).toThrow();
      }
      for (const invalid of ['{', '{}', 'null'])
        expect(() => verifyReport(invalid, suite, process.cwd(), 0)).toThrow();
    },
  );
  it('does not accept a report in place of a successful actual child exit', () => {
    for (const result of [
      { ...ok(), code: 1 },
      { ...ok(), signal: 'SIGTERM' },
      { ...ok(), timedOut: true },
    ])
      expect(() => requireSuccess(result)).toThrow();
  });
  it('records stable failure codes without exposing raw endpoint errors', () => {
    expect(
      failureCodes(
        new AggregateError([
          new Error('REQUIRED_GAME_CI_CHILD_FAILED'),
          new Error(env.DATABASE_URL),
        ]),
      ),
    ).toEqual(['REQUIRED_GAME_CI_CHILD_FAILED', 'REQUIRED_GAME_CI_UNEXPECTED_ERROR']);
  });
  it('bounds idle waits and never terminates active clients', async () => {
    const pause = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue(1);
    await expect(waitIdle(read, pause)).rejects.toThrow('ACTIVE_CLIENTS');
    expect(read).toHaveBeenCalledTimes(10);
    await expect(waitIdle(() => Promise.resolve(Number.NaN), pause)).rejects.toThrow(
      'INVALID_CLIENT_COUNT',
    );
  });
  it('awaits child completion before cleanup and retains both primary/cleanup failures', async () => {
    const order: string[] = [];
    await expect(
      withCleanup(
        async () => {
          await Promise.resolve();
          order.push('child-close');
          throw new Error('primary');
        },
        async () => {
          await Promise.resolve();
          order.push('cleanup');
          throw new Error('cleanup-refused');
        },
      ),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'primary' }),
        expect.objectContaining({ message: 'cleanup-refused' }),
      ],
    });
    expect(order).toEqual(['child-close', 'cleanup']);
  });
  it('terminates only its owned synthetic process group on timeout, then resolves close', async () => {
    const result = await command([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {}, 50);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toMatch(/^SIG(TERM|KILL)$/);
    expect(() => requireSuccess(result)).toThrow();
  });
  it('distinguishes live descendants from Linux zombies and refuses unknown group state', async () => {
    expect(hasLiveGroupMembers('123 Z\n123 Zs\n456 S', 123)).toBe(false);
    expect(hasLiveGroupMembers('123 Z\n123 S\n456 S', 123)).toBe(true);
    const cleanup = vi.fn();
    await expect(
      withCleanup(
        () =>
          Promise.resolve().then(() => {
            hasLiveGroupMembers('unparseable', 123);
          }),
        cleanup,
      ),
    ).rejects.toThrow('PROCESS_GROUP_UNCONFIRMED');
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('waits for the TERM-ignoring grandchild after the direct parent closes its stdio', async () => {
    const descendant = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
    const parent = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.on('message', () => console.log(JSON.stringify({ pgid: process.pid, descendant: child.pid })));`;
    const started = Date.now();
    const result = await command([process.execPath, '-e', parent], process.env, 1000);
    const identity = JSON.parse(result.stdout.trim()) as { pgid: number; descendant: number };
    expect(Number.isSafeInteger(identity.descendant)).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(Date.now() - started).toBeGreaterThanOrEqual(3900);
    expect(ownedGroupIsLive(identity.pgid)).toBe(false);
  }, 10_000);
});

// In-memory PostgreSQL/Rabbit transcripts exercise orchestration and refused cleanup.
// No database/broker is provisioned or contacted by these tests.
function fixture(
  failure?:
    | 'create-ack'
    | 'comment'
    | 'migration'
    | 'test-exit'
    | 'missing-report'
    | 'permission'
    | 'rabbit-ack'
    | 'cleanup'
    | 'timeout'
    | 'bad-connections'
    | 'busy',
) {
  const rows = new Map<
    string,
    { name: string; oid: number; owner: string; marker: string | null }
  >();
  const hosts = new Map<string, string>();
  const events: string[] = [];
  database.end.mockResolvedValue(undefined);
  database.query.mockImplementation(async (sql: string, values?: string[]) => {
    await Promise.resolve();
    events.push(sql.split(' ')[0]!);
    if (sql.includes('current_database'))
      return { rows: [{ database: 'phub', owner: 'phub', port: 5432 }] };
    if (sql.includes('from pg_database'))
      return { rows: rows.has(values![0]!) ? [rows.get(values![0]!)] : [] };
    if (sql.startsWith('CREATE DATABASE')) {
      const name = sql.split('"')[1]!;
      artifacts.add(resolve('.ci-artifacts/required-game', name.split('_')[1]!));
      rows.set(name, { name, oid: rows.size + 100, owner: 'phub', marker: null });
      if (failure === 'create-ack') throw new Error('ambiguous-create');
    } else if (sql.startsWith('COMMENT')) {
      if (failure === 'comment') throw new Error('comment-failed');
      rows.get(sql.split('"')[1]!)!.marker = sql.split("'")[1]!;
    } else if (sql.includes('pg_stat_activity'))
      return { rows: [{ count: failure === 'busy' ? 1 : 0 }] };
    else if (sql.startsWith('DROP')) {
      if (failure === 'cleanup') throw new Error('drop-refused');
      rows.delete(sql.split('"')[1]!);
    }
    return { rows: [] };
  });
  const execute: Command = async (args, childEnv) => {
    if (args.includes('inspect')) return ok(service());
    if (args.includes('scripts/migrate.ts')) {
      expect(childEnv.DATABASE_URL).toMatch(/\/lk2_[a-f0-9]{32}_(lifecycle|comms)_verify$/);
      expect(childEnv.CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK).toBe(
        'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
      );
      events.push('migrate');
      if (failure === 'timeout') return { ...ok(), code: null, signal: 'SIGKILL', timedOut: true };
      return failure === 'migration' ? { ...ok(), code: 1 } : ok();
    }
    if (args.includes('node_modules/vitest/vitest.mjs')) {
      const suite = suites.find((value) => args.includes(value.file))!;
      const reportPath = args
        .find((arg) => arg.startsWith('--outputFile='))!
        .slice('--outputFile='.length);
      artifacts.add(dirname(reportPath));
      expect(childEnv[suite.env]).toContain('_verify');
      await mkdir(dirname(reportPath), { recursive: true });
      if (failure !== 'missing-report')
        await writeFile(reportPath, JSON.stringify(reportFor(suite)));
      events.push(`test-${suite.id}-closed`);
      return failure === 'test-exit' ? { ...ok(), code: 1 } : ok();
    }
    if (args.includes('list_vhosts'))
      return ok(JSON.stringify([...hosts].map(([name, description]) => ({ name, description }))));
    if (args.includes('add_vhost')) {
      const name = args[args.indexOf('add_vhost') + 1]!;
      hosts.set(name, args[args.indexOf('--description') + 1]!);
      return failure === 'rabbit-ack' ? { ...ok(), code: 1 } : ok();
    }
    if (args.includes('set_permissions'))
      return failure === 'permission' ? { ...ok(), code: 1 } : ok();
    if (args.includes('list_connections')) return ok(failure === 'bad-connections' ? '[{}]' : '[]');
    if (args.includes('delete_vhost')) {
      hosts.delete(args[args.indexOf('delete_vhost') + 1]!);
      events.push('delete-vhost');
      return ok();
    }
    throw new Error('Unexpected synthetic command');
  };
  return { execute, rows, hosts, events };
}

describe('required game CI fixture custody and orchestration', () => {
  it('runs three suites sequentially and deletes only acknowledged idle owned fixtures', async () => {
    const f = fixture();
    await main(env, f.execute);
    expect(f.rows.size).toBe(0);
    expect(f.hosts.size).toBe(0);
    expect(f.events.filter((event) => event.startsWith('test-'))).toEqual([
      'test-lifecycle-closed',
      'test-comms-closed',
      'test-rabbit-closed',
    ]);
    expect(f.events.indexOf('DROP')).toBeGreaterThan(f.events.indexOf('test-lifecycle-closed'));
    expect(f.events.indexOf('delete-vhost')).toBeGreaterThan(
      f.events.indexOf('test-rabbit-closed'),
    );
    expect(database.end).toHaveBeenCalledOnce();
  });
  it.each([
    'create-ack',
    'comment',
    'migration',
    'test-exit',
    'missing-report',
    'permission',
    'rabbit-ack',
    'cleanup',
    'timeout',
    'bad-connections',
  ] as const)(
    'fails closed for %s and retains only fixtures lacking cleanup authority',
    async (failure) => {
      const f = fixture(failure);
      await expect(main(env, f.execute)).rejects.toThrow('FAILED_OR_CLEANUP_REFUSED');
      expect(f.rows.size).toBe(['create-ack', 'comment', 'cleanup'].includes(failure) ? 1 : 0);
      expect(f.hosts.size).toBe(['rabbit-ack', 'bad-connections'].includes(failure) ? 1 : 0);
      if (failure === 'create-ack' || failure === 'comment') expect(f.events).not.toContain('DROP');
      expect(database.end).toHaveBeenCalledOnce();
    },
  );
});
