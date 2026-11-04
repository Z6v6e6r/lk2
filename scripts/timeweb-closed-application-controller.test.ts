import { readFileSync } from 'node:fs';
import type * as ChildProcess from 'node:child_process';
import type * as ApiWebUpgrade from './timeweb-api-web-upgrade.js';
import { createClosedApplicationProductionBinding } from './timeweb-closed-application-runtime.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closedApplicationRequestPath,
  closedApplicationPreviousRequestHashes,
  closedApplicationProductionPaths,
  createClosedApplicationProductionEffects,
  migrationCreateArgs,
  runClosedApplicationManualEntryAdapter,
  sealNotificationPrefetchMetadata,
  type ClosedProductionBinding,
  type ClosedApplicationManualEntryEffects,
} from './timeweb-api-worker-migration.js';
import {
  createClosedApplicationKernelProfile,
  type ClosedApplicationOperation,
} from './timeweb-closed-application-profile.js';
import { closedApplicationOperationFixture } from './timeweb-closed-application.fixture.js';

function binding(operation: ClosedApplicationOperation): ClosedProductionBinding {
  const forbidden = () => {
    throw Error('LIVE_EFFECT_FORBIDDEN_IN_UNIT_TEST');
  };
  return {
    kind: operation.migrationProfile,
    kernelProfile: createClosedApplicationKernelProfile(operation),
    attestSource: forbidden,
    validateManifest: forbidden,
    backup: forbidden,
    inputs: forbidden,
    readState: forbidden,
    bootstrapSql: forbidden,
    cleanupSql: forbidden,
    attestPrevious: forbidden,
    assertRuntimeFlags: forbidden,
  };
}
describe('closed production binding and entry custody', () => {
  it('admits only the exact reconciled first-stage requests and refuses foreign coexistence', () => {
    const op = closedApplicationOperationFixture('subject_link_0104'),
      previous = closedApplicationProductionPaths({ ...op, migrationProfile: 'game_start_0103' }),
      proof = {
        schema: 'PHUB_CLOSED_APPLICATION_PREVIOUS_REQUESTS_V1',
        status: 'RECONCILED_SUCCESS',
        migrationProfile: 'game_start_0103',
        sourceSha: op.controllerSha,
        sourceTree: op.controllerTree,
        controllerSourceCiRunId: op.controllerSourceCiRunId,
        operationSha256: op.previousMigrationSuccess!.operationSha256,
        successSha256: op.previousMigrationSuccess!.sha256,
        requestHashes: {
          [previous.requestPath]: op.previousMigrationSuccess!.operationSha256,
          [previous.prefetchRequestPath]: 'd'.repeat(64),
          '/opt/phub/timeweb-beta/operator/database-backup-restore.json': 'e'.repeat(64),
        },
      };
    expect(closedApplicationPreviousRequestHashes(op, proof)).toEqual(proof.requestHashes);
    for (const change of [
      { status: 'SUCCESS' },
      { sourceTree: 'd'.repeat(40) },
      { successSha256: 'e'.repeat(64) },
      { requestHashes: { ...proof.requestHashes, '/tmp/foreign.json': 'f'.repeat(64) } },
      { requestHashes: { ...proof.requestHashes, [previous.requestPath]: 'f'.repeat(64) } },
    ])
      expect(() => closedApplicationPreviousRequestHashes(op, { ...proof, ...change })).toThrow();
    expect(
      closedApplicationPreviousRequestHashes(
        closedApplicationOperationFixture('game_start_0103'),
        null,
      ),
    ).toEqual({});
    expect(() =>
      closedApplicationPreviousRequestHashes(
        closedApplicationOperationFixture('game_start_0103'),
        proof,
      ),
    ).toThrow();
  });
  it('gives retained stages distinct request, transaction, container and prefetch namespaces', () => {
    const game = closedApplicationProductionPaths(
      closedApplicationOperationFixture('game_start_0103'),
    );
    const subject = closedApplicationProductionPaths(
      closedApplicationOperationFixture('subject_link_0104'),
    );
    expect(game.candidate).toBe(subject.candidate);
    for (const key of [
      'requestPath',
      'transactionRoot',
      'containerName',
      'prefetchRoot',
      'prefetchRequestPath',
    ] as const)
      expect(game[key]).not.toBe(subject[key]);
    const source = readFileSync('scripts/timeweb-api-worker-migration.js', 'utf8');
    const production = source.slice(
      source.indexOf('function productionOps('),
      source.indexOf('export async function runClosedApplicationManualEntryAdapter'),
    );
    expect(production).not.toContain('read(REQUEST)');
    expect(production).toContain('read(requestPath)');
  });
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'constructs only exact %s migration/probe argv',
    (profile) => {
      const op = closedApplicationOperationFixture(profile),
        kernelProfile = createClosedApplicationKernelProfile(op),
        paths = closedApplicationProductionPaths(op);
      for (const kind of ['migration', 'migrator', 'migrator-post']) {
        const name =
          kind === 'migration' ? paths.containerName : `${paths.containerName}-role-${kind}`;
        const args = migrationCreateArgs(
          name,
          'f'.repeat(64),
          '/etc/phub/timeweb-beta/migrator.env',
          kind,
          undefined,
          { closedApplication: { operation: op, profile: kernelProfile } },
        );
        expect(args[args.indexOf('--name') + 1]).toBe(name);
        expect(args).toContain(`phub.migration-kind=${kind}`);
        const command = args.slice(args.indexOf(op.publishedMigrator.image) + 1);
        if (kind === 'migration') {
          expect(command.slice(0, 3)).toEqual([
            'node',
            'apps/migrator/dist/main.js',
            profile === 'game_start_0103'
              ? '--game-start-migration-0103'
              : '--subject-link-migration-0104',
          ]);
          expect(JSON.parse(Buffer.from(command[3]!, 'base64').toString())).toEqual({
            ...op.expectedDatabaseTarget,
            catalogVariant: op.catalogVariant,
          });
        } else
          expect(command).toEqual([
            '--input-type=module',
            '-e',
            kernelProfile.roleProbeSource,
            kind === 'migrator' ? 'pre' : 'bootstrap',
          ]);
      }
      expect(() =>
        migrationCreateArgs(
          paths.containerName,
          'f'.repeat(64),
          '/tmp/foreign.env',
          'migration',
          undefined,
          { closedApplication: { operation: op, profile: kernelProfile } },
        ),
      ).toThrow('CLOSED_CREATE');
      expect(() =>
        migrationCreateArgs(
          paths.containerName,
          'f'.repeat(64),
          '/etc/phub/timeweb-beta/migrator.env',
          'runtime',
          undefined,
          { closedApplication: { operation: op, profile: kernelProfile } },
        ),
      ).toThrow('CLOSED_CREATE');
    },
  );
  it('creates lazy bound effects without source, Docker, SQL or owner actions', () => {
    const op = closedApplicationOperationFixture('game_start_0103');
    const effects = createClosedApplicationProductionEffects(
      op,
      {
        assertOwned: () => {
          throw Error('OWNER_EFFECT');
        },
      },
      binding(op),
    );
    expect(effects.receiptPath).toBe(
      `${closedApplicationProductionPaths(op).transactionRoot}/migration-receipt.json`,
    );
    expect(() =>
      createClosedApplicationProductionEffects(
        {
          ...op,
          expectedDatabaseTarget: { ...op.expectedDatabaseTarget, databaseName: 'foreign' },
        },
        { assertOwned: () => undefined },
        binding(op),
      ),
    ).toThrow('CLOSED_BINDING');
  });
  it('rejects request/kind/target mismatch before executor acquisition and always closes its owner', async () => {
    const op = closedApplicationOperationFixture('game_start_0103'),
      calls: string[] = [];
    const effects: ClosedApplicationManualEntryEffects = {
      uid: () => 0,
      time: () => Date.parse('2026-10-27T07:30:00.000Z'),
      assertAmbient: () => calls.push('ambient'),
      secureStandard: () => calls.push('secure'),
      readRequest: () => Buffer.from(JSON.stringify(op)),
      binding: () => binding(op),
      acquire: () => {
        calls.push('acquire');
        return { close: () => calls.push('close') };
      },
      run: () => {
        calls.push('run');
        return Promise.resolve({ status: 'SYNTHETIC_ONLY', receipt: 'synthetic-receipt' });
      },
    };
    await expect(
      runClosedApplicationManualEntryAdapter(
        'deploy',
        'game_start_0103',
        closedApplicationRequestPath('subject_link_0104'),
        effects,
      ),
    ).rejects.toThrow('CLOSED_ENTRY');
    expect(calls).toEqual([]);
    await expect(
      runClosedApplicationManualEntryAdapter(
        'deploy',
        'game_start_0103',
        closedApplicationRequestPath('game_start_0103'),
        {
          ...effects,
          readRequest: () =>
            Buffer.from(
              JSON.stringify({
                ...op,
                expectedDatabaseTarget: { ...op.expectedDatabaseTarget, databaseName: 'foreign' },
              }),
            ),
        },
      ),
    ).rejects.toThrow('CLOSED_BINDING');
    expect(calls).toEqual(['ambient', 'secure']);
    calls.length = 0;
    await expect(
      runClosedApplicationManualEntryAdapter(
        'deploy',
        'game_start_0103',
        closedApplicationRequestPath('game_start_0103'),
        effects,
      ),
    ).resolves.toMatchObject({ status: 'SYNTHETIC_ONLY' });
    expect(calls).toEqual(['ambient', 'secure', 'acquire', 'run', 'close']);
    calls.length = 0;
    await expect(
      runClosedApplicationManualEntryAdapter(
        'reconcile',
        'game_start_0103',
        closedApplicationRequestPath('game_start_0103'),
        {
          ...effects,
          run: () => {
            throw Error('SYNTHETIC_FAILURE');
          },
        },
      ),
    ).rejects.toThrow('SYNTHETIC_FAILURE');
    expect(calls).toEqual(['ambient', 'secure', 'acquire', 'close']);
  });
  it('keeps old prefetch path admission unchanged and fences cross-stage metadata', () => {
    const op = closedApplicationOperationFixture('game_start_0103'),
      game = closedApplicationProductionPaths(op);
    expect(() =>
      sealNotificationPrefetchMetadata(
        `${game.prefetchRoot}/intent.json`,
        Buffer.from('synthetic'),
      ),
    ).toThrow('PREFETCH_METADATA_PATH');
    const other = closedApplicationProductionPaths(
      closedApplicationOperationFixture('subject_link_0104'),
    );
    expect(() =>
      sealNotificationPrefetchMetadata(
        `${other.prefetchRoot}/intent.json`,
        Buffer.from('synthetic'),
        'game_start_0103',
      ),
    ).toThrow('PREFETCH_METADATA_PATH');
  });
  it('scopes generated prefetch effects and metadata sealing to the same validated R1 intent', () => {
    const base = closedApplicationOperationFixture('game_start_0103', 'R1_PACKAGE119');
    const a = { ...base, backupGeneration: 'a'.repeat(32) },
      b = { ...base, backupGeneration: 'b'.repeat(32) };
    const old = closedApplicationProductionPaths(base),
      first = closedApplicationProductionPaths(a),
      next = closedApplicationProductionPaths(b);
    expect(first.prefetchRoot).toBe(old.prefetchRoot + '-generation-' + a.backupGeneration);
    expect(next.prefetchRoot).not.toBe(first.prefetchRoot);
    expect(first.transactionRoot).toBe(old.transactionRoot);
    expect(first.containerName).toBe(old.containerName);
    expect(() =>
      sealNotificationPrefetchMetadata(
        first.prefetchRoot + '/receipt.json',
        Buffer.from('synthetic'),
        'game_start_0103',
      ),
    ).toThrow('PREFETCH_METADATA_PATH');
    expect(() =>
      sealNotificationPrefetchMetadata(
        first.prefetchRoot + '/receipt.json',
        Buffer.from('synthetic'),
        'game_start_0103',
        b,
      ),
    ).toThrow('PREFETCH_METADATA_PATH');
    const custody = io.secure;
    custody.mockImplementation(() => {
      throw Error('EXPECTED_SEALER_CUSTODY_STOP');
    });
    try {
      const effects = createClosedApplicationProductionEffects(
        a,
        {
          assertOwned: () => {
            throw Error('LIVE_EFFECT_FORBIDDEN');
          },
        },
        binding(a),
      );
      const prefetch = effects as unknown as { writePrefetchReceipt(bytes: Buffer): void };
      expect(() => prefetch.writePrefetchReceipt(Buffer.from('synthetic'))).toThrow(
        'EXPECTED_SEALER_CUSTODY_STOP',
      );
      expect(custody).toHaveBeenLastCalledWith(first.prefetchRoot, 0o700);
      expect(() =>
        sealNotificationPrefetchMetadata(
          first.prefetchRoot + '/intent.json',
          Buffer.from('synthetic'),
          'game_start_0103',
          a,
        ),
      ).toThrow('EXPECTED_SEALER_CUSTODY_STOP');
    } finally {
      custody.mockRestore();
    }
  });
});

