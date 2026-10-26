import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as apiWorkerContract from './timeweb-api-worker-contract.js';
import {
  readApiWorkerMigrationCapsule,
  migrationCreateArgs,
  runLocationPhotoMigratorPrefetchAdapter,
  runLocationPhotoMigrationAdapter,
  validateLocationPhotoCompletedBackupBinding,
  validateLocationPhotoMigrationPlan,
} from './timeweb-api-worker-migration.js';
import {
  LOCATION_PHOTO_EDITOR_ACL,
  LOCATION_PHOTO_MIGRATION,
  LOCATION_PHOTO_MIGRATION_SCHEMA,
  LOCATION_PHOTO_PUBLISHED_MIGRATOR,
  LOCATION_PHOTO_SECRET_NAMES,
  attestLocationPhotoControllerSource,
  locationPhotoStateSql,
  validateLocationPhotoBackupOperation,
  validateLocationPhotoLedger,
  validateLocationPhotoOperation,
  validateLocationPhotoPackage,
  validateLocationPhotoState,
} from './timeweb-location-photo-profile.js';

type RuntimeIdentity = {
  id: string;
  image: string;
  imageId: string;
  releaseId: string | null;
  revision: string | null;
  restarts: number;
  startedAt: string;
};
type PublishedMigrator = {
  sourceSha: string;
  sourceTree: string;
  publicationRunId: string;
  publicationRunAttempt: number;
  manifestSha256: string;
  image: string;
  imageId: string;
};
type Operation = {
  schema: string;
  profile: string;
  target: { hostname: string; serverId: number; projectId: number };
  expectedDatabaseTarget: { databaseName: string; systemIdentifier: string };
  controllerSha: string;
  controllerTree: string;
  controllerSourceCiRunId: string;
  publishedMigrator: PublishedMigrator;
  packageDescriptorSha256: string;
  bootstrapSha256: string;
  cleanupSha256: string;
  expectedApi: RuntimeIdentity;
  expectedWorker: RuntimeIdentity;
  expectedPostgres: RuntimeIdentity;
  expectedSecretSetReleaseId: string;
  expectedSecretSetFiles: Record<string, string>;
  expiresAt: string;
  confirmation: string;
};
type PhotoState = {
  schema: string;
  phase: 'pre' | 'bootstrap' | 'post' | 'cleanup';
  target: { databaseName: string; systemIdentifier: string };
  ledger: Array<{ filename: string; checksum: string }>;
  rolesSafe: boolean;
  privileges: {
    migratorUsage: boolean;
    migratorCreate: boolean;
    migratorPublicUsage: boolean;
    migratorPublicCreate: boolean;
    migratorProfilesReferenceColumns: string[];
    migratorMediaReferenceColumns: string[];
    migratorParentReferenceAcl: Array<Record<string, unknown>>;
    parentColumnAclCount: number;
    runtimeUsage: boolean;
    runtimeProfilesSelect: boolean;
    runtimeMediaSelect: boolean;
  };
  hazards: { migrationLockHeld: boolean; longTransactions: number; conflictingLocks: number };
  editorAcl: Array<{
    relation: string;
    grantor: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>;
  photo: {
    exists: boolean;
    owner: string | null;
    rowCount: number;
    catalogOk: boolean;
    nonOwnerAcl: Array<Record<string, unknown>>;
    columnAclCount: number;
  };
};
type Container = { Id: string; State: { Status: string; ExitCode: number } };
type Receipt = {
  status: string;
  reconciledStatus: string | null;
  containerId: string | null;
  [key: string]: unknown;
};
type PhotoControllerDeltaRow = {
  readonly path: string;
  readonly status: 'A' | 'M';
};

const photoContract = apiWorkerContract as unknown as {
  LOCATION_PHOTO_CONTROLLER_BASE: Readonly<{ sha: string; tree: string }>;
  LOCATION_PHOTO_CONTROLLER_DELTA: Readonly<Record<string, PhotoControllerDeltaRow>>;
  validateLocationPhotoControllerClosure(rows: unknown): unknown;
};
const LOCATION_PHOTO_CONTROLLER_BASE = photoContract.LOCATION_PHOTO_CONTROLLER_BASE;
const LOCATION_PHOTO_CONTROLLER_DELTA = photoContract.LOCATION_PHOTO_CONTROLLER_DELTA;
const validateLocationPhotoControllerClosure = (rows: unknown) =>
  photoContract.validateLocationPhotoControllerClosure(rows);

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const controllerRows = () =>
  Object.values(LOCATION_PHOTO_CONTROLLER_DELTA).map((row, index) => ({
    ...row,
    oldMode: row.status === 'A' ? '000000' : '100644',
    newMode: '100644',
    oldOid: row.status === 'A' ? '0'.repeat(40) : (index + 1).toString(16).padStart(40, '0'),
    newOid: (index + 101).toString(16).padStart(40, '0'),
  }));
const controllerRaw = (rows = controllerRows()) =>
  rows
    .map(
      (row) =>
        `:${row.oldMode} ${row.newMode} ${row.oldOid} ${row.newOid} ${row.status}\0${row.path}\0`,
    )
    .join('');
const packageBytes = readFileSync('deploy/timeweb/location-photo-migration-0102.v1.json');
const bootstrap = readFileSync('deploy/timeweb/location-photo-role-bootstrap-0102.sql');
const cleanup = readFileSync('deploy/timeweb/location-photo-role-cleanup-0102.sql');
const locationPhotoMigration = LOCATION_PHOTO_MIGRATION.filename;
if (!locationPhotoMigration) throw new Error('LOCATION_PHOTO_TEST_MIGRATION_FILENAME');
const ledger = readdirSync('packages/database/migrations')
  .filter((name) => name.endsWith('.sql') && name <= locationPhotoMigration)
  .sort()
  .map((filename) => ({
    filename,
    checksum: hash(readFileSync(`packages/database/migrations/${filename}`)),
  }));
const runtime = (service: 'api' | 'worker' | 'postgres'): RuntimeIdentity => {
  const revision = 'b6bd6b38c54381e7eb1a0fd62d885b3f475b9f48';
  const digest =
    service === 'postgres' ? 'c'.repeat(64) : service === 'api' ? 'a'.repeat(64) : 'b'.repeat(64);
  return {
    id: digest,
    image: `${service === 'postgres' ? 'docker.io/library/postgres' : `ghcr.io/z6v6e6r/phub-${service}`}@sha256:${digest}`,
    imageId: `sha256:${digest}`,
    releaseId: service === 'api' ? `${revision}-40270245314-1` : service === 'worker' ? null : null,
    revision: service === 'postgres' ? null : revision,
    restarts: 0,
    startedAt: '2026-10-26T07:15:00.000000000Z',
  };
};
function operation(): Operation {
  return {
    schema: LOCATION_PHOTO_MIGRATION_SCHEMA,
    profile: 'beta',
    target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
    expectedDatabaseTarget: {
      databaseName: 'phub_beta',
      systemIdentifier: '7679125609183186977',
    },
    controllerSha: 'd'.repeat(40),
    controllerTree: 'e'.repeat(40),
    controllerSourceCiRunId: '40400000000',
    publishedMigrator: structuredClone(LOCATION_PHOTO_PUBLISHED_MIGRATOR) as PublishedMigrator,
    packageDescriptorSha256: hash(packageBytes),
    bootstrapSha256: hash(bootstrap),
    cleanupSha256: hash(cleanup),
    expectedApi: runtime('api'),
    expectedWorker: runtime('worker'),
    expectedPostgres: runtime('postgres'),
    expectedSecretSetReleaseId: `${'1'.repeat(40)}-40000000000-1`,
    expectedSecretSetFiles: Object.fromEntries(
      LOCATION_PHOTO_SECRET_NAMES.map((name) => [name, '2'.repeat(64)]),
    ),
    expiresAt: '2026-10-26T12:40:00.000Z',
    confirmation:
      'MIGRATE_LOCATION_PHOTO_0102_105_TO_106_TEMP_CREATE_LOCATIONS_PUBLIC_PARENT_REFERENCES_PRESERVE_EDITOR_ACL_NO_APP_DEPLOY',
  };
}
const editorAcl = LOCATION_PHOTO_EDITOR_ACL.map(([relation, privilege]) => ({
  relation,
  grantor: 'phub_migrator',
  grantee: 'phub_runtime',
  privilege,
  grantable: false,
}));
const parentReferenceAcl = [
  ['locations.media_assets', 'id'],
  ['locations.media_assets', 'tenant_id'],
  ['locations.profiles', 'id'],
  ['locations.profiles', 'tenant_id'],
].map(([relation, column]) => ({
  relation,
  column,
  grantor: 'phub_beta',
  grantee: 'phub_migrator',
  privilege: 'REFERENCES',
  grantable: false,
}));
function state(phase: 'pre' | 'bootstrap' | 'post' | 'cleanup'): PhotoState {
  const exists = phase === 'post' || phase === 'cleanup';
  const parentReferences = phase === 'bootstrap' || phase === 'post';
  return {
    schema: 'PHUB_LOCATION_PHOTO_DATABASE_STATE_V1',
    phase,
    target: { databaseName: 'phub_beta', systemIdentifier: '7679125609183186977' },
    ledger: structuredClone(ledger.slice(0, exists ? 106 : 105)),
    rolesSafe: true,
    privileges: {
      migratorUsage: true,
      migratorCreate: parentReferences,
      migratorPublicUsage: true,
      migratorPublicCreate: parentReferences,
      migratorProfilesReferenceColumns: parentReferences ? ['id', 'tenant_id'] : [],
      migratorMediaReferenceColumns: parentReferences ? ['id', 'tenant_id'] : [],
      migratorParentReferenceAcl: parentReferences ? structuredClone(parentReferenceAcl) : [],
      parentColumnAclCount: parentReferences ? 4 : 0,
      runtimeUsage: true,
      runtimeProfilesSelect: true,
      runtimeMediaSelect: true,
    },
    hazards: { migrationLockHeld: false, longTransactions: 0, conflictingLocks: 0 },
    editorAcl: structuredClone(editorAcl),
    photo: {
      exists,
      owner: exists ? 'phub_migrator' : null,
      rowCount: 0,
      catalogOk: exists,
      nonOwnerAcl: [],
      columnAclCount: 0,
    },
  };
}

function adapterFixture(
  fail: 'prepare' | 'bootstrap' | 'cleanup' | 'migration-exit' | null = null,
) {
  const op = operation();
  op.expiresAt = '2026-10-26T13:00:00.000Z';
  const operationBytes = Buffer.from(`${JSON.stringify(op)}\n`);
  const snapshot = {
    api: {
      identity: runtime('api'),
      status: 'running',
      health: 'healthy',
      fingerprint: '3'.repeat(64),
    },
    worker: {
      identity: runtime('worker'),
      status: 'running',
      health: 'healthy',
      fingerprint: '4'.repeat(64),
    },
    postgres: runtime('postgres'),
    controllerConfigSha256: '5'.repeat(64),
    excluded: [
      {
        identity: runtime('postgres'),
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
    files: structuredClone(op.expectedSecretSetFiles),
  };
  const backup = {
    path: `/opt/phub/timeweb-beta/backups/${op.controllerSha}-${op.controllerSourceCiRunId}-1-location-photo-pre0102/database-backup-receipt.json`,
    sha256: '7'.repeat(64),
    operationSha256: '8'.repeat(64),
    preimageSha256: '9'.repeat(64),
    target: { databaseName: 'phub_beta', systemIdentifier: '7679125609183186977' },
  };
  let createPrivilege = false;
  let applied = false;
  const containers = new Map<string, Container>();
  let preparation: Buffer | null = null;
  let receipt: Receipt | null = null;
  let success: Buffer | null = null;
  let bootstrapFailed = false;
  let cleanupFailed = false;
  let releases = 0;
  let migrationStarts = 0;
  const backupCalls: Array<{ fresh?: boolean } | undefined> = [];
  const proofs = new Map<string, Buffer>();
  const stateFor = (phase: 'pre' | 'bootstrap' | 'post' | 'cleanup') => {
    const value = state(phase);
    value.ledger = structuredClone(ledger.slice(0, applied ? 106 : 105));
    value.privileges.migratorCreate = createPrivilege;
    value.privileges.migratorPublicCreate = createPrivilege;
    value.privileges.migratorProfilesReferenceColumns = createPrivilege ? ['id', 'tenant_id'] : [];
    value.privileges.migratorMediaReferenceColumns = createPrivilege ? ['id', 'tenant_id'] : [];
    value.privileges.migratorParentReferenceAcl = createPrivilege
      ? structuredClone(parentReferenceAcl)
      : [];
    value.privileges.parentColumnAclCount = createPrivilege ? 4 : 0;
    value.photo.exists = applied;
    value.photo.owner = applied ? 'phub_migrator' : null;
    value.photo.catalogOk = applied;
    return value;
  };
  const ops = {
    time: () => Date.parse('2026-10-26T12:30:00.000Z'),
    receiptPath: '/receipt.json',
    assertUnused: () => undefined,
    assertSource: () => undefined,
    assertOwned: () => undefined,
    authority: () => undefined,
    snapshot: () => structuredClone(snapshot),
    secrets: () => structuredClone(secrets),
    ledger: () => structuredClone(ledger.slice(0, applied ? 106 : 105)),
    inputs: () => ({
      packageDescriptorSha256: op.packageDescriptorSha256,
      bootstrapSha256: op.bootstrapSha256,
      cleanupSha256: op.cleanupSha256,
    }),
    locationPhotoState: (phase: 'pre' | 'bootstrap' | 'post' | 'cleanup') => stateFor(phase),
    backup: (_operation: unknown, options?: { fresh?: boolean }) => {
      backupCalls.push(options);
      return structuredClone(backup);
    },
    image: () => op.publishedMigrator.imageId,
    prepare: (bytes: Buffer) => {
      preparation = Buffer.from(bytes);
      if (fail === 'prepare') throw new Error('lost preparation ack');
    },
    preparation: () => preparation,
    claim: () => undefined,
    assertPreparedUnclaimed: () => {
      if (!preparation || receipt || containers.size || createPrivilege || applied)
        throw new Error('unclaimed preparation drift');
    },
    loadPlan: () => undefined,
    writeReceipt: (value: unknown) => {
      receipt = structuredClone(value as Receipt);
    },
    receipt: () => structuredClone(receipt),
    bootstrap: () => {
      createPrivilege = true;
      if (fail === 'bootstrap' && !bootstrapFailed) {
        bootstrapFailed = true;
        throw new Error('lost bootstrap ack');
      }
    },
    cleanup: () => {
      createPrivilege = false;
      if (fail === 'cleanup' && !cleanupFailed) {
        cleanupFailed = true;
        throw new Error('lost cleanup ack');
      }
    },
    writeLocationPhotoProof: (name: string, bytes: Buffer) => proofs.set(name, Buffer.from(bytes)),
    readLocationPhotoProof: (name: string) => proofs.get(name) ?? null,
    create: (kind: string) => {
      const created: Container = {
        Id: (kind === 'migration' ? 'a' : kind === 'migrator' ? 'b' : 'c').repeat(64),
        State: { Status: 'created', ExitCode: 0 },
      };
      containers.set(kind, created);
      return created.Id;
    },
    start: (_id: string, kind: string) => {
      const container = containers.get(kind);
      if (!container) throw new Error('missing container');
      container.State.Status = 'running';
      if (kind === 'migration') migrationStarts += 1;
    },
    wait: (_id: string, kind: string) => {
      const container = containers.get(kind);
      if (!container) throw new Error('missing container');
      if (kind === 'migration' && fail === 'migration-exit') {
        container.State = { Status: 'exited', ExitCode: 2 };
        throw new Error('migration exit');
      }
      if (kind === 'migration') applied = true;
      container.State = { Status: 'exited', ExitCode: 0 };
    },
    lookup: (kind: string) => structuredClone(containers.get(kind) ?? null),
    logs: (id: string) => {
      const phase = id === 'b'.repeat(64) ? 'pre' : 'bootstrap';
      return {
        schema: 'PHUB_LOCATION_PHOTO_MIGRATOR_ROLE_READBACK_V1',
        phase,
        wireRoleName: 'phub_migrator',
        advisoryLockTimeoutMs: '30000',
        currentRoleName: 'phub_migrator',
        sessionRoleName: 'phub_migrator',
        roleOverride: 'none',
        databaseName: 'phub_beta',
        systemIdentifier: '7679125609183186977',
        recovery: false,
        readOnly: 'on',
        superuser: false,
        createRole: false,
        createDatabase: false,
        replication: false,
        bypassRls: false,
        privilegedMembership: false,
        locationsUsage: true,
        locationsCreate: phase === 'bootstrap',
        publicUsage: true,
        publicCreate: phase === 'bootstrap',
        ledgerSelect: true,
        ledgerInsert: true,
        ledgerRowCount: 105,
        profilesReferenceColumns: phase === 'bootstrap' ? ['id', 'tenant_id'] : [],
        mediaReferenceColumns: phase === 'bootstrap' ? ['id', 'tenant_id'] : [],
        parentReferenceAcl: phase === 'bootstrap' ? structuredClone(parentReferenceAcl) : [],
        migrationLockAvailable: true,
      };
    },
    attestStoppedProbes: () => {
      for (const kind of ['migrator', 'migrator-post'])
        if (containers.get(kind)?.State.Status === 'running') throw new Error('running probe');
    },
    successProof: () => success,
    writeSuccess: (bytes: Buffer) => {
      success = Buffer.from(bytes);
    },
    release: () => {
      releases += 1;
    },
  };
  return {
    op,
    operationBytes,
    ops,
    setApplied: (value: boolean) => {
      applied = value;
    },
    values: () => ({
      createPrivilege,
      applied,
      receipt,
      preparation,
      success,
      proofs,
      releases,
      migrationStarts,
      backupCalls,
      backup,
      containers,
    }),
  };
}

function prefetchFixture(lostAck = false) {
  const op = operation();
  op.expiresAt = '2026-10-26T13:00:00.000Z';
  const bytes = Buffer.from(
    `${JSON.stringify({
      schema: 'PHUB_TIMEWEB_LOCATION_PHOTO_0102_PREFETCH_V1',
      operation: op,
      confirmation: 'PREFETCH_LOCATION_PHOTO_0102_MIGRATOR_KEEP_DATABASE_AND_RUNTIME',
    })}\n`,
  );
  const base = adapterFixture();
  let intent: Buffer | null = null;
  let receipt: Buffer | null = null;
  let present = false;
  let pulls = 0;
  const ops = {
    ...base.ops,
    time: () => Date.parse('2026-10-26T12:30:00.000Z'),
    prefetchUnused: () => undefined,
    prefetchIntent: () => intent,
    writePrefetchIntent: (value: Buffer) => {
      intent = Buffer.from(value);
    },
    prefetchReceipt: () => receipt,
    writePrefetchReceipt: (value: Buffer) => {
      receipt = Buffer.from(value);
    },
    imageInventory: () =>
      [...['sha256:' + '1'.repeat(64), ...(present ? [op.publishedMigrator.imageId] : [])]].sort(),
    prefetchImagePresent: () => present,
    pullMigrator: () => {
      pulls += 1;
      present = true;
      if (lostAck && pulls === 1) throw new Error('lost pull ack');
      return op.publishedMigrator.imageId;
    },
    image: () => op.publishedMigrator.imageId,
  };
  return { bytes, ops, values: () => ({ intent, receipt, present, pulls }) };
}

describe('closed Timeweb location-photo 0102 profile', () => {
  it('pins the exact regular-file controller closure and rejects any widened delta', () => {
    const rows = controllerRows();
    expect(validateLocationPhotoControllerClosure(rows)).toEqual(rows);
    for (const invalid of [
      rows.slice(1),
      [...rows, rows[0]],
      rows.map((row, index) => (index === 0 ? { ...row, newMode: '120000' } : row)),
      rows.map((row, index) =>
        index === 0 ? { ...row, path: 'scripts/location-photo-unpinned.js' } : row,
      ),
    ])
      expect(() => validateLocationPhotoControllerClosure(invalid)).toThrow(
        'LOCATION_PHOTO_CONTROLLER_DELTA',
      );
  });

  it('checks git config before discovery and rejects unsafe tracked paths and modes', () => {
    const op = operation();
    const rows = controllerRows();
    const tracked = (mode = '100644', path = rows[0]!.path) =>
      `${mode} ${'a'.repeat(40)} 0\t${path}\0`;
    const invoke = (
      trackedBytes: string,
      assertGitConfig: (git: (args: string[]) => string) => void = () => undefined,
    ) => {
      const calls: string[] = [];
      const git = (args: string[]) => {
        calls.push(args.join(' '));
        if (args.join(' ') === 'rev-parse --show-toplevel')
          return '/opt/phub/timeweb-beta/standard/source';
        if (args.join(' ') === 'rev-parse --absolute-git-dir')
          return '/opt/phub/timeweb-beta/standard/source/.git';
        if (args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir')
          return '/opt/phub/timeweb-beta/standard/source/.git';
        if (args.join(' ') === 'rev-parse HEAD') return op.controllerSha;
        if (args.join(' ') === 'rev-parse HEAD^{tree}') return op.controllerTree;
        if (args.join(' ') === 'status --porcelain --untracked-files=all') return '';
        if (args.join(' ') === `rev-parse ${LOCATION_PHOTO_CONTROLLER_BASE.sha}^{tree}`)
          return LOCATION_PHOTO_CONTROLLER_BASE.tree;
        if (args[0] === 'merge-base') return '';
        if (args[0] === 'diff') return controllerRaw(rows);
        if (args.join(' ') === 'ls-files --stage -z') return trackedBytes;
        throw new Error(`unexpected git ${args.join(' ')}`);
      };
      return {
        calls,
        run: () =>
          attestLocationPhotoControllerSource(op, {
            git,
            read: () =>
              Buffer.from(
                JSON.stringify({
                  schema: 1,
                  enabled: true,
                  owner: 'synthetic-owner',
                  controllerSha: op.controllerSha,
                }),
              ),
            secure: () => ({ isDirectory: () => true }),
            present: () => false,
            assertGitConfig,
          }),
      };
    };

    const good = invoke(tracked());
    expect(good.run()).toEqual(op);
    expect(good.calls[0]).toBe('rev-parse --show-toplevel');
    for (const bytes of [
      tracked('120000'),
      tracked('100644', '../outside'),
      tracked('100644', '/abs'),
    ])
      expect(() => invoke(bytes).run()).toThrow('SOURCE_FILE');

    const blocked = invoke(tracked(), () => {
      throw new Error('SOURCE_CONFIG_INCLUDE');
    });
    expect(() => blocked.run()).toThrow('SOURCE_CONFIG_INCLUDE');
    expect(blocked.calls).toEqual([]);
  });

  it('pins the exact published migrator and 105 to 106 catalog without widening notification mode', () => {
    expect(validateLocationPhotoPackage(packageBytes)).toBeTruthy();
    expect(validateLocationPhotoLedger(ledger.slice(0, 105), 'pre')).toBe(
      '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd',
    );
    expect(validateLocationPhotoLedger(ledger, 'cleanup')).toBe(
      'ff74c193b5e5253f929818b1550d0e5c0264a9818cb0ee5437d49d5aa043904e',
    );
    expect(() => validateLocationPhotoLedger([...ledger, ledger[105]!], 'cleanup')).toThrow(
      'LEDGER',
    );
    const suffix = [...ledger, { filename: '0103_unexpected.sql', checksum: 'f'.repeat(64) }];
    expect(() => validateLocationPhotoLedger(suffix, 'cleanup')).toThrow('LEDGER');
  });

  it('keeps installed b6bd runtime, published 4256 migrator and controller source independent', () => {
    const value = operation();
    expect(() =>
      validateLocationPhotoOperation(value, Date.parse('2026-10-26T12:00:00.000Z')),
    ).not.toThrow();
    expect(value.expectedApi.revision).not.toBe(value.publishedMigrator.sourceSha);
    expect(value.controllerSha).not.toBe(value.publishedMigrator.sourceSha);
    for (const mutate of [
      (copy: ReturnType<typeof operation>) =>
        (copy.expectedApi.imageId = 'sha256:' + '9'.repeat(64)),
      (copy: ReturnType<typeof operation>) => (copy.publishedMigrator.sourceSha = '9'.repeat(40)),
      (copy: ReturnType<typeof operation>) => (copy.expectedDatabaseTarget.databaseName = 'other'),
      (copy: ReturnType<typeof operation>) => (copy.expectedDatabaseTarget.systemIdentifier = '1'),
      (copy: ReturnType<typeof operation>) => (copy.profile = 'production'),
      (copy: ReturnType<typeof operation>) => (copy.controllerSourceCiRunId = '0'),
      (copy: ReturnType<typeof operation>) => (copy.target.serverId = 1),
    ]) {
      const copy = structuredClone(value);
      mutate(copy);
      expect(() => validateLocationPhotoOperation(copy)).toThrow();
    }
  });

  it('closes the owner/ACL backup request to target 105 and the prefetched image receipt', () => {
    const migration = operation();
    const value = {
      schema: 'PHUB_TIMEWEB_LOCATION_PHOTO_PRE0102_BACKUP_NAMESPACE_V1',
      profile: 'beta',
      target: structuredClone(migration.target),
      expectedDatabaseTarget: structuredClone(migration.expectedDatabaseTarget),
      toolCommit: migration.controllerSha,
      toolFileSha256: '1'.repeat(64),
      controllerSha: migration.controllerSha,
      toolProofSha256: '2'.repeat(64),
      toolInstallationSha256: '3'.repeat(64),
      controllerTree: migration.controllerTree,
      controllerConfigSha256: '4'.repeat(64),
      expectedBoundarySha256: '5'.repeat(64),
      expectedApi: structuredClone(migration.expectedApi),
      expectedPostgres: structuredClone(migration.expectedPostgres),
      expiresAt: migration.expiresAt,
      confirmation: 'BACKUP_RESTORE_LOCATION_PHOTO_PRE0102_PRIVATE_NAMESPACE_KEEP_RUNTIME',
      releaseId: `${migration.controllerSha}-${migration.controllerSourceCiRunId}-1`,
      controllerSourceCiRunId: migration.controllerSourceCiRunId,
      expectedLedgerSha256: '7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd',
      packageDescriptorSha256: migration.packageDescriptorSha256,
      migratorPrefetch: {
        requestSha256: '6'.repeat(64),
        receiptSha256: '7'.repeat(64),
        migratorImage: migration.publishedMigrator.image,
        imageId: migration.publishedMigrator.imageId,
      },
    };
    expect(() =>
      validateLocationPhotoBackupOperation(value, Date.parse('2026-10-26T12:00:00.000Z')),
    ).not.toThrow();
    const operationBytes = Buffer.from(`${JSON.stringify(value)}\n`);
    expect(() =>
      validateLocationPhotoCompletedBackupBinding(value, operationBytes, {
        operationSha256: hash(operationBytes),
        migratorPrefetch: structuredClone(value.migratorPrefetch),
      }),
    ).not.toThrow();
    for (const mutate of [
      (copy: typeof value) => (copy.expectedLedgerSha256 = '0'.repeat(64)),
      (copy: typeof value) => (copy.target.projectId = 1),
      (copy: typeof value) => (copy.expectedDatabaseTarget.databaseName = 'other'),
      (copy: typeof value) => (copy.expectedDatabaseTarget.systemIdentifier = '1'),
      (copy: typeof value) => (copy.migratorPrefetch.receiptSha256 = 'missing'),
      (copy: typeof value) => (copy.migratorPrefetch.imageId = 'sha256:' + '0'.repeat(64)),
    ]) {
      const copy = structuredClone(value);
      mutate(copy);
      expect(() => validateLocationPhotoBackupOperation(copy)).toThrow();
      const selfConsistentBytes = Buffer.from(`${JSON.stringify(copy)}\n`);
      expect(() =>
        validateLocationPhotoCompletedBackupBinding(copy, selfConsistentBytes, {
          operationSha256: hash(selfConsistentBytes),
          migratorPrefetch: structuredClone(copy.migratorPrefetch),
        }),
      ).toThrow();
    }
  });

  it('uses the ordinary one-shot migrator with the exact prefetched image and no pull', () => {
    const value = operation();
    const args = migrationCreateArgs(
      `phub-timeweb-migration-${value.publishedMigrator.sourceSha.slice(0, 12)}-${value.publishedMigrator.publicationRunId}-1`,
      '3'.repeat(64),
      '/etc/phub/timeweb-beta/migrator.env',
      'migration',
      undefined,
      { operation: value },
    );
    expect(args.slice(0, 4)).toEqual(['create', '--pull', 'never', '--name']);
    expect(args).toContain(value.publishedMigrator.image);
    expect(args).not.toContain('--notification-migrations-0099-0101');
  });

  it('accepts the applied editor ACL through pre, bootstrap, post and cleanup states', () => {
    for (const phase of ['pre', 'bootstrap', 'post', 'cleanup'] as const)
      expect(validateLocationPhotoState(state(phase), phase)).toBeTruthy();
    for (const target of [
      { databaseName: 'other', systemIdentifier: '7679125609183186977' },
      { databaseName: 'phub_beta', systemIdentifier: '1' },
    ]) {
      const drifted = state('pre');
      drifted.target = target;
      expect(() => validateLocationPhotoState(drifted, 'pre')).toThrow('STATE');
    }
    const ownerOnly = state('pre');
    ownerOnly.editorAcl = [];
    expect(() => validateLocationPhotoState(ownerOnly, 'pre')).toThrow('EDITOR_ACL');
    const extra = state('post');
    extra.editorAcl.push({
      relation: 'notifications.scenarios',
      grantor: 'phub_migrator',
      grantee: 'phub_runtime',
      privilege: 'DELETE',
      grantable: false,
    });
    expect(() => validateLocationPhotoState(extra, 'post')).toThrow('EDITOR_ACL');
    const runtimeEarly = state('post');
    runtimeEarly.photo.nonOwnerAcl.push({ privilege: 'SELECT' });
    expect(() => validateLocationPhotoState(runtimeEarly, 'post')).toThrow('PHOTO_CATALOG');
  });

  it('generates read-only state SQL without referencing the absent photo table in preflight', () => {
    const pre = locationPhotoStateSql('pre');
    expect(pre).toContain('repeatable read read only');
    expect(pre).not.toContain('select count(*)::int from locations.recommendation_card_photos');
    expect(locationPhotoStateSql('post')).toContain(
      'select count(*)::int from locations.recommendation_card_photos',
    );
    expect(() => locationPhotoStateSql('runtime')).toThrow('STATE_PHASE');
  });

  it('runs one ordinary migrator and removes temporary CREATE before success', async () => {
    const fixture = adapterFixture();
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'SUCCESS' });
    const values = fixture.values();
    expect(values.applied).toBe(true);
    expect(values.createPrivilege).toBe(false);
    expect(values.migrationStarts).toBe(1);
    expect(values.releases).toBe(0);
    expect(values.backupCalls.at(-1)).toEqual({ fresh: true });
    expect(values.receipt!.status).toBe('SUCCESS');
    const capsule = readApiWorkerMigrationCapsule(values.preparation!);
    expect(() =>
      validateLocationPhotoMigrationPlan(capsule.plan, capsule.operationBytes),
    ).not.toThrow();
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'RECONCILED' });
    expect(fixture.values()).toMatchObject({ migrationStarts: 1, releases: 1 });
    expect(fixture.values().backupCalls.at(-1)).toEqual({ fresh: false });
  });

  it('cleans temporary CREATE after a definitive nonzero migration exit without rerunning DDL', async () => {
    const fixture = adapterFixture('migration-exit');
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).rejects.toThrow('migration exit');
    expect(fixture.values()).toMatchObject({
      createPrivilege: true,
      applied: false,
      migrationStarts: 1,
      releases: 0,
    });
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'RECONCILED' });
    expect(fixture.values()).toMatchObject({
      createPrivilege: false,
      applied: false,
      migrationStarts: 1,
      releases: 1,
      receipt: { status: 'RECONCILED', reconciledStatus: 'ABORTED' },
    });
  });

  it('rejects a replacement migration container during ledger-106 reconcile', async () => {
    const fixture = adapterFixture();
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'SUCCESS' });
    fixture.values().containers.set('migration', {
      Id: 'f'.repeat(64),
      State: { Status: 'exited', ExitCode: 0 },
    });
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', fixture.operationBytes, fixture.ops),
    ).rejects.toThrow('RECONCILE_OWNER_DECISION');
    expect(fixture.values()).toMatchObject({ migrationStarts: 1, releases: 0 });
  });

  it('binds the backup target to the migration preimage before any effect', async () => {
    const fixture = adapterFixture();
    fixture.values().backup.target.systemIdentifier = '1';
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).rejects.toThrow('LOCATION_PHOTO_PLAN_BACKUP');
    expect(fixture.values()).toMatchObject({ migrationStarts: 0, releases: 0 });
  });

  it('keeps reconciled terminal classification monotonic across ledger drift', async () => {
    const aborted = adapterFixture('migration-exit');
    await expect(
      runLocationPhotoMigrationAdapter('deploy', aborted.operationBytes, aborted.ops),
    ).rejects.toThrow('migration exit');
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', aborted.operationBytes, aborted.ops),
    ).resolves.toMatchObject({ status: 'RECONCILED' });
    aborted.setApplied(true);
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', aborted.operationBytes, aborted.ops),
    ).rejects.toThrow('RECONCILE_OWNER_DECISION');

    const successful = adapterFixture();
    await runLocationPhotoMigrationAdapter('deploy', successful.operationBytes, successful.ops);
    await runLocationPhotoMigrationAdapter('reconcile', successful.operationBytes, successful.ops);
    successful.setApplied(false);
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', successful.operationBytes, successful.ops),
    ).rejects.toThrow('RECONCILE_OWNER_DECISION');
  });

  it('reconciles a lost bootstrap ACK by revoking CREATE without starting DDL', async () => {
    const fixture = adapterFixture('bootstrap');
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).rejects.toThrow('lost bootstrap ack');
    expect(fixture.values().createPrivilege).toBe(true);
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'RECONCILED' });
    const values = fixture.values();
    expect(values.applied).toBe(false);
    expect(values.createPrivilege).toBe(false);
    expect(values.receipt).toMatchObject({ status: 'RECONCILED', reconciledStatus: 'ABORTED' });
  });

  it('reconciles a lost preparation ACK before any lock, container or DDL effect', async () => {
    const fixture = adapterFixture('prepare');
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).rejects.toThrow('lost preparation ack');
    expect(fixture.values()).toMatchObject({
      createPrivilege: false,
      applied: false,
      migrationStarts: 0,
      releases: 0,
      receipt: null,
    });
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'RECONCILED' });
    expect(fixture.values()).toMatchObject({
      createPrivilege: false,
      applied: false,
      migrationStarts: 0,
      releases: 1,
      receipt: { status: 'RECONCILED', reconciledStatus: 'ABORTED' },
    });
  });

  it('reconciles a lost cleanup ACK without rerunning the migration container', async () => {
    const fixture = adapterFixture('cleanup');
    await expect(
      runLocationPhotoMigrationAdapter('deploy', fixture.operationBytes, fixture.ops),
    ).rejects.toThrow('lost cleanup ack');
    const id = fixture.values().receipt!.containerId;
    await expect(
      runLocationPhotoMigrationAdapter('reconcile', fixture.operationBytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'RECONCILED' });
    const values = fixture.values();
    expect(values.createPrivilege).toBe(false);
    expect(values.receipt).toMatchObject({
      status: 'RECONCILED',
      reconciledStatus: 'SUCCESS',
      containerId: id,
    });
  });

  it('seals the published migrator prefetch without database or runtime mutation', async () => {
    const fixture = prefetchFixture();
    await expect(
      runLocationPhotoMigratorPrefetchAdapter('pull', fixture.bytes, fixture.ops),
    ).resolves.toMatchObject({
      status: 'LOCATION_PHOTO_MIGRATOR_PREFETCH_VERIFIED',
      databaseMutated: false,
      runtimeMutated: false,
    });
    expect(fixture.values()).toMatchObject({ present: true, pulls: 1 });
    expect(fixture.values().intent).not.toBeNull();
    expect(fixture.values().receipt).not.toBeNull();
  });

  it('reconciles a lost pull ACK from the sealed intent without a second pull', async () => {
    const fixture = prefetchFixture(true);
    await expect(
      runLocationPhotoMigratorPrefetchAdapter('pull', fixture.bytes, fixture.ops),
    ).rejects.toThrow('lost pull ack');
    await expect(
      runLocationPhotoMigratorPrefetchAdapter('reconcile', fixture.bytes, fixture.ops),
    ).resolves.toMatchObject({ status: 'LOCATION_PHOTO_MIGRATOR_PREFETCH_VERIFIED' });
    expect(fixture.values()).toMatchObject({ present: true, pulls: 1 });
  });
});
