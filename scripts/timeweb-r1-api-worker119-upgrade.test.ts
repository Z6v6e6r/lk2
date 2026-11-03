import { r1ApiWorker119PlanFixture } from './timeweb-r1-api-worker119.fixture.js';
import { encoded, sha256 } from './timeweb-notification-preserved.fixture.js';
import { assertPlan } from './timeweb-api-worker-contract.js';
import {
  observeNotificationRollout,
  validateInstalledApiWorkerEvidence,
} from './timeweb-api-worker-upgrade.js';
import { fcmGateBinding, fcmGateToken } from './timeweb-notification-delivery-gate.js';
import { NOTIFICATION_OBSERVATION_POLICY_SHA256 } from './timeweb-notification-profile.js';
import { describe, expect, it, vi } from 'vitest';
import {
  runApiWorkerTransition,
  recoverApiWorkerPhase,
  assertR1ApiWorkerInactive,
} from './timeweb-api-worker-upgrade.js';
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
    containApi: vi.fn(mark('stop-api')),
    installRuntimeGrants: vi.fn(mark('grants')),
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

describe('R1 API/Worker119 transition through existing kernel', () => {
  it('drains and contains both apps before grants and starts neither before verified grants', async () => {
    const f = transition();
    await runApiWorkerTransition(f.op);
    const ordered = [
      'held',
      'pull',
      'stop',
      'drain',
      'stop-api',
      'grants',
      'secrets',
      'up:api',
      'up:worker',
      'observe',
      'candidate',
      'baseline',
      'released',
      'commit',
      'SUCCESS',
    ];
    let last = -1;
    for (const name of ordered) {
      const i = f.events.indexOf(name);
      expect(i, name).toBeGreaterThan(last);
      last = i;
    }
  });
  it('never replays ambiguous grant execution or restores applications without terminal proof', async () => {
    const f = transition();
    f.op.installRuntimeGrants.mockRejectedValueOnce(Error('lost-ack'));
    f.op.restoreSecrets.mockRejectedValue(Error('R1_GRANT_EXECUTION_UNKNOWN'));
    await expect(runApiWorkerTransition(f.op)).rejects.toThrow('ROLLBACK_FAILED');
    expect(f.op.installRuntimeGrants).toHaveBeenCalledTimes(1);
    expect(f.op.activate).not.toHaveBeenCalled();
    expect(f.op.restore).not.toHaveBeenCalled();
    expect(f.op.releaseDeliveryGate).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe('ROLLBACK_FAILED');
  });
  it.each(['API_STOP_INTENT', 'API_STOPPED', 'GRANTS_INTENT', 'GRANTS_VERIFIED'])(
    'recovery of %s contains both applications before restore and never reapplies grants',
    async (phase) => {
      const f = transition();
      await recoverApiWorkerPhase(phase, f.op);
      expect(f.events.indexOf('stop-api')).toBeLessThan(f.events.indexOf('restore-secrets'));
      expect(f.op.installRuntimeGrants).not.toHaveBeenCalled();
      expect(f.events).toContain('ROLLED_BACK');
    },
  );
  it('blocks rollback completion when restored old Worker gate cannot be attested', async () => {
    const f = transition();
    f.op.attestPrevious.mockRejectedValueOnce(Error('R1_PREVIOUS_GATE_RUNTIME'));
    await expect(recoverApiWorkerPhase('GRANTS_VERIFIED', f.op)).rejects.toThrow('ROLLBACK_FAILED');
    expect(f.events).not.toContain('ROLLED_BACK');
  });
  it('after provider-release intent only reconciles candidate; never restores old sender', async () => {
    const f = transition();
    await recoverApiWorkerPhase('GATE_RELEASE_INTENT', f.op);
    expect(f.op.restore).not.toHaveBeenCalled();
    expect(f.op.installRuntimeGrants).not.toHaveBeenCalled();
    expect(f.events).toContain('candidate');
    expect(f.events).toContain('released');
  });
  it.each([
    'STATION_NOTIFICATIONS_ENABLED',
    'TOURNAMENT_CHAT_NOTIFICATION_DELIVERY_ENABLED',
    'AUTH_PHONE_SUBJECT_LINK_ENABLED',
    'TRAINING_REGISTRATION_ENABLED',
  ])('rejects enabled/blank/duplicate %s in files or actual environment', (flag) => {
    expect(() => assertR1ApiWorkerInactive(flag + '=false')).not.toThrow();
    expect(() => assertR1ApiWorkerInactive('UNRELATED=value')).not.toThrow();
    for (const v of ['true', '1', ''])
      expect(() => assertR1ApiWorkerInactive(flag + '=' + v)).toThrow();
    expect(() => assertR1ApiWorkerInactive(flag + '=false\n' + flag + '=true')).toThrow();
  });
});

