import { describe, expect, it } from 'vitest';
import {
  JOIN_OPERATION,
  JOIN_PLAN,
  JOIN_RECEIPT,
  JOIN_INSTALLED_KIND,
  joinHash,
  validateJoinOperation,
  validateJoinRuntimeTail,
  validateJoinNotificationBinding,
  validateJoinBackupLedger,
  validateJoinRunningEnvironment,
  validateJoinReceipt,
  buildJoinInstalledDescriptor,
  validateJoinObservation,
} from './timeweb-join-dormant-profile.js';
const sha = (c: string) => c.repeat(40),
  hash = (c: string) => c.repeat(64);
const image = (service: string, c: string) => `ghcr.io/z6v6e6r/phub-${service}@sha256:${hash(c)}`;
const id = (c: string) => `${sha(c)}-123-1`;
function operation() {
  const op = {
    schema: JOIN_OPERATION,
    target: 'lk2.padlhub.su',
    controllerSha: sha('a'),
    candidateSha: sha('b'),
    candidateTree: sha('c'),
    sourceCiRunId: '123',
    publicationRunId: '124',
    artifactId: '125',
    artifactDigest: `sha256:${hash('d')}`,
    manifestSha256: hash('e'),
    expectedApi: { id: hash('f'), image: image('api', '1'), releaseId: id('2') },
    expectedWeb: { id: hash('3'), image: image('web', '4'), releaseId: id('5') },
    expectedCurrentSecretSetReleaseId: id('6'),
    candidateSecretHashes: Object.fromEntries(
      ['.release-identity.json', 'api.env', 'worker.env', 'realtime.env', 'migrator.env'].map(
        (k) => [k, hash('7')],
      ),
    ),
    verifierPublicKeySha256: hash('8'),
    notificationBundleSha256: hash('9'),
    expectedExcludedSha256: hash('0'),
    expiresAt: '2026-10-23T10:00:00.000Z',
    confirmation: '',
  };
  op.confirmation = `DEPLOY_DORMANT_JOIN_API_WEB_${op.candidateSha.slice(0, 12).toUpperCase()}_FROM_${op.expectedApi.releaseId.slice(0, 12).toUpperCase()}_NO_JOIN_NO_PROVIDER_WRITES`;
  return op;
}
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
function notification() {
  const op = operation(),
    values = {
      PHUB_COMPONENT_ROLLOUT_KIND: 'API_WORKER_NOTIFICATION_0105',
      PHUB_RELEASE_ID: op.expectedApi.releaseId,
      PHUB_RUNTIME_SECRET_SET_RELEASE_ID: op.expectedCurrentSecretSetReleaseId,
      WEB_IMAGE_DIGEST: `sha256:${hash('4')}`,
      WORKER_IMAGE_DIGEST: `sha256:${hash('a')}`,
    };
  const web = {
    id: op.expectedWeb.id,
    image: op.expectedWeb.image,
    imageId: `sha256:${hash('4')}`,
    restarts: 0,
    startedAt: '2026-10-23T07:00:00.000Z',
    status: 'running',
    health: 'healthy',
  };
  const worker = {
    ...web,
    id: hash('b'),
    image: image('worker', 'a'),
    imageId: `sha256:${hash('a')}`,
  };
  const postgres = {
    ...web,
    id: hash('c'),
    image: `docker.io/library/postgres@sha256:${hash('d')}`,
  };
  const operationBytes = bytes({ syntheticNotificationOperation: true }),
    plan = bytes({ excluded: [web, postgres] }),
    descriptor = bytes({ synthetic: true }),
    observation = bytes({ synthetic: true });
  const receipt = {
    schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V2',
    status: 'RECONCILED',
    reconciledStatus: 'SUCCESS',
    planSha256: joinHash(plan),
    installedBaselineSha256: joinHash(descriptor),
    observationSha256: joinHash(observation),
  };
  const bundle = {
    operation: operationBytes,
    plan,
    descriptor,
    observation,
    receipt: bytes(receipt),
    capsule: bytes({
      schema: 'PHUB_TIMEWEB_API_WORKER_CAPSULE_V1',
      operation: operationBytes.toString('base64'),
      plan: plan.toString('base64'),
    }),
    apiIdentity: bytes(op.expectedApi),
    workerIdentity: bytes(worker),
  };
  const bind = () => {
    op.notificationBundleSha256 = joinHash(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(bundle)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, joinHash(v)]),
        ),
      ),
    );
  };
  bind();
  return { op, values, bundle, worker, postgres, receipt, bind, excluded: [worker, postgres] };
}
describe('bounded dormant JOIN profile', () => {
  it('requires exact explicit identity and a bounded fresh authority', () => {
    const op = operation();
    expect(validateJoinOperation(op, true, Date.parse('2026-10-23T09:30:00Z'))).toBe(op);
    expect(() => validateJoinOperation(op, true, Date.parse('2026-10-23T10:00:00Z'))).toThrow();
    expect(() => validateJoinOperation(op, true, Date.parse('2026-10-23T08:00:00Z'))).toThrow();
    expect(() => validateJoinOperation({ ...op, confirmation: 'DEPLOY_API_WEB' })).toThrow();
    expect(() => validateJoinOperation({ ...op, profile: 'beta' })).toThrow();
  });
  it.each([
    'controllerSha',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'manifestSha256',
    'verifierPublicKeySha256',
    'notificationBundleSha256',
    'expectedExcludedSha256',
  ])('rejects invalid %s', (key) => {
    expect(() => validateJoinOperation({ ...operation(), [key]: 'invalid' })).toThrow();
  });
  it('rejects unreviewed runtime changes, symlinks, renames, deletion and mode drift', () => {
    const e = {
      path: 'scripts/timeweb-join-dormant-profile.js',
      status: 'A',
      oldMode: '000000',
      newMode: '100644',
      oldOid: '0'.repeat(40),
      newOid: sha('a'),
      oldType: null,
      newType: 'blob',
    };
    validateJoinRuntimeTail([e]);
    for (const change of [
      { path: 'apps/api/src/main.ts' },
      { path: 'deploy/timeweb/compose.beta.yaml' },
      { path: 'package-lock.json' },
      { newMode: '120000' },
      { newType: 'tree' },
      { status: 'R100' },
      { status: 'D' },
    ])
      expect(() => validateJoinRuntimeTail([{ ...e, ...change }])).toThrow();
  });
  it('binds only a fully validated terminal notification bundle and unchanged runtime lineage', () => {
    const f = notification();
    expect(validateJoinNotificationBinding(f.bundle, f.values, f.op, f.excluded)).toBe(
      f.op.notificationBundleSha256,
    );
    const drifted = [{ ...f.worker, id: hash('f') }, f.postgres];
    f.op.expectedExcludedSha256 = joinHash(JSON.stringify(drifted));
    expect(() => validateJoinNotificationBinding(f.bundle, f.values, f.op, drifted)).toThrow(
      'RUNTIME_LINEAGE',
    );
    expect(() =>
      validateJoinNotificationBinding(f.bundle, f.values, f.op, [
        f.worker,
        { ...f.postgres, restarts: 1 },
      ]),
    ).toThrow('RUNTIME_LINEAGE');
    expect(() =>
      validateJoinNotificationBinding(
        f.bundle,
        f.values,
        { ...f.op, expectedWeb: { ...f.op.expectedWeb, id: hash('0') } },
        f.excluded,
      ),
    ).toThrow();
  });
  it.each(['SUCCESS', 'ROLLED_BACK', 'ROLLBACK_FAILED'])(
    'rejects a notification receipt with status %s even with a matching bundle hash',
    (status) => {
      const f = notification();
      f.bundle.receipt = bytes({ ...f.receipt, status });
      f.bind();
      expect(() => validateJoinNotificationBinding(f.bundle, f.values, f.op, f.excluded)).toThrow(
        'NOTIFICATION_BASELINE',
      );
    },
  );
  it('rejects foreign/noncanonical capsules and observation or descriptor drift', () => {
    for (const field of ['capsule', 'observation', 'descriptor'] as const) {
      const f = notification();
      f.bundle[field] = bytes({ foreign: true });
      f.bind();
      expect(() => validateJoinNotificationBinding(f.bundle, f.values, f.op, f.excluded)).toThrow();
    }
    const f = notification();
    f.bundle.capsule = Buffer.from(
      '{"schema":"PHUB_TIMEWEB_API_WORKER_CAPSULE_V1","operation":"AA==","operation":"AA==","plan":"AA=="}',
    );
    f.bind();
    expect(() => validateJoinNotificationBinding(f.bundle, f.values, f.op, f.excluded)).toThrow();
  });
  it('rejects pre0105, degraded, missing and mismatched backup ledgers', () => {
    for (const v of [
      undefined,
      {},
      { restoreVerified: false },
      { restoreVerified: true, sourceLedgerSha256: hash('a'), restoredLedgerSha256: hash('a') },
    ])
      expect(() => validateJoinBackupLedger(v)).toThrow();
  });
  it('requires actual process flags and all selected env values to stay dormant', () => {
    const expected = {
      SUBSCRIPTION_RUNTIME_WARN_MODE: 'OFF',
      GAME_COMMERCIAL_JOIN_ENABLED: 'false',
      VIVA_MODE: 'production',
    };
    validateJoinRunningEnvironment({ ...expected, NODE_ENV: 'production' }, expected);
    for (const extra of [
      { GAME_COMMERCIAL_JOIN_ENABLED: 'true' },
      { SUBSCRIPTION_RUNTIME_WARN_MODE: 'WARN' },
      { VIVA_MODE: 'mock' },
      { SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID: 'foreign' },
    ])
      expect(() => validateJoinRunningEnvironment({ ...expected, ...extra }, expected)).toThrow();
  });
  it('binds new receipt phases to the new operation and sealed plan only', () => {
    const op = operation(),
      plan = {
        schema: JOIN_PLAN,
        controllerSha: op.controllerSha,
        operationSha256: joinHash(bytes(op)),
      },
      pb = bytes(plan);
    const r = {
      schema: JOIN_RECEIPT,
      status: 'SECRET_SWAP_INTENT',
      planSha256: joinHash(pb),
      observedAt: '2026-10-23T09:30:00.000Z',
    };
    expect(validateJoinReceipt(r, joinHash(pb), op, plan, pb)).toBe(r);
    for (const v of [
      { ...r, status: 'MIGRATION_INTENT' },
      { ...r, extra: true },
      { ...r, planSha256: hash('a') },
    ])
      expect(() => validateJoinReceipt(v, joinHash(pb), op, plan, pb)).toThrow();
    expect(() =>
      validateJoinReceipt(
        r,
        joinHash(pb),
        { ...op, schema: 'PHUB_TIMEWEB_API_WEB_OPERATION_V1' },
        plan,
        pb,
      ),
    ).toThrow();
  });
  it('publishes an installed descriptor, preserving Worker/Realtime and removing canonical claims', () => {
    const plan = {
      candidate: { api: { image: image('api', 'a') }, web: { image: image('web', 'b') } },
      unchangedServiceImages: { worker: image('worker', 'c'), realtime: image('realtime', 'd') },
    };
    const text = buildJoinInstalledDescriptor(
      {
        PHUB_RELEASE_ID: id('2'),
        PHUB_COMPONENT_ROLLOUT_KIND: 'API_WORKER_NOTIFICATION_0105',
        PHUB_CANONICAL_MANIFEST_SHA256: hash('e'),
        PHUB_PUBLICATION_RUN_ID: '1',
        API_RUNTIME_DIGEST: `sha256:${hash('f')}`,
      },
      plan,
      id('3'),
      '/receipt',
    ).toString();
    expect(text).toContain(`PHUB_COMPONENT_ROLLOUT_KIND=${JOIN_INSTALLED_KIND}`);
    expect(text).toContain(`PHUB_RUNTIME_SECRET_SET_RELEASE_ID=${id('3')}`);
    expect(text).toContain(`WORKER_IMAGE_DIGEST=sha256:${hash('c')}`);
    expect(text).not.toMatch(/CANONICAL|PUBLICATION|RUNTIME_DIGEST/);
  });
});

