import { describe, expect, it, vi } from 'vitest';
import type * as NativeFs from 'node:fs';
import { preservedFixture, encoded, sha256 } from './timeweb-notification-preserved.fixture.js';
import {
  fcmGateBinding,
  fcmGateToken,
  fcmGateComposeOverride,
  fcmGateEnvironment,
  FCM_GATE_TARGET,
} from './timeweb-notification-delivery-gate.js';
import { observeNotificationRollout } from './timeweb-api-worker-upgrade.js';
import { NOTIFICATION_OBSERVATION_POLICY_SHA256 } from './timeweb-notification-profile.js';

describe('installed V3 gate custody across restart and later release', () => {
  it('API/Web-only descriptor carries the retained Worker gate without changing any Worker state', async () => {
    const { buildApiWebInstalledDescriptor } = await import('./timeweb-api-web-upgrade.js');
    const pointer =
      '/opt/phub/timeweb-beta/backups/' + 'a'.repeat(40) + '-100-1-api-worker/rollout-receipt.json';
    const worker = {
      image: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + 'b'.repeat(64),
      mount: { Source: 'retained', RW: false },
      env: { FCM_ROLLOUT_OPERATION_SHA256: 'c'.repeat(64) },
    };
    const before = structuredClone(worker);
    const values = {
      PHUB_WORKER_DELIVERY_GATE_RECEIPT: pointer,
      PHUB_COMPONENT_ROLLOUT_KIND: 'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
      WORKER_IMAGE_DIGEST: 'sha256:' + 'b'.repeat(64),
    };
    const plan = {
      secretSetReleaseId: 'old',
      candidate: { api: { image: 'repo@sha256:api' }, web: { image: 'repo@sha256:web' } },
      unchangedServiceImages: { worker: worker.image },
    };
    const bytes = buildApiWebInstalledDescriptor(
      values,
      plan,
      'web-only',
      'web-receipt',
    ).toString();
    expect(bytes).toContain('PHUB_WORKER_DELIVERY_GATE_RECEIPT=' + pointer + '\n');
    expect(bytes).toContain('PHUB_COMPONENT_ROLLOUT_KIND=API_WEB\n');
    expect(bytes).toContain('WORKER_IMAGE_DIGEST=sha256:' + 'b'.repeat(64) + '\n');
    expect(worker).toEqual(before);
    expect(values.PHUB_COMPONENT_ROLLOUT_KIND).toBe(
      'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
    );
    expect(() =>
      buildApiWebInstalledDescriptor(
        values,
        { ...plan, unchangedServiceImages: { worker: 'foreign' } },
        'web-only',
        'web-receipt',
      ),
    ).toThrow('installed_worker_gate_component_change');
  });
  it('retains exact readonly directory/env/config dependency and rejects recreate without it', async () => {
    const f = preservedFixture(),
      root = '/opt/phub/timeweb-beta',
      id = `${f.op.candidateSha}-${f.op.publicationRunId}-1`,
      tx = `${root}/backups/${id}-api-worker`,
      receiptPath = `${tx}/rollout-receipt.json`,
      binding = fcmGateBinding(f.op, sha256(f.operationBytes), sha256(f.planBytes)),
      directory = `${tx}/fcm-delivery-gate`;
    let clock = Date.parse('2026-10-22T12:00:00.000Z');
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
    const drain = encoded({
      schema: 'PHUB_FCM_DRAIN_PROOF_V1',
      planSha256: sha256(f.planBytes),
      snapshotSha256: f.op.androidGate.snapshotSha256,
      workerId: f.op.expectedWorker.id,
      sendingCount: 0,
      observedAt: '2026-10-22T12:00:00.000Z',
    });
    const values = {
      ...f.plan.unchangedImages,
      PHUB_RELEASE_ID: id,
      PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
      PHUB_COMPONENT_ROLLOUT_KIND: 'API_WORKER_NOTIFICATION_0105_PRESERVED_ANDROID',
      PHUB_COMPONENT_ROLLOUT_RECEIPT: receiptPath,
      PHUB_WORKER_DELIVERY_GATE_RECEIPT: receiptPath,
      PHUB_RUNTIME_SECRET_SET_RELEASE_ID: f.op.expectedCurrentSecretSetReleaseId,
      API_IMAGE_DIGEST: f.op.apiImage.split('@')[1]!,
      WORKER_IMAGE_DIGEST: f.op.workerImage.split('@')[1]!,
      MIGRATOR_IMAGE_DIGEST: f.op.completedMigration.migratorImage.split('@')[1]!,
    };
    const descriptor = Buffer.from(
      Object.entries(values)
        .map(([k, v]) => k + '=' + v)
        .join('\n') + '\n',
    );
    const receipt = {
      schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V3',
      status: 'RECONCILED',
      reconciledStatus: 'SUCCESS',
      planSha256: sha256(f.planBytes),
      observedAt: '2026-10-22T12:20:00.000Z',
      installedBaselineSha256: sha256(descriptor),
      observationSha256: sha256(observation),
      observationPolicySha256: NOTIFICATION_OBSERVATION_POLICY_SHA256,
      fcmDrainSha256: sha256(drain),
      fcmGateHeldSha256: sha256(fcmGateToken(binding, 'HELD')),
      fcmGateReleasedSha256: sha256(fcmGateToken(binding, 'RELEASED')),
    };
    const config = 'f'.repeat(64);
    const worker = {
      Id: 'a'.repeat(64),
      Image: 'sha256:' + 'b'.repeat(64),
      Config: {
        Image: f.op.workerImage,
        Env: Object.entries(fcmGateEnvironment(binding)).map(([k, v]) => k + '=' + v),
        Labels: {
          'com.docker.compose.config-hash': config,
          'org.opencontainers.image.revision': f.op.candidateSha,
        },
      },
      State: {
        Status: 'running',
        Health: { Status: 'healthy' },
        StartedAt: '2026-10-22T12:20:00.000Z',
      },
      RestartCount: 0,
      Mounts: [{ Destination: FCM_GATE_TARGET, Source: directory, Type: 'bind', RW: false }],
    };
    const files = new Map<string, Buffer>([
      [`${tx}/operation.json`, f.operationBytes],
      [`${tx}/plan.json`, f.planBytes],
      [receiptPath, encoded(receipt)],
      [`${tx}/observation.json`, observation],
      [`${tx}/fcm-drain.json`, drain],
      [`${directory}/held.json`, Buffer.from(fcmGateToken(binding, 'HELD'))],
      [`${directory}/released.json`, Buffer.from(fcmGateToken(binding, 'RELEASED'))],
      [
        `${tx}/candidate-worker-gate.compose.json`,
        Buffer.from(fcmGateComposeOverride(directory, binding)),
      ],
      [`${tx}/candidate-worker.config-hash`, Buffer.from(config + '\n')],
      [`${tx}/candidate-worker.identity.json`, encoded({ imageId: worker.Image })],
      [`${root}/releases/${id}/installed-components.env`, descriptor],
    ]);
    const stat = (path: string) => ({
      uid: 0,
      gid: 0,
      mode: files.has(path)
        ? path.startsWith(directory + '/')
          ? 0o644
          : 0o600
        : path === directory
          ? 0o755
          : 0o700,
      nlink: 1,
      ino: 1,
      dev: 1,
      size: files.get(path)?.length ?? 0,
      isSymbolicLink: () => false,
      isDirectory: () => !files.has(path),
      isFile: () => files.has(path),
    });
    vi.doMock('node:fs', async (original) => {
      const fs = await original<typeof NativeFs>();
      return {
        ...fs,
        existsSync: (p: string) => files.has(p),
        lstatSync: stat,
        openSync: (p: string) => p,
        fstatSync: stat,
        closeSync: () => {},
        readdirSync: () => ['held.json', 'released.json'],
        readFileSync: (p: string, encoding?: string) => {
          const bytes = files.get(p);
          return bytes ? (encoding ? bytes.toString('utf8') : bytes) : fs.readFileSync(p);
        },
      };
    });
    vi.doMock('node:child_process', async (original) => ({
      ...(await original<object>()),
      execFileSync: (_program: string, args: string[]) =>
        args[0] === 'ps' ? worker.Id : JSON.stringify([worker]),
    }));
    try {
      vi.resetModules();
      const { readInstalledWorkerGate } = await import('./timeweb-api-web-upgrade.js');
      expect(readInstalledWorkerGate(receiptPath, f.op.workerImage)).toMatchObject({
        directory,
        configHash: config,
      });
      // Existing mount/env survive Docker restart / host restart. Identity id/restart time may move.
      worker.RestartCount = 1;
      worker.Id = 'c'.repeat(64);
      expect(() => readInstalledWorkerGate(receiptPath, f.op.workerImage)).not.toThrow();
      const goodEnv = worker.Config.Env;
      worker.Config.Env = [];
      expect(() => readInstalledWorkerGate(receiptPath, f.op.workerImage)).toThrow('ENVIRONMENT');
      worker.Config.Env = goodEnv;
      worker.Mounts[0]!.RW = true;
      expect(() => readInstalledWorkerGate(receiptPath, f.op.workerImage)).toThrow('MOUNT');
      worker.Mounts[0]!.RW = false;
      worker.Config.Labels['com.docker.compose.config-hash'] = '0'.repeat(64);
      expect(() => readInstalledWorkerGate(receiptPath, f.op.workerImage)).toThrow(
        'installed_worker_gate_runtime',
      );
      worker.Config.Labels['com.docker.compose.config-hash'] = config;
      files.set(
        `${directory}/released.json`,
        Buffer.from(fcmGateToken({ ...binding, operationSha256: '0'.repeat(64) }, 'RELEASED')),
      );
      expect(() => readInstalledWorkerGate(receiptPath, f.op.workerImage)).toThrow();
    } finally {
      vi.doUnmock('node:fs');
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});
