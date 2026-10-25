import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  androidSnapshot,
  preservedFixture,
  encoded,
  sha256,
} from './timeweb-notification-preserved.fixture.js';
import {
  validateNotificationOperation,
  validateNotificationManifest,
} from './timeweb-notification-profile.js';
import { assertPlan, validateApiWorkerOperation } from './timeweb-api-worker-contract.js';
import {
  validateApiWorkerDatabase,
  API_WORKER_PRESERVED_DATABASE_SQL,
  runApiWorkerTransition,
  recoverApiWorkerPhase,
  overlay,
  apiWorkerComposeArgs,
  validateApiWorkerReceipt,
} from './timeweb-api-worker-upgrade.js';
import {
  assertAndroidGateSnapshot,
  ANDROID_ALL_SENDING_SQL,
  validateFcmDrainProof,
  verifyFcmHeldRollback,
} from './timeweb-notification-android-gates.js';
import {
  assertCompletedNotificationInputs,
  COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS,
} from './timeweb-notification-completed-migration.js';

function database() {
  const { plan } = preservedFixture();
  return {
    backendPid: 1,
    transactionStartedAt: '2026-10-22T12:00:00.000Z',
    readOnly: 'on',
    superuser: true,
    bypassRls: true,
    tenantCount: 1,
    tenantFingerprint: 'a'.repeat(32),
    androidEnabledTenants: 1,
    activeProviders: 1,
    liveLeases: 0,
    ledger: plan.packagedLedger,
    androidSnapshot: androidSnapshot(),
    allSending: 0,
  };
}
function transition() {
  const events: string[] = [];
  let phase = 'PREPARING',
    marker = 'HELD';
  const mark = (event: string) => () => {
    events.push(event);
    return Promise.resolve();
  };
  const op = {
    preserveAndroid: true,
    secretMode: 'preserve' as const,
    journal: vi.fn((p: string) => {
      phase = p;
      events.push(p);
      return Promise.resolve();
    }),
    recoveryPhase: () => Promise.resolve(phase),
    preflight: vi.fn(mark('preflight')),
    attestGatePreparation: vi.fn(mark('classify-held')),
    prepareDeliveryGate: vi.fn(mark('held')),
    pullAndSmoke: vi.fn(mark('pull')),
    containWorker: vi.fn(mark('stop')),
    verifyFcmDrain: vi.fn(mark('drain')),
    verifyHeldForRollback: vi.fn(() => {
      if (marker !== 'HELD') return Promise.reject(Error('released'));
      return mark('rollback-drain')();
    }),
    installSecrets: vi.fn(mark('secrets')),
    activate: vi.fn((s: string) => mark('up:' + s)()),
    observe: vi.fn(mark('observe')),
    attestCandidate: vi.fn(mark('candidate')),
    installBaseline: vi.fn(mark('baseline')),
    attestInstalledBaseline: vi.fn(mark('installed')),
    releaseDeliveryGate: vi.fn(() => {
      marker = 'RELEASED';
      return mark('released')();
    }),
    releaseFence: vi.fn(mark('commit')),
    restoreSecrets: vi.fn(mark('restore-secrets')),
    restore: vi.fn((s: string) => mark('restore:' + s)()),
    removeCandidateBaseline: vi.fn(mark('remove-baseline')),
    attestPrevious: vi.fn(mark('previous')),
  };
  return {
    op,
    events,
    phase: () => phase,
    setReleased: () => {
      marker = 'RELEASED';
    },
  };
}
describe('notification V3 preserves existing Android with a separate completed-migration identity', () => {
  it('binds the new manifest while retaining the actually executed old migrator', () => {
    const f = preservedFixture();
    expect(() => validateApiWorkerOperation(f.op)).not.toThrow();
    expect(() => assertPlan(f.plan, f.op, f.operationBytes)).not.toThrow();
    expect(f.plan.migratorImage).not.toBe(f.op.publishedMigratorImage);
    const images = [
      { component: 'api', digest: f.op.apiImage.split('@')[1] },
      { component: 'worker', digest: f.op.workerImage.split('@')[1] },
      { component: 'migrator', digest: f.op.publishedMigratorImage.split('@')[1] },
    ];
    expect(() =>
      validateNotificationManifest(f.op, {
        gitCommit: f.op.candidateSha,
        gitTree: f.op.candidateTree,
        images,
      }),
    ).not.toThrow();
    images[2]!.digest = f.plan.migratorImage.split('@')[1];
    expect(() =>
      validateNotificationManifest(f.op, {
        gitCommit: f.op.candidateSha,
        gitTree: f.op.candidateTree,
        images,
      }),
    ).toThrow();
    expect(overlay(f.plan, 'candidate', 'worker')).toContain(
      'TIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
    );
    expect(
      apiWorkerComposeArgs('baseline', 'overlay', 'up', 'worker', 'gate.compose.json'),
    ).toContain('gate.compose.json');
    expect(apiWorkerComposeArgs('baseline', 'overlay', 'up', 'worker')).not.toContain(
      'gate.compose.json',
    );
  });
  it.each(['migratorImage', 'completedMigrationSha256', 'androidGate'])(
    'rejects mixed plan %s',
    (key) => {
      const f = preservedFixture();
      const p = {
        ...f.plan,
        [key]:
          key === 'androidGate'
            ? { ...f.op.androidGate, snapshotSha256: '0'.repeat(64) }
            : '0'.repeat(64),
      };
      expect(() => assertPlan(p, f.op, f.operationBytes)).toThrow();
    },
  );
  it.each(['controllerSha', 'candidateSha', 'packageDescriptorSha256', 'migrationPlanSha256'])(
    'rejects mixed operation %s',
    (key) => {
      const f = preservedFixture();
      expect(() =>
        validateNotificationOperation({
          ...f.op,
          [key]: '0'.repeat(key.includes('Sha256') ? 64 : 40),
        }),
      ).toThrow();
    },
  );
  it('rejects a V2 request trying to gain V3 preservation authority', () => {
    const f = preservedFixture();
    expect(() =>
      validateNotificationOperation({
        ...f.op,
        schema: 'PHUB_TIMEWEB_API_WORKER_NOTIFICATION_0105_OPERATION_V2',
      }),
    ).toThrow();
  });
  it('requires exact credential source and active expected state', () => {
    const f = preservedFixture();
    expect(() =>
      validateNotificationOperation({ ...f.op, expectedFcmSource: '/dev/null' }),
    ).toThrow();
    expect(() =>
      validateNotificationOperation({
        ...f.op,
        androidGate: { ...f.op.androidGate, enabledTenantCount: 0, activeProviderCount: 0 },
      }),
    ).toThrow();
  });
  it('accepts exact snapshot; counts alone cannot authorize another tenant/provider/ref/version', () => {
    const { op } = preservedFixture();
    expect(() => assertAndroidGateSnapshot(androidSnapshot(), op.androidGate)).not.toThrow();
    for (const field of ['id', 'tenantId', 'credentialRefSha256', 'updatedAt', 'status']) {
      const snapshot = androidSnapshot();
      const row = snapshot.providers[0]!;
      Object.assign(row, {
        [field]:
          field === 'credentialRefSha256'
            ? '0'.repeat(64)
            : field === 'updatedAt'
              ? '1792554661'
              : field === 'status'
                ? 'DISABLED'
                : 'a3000000-0000-4000-8000-000000000002',
      });
      expect(() => assertAndroidGateSnapshot(snapshot, op.androidGate)).toThrow();
    }
  });
  it('rejects duplicate/out-of-order rows and observes disabled providers', () => {
    const { op } = preservedFixture();
    const snap = androidSnapshot();
    snap.providers.push({ ...snap.providers[0]! });
    expect(() => assertAndroidGateSnapshot(snap, op.androidGate)).toThrow();
    const changed = androidSnapshot();
    changed.providers.push({
      ...changed.providers[0]!,
      id: 'a3000000-0000-4000-8000-000000000003',
      status: 'DISABLED',
    });
    expect(() => assertAndroidGateSnapshot(changed, op.androidGate)).toThrow();
  });
  it('counts every SENDING, including expired leases and disabled accounts/endpoints', () => {
    expect(ANDROID_ALL_SENDING_SQL).toContain("d.state='SENDING'");
    expect(ANDROID_ALL_SENDING_SQL).not.toMatch(/lease_expires_at|status=|android_push_enabled/);
    expect(API_WORKER_PRESERVED_DATABASE_SQL).toContain("'allSending'");
    const f = preservedFixture(),
      db = database();
    expect(() =>
      validateApiWorkerDatabase(db, f.plan.packagedLedger, undefined, f.op),
    ).not.toThrow();
    db.allSending = 1;
    expect(() => validateApiWorkerDatabase(db, f.plan.packagedLedger, undefined, f.op)).toThrow(
      'DATABASE_SAFETY',
    );
    // Forward-only recovery after release may encounter existing at-least-once traffic.
    expect(() =>
      validateApiWorkerDatabase(db, f.plan.packagedLedger, undefined, f.op, false),
    ).not.toThrow();
  });
  it('keeps the legacy zero guard and tenant/ledger fence strict', () => {
    const f = preservedFixture(),
      db = database();
    const legacy = Object.fromEntries(
      Object.entries(db).filter(([key]) => !['androidSnapshot', 'allSending'].includes(key)),
    );
    expect(() => validateApiWorkerDatabase(legacy, f.plan.packagedLedger)).toThrow(
      'DATABASE_SAFETY',
    );
    expect(() =>
      validateApiWorkerDatabase(
        { ...db, tenantFingerprint: 'b'.repeat(32) },
        f.plan.packagedLedger,
        db,
        f.op,
      ),
    ).toThrow('DATABASE_DRIFT');
    expect(() =>
      validateApiWorkerDatabase(
        { ...db, ledger: db.ledger.slice(1) },
        f.plan.packagedLedger,
        undefined,
        f.op,
      ),
    ).toThrow('LEDGER');
  });
  it.each(COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS)(
    'rejects byte drift in completed input %s',
    (path) => {
      const { op, old } = preservedFixture();
      const plan = {
        backup: op.completedMigration.backup,
        inputs: {
          bootstrapSha256:
            op.completedMigration.compatibility[
              'deploy/timeweb/notification-role-bootstrap-0105.sql'
            ],
          inverseSha256:
            op.completedMigration.compatibility[
              'deploy/timeweb/notification-role-bootstrap-0105-inverse.sql'
            ],
        },
      };
      const read = (p: string) =>
        readFileSync(p.replace('/opt/phub/timeweb-beta/standard/source/', ''));
      expect(() =>
        assertCompletedNotificationInputs(op.completedMigration, old, encoded(old), plan, read),
      ).not.toThrow();
      expect(() =>
        assertCompletedNotificationInputs(op.completedMigration, old, encoded(old), plan, (p) =>
          p.endsWith(path) ? Buffer.from('drift') : read(p),
        ),
      ).toThrow('INPUT_DRIFT');
    },
  );
  it('rejects raw operation substitution and unbound backup proof', () => {
    const { op, old } = preservedFixture();
    const read = (p: string) =>
      readFileSync(p.replace('/opt/phub/timeweb-beta/standard/source/', ''));
    const plan = { backup: op.completedMigration.backup, inputs: {} };
    expect(() =>
      assertCompletedNotificationInputs(
        op.completedMigration,
        old,
        Buffer.from(' ' + encoded(old).toString('utf8')),
        plan,
        read,
      ),
    ).toThrow('OPERATION');
    expect(() =>
      assertCompletedNotificationInputs(
        op.completedMigration,
        old,
        encoded(old),
        { ...plan, backup: { ...plan.backup, sha256: '0'.repeat(64) } },
        read,
      ),
    ).toThrow('BACKUP_BINDING');
  });
  it('binds post-stop proof to exact plan, worker and snapshot', () => {
    const f = preservedFixture(),
      hash = sha256(f.planBytes);
    const proof = {
      schema: 'PHUB_FCM_DRAIN_PROOF_V1',
      planSha256: hash,
      snapshotSha256: f.op.androidGate.snapshotSha256,
      workerId: f.op.expectedWorker.id,
      sendingCount: 0,
      observedAt: '2026-10-22T12:01:00.000Z',
    };
    expect(() => validateFcmDrainProof(proof, f.op, hash)).not.toThrow();
    for (const change of [
      { sendingCount: 1 },
      { workerId: '0'.repeat(64) },
      { snapshotSha256: '0'.repeat(64) },
      { planSha256: '0'.repeat(64) },
    ])
      expect(() => validateFcmDrainProof({ ...proof, ...change }, f.op, hash)).toThrow();
  });
  it('does not accept V3 success without drain and both token hashes', () => {
    const f = preservedFixture();
    expect(() =>
      validateApiWorkerReceipt(
        {
          schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V3',
          status: 'SUCCESS',
          planSha256: sha256(f.planBytes),
          observedAt: '2026-10-22T12:20:00.000Z',
        },
        sha256(f.planBytes),
        f.op,
      ),
    ).toThrow();
  });
});
describe('V3 crash/recovery ordering', () => {
  it('holds before pull, drains after stop and releases only after observation/baseline/intent', async () => {
    const f = transition();
    await runApiWorkerTransition(f.op);
    expect(f.events).toEqual([
      'preflight',
      'GATE_PREPARE_INTENT',
      'held',
      'pull',
      'PREPARED',
      'WORKER_STOP_INTENT',
      'stop',
      'WORKER_STOPPED',
      'drain',
      'FCM_DRAIN_VERIFIED',
      'secrets',
      'SECRETS_VERIFIED',
      'API_INTENT',
      'up:api',
      'API_ACTIVE',
      'WORKER_INTENT',
      'up:worker',
      'WORKER_ACTIVE',
      'OBSERVING',
      'observe',
      'candidate',
      'BASELINE_INTENT',
      'baseline',
      'GATE_RELEASE_INTENT',
      'released',
      'commit',
      'SUCCESS',
    ]);
  });
  it('an old claim race blocks candidate activation and restores old at-least-once recovery without clearing a lease', async () => {
    const f = transition();
    f.op.verifyFcmDrain.mockRejectedValue(Error('IN_FLIGHT'));
    await expect(runApiWorkerTransition(f.op)).rejects.toThrow('IN_FLIGHT');
    expect(f.op.activate).not.toHaveBeenCalled();
    expect(f.op.restore).toHaveBeenCalledWith('worker');
    expect(f.op.verifyHeldForRollback).toHaveBeenCalledTimes(1);
  });
  it.each([
    'WORKER_STOP_INTENT',
    'WORKER_STOPPED',
    'FCM_DRAIN_VERIFIED',
    'SECRETS_VERIFIED',
    'API_INTENT',
    'API_ACTIVE',
    'WORKER_INTENT',
    'WORKER_ACTIVE',
    'OBSERVING',
    'BASELINE_INTENT',
  ])('contains and drains before pre-release recovery at %s', async (phase) => {
    const f = transition();
    await expect(recoverApiWorkerPhase(phase, f.op)).resolves.toBe('ROLLED_BACK');
    expect(f.events.indexOf('stop')).toBeLessThan(f.events.indexOf('rollback-drain'));
    expect(f.events.indexOf('rollback-drain')).toBeLessThan(f.events.indexOf('restore:worker'));
    expect(f.op.releaseDeliveryGate).not.toHaveBeenCalled();
  });
  it.each(['GATE_RELEASE_INTENT', 'SUCCESS'])(
    'only forward-completes after %s, even with released token and provider work',
    async (phase) => {
      const f = transition();
      f.setReleased();
      await expect(recoverApiWorkerPhase(phase, f.op)).resolves.toBe('SUCCESS');
      expect(f.events).toEqual(['candidate', 'installed', 'released', 'commit', 'SUCCESS']);
      expect(f.op.containWorker).not.toHaveBeenCalled();
      expect(f.op.restore).not.toHaveBeenCalled();
    },
  );
  it.each(['release', 'commit', 'success-ack'])(
    'never rolls back after ambiguous %s',
    async (boundary) => {
      const f = transition();
      if (boundary === 'release') f.op.releaseDeliveryGate.mockRejectedValueOnce(Error('ACK_LOST'));
      if (boundary === 'commit') f.op.releaseFence.mockRejectedValueOnce(Error('ACK_LOST'));
      if (boundary === 'success-ack')
        f.op.journal.mockImplementation((p) => {
          f.events.push(p);
          return p === 'SUCCESS' ? Promise.reject(Error('ACK_LOST')) : Promise.resolve();
        });
      if (boundary === 'success-ack') f.op.recoveryPhase = () => Promise.resolve('SUCCESS');
      await expect(runApiWorkerTransition(f.op)).rejects.toThrow('ACK_LOST');
      expect(f.op.restore).not.toHaveBeenCalled();
      expect(f.op.containWorker).toHaveBeenCalledTimes(1);
    },
  );
  it('re-reads durable intent when its write acknowledgment is lost', async () => {
    const f = transition();
    const write = f.op.journal.getMockImplementation()!;
    f.op.journal.mockImplementation(async (p) => {
      await write(p);
      if (p === 'GATE_RELEASE_INTENT') throw Error('ACK_LOST');
    });
    await expect(runApiWorkerTransition(f.op)).rejects.toThrow('ACK_LOST');
    expect(f.op.restore).not.toHaveBeenCalled();
    expect(f.op.releaseDeliveryGate).toHaveBeenCalledTimes(1);
  });
  it('holds on unknown candidate/marker after intent without selecting rollback', async () => {
    const f = transition();
    f.op.attestCandidate.mockRejectedValue(Error('UNKNOWN'));
    await expect(recoverApiWorkerPhase('GATE_RELEASE_INTENT', f.op)).rejects.toThrow('UNKNOWN');
    expect(f.op.restore).not.toHaveBeenCalled();
    expect(f.op.releaseDeliveryGate).not.toHaveBeenCalled();
  });
  it('refuses rollback if released evidence contradicts the phase', async () => {
    const f = transition();
    f.setReleased();
    await expect(recoverApiWorkerPhase('WORKER_ACTIVE', f.op)).rejects.toThrow('ROLLBACK_FAILED');
    expect(f.op.restore).not.toHaveBeenCalled();
  });
});