describe('R1 installed grant custody', () => {
  it('accepts complete evidence, rejects missing/rehashed foreign terminal and unrelated baseline', async () => {
    const f = r1ApiWorker119PlanFixture();
    expect(() => assertPlan(f.plan, f.op, f.operationBytes)).not.toThrow();
    expect(() =>
      assertPlan(
        {
          ...f.plan,
          baselinePath:
            '/opt/phub/timeweb-beta/releases/' + 'f'.repeat(40) + '-41-1/installed-components.env',
        },
        f.op,
        f.operationBytes,
      ),
    ).toThrow();
    const id = f.op.candidateSha + '-' + f.op.publicationRunId + '-1',
      tx = '/opt/phub/timeweb-beta/backups/' + id + '-api-worker';
    const values = {
      PHUB_RELEASE_ID: id,
      PHUB_COMPONENT_ROLLOUT_KIND: 'API_WORKER_R1_119',
      PHUB_COMPONENT_ROLLOUT_RECEIPT: tx + '/rollout-receipt.json',
      PHUB_WORKER_DELIVERY_GATE_RECEIPT: tx + '/rollout-receipt.json',
      PHUB_RUNTIME_SECRET_SET_RELEASE_ID: f.op.expectedCurrentSecretSetReleaseId,
      API_IMAGE_DIGEST: f.op.apiImage.split('@')[1]!,
      WORKER_IMAGE_DIGEST: f.op.workerImage.split('@')[1]!,
      MIGRATOR_IMAGE_DIGEST: f.op.publishedMigratorImage.split('@')[1]!,
      ...f.plan.unchangedImages,
    };
    const bytes = encoded(values),
      binding = fcmGateBinding(f.op, sha256(f.operationBytes), sha256(f.planBytes));
    let clock = Date.parse('2026-11-03T00:00:00Z');
    const observation = encoded(
      await observeNotificationRollout({
        operationSha256: sha256(f.operationBytes),
        planSha256: sha256(f.planBytes),
        attest: async () => {},
        probePublic: () => Promise.resolve({ publicApiMs: 10, publicWebMs: 10 }),
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      }),
    );
    const intent = {
      schema: 'PHUB_R1_RUNTIME_GRANT_EXECUTION_V1',
      operationSha256: sha256(f.operationBytes),
      planSha256: sha256(f.planBytes),
      grantPlanSha256: sha256(encoded(f.plan.runtimeGrants)),
    };
    const evidence: Record<string, Buffer> = {
      'observation.json': observation,
      'fcm-drain.json': encoded({
        schema: 'PHUB_FCM_DRAIN_PROOF_V1',
        planSha256: sha256(f.planBytes),
        snapshotSha256: f.op.androidGate.snapshotSha256,
        workerId: f.op.expectedWorker.id,
        sendingCount: 0,
        observedAt: '2026-11-03T00:00:00.000Z',
      }),
      'fcm-delivery-gate/held.json': Buffer.from(fcmGateToken(binding, 'HELD')),
      'fcm-delivery-gate/released.json': Buffer.from(fcmGateToken(binding, 'RELEASED')),
      'runtime-grant-intent.json': encoded(intent),
      'runtime-grant-terminal.json': encoded({ ...intent, status: 'COMMITTED_CHILD_EXIT_ZERO' }),
    };
    const receipt = {
      schema: 'PHUB_TIMEWEB_R1_API_WORKER119_RECEIPT_V1',
      status: 'SUCCESS',
      planSha256: sha256(f.planBytes),
      observedAt: '2026-11-03T00:20:00.000Z',
      installedBaselineSha256: sha256(bytes),
      observationSha256: sha256(observation),
      observationPolicySha256: NOTIFICATION_OBSERVATION_POLICY_SHA256,
      fcmDrainSha256: sha256(evidence['fcm-drain.json']!),
      fcmGateHeldSha256: sha256(evidence['fcm-delivery-gate/held.json']!),
      fcmGateReleasedSha256: sha256(evidence['fcm-delivery-gate/released.json']!),
      runtimeGrantIntentSha256: sha256(evidence['runtime-grant-intent.json']!),
      runtimeGrantTerminalSha256: sha256(evidence['runtime-grant-terminal.json']!),
    };
    const installed = {
      releaseId: id,
      values,
      bytes,
      receipt,
      planBytes: f.planBytes,
      operationBytes: f.operationBytes,
      evidence,
    };
    expect(() => validateInstalledApiWorkerEvidence(installed)).not.toThrow();
    const missing = { ...evidence };
    delete missing['runtime-grant-terminal.json'];
    expect(() => validateInstalledApiWorkerEvidence({ ...installed, evidence: missing })).toThrow();
    const foreign = encoded({
      ...intent,
      grantPlanSha256: 'f'.repeat(64),
      status: 'COMMITTED_CHILD_EXIT_ZERO',
    });
    expect(() =>
      validateInstalledApiWorkerEvidence({
        ...installed,
        evidence: { ...evidence, 'runtime-grant-terminal.json': foreign },
        receipt: { ...receipt, runtimeGrantTerminalSha256: sha256(foreign) },
      }),
    ).toThrow('INSTALLED_RUNTIME_GRANTS');
  });
});
