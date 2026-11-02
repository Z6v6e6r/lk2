import { describe, expect, it } from 'vitest';
import descriptor from '../deploy/timeweb/r1-tail108-119.v1.json';
import { r1Encode, r1Hash } from './r1-tail-migration-profile.js';
import { runR1TailAdapter, validateR1TailOperation } from './r1-tail-migration-controller.js';

const at = Date.parse('2026-11-02T09:00:00.000Z');
const runtime = { identity: 'synthetic fixed runtime' },
  secrets = { hashes: 'synthetic secret digests only' };
const security = {
  owners: { 'notifications.intents': 'phub_beta', 'notifications.deliveries': 'phub_migrator' },
  rls: true,
};
const prefix = (count: number) => ({ ledger: descriptor.inventory.slice(0, count), security });
function operation(fromCount = 108) {
  return {
    schema: 'PHUB_R1_TAIL108_119_OPERATION_V1',
    migrationProfile: 'r1_tail108_119',
    packageDescriptorSha256: 'a'.repeat(64),
    catalogBuilderSha256: 'b'.repeat(64),
    expectedApi: {
      id: '1'.repeat(64),
      image: 'ghcr.io/z6v6e6r/phub-api@sha256:' + '2'.repeat(64),
      imageId: 'sha256:' + '2'.repeat(64),
      releaseId: 'a'.repeat(40) + '-42-1',
      revision: 'a'.repeat(40),
      restarts: 0,
      startedAt: new Date(at).toISOString(),
    },
    expectedWorker: {
      id: '3'.repeat(64),
      image: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + '4'.repeat(64),
      imageId: 'sha256:' + '4'.repeat(64),
      releaseId: null,
      revision: 'a'.repeat(40),
      restarts: 0,
      startedAt: new Date(at).toISOString(),
    },
    expectedPostgres: {
      id: 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
      image:
        'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
      imageId: 'sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
      releaseId: null,
      revision: null,
      restarts: 0,
      startedAt: new Date(at).toISOString(),
    },
    profile: 'beta',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    expectedDatabaseTarget: { databaseName: 'phub_beta', systemIdentifier: '7679125609183186977' },
    controllerSha: 'a'.repeat(40),
    controllerTree: 'b'.repeat(40),
    controllerSourceCiRunId: '42',
    publishedMigrator: {
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      publicationRunId: '43',
      publicationRunAttempt: 1,
      manifestSha256: 'c'.repeat(64),
      image: 'ghcr.io/z6v6e6r/phub-migrator@sha256:' + 'd'.repeat(64),
      imageId: 'sha256:' + 'e'.repeat(64),
    },
    catalogVariant: 'DORMANT',
    catalogsSha256: 'f'.repeat(64),
    fromCount,
    attemptId: '00000000-0000-4000-8000-000000000001',
    expectedRuntimeSha256: r1Hash(r1Encode(runtime)),
    expectedSecretsSha256: r1Hash(r1Encode(secrets)),
    expectedSecuritySha256: r1Hash(r1Encode(security)),
    previousMigrationSuccess: {
      path:
        '/opt/phub/timeweb-beta/backups/' +
        '1'.repeat(40) +
        '-41-1-subject-link0104-migration/migration-success.json',
      sha256: '2'.repeat(64),
      operationSha256: '3'.repeat(64),
    },
    backup: {
      operationPath:
        '/opt/phub/timeweb-beta/backups/' +
        'a'.repeat(40) +
        `-42-1-r1-tail-pre${fromCount}-00000000-0000-4000-8000-000000000001/backup-operation.json`,
      operationSha256: '4'.repeat(64),
      receiptSha256: '5'.repeat(64),
      preimageSha256: '6'.repeat(64),
    },
    resume:
      fromCount === 108
        ? null
        : {
            attemptId: '00000000-0000-4000-8000-000000000002',
            receiptSha256: '7'.repeat(64),
            operationSha256: '8'.repeat(64),
            count: fromCount,
          },
    expiresAt: new Date(at + 1800000).toISOString(),
    confirmation: `MIGRATE_R1_TAIL_FROM_${fromCount}_TO_119_KEEP_RUNTIME_NO_SEND_NO_PURCHASE`,
  };
}
function fixture(count = 119, exitCode = 0) {
  const op = operation();
  let currentCount = 108,
    clock = at;
  let receipt: Buffer | null = null,
    saved: { operation: string; plan: string } | null = null;
  let row: { id: string; status: string; exitCode: number } | null = null;
  const calls: string[] = [];
  const ops = {
    time: () => clock,
    assertSource: () => {},
    assertPrevious: () => {},
    assertUnused: () => {},
    assertAuthority: () => {},
    assertOwned: () => {},
    assertTerminalOwned: () => {},
    reconcileOwnership: () => {},
    releaseTerminal: () => {},
    assertStoppedProbes: () => {},
    attestRoleProof: () => {},
    attestTerminal: () => {},
    runtime: () => runtime,
    secrets: () => secrets,
    state: () => prefix(currentCount),
    validateState: (state: unknown, _phase: string, n: number) => {
      expect(state).toEqual(prefix(n));
    },
    backup: () => op.backup,
    image: () => op.publishedMigrator.imageId,
    preparationPlan: () => ({ only: 'owned delta' }),
    prepare: (bytes: Buffer, plan: Buffer) => {
      saved = { operation: bytes.toString('base64'), plan: plan.toString('base64') };
    },
    writeReceipt: (bytes: Buffer) => {
      receipt = bytes;
    },
    claim: () => {},
    bootstrap: () => {
      calls.push('bootstrap');
    },
    writeProof: () => {},
    roleProof: () => {},
    create: () => {
      calls.push('create');
      row = { id: '9'.repeat(64), status: 'created', exitCode: 0 };
      return row.id;
    },
    start: () => {
      calls.push('start');
      row!.status = 'running';
    },
    wait: () => {
      currentCount = count;
      row!.status = 'exited';
      row!.exitCode = exitCode;
    },
    preparation: () => saved,
    receipt: () => receipt,
    loadPlan: () => {},
    lookup: () => row,
    cleanup: () => {
      calls.push('cleanup');
    },
    success: () => {
      calls.push('success');
    },
    release: () => {
      calls.push('release');
    },
    assertResume: () => {},
  };
  return {
    op,
    ops,
    calls,
    now: (value: number) => {
      clock = value;
    },
    setCount: (n: number) => {
      currentCount = n;
    },
    setRow: (value: typeof row) => {
      row = value;
    },
    getReceipt: () => receipt,
  };
}
describe('fixed R1 tail durable failure and no-replay contract', () => {
  it('seals119 only after cleanup and exact successful stopped container', async () => {
    const f = fixture();
    await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).resolves.toMatchObject({
      status: 'SUCCESS',
      count: 119,
      replayAllowed: false,
    });
    expect(f.calls).toEqual(['bootstrap', 'create', 'start', 'cleanup', 'success', 'release']);
    f.calls.length = 0;
    await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).resolves.toMatchObject({
      status: 'SUCCESS',
    });
    expect(f.calls).not.toContain('start');
    expect(f.calls).not.toContain('create');
    expect(f.calls).not.toContain('bootstrap');
  });
  it.each(Array.from({ length: 10 }, (_, i) => i + 109))(
    'classifies failed prefix%i as PARTIAL without replay',
    async (count) => {
      const f = fixture(count, 1);
      await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).resolves.toMatchObject({
        status: 'PARTIAL',
        count,
      });
      expect(f.calls).not.toContain('success');
      f.calls.length = 0;
      await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).resolves.toMatchObject({
        status: 'PARTIAL',
        count,
      });
      expect(f.calls).toEqual([]);
    },
  );
  it('does not retry ambiguous START_INTENT or clean a running container', async () => {
    const f = fixture();
    f.ops.start = () => {
      f.calls.push('start');
      throw Error('lost ACK');
    };
    await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).rejects.toThrow('lost ACK');
    f.setRow({ id: '9'.repeat(64), status: 'running', exitCode: 0 });
    f.setCount(110);
    f.calls.length = 0;
    await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).rejects.toThrow(
      'R1_TAIL_OUTCOME_UNKNOWN',
    );
    expect(f.calls).toEqual([]);
  });
  it('recovers lost ACK after119 commit without another start', async () => {
    const f = fixture();
    f.ops.wait = () => {
      f.setCount(119);
      f.setRow({ id: '9'.repeat(64), status: 'exited', exitCode: 0 });
      throw Error('lost wait');
    };
    await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).rejects.toThrow('lost wait');
    f.calls.length = 0;
    await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).resolves.toMatchObject({
      status: 'SUCCESS',
    });
    expect(f.calls).toEqual(['cleanup', 'success', 'release']);
  });
  it('rejects missing ownership, drift and expiry before starting', async () => {
    for (const mode of ['owner', 'runtime', 'expiry']) {
      const f = fixture();
      if (mode === 'owner')
        f.ops.roleProof = () => {
          throw Error('MISSING_OWNER');
        };
      if (mode === 'runtime') f.ops.runtime = () => ({ identity: 'drift' });
      if (mode === 'expiry') f.now(at + 1800000);
      await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).rejects.toThrow();
      expect(f.calls).not.toContain('start');
    }
  });
  it.each([
    ['BOOTSTRAP_INTENT', 'bootstrap'],
    ['CREATE_INTENT', 'create'],
    ['START_INTENT', 'start'],
  ])(
    'refuses forward%s after its durable intent write crosses authority expiry',
    async (intent, effect) => {
      const f = fixture();
      const write = f.ops.writeReceipt;
      f.ops.writeReceipt = (bytes: Buffer) => {
        write(bytes);
        const record = JSON.parse(bytes.toString()) as { status: string };
        if (record.status === intent) f.now(Date.parse(f.op.expiresAt));
      };
      await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).rejects.toThrow(
        'R1_TAIL_EXPIRED',
      );
      expect(f.calls).not.toContain(effect);
      // Expiry never becomes permission to restart; the retained state reconciles without forward effects.
      f.calls.length = 0;
      if (intent === 'START_INTENT')
        await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).rejects.toThrow(
          'R1_TAIL_OUTCOME_UNKNOWN',
        );
      else
        await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).resolves.toMatchObject({
          status: 'ABORTED',
        });
      expect(f.calls).not.toContain('bootstrap');
      expect(f.calls).not.toContain('create');
      expect(f.calls).not.toContain('start');
    },
  );
  it('seals a missing SUCCESS artifact after the terminal receipt ACK is lost, without DB replay', async () => {
    const f = fixture();
    const realSuccess = f.ops.success;
    let fail = true;
    f.ops.success = () => {
      if (fail) {
        fail = false;
        throw Error('SYNTHETIC_SUCCESS_ACK_LOST');
      }
      realSuccess();
    };
    await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).rejects.toThrow(
      'SYNTHETIC_SUCCESS_ACK_LOST',
    );
    f.calls.length = 0;
    await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).resolves.toMatchObject({
      status: 'SUCCESS',
    });
    expect(f.calls).toEqual(['success']);
  });
  it('aborts a PREPARED partial lock claim without recreating locks or starting database work', async () => {
    const f = fixture();
    f.ops.claim = () => {
      throw Error('SYNTHETIC_PARTIAL_LOCK_CLAIM');
    };
    await expect(runR1TailAdapter('deploy', r1Encode(f.op), f.ops)).rejects.toThrow(
      'SYNTHETIC_PARTIAL_LOCK_CLAIM',
    );
    f.calls.length = 0;
    await expect(runR1TailAdapter('reconcile', r1Encode(f.op), f.ops)).resolves.toMatchObject({
      status: 'ABORTED',
      count: 108,
    });
    expect(f.calls).toEqual(['cleanup', 'release']);
  });
  it('refuses spoofed resume, arbitrary argv/SQL, wrong target and new budgets', () => {
    expect(() => validateR1TailOperation(operation(109), at)).not.toThrow();
    for (const op of [
      { ...operation(), sql: 'select 1' },
      { ...operation(), statementMs: 0 },
      { ...operation(109), resume: null },
      {
        ...operation(),
        expectedDatabaseTarget: { databaseName: 'wrong', systemIdentifier: '7679125609183186977' },
      },
    ])
      expect(() => validateR1TailOperation(op, at)).toThrow();
  });
});
