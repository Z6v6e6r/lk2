import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JOIN_OPERATION,
  JOIN_PLAN,
  JOIN_RECEIPT,
  JOIN_INSTALLED_KIND,
  JOIN_CONTROLLER_FILES,
  joinHash,
  validateJoinOperation,
  validateJoinRuntimeTail,
  validateJoinNotificationBinding,
  validateJoinNotificationSnapshot,
  validateJoinBackupLedger,
  validateJoinRunningEnvironment,
  validateJoinReceipt,
  buildJoinInstalledDescriptor,
  validateJoinObservation,
  JOIN_POST105_BACKUP_SCHEMA,
  JOIN_POST105_BACKUP_RECEIPT,
  JOIN_POST105_BACKUP_TERMINAL,
  validateJoinPost105BackupBundle,
  validateJoinPost105BackupOperation,
} from './timeweb-join-dormant-profile.js';
const sha = (c: string) => c.repeat(40),
  hash = (c: string) => c.repeat(64);
const image = (service: string, c: string) => `ghcr.io/z6v6e6r/phub-${service}@sha256:${hash(c)}`;
const id = (c: string) => `${sha(c)}-123-1`;
const notificationRecoveryBridge = () =>
  [
    {
      path: 'scripts/run-timeweb-standard-delivery.js',
      oldOid: '8489049616f991e019b70a8199fcaa5dd4650aa8',
      newOid: '13cae992f42fb040f221299eecb09ca98896ac39',
    },
    {
      path: 'scripts/timeweb-api-worker-migration.d.ts',
      oldOid: '9f776e939e9880fecf65738ec4c4f52923afe591',
      newOid: '02465a0e0f2812efc547380729405199fda5e3f1',
    },
  ].map((row) => ({
    ...row,
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    oldType: 'blob',
    newType: 'blob',
  }));
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
    post105BackupOperationSha256: hash('a'),
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
    validateJoinRuntimeTail([{ ...e, path: 'scripts/rehearse-timeweb-backup-early-exit.py' }]);
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
  it('accepts the exact PR468 source pair without opening either editable path', () => {
    const pair = notificationRecoveryBridge();
    validateJoinRuntimeTail(pair);
    validateJoinRuntimeTail([...pair].reverse());
    validateJoinRuntimeTail([
      ...pair,
      { ...pair[0], path: 'scripts/timeweb-join-dormant-profile.js' },
    ]);
    for (const row of pair) {
      expect(JOIN_CONTROLLER_FILES.has(row.path)).toBe(false);
      const source = readFileSync(new URL('../' + row.path, import.meta.url));
      const oid = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
      expect(oid).toBe(row.newOid);
    }
  });
  it('rejects incomplete or duplicated compatibility pairs', () => {
    const pair = notificationRecoveryBridge();
    for (const entries of [[pair[0]], [pair[1]], [pair[0], pair[0]], [...pair, pair[1]]])
      expect(() => validateJoinRuntimeTail(entries)).toThrow('JOIN_DORMANT_RUNTIME_TAIL');
  });
  it.each([
    { oldOid: sha('a') },
    { newOid: sha('a') },
    { status: 'A' },
    { status: 'D' },
    { status: 'R100' },
    { oldMode: '100755' },
    { newMode: '100755' },
    { newMode: '120000' },
    { oldType: 'tree' },
    { newType: 'commit' },
  ])('rejects compatibility tuple drift %j on either path', (change) => {
    for (const index of [0, 1]) {
      const pair = notificationRecoveryBridge();
      const drifted = pair.map((row, i) => (i === index ? { ...row, ...change } : row));
      expect(() => validateJoinRuntimeTail(drifted)).toThrow('JOIN_DORMANT_RUNTIME_TAIL');
    }
  });
  it.each(['apps/api/src/main.ts', 'deploy/timeweb/migrations/0106.sql', 'package-lock.json'])(
    'rejects unrelated runtime change beside a valid compatibility pair: %s',
    (path) => {
      const pair = notificationRecoveryBridge();
      expect(() => validateJoinRuntimeTail([...pair, { ...pair[0], path }])).toThrow(
        'JOIN_DORMANT_RUNTIME_TAIL',
      );
    },
  );
  it('binds full forward API/Web snapshots and the original secret inode set', () => {
    const f = notification();
    const plan = JSON.parse(f.bundle.plan.toString()) as {
      excluded: {
        id: string;
        image: string;
        imageId: string;
        restarts: number;
        startedAt: string;
        status: string;
        health: string;
      }[];
      previousSecrets: {
        releaseId: string;
        directory: { ino: number };
        files: { synthetic: string };
      };
    };
    plan.previousSecrets = {
      releaseId: f.op.expectedCurrentSecretSetReleaseId,
      directory: { ino: 42 },
      files: { synthetic: hash('a') },
    };
    f.bundle.plan = bytes(plan);
    f.bundle.capsule = bytes({
      schema: 'PHUB_TIMEWEB_API_WORKER_CAPSULE_V1',
      operation: f.bundle.operation.toString('base64'),
      plan: f.bundle.plan.toString('base64'),
    });
    f.receipt.planSha256 = joinHash(f.bundle.plan);
    f.bundle.receipt = bytes(f.receipt);
    const api = {
      ...f.op.expectedApi,
      imageId: 'sha256:' + hash('1'),
      revision: sha('2'),
      restarts: 0,
      startedAt: '2026-10-23T07:00:00.000Z',
    };
    f.bundle.apiIdentity = bytes(api);
    f.bind();
    const snapshot = {
      api,
      web: { ...plan.excluded[0], ...f.op.expectedWeb, revision: sha('5') },
      secretSet: plan.previousSecrets,
      secretSetReleaseId: f.op.expectedCurrentSecretSetReleaseId,
      excluded: f.excluded,
    };
    expect(validateJoinNotificationSnapshot(f.bundle, f.values, f.op, snapshot)).toBe(
      f.op.notificationBundleSha256,
    );
    const post = { ...f.op, schema: JOIN_POST105_BACKUP_SCHEMA, expectedApi: api };
    expect(validateJoinNotificationSnapshot(f.bundle, f.values, post, snapshot)).toBe(
      post.notificationBundleSha256,
    );
    for (const target of ['api', 'web'] as const)
      for (const key of ['id', 'image', 'imageId', 'restarts', 'startedAt']) {
        const bad = structuredClone(snapshot);
        Object.assign(bad[target], { [key]: key === 'restarts' ? 1 : 'changed' });
        expect(() => validateJoinNotificationSnapshot(f.bundle, f.values, post, bad)).toThrow();
      }
    expect(() =>
      validateJoinNotificationSnapshot(f.bundle, f.values, post, {
        ...snapshot,
        secretSet: { ...snapshot.secretSet, directory: { ino: 43 } },
      }),
    ).toThrow();
    expect(() =>
      validateJoinNotificationSnapshot(
        f.bundle,
        f.values,
        { ...post, expectedApi: { ...api, revision: sha('f') } },
        snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateJoinNotificationSnapshot(f.bundle, f.values, { ...post, schema: 'OTHER' }, snapshot),
    ).toThrow();
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

describe('authenticated post-0105 backup for JOIN', () => {
  const now = Date.parse('2026-10-23T10:00:00.000Z');
  function fixture() {
    const join = operation(),
      controllerTree = sha('d');
    const descriptor = readFileSync('deploy/timeweb/notification-migrations-0099-0101.v1.json');
    const golden = readFileSync('deploy/timeweb/notification-migration-catalogs.v1.json');
    const spec = JSON.parse(descriptor.toString()) as {
      steps: { filename: string; checksum: string }[];
      newTables: string[];
    };
    const base = JSON.parse(
      readFileSync('scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json', 'utf8'),
    ) as { ledger: { filename: string; checksum: string }[] };
    const catalogs = JSON.parse(golden.toString()) as {
      checkpoints: Record<string, { rows: unknown[] }>;
    };
    const target = { databaseName: 'synthetic', systemIdentifier: '12345' };
    const state = {
      schema: 'PHUB_NOTIFICATION_DATABASE_STATE_V1',
      phase: 'post',
      target,
      ledger: [
        ...base.ledger,
        ...spec.steps.map(({ filename, checksum }) => ({ filename, checksum })),
      ],
      catalog: catalogs.checkpoints['105']!.rows,
      defaults: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((privilege) => ({
        scope: 'identity',
        type: 'r',
        grantor: 'phub_migrator',
        grantee: 'phub_runtime',
        privilege,
        grantable: false,
      })),
      security: [...spec.newTables].sort().map((name) => ({
        name,
        owner: 'phub_migrator',
        rls: true,
        force: true,
        nonOwnerGrants: 0,
        columnAcls: 0,
        runtimeAccess: false,
      })),
      counts: [...spec.newTables].sort().map((name) => ({ name, count: 0 })),
      legacyMarkers: 0,
      postRights: true,
    };
    const security = {
      schema: 'PHUB_NOTIFICATION_BACKUP_SECURITY_V1',
      objects: [
        { key: 'schema:synthetic', kind: 'schema', owner: 'phub_beta', props: {}, acl: [] },
      ],
      roles: ['phub_beta'],
      unsupported: { largeObjects: 0, securityLabels: 0 },
    };
    const pgImage =
      'docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
    const op = {
      schema: JOIN_POST105_BACKUP_SCHEMA,
      profile: 'production',
      target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
      toolCommit: join.controllerSha,
      toolFileSha256: hash('1'),
      toolProofSha256: hash('2'),
      toolInstallationSha256: hash('3'),
      controllerSha: join.controllerSha,
      controllerTree,
      controllerSourceCiRunId: '555',
      controllerConfigSha256: hash('4'),
      expectedBoundarySha256: hash('5'),
      expectedApi: {
        ...join.expectedApi,
        imageId: join.expectedApi.image.split('@')[1],
        revision: join.expectedApi.releaseId.slice(0, 40),
        restarts: 0,
        startedAt: '2026-10-23T07:00:00.000Z',
      },
      expectedPostgres: {
        id: 'fe614a3312e446e8036243be3781590bfe90b5da037b83580abd410d4514e84c',
        image: pgImage,
        imageId: pgImage.split('@')[1],
        releaseId: null,
        revision: null,
        restarts: 0,
        startedAt: '2026-10-23T07:00:00.000Z',
      },
      releaseId: join.controllerSha + '-555-1',
      expectedLedgerSha256: '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd',
      packageDescriptorSha256: joinHash(descriptor),
      catalogsSha256: joinHash(golden),
      expiresAt: join.expiresAt,
      confirmation: 'BACKUP_RESTORE_JOIN_POST105_PRIVATE_NAMESPACE_KEEP_RUNTIME',
      notificationBundleSha256: join.notificationBundleSha256,
    };
    const operationBytes = bytes(op),
      preimage = bytes({ state, target, security });
    join.post105BackupOperationSha256 = joinHash(operationBytes);
    const encoded = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
    const receipt = {
      schema: JOIN_POST105_BACKUP_RECEIPT,
      baselineReleaseId: join.expectedApi.releaseId,
      completedAt: '2026-10-23T09:30:00.000Z',
      backupFile:
        '/opt/phub/timeweb-beta/backups/' + op.releaseId + '-join-post105/database.pgcustom',
      backupSha256: hash('7'),
      restoreVerified: true,
      restoreImage: pgImage,
      restoredLedgerSha256: op.expectedLedgerSha256,
      sourceLedgerSha256: op.expectedLedgerSha256,
      operationSha256: joinHash(operationBytes),
      target,
      preimageSha256: joinHash(preimage),
      packageDescriptorSha256: op.packageDescriptorSha256,
      catalogsSha256: op.catalogsSha256,
      aclRecovery: 'ISOLATED_OWNER_ACL_RESTORE_VERIFIED',
      securityPreimageSha256: joinHash(encoded(security)),
      restoredSecuritySha256: joinHash(encoded(security)),
      roleClosureSha256: joinHash(encoded(security.roles)),
      notificationBundleSha256: op.notificationBundleSha256,
    };
    const terminal = {
      schema: JOIN_POST105_BACKUP_TERMINAL,
      operationSha256: receipt.operationSha256,
      receiptSha256: joinHash(bytes(receipt)),
      preimageSha256: receipt.preimageSha256,
      target,
      sourceLedgerSha256: op.expectedLedgerSha256,
      storageCleanupVerified: true,
      reconciled: true,
      notificationBundleSha256: receipt.notificationBundleSha256,
    };
    const bundle = {
      operation: operationBytes,
      receipt: bytes(receipt),
      preimage,
      golden,
      descriptor,
      terminal: bytes(terminal),
    };
    const actual = {
      dumpSha256: receipt.backupSha256,
      toolSha256: op.toolFileSha256,
      installationSha256: op.toolInstallationSha256,
    };
    const validate = (fresh = true) =>
      validateJoinPost105BackupBundle(bundle, join, controllerTree, actual, { fresh, now });
    return {
      op,
      join,
      controllerTree,
      bundle,
      receipt,
      terminal,
      actual,
      state,
      security,
      validate,
    };
  }
  it('accepts only the original rich105 bundle and returns its sealed reference', () => {
    const f = fixture(),
      r = f.validate();
    expect(r.operationSha256).toBe(f.join.post105BackupOperationSha256);
    expect(r.path).toBe(
      f.receipt.backupFile.replace('database.pgcustom', 'database-backup-receipt.json'),
    );
    const ordered = {
      ...f.op,
      target: { projectId: 262717, serverId: 8886471, hostname: 'lk2.padlhub.su' },
    };
    expect(validateJoinPost105BackupOperation(ordered, f.join, f.controllerTree)).toBe(ordered);
  });
  it.each([
    'sourceLedgerSha256',
    'restoredLedgerSha256',
    'backupSha256',
    'operationSha256',
    'notificationBundleSha256',
    'securityPreimageSha256',
    'restoredSecuritySha256',
    'roleClosureSha256',
    'preimageSha256',
    'catalogsSha256',
    'packageDescriptorSha256',
  ] as const)('rejects changed receipt %s', (key) => {
    const f = fixture();
    f.bundle.receipt = bytes({ ...f.receipt, [key]: hash('f') });
    expect(() => f.validate()).toThrow();
  });
  it.each([
    'storageCleanupVerified',
    'reconciled',
    'receiptSha256',
    'operationSha256',
    'preimageSha256',
    'notificationBundleSha256',
    'sourceLedgerSha256',
  ] as const)('rejects missing or foreign terminal %s', (key) => {
    const f = fixture();
    f.bundle.terminal = bytes({ ...f.terminal, [key]: false });
    expect(() => f.validate()).toThrow();
  });
  it('rejects PRE102, legacy V1, degraded, foreign helper and incomplete proof', () => {
    const f = fixture();
    for (const v of [
      { ...f.receipt, schema: 'PHUB_TIMEWEB_DATABASE_BACKUP_RESTORE_V1' },
      { ...f.receipt, schema: 'PHUB_TIMEWEB_NOTIFICATION_PRE105_BACKUP_RESTORE_V1' },
      { ...f.receipt, restoreVerified: false },
      { ...f.receipt, aclRecovery: 'NO_OWNER_NO_ACL' },
      { schema: 'PHUB_DEGRADED_BACKUP_PROOF_V1' },
    ]) {
      f.bundle.receipt = bytes(v);
      expect(() => f.validate()).toThrow();
    }
    f.bundle.receipt = bytes(f.receipt);
    f.actual.toolSha256 = hash('f');
    expect(() => f.validate()).toThrow();
  });
  it('rejects post-state catalog, role/security and nonempty new-table drift even with refreshed byte hashes', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.state.ledger.pop();
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.counts[0]!.count = 1;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.security[0]!.rls = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.security.roles.push('postgres');
      },
    ]) {
      const f = fixture();
      change(f);
      f.bundle.preimage = bytes({ state: f.state, target: f.state.target, security: f.security });
      f.receipt.preimageSha256 = joinHash(f.bundle.preimage);
      f.bundle.receipt = bytes(f.receipt);
      expect(() => f.validate()).toThrow();
    }
  });
  it('expires forward freshness without minting new recovery authority', () => {
    const f = fixture();
    expect(() =>
      validateJoinPost105BackupBundle(f.bundle, f.join, f.controllerTree, f.actual, {
        now: now + 3600000,
      }),
    ).toThrow();
    expect(
      validateJoinPost105BackupBundle(f.bundle, f.join, f.controllerTree, f.actual, {
        fresh: false,
        now: now + 3600000,
      }),
    ).toHaveProperty('completedAt', f.receipt.completedAt);
    expect(() =>
      validateJoinPost105BackupBundle(f.bundle, f.join, f.controllerTree, f.actual, {
        fresh: false,
        now: Date.parse('2026-10-23T09:00:00.000Z'),
      }),
    ).toThrow();
  });
  it.each([
    { profile: 'beta' },
    { expectedLedgerSha256: hash('a') },
    { confirmation: 'BACKUP_RESTORE' },
    { controllerPromotion: {} },
    { controllerSha: sha('f') },
    { notificationBundleSha256: hash('f') },
  ])('rejects incorrect post105 operation policy', (patch) => {
    const f = fixture();
    expect(() =>
      validateJoinPost105BackupOperation({ ...f.op, ...patch }, f.join, f.controllerTree),
    ).toThrow();
  });
  it('rejects semantically invalid security even when every dependent hash and terminal is refreshed', () => {
    const seed = fixture(),
      row = seed.security.objects[0]!;
    const invalid: unknown[] = [
      { ...seed.security, schema: 'FOREIGN' },
      { ...seed.security, unsupported: { largeObjects: 1, securityLabels: 0 } },
      { ...seed.security, roles: ['evil'] },
      { ...seed.security, roles: ['postgres', 'phub_beta'] },
      { ...seed.security, objects: [{ ...row, owner: 'evil' }] },
      { ...seed.security, objects: [row, row] },
      {
        ...seed.security,
        objects: [
          {
            ...row,
            acl: [{ grantor: 'evil', grantee: 'PUBLIC', privilege: 'USAGE', grantable: false }],
          },
        ],
      },
      {
        ...seed.security,
        objects: [
          {
            ...row,
            acl: [{ grantor: 'phub_beta', grantee: 'evil', privilege: 'USAGE', grantable: false }],
          },
        ],
      },
      {
        ...seed.security,
        objects: [
          {
            ...row,
            acl: [
              { grantor: 'phub_beta', grantee: 'PUBLIC', privilege: 'USAGE', grantable: 'yes' },
            ],
          },
        ],
      },
    ];
    for (const security of invalid) {
      const f = fixture(),
        encoded = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
      f.bundle.preimage = bytes({ state: f.state, target: f.state.target, security });
      f.receipt.preimageSha256 = joinHash(f.bundle.preimage);
      f.receipt.securityPreimageSha256 = f.receipt.restoredSecuritySha256 = joinHash(
        encoded(security),
      );
      f.receipt.roleClosureSha256 = joinHash(encoded((security as { roles: unknown }).roles));
      f.bundle.receipt = bytes(f.receipt);
      f.bundle.terminal = bytes({
        ...f.terminal,
        preimageSha256: f.receipt.preimageSha256,
        receiptSha256: joinHash(f.bundle.receipt),
      });
      expect(() => f.validate()).toThrow('POST105_SECURITY_INVENTORY');
    }
  });
  it('rejects stale backup authority paired with a fresh receipt and invalid calendar baselines', () => {
    const f = fixture();
    f.op.expiresAt = '2026-10-23T09:00:00.000Z';
    f.bundle.operation = bytes(f.op);
    f.join.post105BackupOperationSha256 = joinHash(f.bundle.operation);
    f.receipt.operationSha256 = f.join.post105BackupOperationSha256;
    f.bundle.receipt = bytes(f.receipt);
    f.bundle.terminal = bytes({
      ...f.terminal,
      operationSha256: f.receipt.operationSha256,
      receiptSha256: joinHash(f.bundle.receipt),
    });
    expect(() => f.validate()).toThrow('POST105_BACKUP');
    const g = fixture();
    g.op.expectedApi.startedAt = '2026-02-31T07:00:00.000000000Z';
    expect(() => validateJoinPost105BackupOperation(g.op, g.join, g.controllerTree)).toThrow(
      'POST105_BASELINE',
    );
  });
});