describe('actual pre-restore rollback boundary with existing SENDING', () => {
  it('drains no lease and restores old Worker after nonzero allSending, binding FIRST proof into terminal receipt', async () => {
    const fixture = preservedFixture(),
      planSha = sha256(fixture.planBytes),
      f = transition();
    let currentSending = 1,
      first: unknown = null;
    const readDatabase = vi.fn((quiescent: boolean) => {
      const db = { ...database(), allSending: currentSending };
      validateApiWorkerDatabase(db, fixture.plan.packagedLedger, undefined, fixture.op, quiescent);
      return Promise.resolve(db);
    });
    const write = vi.fn((proof: unknown) => {
      first = proof;
    });
    const io = {
      readGateState: () => 'HELD',
      readDatabase,
      readFirstProof: () => first,
      writeFirstProof: write,
      now: () => '2026-10-22T12:01:00.000Z',
    };
    f.op.verifyFcmDrain.mockImplementation(async () => {
      await readDatabase(true);
    });
    f.op.verifyHeldForRollback.mockImplementation(async () => {
      await verifyFcmHeldRollback(fixture.op, planSha, io);
    });
    const journal = f.op.journal.getMockImplementation()!;
    f.op.journal.mockImplementation(async (phase) => {
      await journal(phase);
      if (phase === 'ROLLED_BACK') {
        validateApiWorkerReceipt(
          {
            schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V3',
            status: phase,
            planSha256: planSha,
            observedAt: io.now(),
            rollbackFcmSha256: sha256(encoded(first)),
          },
          planSha,
          fixture.op,
        );
      }
    });
    await expect(runApiWorkerTransition(f.op)).rejects.toThrow('DATABASE_SAFETY');
    expect(f.op.activate).not.toHaveBeenCalled();
    expect(f.op.restore).toHaveBeenCalledWith('worker');
    expect(readDatabase).toHaveBeenLastCalledWith(false);
    expect(first).toMatchObject({ allSending: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    // Simulate crash after old Worker restarted but before durable ROLLED_BACK; it has claimed work.
    currentSending = 3;
    await expect(recoverApiWorkerPhase('PREVIOUS_SECRETS_VERIFIED', f.op)).resolves.toBe(
      'ROLLED_BACK',
    );
    expect(readDatabase).toHaveBeenLastCalledWith(false);
    expect(first).toMatchObject({ allSending: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.op.containWorker).toHaveBeenCalledTimes(3);
    first = { ...(first as object), planSha256: '0'.repeat(64) };
    const restores = f.op.restore.mock.calls.length;
    await expect(recoverApiWorkerPhase('PREVIOUS_SECRETS_VERIFIED', f.op)).rejects.toThrow(
      'ROLLBACK_FAILED',
    );
    expect(f.op.restore.mock.calls.length).toBe(restores);
  });
});