const io = vi.hoisted(() => ({ execute: vi.fn(), read: vi.fn(), secure: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFileSync: io.execute,
}));
vi.mock('./timeweb-api-web-upgrade.js', async (original) => {
  const actual = await original<typeof ApiWebUpgrade>();
  return {
    ...actual,
    readUpgradeFile: io.read,
    secureUpgradePath: io.secure,
  };
});

function fixture(kind: 'game_start_0103' | 'subject_link_0104') {
  const operation = closedApplicationOperationFixture(kind, 'R1_PACKAGE119');
  const rows = ['api', 'worker', 'postgres'].map((service) => {
    const identity =
      service === 'api'
        ? operation.expectedApi
        : service === 'worker'
          ? operation.expectedWorker
          : operation.expectedPostgres;
    return {
      Id: identity.id,
      Image: identity.imageId,
      Name: `/synthetic-${service}`,
      RestartCount: identity.restarts,
      State: {
        Status: 'running',
        Running: true,
        StartedAt: identity.startedAt,
        Health: { Status: 'healthy' },
      },
      Config: {
        Image: identity.image,
        Env: ['SYNTHETIC_ONLY=true'],
        Labels: {
          'com.docker.compose.service': service,
          'com.docker.compose.project': 'phub-timeweb-beta',
          'phub.release-id': identity.releaseId,
          'org.opencontainers.image.revision': identity.revision,
          'phub.migration-kind': 'migration',
        },
      },
      HostConfig: {},
      Mounts: [],
      NetworkSettings: {},
    };
  });
  io.execute.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe('/usr/bin/docker');
    if (JSON.stringify(args) === JSON.stringify(['ps', '-aq', '--no-trunc']))
      return rows.map((row) => row.Id).join('\n');
    if (args[0] === 'container' && args[1] === 'inspect')
      return JSON.stringify(rows.filter((row) => row.Id === args[2]));
    throw Error('UNEXPECTED_PROCESS_EFFECT');
  });
  io.read.mockImplementation((path: string) => {
    if (path === '/etc/phub/timeweb-beta-standard-delivery.json') return Buffer.from('{}');
    throw Object.assign(Error('MIGRATION_REQUEST_NOT_STAGED'), { code: 'ENOENT' });
  });
  const assertRuntimeFlags = vi.fn();
  const effects = createClosedApplicationProductionEffects(
    operation,
    {
      assertOwned: () => {
        throw Error('WRITE_FORBIDDEN');
      },
    },
    { ...createClosedApplicationProductionBinding(operation), assertRuntimeFlags },
  );
  return { operation, rows, effects, assertRuntimeFlags };
}

