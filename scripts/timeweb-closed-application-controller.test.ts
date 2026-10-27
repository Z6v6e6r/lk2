import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
});
