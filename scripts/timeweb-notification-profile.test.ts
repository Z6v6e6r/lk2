import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_MIGRATION_SCHEMA,
  NOTIFICATION_ROLLOUT_SCHEMA,
  notificationSecretNames,
  validateNotificationOperation,
  validateNotificationRoleReadback,
  assertNotificationRuntimeOff,
  notificationStateSql,
} from './timeweb-notification-profile.js';
import {
  migrationCreateArgs,
  runNotificationMigrationAdapter,
  validateNotificationMigrationReceipt,
} from './timeweb-api-worker-migration.js';
import {
  runApiWorkerTransition,
  recoverApiWorkerPhase,
  overlay,
  encodeApiWorkerCapsule,
  readApiWorkerCapsule,
} from './timeweb-api-worker-upgrade.js';
import descriptor from '../deploy/timeweb/notification-migrations-0099-0101.v1.json';
import { createHash } from 'node:crypto';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const encoded = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
const target = { databaseName: 'synthetic', systemIdentifier: '12345' };
const now = Date.parse('2026-10-22T12:00:00.000Z');
function operation() {
  const revision = '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d';
  const baseline = (service: 'api' | 'worker' | 'postgres') => {
    const digest = {
      api: '47bce1fab22cb47d99fa5391764dd20c8c1f53a31550eab2a759b512a4411839',
      worker: '72b9a03aaf95afab5711a8f489b56affe0be4d79eb5af513abe4966eb7695416',
      postgres: 'cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
    }[service];
    return {
      id: '1'.repeat(64),
      image:
        (service === 'postgres'
          ? 'docker.io/library/postgres'
          : 'ghcr.io/z6v6e6r/phub-' + service) +
        '@sha256:' +
        digest,
      imageId: 'sha256:' + digest,
      releaseId: service === 'api' ? revision + '-39366813227-1' : null,
      revision: service === 'postgres' ? null : revision,
      restarts: 0,
      startedAt: '2026-10-21T03:25:28.539450145Z',
    };
  };
  return {
    schema: NOTIFICATION_MIGRATION_SCHEMA,
    profile: 'production',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    controllerSha: 'a'.repeat(40),
    controllerTree: 'b'.repeat(40),
    controllerSourceCiRunId: '100',
    candidateSha: 'a'.repeat(40),
    candidateTree: 'b'.repeat(40),
    sourceCiRunId: '100',
    publicationRunId: '200',
    artifactId: '300',
    artifactDigest: 'sha256:' + 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    migratorImage: 'ghcr.io/z6v6e6r/phub-migrator@sha256:' + 'e'.repeat(64),
    packageDescriptorSha256: 'f'.repeat(64),
    catalogsSha256: '9'.repeat(64),
    expectedApi: baseline('api'),
    expectedWorker: baseline('worker'),
    expectedPostgres: baseline('postgres'),
    expectedSecretSetReleaseId: revision + '-39366813227-1',
    expectedSecretSetFiles: Object.fromEntries(
      notificationSecretNames.map((n) => [n, '8'.repeat(64)]),
    ),
    expiresAt: '2026-10-22T12:40:00.000Z',
    confirmation: 'MIGRATE_0099_0100_0101_102_TO_105_PRESERVE_RUNTIME_AND_PROVIDERS',
  };
}
function role(kind: string, phase = 'pre') {
  const cap = [
    'identity',
    'notifications',
    'support',
    'plpgsql',
    'uuid',
    'ledger',
    'owners',
    'credentials',
    'tenants',
    'users',
    'templates',
    'intents',
    'tickets',
  ];
  return {
    schema: 'PHUB_NOTIFICATION_MIGRATION_ROLE_READBACK_V1',
    kind,
    phase,
    wireRoleName: 'phub_' + kind,
    currentRoleName: 'phub_' + kind,
    sessionRoleName: 'phub_' + kind,
    roleOverride: 'none',
    ...target,
    readOnly: 'on',
    recovery: false,
    superuser: false,
    bypassRls: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    inherit: true,
    databaseCreate: false,
    roleMembershipsPresent: false,
    privilegedMembership: false,
    runtimeCanAssumeMigrator: false,
    businessCreate: kind === 'migrator',
    businessDdlControl: kind === 'migrator',
    capabilities: kind === 'runtime' ? null : Object.fromEntries(cap.map((k) => [k, true])),
    defaultAcls:
      kind === 'runtime'
        ? null
        : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((privilege) => ({
            scope: 'identity',
            type: 'r',
            grantor: 'phub_migrator',
            grantee: 'phub_runtime',
            privilege,
            grantable: false,
          })),
    catalog:
      kind === 'runtime' ? null : { count: phase === 'pre' ? 102 : 105, sha256: '7'.repeat(64) },
  };
}
function effects() {
  const op = operation(),
    events: string[] = [],
    files = new Map<string, Buffer>();
  const baselineRows = JSON.parse(
    readFileSync('scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json', 'utf8'),
  ) as { ledger: { filename: string; checksum: string }[] };
  let ledger = structuredClone(baselineRows.ledger),
    state = 'pre',
    receipt: unknown = null,
    locked = false;
  const containers = new Map<string, { Id: string; State: { Status: string; ExitCode: number } }>();
  const runtime = {
    api: {
      identity: op.expectedApi,
      status: 'running',
      health: 'healthy',
      fingerprint: '6'.repeat(64),
    },
    worker: {
      identity: op.expectedWorker,
      status: 'running',
      health: 'healthy',
      fingerprint: '6'.repeat(64),
    },
    postgres: op.expectedPostgres,
    controllerConfigSha256: '5'.repeat(64),
    excluded: [
      {
        identity: op.expectedPostgres,
        status: 'running',
        health: 'healthy',
        fingerprint: '6'.repeat(64),
      },
    ],
  };
  const secrets = {
    releaseId: op.expectedSecretSetReleaseId,
    device: 1,
    inode: 2,
    files: op.expectedSecretSetFiles,
  };
  const ops = {
    time: () => now,
    receiptPath: 'synthetic',
    assertUnused: () => {
      events.push('unused');
    },
    assertSource: () => {},
    authority: () => {},
    snapshot: () => runtime,
    secrets: () => secrets,
    ledger: () => ledger,
    backup: () => ({
      path: `/opt/phub/timeweb-beta/backups/${op.controllerSha}-100-1-notification-pre105/database-backup-receipt.json`,
      sha256: '4'.repeat(64),
      operationSha256: '3'.repeat(64),
      preimageSha256: '2'.repeat(64),
    }),
    image: () => 'sha256:' + '1'.repeat(64),
    target: () => target,
    inputs: () => ({
      packageDescriptorSha256: op.packageDescriptorSha256,
      catalogsSha256: op.catalogsSha256,
      bootstrapSha256: '1'.repeat(64),
      probeSha256: '2'.repeat(64),
      builderSha256: '3'.repeat(64),
      inverseSha256: '4'.repeat(64),
      securityCatalogSqlSha256: '5'.repeat(64),
    }),
    catalogHash: () => '7'.repeat(64),
    notificationState: (phase: string) => {
      events.push('state:' + phase);
      if (phase !== state) throw Error('STATE');
      return { phase, target };
    },
    footprint: () => [],
    prepare: (bytes: Buffer) => {
      events.push('prepare');
      files.set('preparation', bytes);
    },
    preparation: () => files.get('preparation'),
    loadPlan: () => {},
    claim: () => {
      events.push('claim');
      locked = true;
    },
    assertOwned: () => {
      if (!locked) throw Error('LOCK');
    },
    writeReceipt: (v: unknown) => {
      receipt = v;
      events.push('journal:' + (v as { status: string }).status);
    },
    receipt: () => receipt,
    bootstrap: () => {
      events.push('bootstrap');
      if (!locked) throw Error('LOCK');
      state = 'bootstrap';
    },
    create: (kind: string) => {
      events.push('create:' + kind);
      const id = hash(kind);
      if (containers.has(kind)) throw Error('DUPLICATE');
      containers.set(kind, { Id: id, State: { Status: 'created', ExitCode: 0 } });
      return id;
    },
    start: (id: string, kind: string) => {
      events.push('start:' + kind);
      containers.get(kind)!.State.Status = 'exited';
      if (kind === 'migration') {
        state = 'post';
        ledger = [
          ...ledger,
          ...descriptor.steps.map((s) => ({ filename: s.filename, checksum: s.checksum })),
        ];
      }
    },
    wait: () => {},
    lookup: (kind: string) => containers.get(kind) ?? null,
    logs: (id: string) => {
      const kind = [...containers].find(([, r]) => r.Id === id)![0];
      return role(kind.split('-')[0]!, kind.endsWith('-post') ? 'post' : 'pre');
    },
    writeRoleProof: (bytes: Buffer) => files.set('role', bytes),
    readRoleProof: () => files.get('role'),
    attestRoleContainers: () => {},
    attestStoppedProbes: () => {},
    readNotificationProof: (name: string) => files.get(name) ?? null,
    writeNotificationProof: (name: string, bytes: Buffer) => files.set(name, bytes),
    successProof: () => files.get('success') ?? null,
    writeSuccess: (bytes: Buffer) => files.set('success', bytes),
    release: () => {
      locked = false;
      events.push('release');
    },
  };
  return {
    op,
    ops,
    events,
    files,
    getReceipt: () => receipt,
    isLocked: () => locked,
    setLedger: (count: number) => {
      ledger = Array.from({ length: count }, (_, i) => ({
        filename: String(i).padStart(4, '0') + '_synthetic.sql',
        checksum: '1'.repeat(64),
      }));
    },
  };
}
describe('notification-only Timeweb profile', () => {
  it('requires same source, exact baseline, immutable digests and separate authority from old bridges', () => {
    expect(validateNotificationOperation(operation(), now)).toEqual(operation());
    for (const patch of [
      { controllerSha: 'f'.repeat(40) },
      { candidateTree: 'a'.repeat(40) },
      { sourceCiRunId: '999' },
      { migratorImage: 'latest' },
      { profile: 'beta' },
      { controllerPromotion: {} },
      { confirmation: 'MIGRATE' },
    ])
      expect(() => validateNotificationOperation({ ...operation(), ...patch }, now)).toThrow();
  });
  it('requires safe runtime and migrator proofs with explicit pre/post phase', () => {
    for (const kind of ['runtime', 'migrator'])
      for (const phase of ['pre', 'post'])
        expect(
          validateNotificationRoleReadback(role(kind, phase), kind, target, phase, '7'.repeat(64)),
        ).toEqual(role(kind, phase));
    for (const key of [
      'superuser',
      'bypassRls',
      'roleMembershipsPresent',
      'runtimeCanAssumeMigrator',
      'businessCreate',
      'businessDdlControl',
    ])
      expect(() =>
        validateNotificationRoleReadback(
          { ...role('runtime'), [key]: true },
          'runtime',
          target,
          'pre',
          '7'.repeat(64),
        ),
      ).toThrow();
    expect(() =>
      validateNotificationRoleReadback(
        role('migrator', 'pre'),
        'migrator',
        target,
        'post',
        '7'.repeat(64),
      ),
    ).toThrow();
  });
  it('rejects feature activation without changing secrets or credentials', () => {
    expect(assertNotificationRuntimeOff('DATABASE_URL=synthetic\nSMTP_ENABLED=false\n')).toBe(true);
    for (const flag of [
      'SMTP_ENABLED',
      'NOTIFICATION_SCENARIOS_ENABLED',
      'NOTIFICATION_LIFECYCLE_VIVA_ENABLED',
      'NOTIFICATION_STAFF_TASKS_ENABLED',
      'APNS_ENABLED',
    ])
      expect(() => assertNotificationRuntimeOff(flag + '=true\n')).toThrow('ACTIVATION_FORBIDDEN');
    expect(() => assertNotificationRuntimeOff('SMTP_ENABLED=false\nSMTP_ENABLED=true\n')).toThrow();
  });
  it('generates read-only catalog and fixed strict migration commands', () => {
    const sql = notificationStateSql(
      'pre',
      readFileSync('deploy/timeweb/notification-role-bootstrap-0105.sql', 'utf8'),
    );
    expect(sql).toContain('repeatable read read only');
    expect(sql).not.toContain('grant usage,create');
    expect(sql).not.toContain('alter table notifications.deliveries owner');
    const args = migrationCreateArgs(
      'phub-timeweb-migration-aaaaaaaaaaaa-200-1',
      'f'.repeat(64),
      '/etc/phub/timeweb-beta/migrator.env',
      'migration',
      undefined,
      { operation: operation(), target },
    );
    expect(args.slice(-4)).toEqual([
      'node',
      'apps/migrator/dist/main.js',
      '--notification-migrations-0099-0101',
      Buffer.from(JSON.stringify(target)).toString('base64'),
    ]);
    expect(args).toContain(operation().migratorImage);
  });
  it('orders verified backup/capsule/locks before bootstrap and requires post probes before success', async () => {
    const f = effects(),
      bytes = encoded(f.op);
    await runNotificationMigrationAdapter('deploy', bytes, f.ops);
    expect(f.events.indexOf('prepare')).toBeLessThan(f.events.indexOf('claim'));
    expect(f.events.indexOf('claim')).toBeLessThan(f.events.indexOf('bootstrap'));
    expect(f.events.indexOf('bootstrap')).toBeLessThan(f.events.indexOf('start:migration'));
    expect(f.events.indexOf('start:migrator-post')).toBeLessThan(
      f.events.lastIndexOf('journal:SUCCESS'),
    );
    expect(f.isLocked()).toBe(true);
    await runNotificationMigrationAdapter('reconcile', bytes, f.ops);
    expect(f.isLocked()).toBe(false);
    expect(f.getReceipt()).toMatchObject({ status: 'RECONCILED', reconciledStatus: 'SUCCESS' });
    expect(() =>
      validateNotificationMigrationReceipt(
        { ...(f.getReceipt() as object), schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_RECEIPT_V1' },
        'x',
        'y',
      ),
    ).toThrow();
  });
  it('retains ownership after lost bootstrap ACK or a partial ledger; never repeats bootstrap/migration', async () => {
    for (const partial of [102, 103, 104]) {
      const f = effects(),
        original = f.ops.bootstrap;
      f.ops.bootstrap = () => {
        original();
        throw Error('LOST_ACK');
      };
      await expect(runNotificationMigrationAdapter('deploy', encoded(f.op), f.ops)).rejects.toThrow(
        'LOST_ACK',
      );
      if (partial !== 102) f.setLedger(partial);
      await expect(
        runNotificationMigrationAdapter('reconcile', encoded(f.op), f.ops),
      ).rejects.toThrow('RECONCILE_OWNER_DECISION');
      expect(f.isLocked()).toBe(true);
      expect(f.events.filter((e) => e === 'bootstrap')).toHaveLength(1);
      expect(f.events).not.toContain('start:migration');
    }
  });
  it('adopts the exact completed post probe after a lost start acknowledgement', async () => {
    const f = effects(),
      start = f.ops.start;
    let lost = false;
    f.ops.start = (id, kind) => {
      start(id, kind);
      if (kind === 'runtime-post' && !lost) {
        lost = true;
        throw Error('LOST_POST_ACK');
      }
    };
    await expect(runNotificationMigrationAdapter('deploy', encoded(f.op), f.ops)).rejects.toThrow(
      'LOST_POST_ACK',
    );
    await runNotificationMigrationAdapter('reconcile', encoded(f.op), f.ops);
    expect(f.getReceipt()).toMatchObject({ status: 'RECONCILED', reconciledStatus: 'SUCCESS' });
    expect(f.events.filter((e) => e === 'create:runtime-post')).toHaveLength(1);
    expect(f.events.filter((e) => e === 'start:runtime-post')).toHaveLength(1);
  });
  it('preserves FCM mount on both overlays and uses truthful secret verification phases', async () => {
    const events: string[] = [],
      mark = (v: string) => () => {
        events.push(v);
        return Promise.resolve();
      };
    const ops = {
      secretMode: 'preserve' as const,
      preflight: mark('preflight'),
      pullAndSmoke: mark('pull'),
      journal: (v: string) => {
        events.push(v);
        return Promise.resolve();
      },
      containWorker: mark('contain'),
      installSecrets: mark('verify'),
      restoreSecrets: mark('verifyPrevious'),
      activate: mark('activate'),
      observe: mark('observe'),
      attestCandidate: mark('candidate'),
      installBaseline: mark('baseline'),
      releaseFence: mark('release'),
      restore: mark('restore'),
      removeCandidateBaseline: mark('remove'),
      attestPrevious: mark('previous'),
    };
    await runApiWorkerTransition(ops);
    expect(events).toContain('SECRETS_VERIFIED');
    expect(events).not.toContain('SECRET_SWAP_INTENT');
    await recoverApiWorkerPhase('SECRETS_VERIFIED', ops);
    expect(events).toContain('PREVIOUS_SECRETS_VERIFIED');
    const plan = {
      schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V1',
      fcmCredentialSource: '/dev/null',
      previous: { api: { releaseId: 'old' }, worker: { image: 'repo@sha256:old' } },
      candidate: { api: { releaseId: 'new' }, worker: { image: 'repo@sha256:new' } },
    };
    for (const side of ['previous', 'candidate'])
      expect(overlay(plan, side, 'worker')).toContain('TIMEWEB_FCM_CREDENTIAL_SOURCE=/dev/null');
  });
  it('binds a valid preserved-secret rollout capsule to exact API/Worker images and 105 ledger', () => {
    const { expectedSecretSetReleaseId, expectedSecretSetFiles, ...base } = operation();
    const op = {
      ...base,
      schema: NOTIFICATION_ROLLOUT_SCHEMA,
      apiImage: 'ghcr.io/z6v6e6r/phub-api@sha256:' + '1'.repeat(64),
      workerImage: 'ghcr.io/z6v6e6r/phub-worker@sha256:' + '2'.repeat(64),
      expectedCurrentSecretSetReleaseId: expectedSecretSetReleaseId,
      candidateSecretHashes: expectedSecretSetFiles,
      expectedFcmSource: '/dev/null',
      migrationPlanSha256: '3'.repeat(64),
      migrationSuccessSha256: '4'.repeat(64),
      migrationReceiptSha256: '5'.repeat(64),
      confirmation: 'DEPLOY_API_WORKER_0105_KEEP_SECRETS_AND_PROVIDERS',
    };
    expect(validateNotificationOperation(op, now)).toEqual(op);
    const secret = {
      releaseId: expectedSecretSetReleaseId,
      device: 1,
      inode: 2,
      files: expectedSecretSetFiles,
    };
    const baseline = JSON.parse(
      readFileSync('scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json', 'utf8'),
    ) as { ledger: { filename: string; checksum: string }[] };
    const plan = {
      schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V1',
      operationSha256: hash(encoded(op)),
      controllerSha: op.controllerSha,
      manifestSha256: op.manifestSha256,
      artifactDigest: op.artifactDigest,
      composeSha256: '6'.repeat(64),
      baselineSha256: '7'.repeat(64),
      baselinePath:
        '/opt/phub/timeweb-beta/releases/' + op.expectedApi.releaseId + '/installed-components.env',
      previous: { api: op.expectedApi, worker: op.expectedWorker },
      candidate: {
        api: {
          image: op.apiImage,
          releaseId: op.candidateSha + '-200-1',
          revision: op.candidateSha,
        },
        worker: { image: op.workerImage, releaseId: null, revision: op.candidateSha },
      },
      excluded: [],
      previousSecrets: secret,
      candidateSecrets: secret,
      credential: null,
      packagedLedger: [
        ...baseline.ledger,
        ...descriptor.steps.map((s) => ({ filename: s.filename, checksum: s.checksum })),
      ],
      unchangedImages: {
        WEB_IMAGE_DIGEST: 'sha256:' + '8'.repeat(64),
        REALTIME_IMAGE_DIGEST: 'sha256:' + '9'.repeat(64),
      },
      createdAt: '2026-10-22T12:00:00.000Z',
      migrationProof: {
        migrationPlanSha256: op.migrationPlanSha256,
        migrationSuccessSha256: op.migrationSuccessSha256,
        migrationReceiptSha256: op.migrationReceiptSha256,
        catalogSha256: 'a'.repeat(64),
        backup: {},
        target,
      },
      migratorImage: op.migratorImage,
      fcmCredentialSource: op.expectedFcmSource,
    };
    const read = (value: unknown) =>
      readApiWorkerCapsule(Buffer.from(encodeApiWorkerCapsule(encoded(op), encoded(value))));
    expect(read(plan).op).toEqual(op);
    for (const service of ['api', 'worker'] as const) {
      const changed = structuredClone(plan);
      changed.candidate[service].image =
        'ghcr.io/z6v6e6r/phub-' + service + '@sha256:' + 'f'.repeat(64);
      expect(() => read(changed)).toThrow('PLAN');
    }
    expect(() =>
      read({ ...plan, candidateSecrets: { ...secret, releaseId: 'changed' } }),
    ).toThrow();
    expect(() =>
      read({ ...plan, fcmCredentialSource: '/etc/phub/timeweb-beta-fcm/fcm-service-account.json' }),
    ).toThrow();
    expect(() => read({ ...plan, packagedLedger: baseline.ledger })).toThrow('LEDGER');
  });
  it('separates migration and rollout operation schemas', () => {
    expect(() =>
      validateNotificationOperation({ ...operation(), schema: NOTIFICATION_ROLLOUT_SCHEMA }),
    ).toThrow();
  });
});