beforeEach(() => vi.resetAllMocks());
describe.each(['game_start_0103', 'subject_link_0104'] as const)(
  '%s production snapshot before migration admission',
  (kind) => {
    it('reads the running services without requiring a future migration request', () => {
      const { operation, effects, assertRuntimeFlags } = fixture(kind);
      expect(effects.snapshot()).toMatchObject({
        api: { identity: operation.expectedApi },
        worker: { identity: operation.expectedWorker },
        postgres: operation.expectedPostgres,
      });
      expect(io.read.mock.calls).toEqual([['/etc/phub/timeweb-beta-standard-delivery.json']]);
      expect(assertRuntimeFlags).toHaveBeenCalledOnce();
    });
    it('still refuses a migration container without its request custody', () => {
      const { operation, effects, rows } = fixture(kind);
      rows[0]!.Name = `/${closedApplicationProductionPaths(operation).containerName}`;
      expect(() => effects.snapshot()).toThrow('MIGRATION_REQUEST_NOT_STAGED');
      expect(io.read).toHaveBeenCalledWith(closedApplicationProductionPaths(operation).requestPath);
    });
    it('still refuses an unhealthy application before reading controller configuration', () => {
      const { effects, rows, assertRuntimeFlags } = fixture(kind);
      rows[0]!.State.Health.Status = 'unhealthy';
      expect(() => effects.snapshot()).toThrow('UNHEALTHY');
      expect(io.read).not.toHaveBeenCalled();
      expect(assertRuntimeFlags).not.toHaveBeenCalled();
    });
  },
);