describe('JOIN measured observation custody', () => {
  function fixture() {
    const op = operation(),
      plan = { operationSha256: hash('a'), createdAt: '2026-10-23T09:00:00.000Z' };
    const sample = {
      privateMs: Array(61).fill(100),
      publicMs: Array(61).fill(200),
      timestamps: Array.from({ length: 61 }, (_, i) =>
        new Date(Date.parse(plan.createdAt) + i * 15000).toISOString(),
      ),
      p95PrivateMs: 100,
      p95PublicMs: 200,
    };
    const observation = {
      schema: 'PHUB_TIMEWEB_JOIN_DORMANT_OBSERVATION_V1',
      operationSha256: plan.operationSha256,
      planSha256: hash('b'),
      candidateSha: op.candidateSha,
      startedAt: plan.createdAt,
      completedAt: '2026-10-23T09:15:00.000Z',
      elapsedSeconds: 900,
      samples: { api: structuredClone(sample), web: structuredClone(sample) },
      serverErrors: 0,
    };
    return { op, plan, observation };
  }
  it('accepts measured private/public samples bound to the original authorization and sealed plan', () => {
    const f = fixture();
    expect(validateJoinObservation(f.observation, f.op, f.plan, hash('b'))).toBe(f.observation);
  });
  it.each([
    [
      'operation',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.operationSha256 = hash('c');
      },
    ],
    [
      'plan',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.planSha256 = hash('c');
      },
    ],
    [
      'candidate',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.candidateSha = sha('c');
      },
    ],
    [
      'elapsed',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.elapsedSeconds = 899;
      },
    ],
    [
      'errors',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.serverErrors = 1;
      },
    ],
    [
      'missing public sample',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.samples.api.publicMs.pop();
      },
    ],
    [
      'clustered timestamps',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.samples.web.timestamps[1] = v.samples.web.timestamps[0]!;
      },
    ],
    [
      'forged p95',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.samples.api.p95PublicMs = 0;
      },
    ],
    [
      'public latency at limit',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.samples.web.publicMs.fill(1000);
        v.samples.web.p95PublicMs = 1000;
      },
    ],
    [
      'noncanonical time',
      (v: ReturnType<typeof fixture>['observation']) => {
        v.startedAt = '2026-10-23T09:00:00Z';
      },
    ],
  ])('rejects %s', (_, mutate) => {
    const f = fixture();
    mutate(f.observation);
    expect(() => validateJoinObservation(f.observation, f.op, f.plan, hash('b'))).toThrow();
  });
  it('rejects a measured window before preparation or after authorization expiry', () => {
    const f = fixture();
    expect(() =>
      validateJoinObservation(
        f.observation,
        f.op,
        { ...f.plan, createdAt: f.observation.completedAt },
        hash('b'),
      ),
    ).toThrow();
    expect(() =>
      validateJoinObservation(
        f.observation,
        { ...f.op, expiresAt: '2026-10-23T09:14:00.000Z' },
        f.plan,
        hash('b'),
      ),
    ).toThrow();
    expect(() => validateJoinOperation({ ...f.op, expiresAt: '2026-10-23T10:00:00Z' })).toThrow();
  });
});
