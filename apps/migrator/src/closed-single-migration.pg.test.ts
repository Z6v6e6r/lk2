import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import frozen from '../../../deploy/timeweb/notification-migration-catalogs.v1.json';
import {
  NOTIFICATION_CATALOG_SQL,
  NOTIFICATION_NEW_TABLES,
} from '../../../scripts/notification-migration-catalog.js';
import { closedNewTables, verifyClosedCatalog } from './closed-single-migration.js';
import {
  CLOSED_APPLICATION_CATALOG_SQL,
  CLOSED_APPLICATION_CATALOG_TABLES,
  CLOSED_APPLICATION_EDITOR_ACL,
} from '../../../scripts/closed-application-migration-catalog.js';
import { ownedClosedSchemaLocalFixtureUrl } from '../../../scripts/owned-closed-schema-test-target.js';
import {
  closedApplicationAclSql,
  closedApplicationAclPlan,
  validateClosedApplicationAcl,
} from '../../../scripts/closed-application-migration-acl.js';
import {
  CLOSED_APPLICATION_DATABASE_TARGET,
  closedApplicationStateSql,
  validateClosedApplicationState,
  createClosedApplicationKernelProfile,
  closedApplicationInputDigests,
} from '../../../scripts/timeweb-closed-application-profile.js';
import { closedApplicationOperationFixture } from '../../../scripts/timeweb-closed-application.fixture.js';
import { closedBackupFixture } from '../../../scripts/timeweb-closed-application.fixture.js';
import {
  runClosedApplicationPrefetchAdapter,
  readClosedApplicationBackupProof,
  attestClosedApplicationPrevious,
} from '../../../scripts/timeweb-closed-application-runtime.js';
import {
  CLOSED_APPLICATION_BACKUPS,
  closedApplicationBackupBindingSha256,
  closedApplicationBackupDirectory,
} from '../../../scripts/timeweb-closed-application-backup.js';
import {
  closedApplicationProductionPaths,
  runClosedAdditiveMigrationAdapter,
} from '../../../scripts/timeweb-api-worker-migration.js';
import type { ClosedApplicationOperation } from '../../../scripts/timeweb-closed-application-profile.js';

// Real synthetic-cluster catalog/ACL state, with an explicitly simulated target only.
// No host executor, Docker command, provider or production connection is available here.
async function verifyClosedHostEvidence(operation: ClosedApplicationOperation, state: unknown) {
  const kind = operation.migrationProfile,
    prefix = kind === 'game_start_0103' ? 'PHUB_GAME_START_0103' : 'PHUB_SUBJECT_LINK_0104';
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
  const input = { runtimeSha256: 'a'.repeat(64), secretSetSha256: 'b'.repeat(64), prestate: state };
  const requestBytes = encode({
    schema: `${prefix}_PREFETCH_OPERATION_V1`,
    migrationIntent: operation,
    expiresAt: operation.expiresAt,
    confirmation: `PULL_${kind.toUpperCase()}_MIGRATOR_ONLY_NO_DATABASE_MUTATION`,
  });
  let intent: Buffer | null = null,
    receipt: Buffer | null = null,
    present = false,
    pulls = 0;
  const effects = {
    time: () => Date.parse('2026-10-27T07:30:00.000Z'),
    assertPrefetchOwner: () => undefined,
    prefetchUnused: () => undefined,
    assertSource: () => undefined,
    authority: () => Promise.resolve(undefined),
    hostPreflight: () => Promise.resolve(input),
    prefetchIntent: () => intent,
    prefetchReceipt: () => receipt,
    imageInventory: () => [operation.publishedMigrator.imageId],
    writePrefetchIntent: (bytes: Buffer) => {
      intent = bytes;
    },
    writePrefetchReceipt: (bytes: Buffer) => {
      receipt = bytes;
    },
    pullMigrator: () => {
      pulls++;
      present = true;
    },
    image: () => operation.publishedMigrator.imageId,
    prefetchImagePresent: () => present,
  };
  await expect(
    runClosedApplicationPrefetchAdapter('pull', requestBytes, effects),
  ).resolves.toMatchObject({ status: 'CLOSED_APPLICATION_MIGRATOR_PREFETCH_VERIFIED' });
  expect(pulls).toBe(1);
  await expect(runClosedApplicationPrefetchAdapter('pull', requestBytes, effects)).rejects.toThrow(
    'PREFETCH_USE_RECONCILE',
  );
  await expect(
    runClosedApplicationPrefetchAdapter('attest', requestBytes, effects),
  ).resolves.toBeDefined();
  await expect(
    runClosedApplicationPrefetchAdapter('reconcile', requestBytes, effects),
  ).resolves.toBeDefined();
  present = false;
  await expect(
    runClosedApplicationPrefetchAdapter('reconcile', requestBytes, effects),
  ).rejects.toThrow('PREFETCH_IMAGE_UNKNOWN');
  expect(pulls).toBe(1);
  present = true;
  const saved = receipt;
  receipt = null;
  await expect(
    runClosedApplicationPrefetchAdapter('attest', requestBytes, effects),
  ).rejects.toThrow('PREFETCH_RECEIPT_MISSING');
  await runClosedApplicationPrefetchAdapter('reconcile', requestBytes, effects);
  expect(receipt).toEqual(saved);
  expect(pulls).toBe(1);
  const sealedReceipt = effects.prefetchReceipt();
  if (!sealedReceipt) throw Error('SYNTHETIC_PREFETCH_RECEIPT_REQUIRED');
  const definition = CLOSED_APPLICATION_BACKUPS[kind],
    toolBytes = Buffer.from('synthetic reviewed backup tool');
  const installation = Buffer.from('synthetic installation receipt');
  const backup = {
    ...closedBackupFixture(kind),
    migrationIntent: operation,
    catalogVariant: operation.catalogVariant,
    toolFileSha256: hash(toolBytes),
    toolInstallationSha256: hash(installation),
    migratorPrefetch: {
      requestSha256: hash(requestBytes),
      receiptSha256: hash(sealedReceipt),
      migratorImage: operation.publishedMigrator.image,
      imageId: operation.publishedMigrator.imageId,
    },
  };
  const directory = closedApplicationBackupDirectory(backup),
    backupBytes = encode(backup),
    security = { schema: 'PHUB_NOTIFICATION_BACKUP_SECURITY_V1', objects: [], roles: [] };
  const preimageBytes = encode({
    schema: definition.preimageSchema,
    state,
    target: operation.expectedDatabaseTarget,
    security,
  });
  const completedAt = '2026-10-27T07:20:00.000Z';
  const backupReceipt = {
    schema: definition.receiptSchema,
    baselineReleaseId: operation.expectedApi.releaseId,
    completedAt,
    backupFile: `${directory}/database.pgcustom`,
    backupSha256: 'd'.repeat(64),
    restoreVerified: true,
    restoreImage: operation.expectedPostgres.image,
    restoredLedgerSha256: definition.ledgerSha256,
    sourceLedgerSha256: definition.ledgerSha256,
    operationSha256: hash(backupBytes),
    target: operation.expectedDatabaseTarget,
    preimageSha256: hash(preimageBytes),
    packageDescriptorSha256: operation.packageDescriptorSha256,
    aclRecovery: 'ISOLATED_OWNER_ACL_RESTORE_VERIFIED',
    securityPreimageSha256: hash(encode(security)),
    restoredSecuritySha256: hash(encode(security)),
    roleClosureSha256: hash(encode([])),
    migratorPrefetch: backup.migratorPrefetch,
    migrationProfile: kind,
    catalogVariant: operation.catalogVariant,
    catalogBuilderSha256: operation.catalogBuilderSha256,
    migrationBindingSha256: closedApplicationBackupBindingSha256(operation),
  };
  const backupReceiptBytes = encode(backupReceipt),
    paths = closedApplicationProductionPaths(operation);
  const files = new Map([
    [`${directory}/backup-operation.json`, backupBytes],
    [`${directory}/database-backup-receipt.json`, backupReceiptBytes],
    [`${directory}/preimage-proof.json`, preimageBytes],
    ['/opt/phub/timeweb-beta/operator/database-backup-restore.json', backupBytes],
    [
      `/opt/phub/timeweb-beta/operator/tools/${operation.controllerSha}/control-timeweb-database-backup.py`,
      toolBytes,
    ],
    [
      `/opt/phub/timeweb-beta/operator/tools/${operation.controllerSha}/installation-receipt.json`,
      installation,
    ],
    [paths.prefetchRequestPath, requestBytes],
    [`${paths.prefetchRoot}/intent.json`, intent!],
    [`${paths.prefetchRoot}/receipt.json`, receipt!],
  ]);
  const terminal = {
    schema: definition.terminalSchema,
    operationSha256: hash(backupBytes),
    receiptSha256: hash(backupReceiptBytes),
    preimageSha256: hash(preimageBytes),
    target: operation.expectedDatabaseTarget,
    sourceLedgerSha256: definition.ledgerSha256,
    storageCleanupVerified: true,
    reconciled: true,
    migratorPrefetch: backup.migratorPrefetch,
    migrationProfile: kind,
    catalogVariant: operation.catalogVariant,
    catalogBuilderSha256: operation.catalogBuilderSha256,
    migrationBindingSha256: closedApplicationBackupBindingSha256(operation),
  };
  const deps = {
    git: () => {
      throw Error('GIT_FORBIDDEN');
    },
    read: (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw Error('MISSING_SYNTHETIC_FILE');
      return bytes;
    },
    secure: () => ({ isDirectory: () => true }),
    present: (path: string) => files.has(path),
    terminal: (args: string[]) => {
      expect(args.slice(-2)).toEqual(
        args.at(-2) === '--attest-closed-retained'
          ? ['--attest-closed-retained', `${directory}/backup-operation.json`]
          : ['--attest-disk', '/opt/phub/timeweb-beta/operator/database-backup-restore.json'],
      );
      return encode(terminal);
    },
  };
  const proof = readClosedApplicationBackupProof(
    operation,
    { now: Date.parse('2026-10-27T07:30:00.000Z') },
    deps,
  );
  expect(proof.sha256).toBe(hash(backupReceiptBytes));
  const runtimeRow = (identity: ClosedApplicationOperation['expectedApi']) => ({
    identity,
    status: 'running',
    health: 'healthy',
    fingerprint: 'e'.repeat(64),
  });
  const runtime = {
    api: runtimeRow(operation.expectedApi),
    worker: runtimeRow(operation.expectedWorker),
    postgres: operation.expectedPostgres,
    controllerConfigSha256: 'f'.repeat(64),
    excluded: [runtimeRow(operation.expectedPostgres)],
  };
  let sourceReads = 0,
    clock = Date.parse('2026-10-27T07:30:00.000Z');
  const mutationCalls: string[] = [];
  await expect(
    runClosedAdditiveMigrationAdapter(
      'deploy',
      encode(operation),
      {
        time: () => clock,
        receiptPath: 'synthetic-only',
        assertUnused: () => undefined,
        assertSource: () => {
          if (++sourceReads > 1) clock = Date.parse(operation.expiresAt);
        },
        authority: () => Promise.resolve(undefined),
        snapshot: () => runtime,
        secrets: () => ({
          releaseId: operation.expectedSecretSetReleaseId,
          device: 1,
          inode: 2,
          files: operation.expectedSecretSetFiles,
        }),
        ledger: () => (state as { ledger: unknown }).ledger,
        closedApplicationState: () => state,
        backup: () => proof,
        image: () => operation.publishedMigrator.imageId,
        inputs: () => closedApplicationInputDigests(operation),
        prepare: () => undefined,
        writeReceipt: () => undefined,
        claim: () => undefined,
        assertOwned: () => undefined,
        bootstrap: () => mutationCalls.push('bootstrap'),
        create: () => mutationCalls.push('create'),
        start: () => mutationCalls.push('start'),
      } as never,
      createClosedApplicationKernelProfile(operation),
    ),
  ).rejects.toThrow('EXPIRED');
  expect(mutationCalls).toEqual([]);
  expect(() =>
    readClosedApplicationBackupProof(
      operation,
      { now: Date.parse('2026-10-27T09:30:00.000Z') },
      deps,
    ),
  ).toThrow('RECEIPT');
  expect(
    readClosedApplicationBackupProof(
      operation,
      { now: Date.parse('2026-10-27T09:30:00.000Z'), fresh: false },
      deps,
    ),
  ).toEqual(proof);
  expect(() =>
    readClosedApplicationBackupProof(
      operation,
      { fresh: false },
      { ...deps, terminal: () => encode({ ...terminal, reconciled: false }) },
    ),
  ).toThrow('BACKUP_TERMINAL');
  files.set('/opt/phub/timeweb-beta/operator/database-backup-restore.json', Buffer.from('{}'));
  expect(() => readClosedApplicationBackupProof(operation, { fresh: false }, deps)).toThrow(
    'BACKUP_REQUEST',
  );
  files.set('/opt/phub/timeweb-beta/operator/database-backup-restore.json', backupBytes);
  return { proof, files, deps };
}

async function verifyClosedKernelRecovery(
  operation: ClosedApplicationOperation,
  states: Record<string, Record<string, unknown>>,
  backup: Readonly<Record<string, unknown>>,
) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
  const profile = createClosedApplicationKernelProfile(operation),
    operationBytes = encode(operation);
  const runtimeRow = (identity: ClosedApplicationOperation['expectedApi']) => ({
    identity,
    status: 'running',
    health: 'healthy',
    fingerprint: 'a'.repeat(64),
  });
  const runtime = {
    api: runtimeRow(operation.expectedApi),
    worker: runtimeRow(operation.expectedWorker),
    postgres: operation.expectedPostgres,
    controllerConfigSha256: 'b'.repeat(64),
    excluded: [runtimeRow(operation.expectedPostgres)],
  };
  const secretSet = {
    releaseId: operation.expectedSecretSetReleaseId,
    device: 1,
    inode: 2,
    files: operation.expectedSecretSetFiles,
  };
  let completed:
    | {
        files: Map<string, Buffer>;
        effects: unknown;
        successSha256: string;
        operationSha256: string;
      }
    | undefined;
  for (const crash of [
    null,
    'BOOTSTRAP_INTENT',
    'BOOTSTRAP_APPLIED',
    'PREPARED',
    'CREATE_INTENT',
    'CREATED',
    'START_INTENT',
    'STARTED',
    'CLEANUP_INTENT',
    'CLEANUP_APPLIED',
    'SUCCESS',
  ]) {
    let stage = 'pre',
      capsule: Buffer | null = null,
      receipt: Record<string, unknown> | null = null,
      success: Buffer | null = null,
      locked = false,
      crashed = false;
    const proofs = new Map<string, Buffer>();
    const containers = new Map<
      string,
      { Id: string; State: { Status: string; ExitCode: number } }
    >();
    let starts = 0,
      creates = 0;
    const readback = (kind: string) => {
      const phase = kind === 'migrator' ? 'pre' : 'bootstrap';
      return {
        schema: 'PHUB_CLOSED_APPLICATION_MIGRATOR_READBACK_V1',
        migrationProfile: operation.migrationProfile,
        phase,
        wireRoleName: 'phub_migrator',
        target: operation.expectedDatabaseTarget,
        currentRoleName: 'phub_migrator',
        sessionRoleName: 'phub_migrator',
        roleOverride: 'none',
        readOnly: 'on',
        recovery: false,
        rolesSafe: true,
        migrationLockAvailable: true,
        acl: states[phase]!.acl,
      };
    };
    const effects = {
      time: () => Date.parse('2026-10-27T07:30:00.000Z'),
      receiptPath: 'synthetic-only',
      assertUnused: () => undefined,
      assertSource: () => undefined,
      authority: () => Promise.resolve(undefined),
      snapshot: () => runtime,
      secrets: () => secretSet,
      ledger: () => states[stage]!.ledger,
      closedApplicationState: (phase: string) => ({ ...states[stage], phase }),
      backup: () => backup,
      image: () => operation.publishedMigrator.imageId,
      inputs: () => closedApplicationInputDigests(operation),
      prepare: (bytes: Buffer) => {
        capsule = bytes;
      },
      preparation: () => capsule,
      loadPlan: () => undefined,
      writeReceipt: (value: Record<string, unknown>) => {
        receipt = value;
        if (value.status === crash && !crashed) {
          crashed = true;
          throw Error('SYNTHETIC_CRASH_AFTER_DURABLE_JOURNAL');
        }
      },
      receipt: () => receipt,
      claim: () => {
        locked = true;
      },
      assertOwned: () => {
        if (!locked) throw Error('SYNTHETIC_LOCK_MISSING');
      },
      bootstrap: () => {
        stage = 'bootstrap';
      },
      cleanup: () => {
        stage = stage === 'post' ? 'cleanup' : 'pre';
      },
      create: (kind: string) => {
        creates++;
        const Id = (kind === 'migration' ? '1' : kind === 'migrator' ? '2' : '3').repeat(64);
        containers.set(kind, { Id, State: { Status: 'created', ExitCode: 0 } });
        return Id;
      },
      lookup: (kind: string) => containers.get(kind) ?? null,
      start: (_id: string, kind: string) => {
        if (kind === 'migration') starts++;
        containers.get(kind)!.State.Status = 'running';
      },
      wait: (_id: string, kind: string) => {
        containers.get(kind)!.State.Status = 'exited';
        if (kind === 'migration') stage = 'post';
      },
      logs: (id: string) =>
        readback([...containers.entries()].find(([, row]) => row.Id === id)![0]),
      writeClosedApplicationProof: (name: string, bytes: Buffer) => {
        proofs.set(name, bytes);
      },
      readClosedApplicationProof: (name: string) => proofs.get(name) ?? null,
      successProof: () => success,
      writeSuccess: (bytes: Buffer) => {
        success = bytes;
      },
      attestStoppedProbes: () => undefined,
      release: () => {
        locked = false;
      },
    };
    if (crash === null)
      await expect(
        runClosedAdditiveMigrationAdapter('deploy', operationBytes, effects as never, profile),
      ).resolves.toMatchObject({ status: 'SUCCESS' });
    else
      await expect(
        runClosedAdditiveMigrationAdapter('deploy', operationBytes, effects as never, profile),
      ).rejects.toThrow('SYNTHETIC_CRASH');
    const before = { starts, creates };
    if (['START_INTENT', 'STARTED'].includes(crash ?? '')) {
      await expect(
        runClosedAdditiveMigrationAdapter('reconcile', operationBytes, effects as never, profile),
      ).rejects.toThrow('RECONCILE_OWNER_DECISION');
      expect(locked).toBe(true);
    } else {
      await expect(
        runClosedAdditiveMigrationAdapter('reconcile', operationBytes, effects as never, profile),
      ).resolves.toMatchObject({ status: 'RECONCILED' });
      expect(locked).toBe(false);
      expect((receipt as Record<string, unknown> | null)?.reconciledStatus).toBe(
        ['CLEANUP_INTENT', 'CLEANUP_APPLIED', 'SUCCESS'].includes(crash ?? 'SUCCESS')
          ? 'SUCCESS'
          : 'ABORTED',
      );
    }
    // No migration/probe container is created or started during reconciliation.
    expect({ starts, creates }).toEqual(before);
    if (crash === null) {
      const paths = closedApplicationProductionPaths(operation),
        root = paths.transactionRoot;
      const savedCapsule = capsule as Buffer | null,
        savedSuccess = success as Buffer | null;
      if (!savedCapsule || !savedSuccess) throw Error('SYNTHETIC_COMPLETE_PROOF_REQUIRED');
      const saved = JSON.parse(savedCapsule.toString()) as { plan: string };
      completed = {
        files: new Map([
          [`${root}/preparation.json`, savedCapsule],
          [`${root}/plan.json`, Buffer.from(saved.plan, 'base64')],
          [`${root}/migration-receipt.json`, encode(receipt)],
          [`${root}/migration-success.json`, savedSuccess],
          [paths.requestPath, operationBytes],
          ...[...proofs.entries()].map(
            ([name, bytes]) => [`${root}/${name}`, bytes] as [string, Buffer],
          ),
        ]),
        effects,
        successSha256: hash(savedSuccess),
        operationSha256: hash(operationBytes),
      };
    }
  }
  if (!completed) throw Error('SYNTHETIC_COMPLETE_PROOF_REQUIRED');
  return completed;
}

const root = resolve(import.meta.dirname, '../../..');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function disposableTarget(): string | undefined {
  if (process.env.CLOSED_SINGLE_MIGRATION_PG_TESTS !== '1') return undefined;
  const raw = process.env.CLOSED_SINGLE_MIGRATION_DATABASE_URL;
  if (!raw) throw Error('CLOSED_SINGLE_TEST_DATABASE_REQUIRED');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.search ||
    url.hash
  )
    throw Error('CLOSED_SINGLE_TEST_TARGET');
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.APP_ENV === 'ci' && url.port === '5432')
    return url.toString();
  return ownedClosedSchemaLocalFixtureUrl(process.env);
}
const disposable = disposableTarget();
const ident = (value: string) => {
  if (!/^[a-z_][a-z0-9_.]*$/.test(value)) throw Error('CLOSED_SINGLE_TEST_IDENTIFIER');
  return value;
};
const roleName = (value: string) => {
  const names: Record<string, string> = {
    MIGRATOR: 'phub_migrator',
    RUNTIME: 'phub_runtime',
    PUBLIC: 'PUBLIC',
    phub_beta: 'phub_beta',
  };
  const name = names[value];
  if (!name) throw Error('CLOSED_SINGLE_TEST_ROLE');
  return name;
};
const rolePasswords = {
  phub_beta: 'synthetic_beta_only',
  phub_migrator: 'synthetic_migrator_only',
  phub_runtime: 'synthetic_runtime_only',
};

(disposable ? describe.sequential : describe.skip)(
  'fixed application migration modes on owned PG16',
  () => {
    it.each(['DORMANT', 'SCENARIO_EDITOR_V1'] as const)(
      'applies one step with bounded rollback and preserved %s ACL',
      async (catalogVariant) => {
        const admin = new Pool({ connectionString: disposable, max: 2 });
        const database = `closed_single_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        const directory = await mkdtemp(resolve(tmpdir(), 'closed-single-pg-'));
        const ownedRoles: string[] = [];
        let created = false;
        let db: Pool | undefined;
        try {
          expect(
            (
              await admin.query<{ major: number }>(
                "select current_setting('server_version_num')::int/10000 as major",
              )
            ).rows[0]?.major,
          ).toBe(16);
          for (const [role, password] of Object.entries(rolePasswords)) {
            const present = (await admin.query('select 1 from pg_roles where rolname=$1', [role]))
              .rowCount;
            if (present === 0) {
              await admin.query(
                `create role ${role} login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
              );
              ownedRoles.push(role);
            }
          }
          await admin.query(`create database ${database}`);
          created = true;
          const adminUrl = new URL(disposable!);
          adminUrl.pathname = '/' + database;
          db = new Pool({ connectionString: adminUrl.toString(), max: 2 });
          const client = await db.connect();
          try {
            await client.query(
              'create table public.schema_migrations(filename text primary key,checksum text not null,applied_at timestamptz not null default now())',
            );
            const source = resolve(root, 'packages/database/migrations');
            const files = (await readdir(source)).filter((x) => x.endsWith('.sql')).sort();
            for (const filename of files.slice(0, 106)) {
              const sql = await readFile(resolve(source, filename), 'utf8');
              await client.query('begin');
              try {
                await client.query(sql);
                await client.query(
                  'insert into public.schema_migrations(filename,checksum) values($1,$2)',
                  [filename, hash(sql)],
                );
                await client.query('commit');
              } catch (error) {
                await client.query('rollback');
                throw error;
              }
            }
            // This newly referenced parent is outside the old105 golden scope. Its owner is
            // independently confirmed by a read-only production metadata check.
            await client.query(
              'alter table games.games owner to phub_beta;alter schema identity owner to phub_beta;alter schema notifications owner to phub_beta',
            );
            // Restore the independent105 golden ownership/ACL baseline without copying business data.
            const rows = frozen.checkpoints['105'].rows;
            for (const row of rows) {
              const value = JSON.parse(row.value) as { owner: string };
              if (row.key.startsWith('relation:') || row.key.startsWith('parent:')) {
                const name = row.key.startsWith('relation:')
                  ? row.key.slice(9)
                  : row.key.split(':')[1]!;
                await client.query(`alter table ${ident(name)} owner to ${roleName(value.owner)}`);
              }
            }
            for (const row of rows) {
              const value = JSON.parse(row.value) as {
                owner: string;
                acl?: [string, string, string, boolean][];
              };
              if (row.key.startsWith('relation:'))
                for (const [grantee, , privilege, grantable] of value.acl ?? []) {
                  if (roleName(grantee) === roleName(value.owner)) continue;
                  if (
                    ![
                      'SELECT',
                      'INSERT',
                      'UPDATE',
                      'DELETE',
                      'REFERENCES',
                      'TRIGGER',
                      'TRUNCATE',
                    ].includes(privilege) ||
                    grantable
                  )
                    throw Error('CLOSED_SINGLE_TEST_GRANT');
                  await client.query(
                    `grant ${privilege} on ${ident(row.key.slice(9))} to ${roleName(grantee)}`,
                  );
                }
              if (row.key.startsWith('column:'))
                for (const [grantee, , privilege, grantable] of value.acl ?? []) {
                  if (privilege !== 'REFERENCES' || grantable)
                    throw Error('CLOSED_SINGLE_TEST_COLUMN_GRANT');
                  const [, relation, column] = row.key.split(':');
                  await client.query(
                    `grant references (${ident(column!)}) on ${ident(relation!)} to ${roleName(grantee)}`,
                  );
                }
              if (row.key.startsWith('function:')) {
                const name = row.key.slice(9);
                if (!/^[a-z_.]+\(\)$/.test(name)) throw Error('CLOSED_SINGLE_TEST_FUNCTION');
                await client.query(`alter function ${name} owner to ${roleName(value.owner)}`);
              }
            }
            await client.query(`alter table public.schema_migrations owner to phub_migrator;
          grant usage on schema public,identity,profile,notifications,support,games,locations to phub_migrator,phub_runtime;
          grant execute on function pg_catalog.pg_control_system() to phub_migrator,phub_runtime;
          alter default privileges for role phub_migrator in schema identity grant select,insert,update,delete on tables to phub_runtime`);
            await client.query("set search_path='pg_catalog'");
            const baseline = (
              await client.query(NOTIFICATION_CATALOG_SQL, [[...NOTIFICATION_NEW_TABLES]])
            ).rows;
            expect(hash(`${JSON.stringify(baseline)}\n`)).toBe(frozen.checkpoints['105'].sha256);
            if (catalogVariant === 'SCENARIO_EDITOR_V1') {
              await client.query('set role phub_migrator');
              try {
                for (const [table, privilege] of CLOSED_APPLICATION_EDITOR_ACL)
                  await client.query(`grant ${privilege} on ${ident(table)} to phub_runtime`);
              } finally {
                await client.query('reset role');
              }
            }
          } finally {
            client.release();
          }
          await symlink(
            resolve(root, 'packages/database/migrations'),
            resolve(directory, 'migrations'),
          );
          const roleUrl = new URL(adminUrl);
          roleUrl.username = 'phub_migrator';
          roleUrl.password = rolePasswords.phub_migrator;
          const identity = (
            await db.query<{ databaseName: string; systemIdentifier: string }>(
              'select current_database() as "databaseName",system_identifier::text as "systemIdentifier" from pg_control_system()',
            )
          ).rows[0]!;
          const target = { ...identity, catalogVariant };
          const encoded = Buffer.from(JSON.stringify(target)).toString('base64');
          const main = 'apps/migrator/src/main.ts',
            game = ['--game-start-migration-0103', encoded],
            subject = ['--subject-link-migration-0104', encoded];
          const cli = (entry: string, args: string[] = [], cwd = directory) =>
            promisify(execFile)(
              process.execPath,
              [
                '--import',
                resolve(root, 'node_modules/tsx/dist/loader.mjs'),
                resolve(root, entry),
                ...args,
              ],
              {
                cwd,
                timeout: 45000,
                maxBuffer: 200000,
                env: {
                  PATH: process.env.PATH ?? '',
                  DATABASE_URL: roleUrl.toString(),
                  TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.json'),
                },
              },
            );
          const denied = async (
            code: string,
            entry = main,
            args: string[] = [],
            cwd = directory,
          ) => {
            await expect(cli(entry, args, cwd)).rejects.toMatchObject({
              stderr: expect.stringContaining(code) as unknown,
            });
          };
          const count = async () =>
            (await db!.query<{ n: number }>('select count(*)::int n from public.schema_migrations'))
              .rows[0]!.n;
          const catalog = async () =>
            (
              await db!.query<{ key: string; value: string }>(CLOSED_APPLICATION_CATALOG_SQL, [
                CLOSED_APPLICATION_CATALOG_TABLES,
              ])
            ).rows;
          const acls = async () =>
            JSON.stringify(
              (
                await db!
                  .query(`select 'schema:'||nspname item,coalesce(nspacl::text,'') acl from pg_namespace where nspname in ('identity','notifications') union all
        select 'column:'||attrelid::regclass::text||':'||attname,coalesce(attacl::text,'') from pg_attribute where attrelid in ('identity.tenants'::regclass,'identity.users'::regclass,'games.games'::regclass) and attnum>0 and not attisdropped union all
        select 'default:'||coalesce(n.nspname,'GLOBAL'),d.defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where d.defaclrole='phub_migrator'::regrole order by item`)
              ).rows,
            );
          const pre = await catalog(),
            aclPreimage = await acls();
          await denied('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
          await denied(
            'CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED',
            'scripts/migrate.ts',
            [],
            root,
          );
          await denied('CLOSED_APPLICATION_MIGRATION_LEDGER', main, subject);
          await denied('CLOSED_APPLICATION_MIGRATION_TARGET', main, [
            '--game-start-migration-0103',
            Buffer.from(JSON.stringify({ ...target, systemIdentifier: '1' })).toString('base64'),
          ]);
          await denied('CLOSED_APPLICATION_MIGRATION_CATALOG', main, [
            '--game-start-migration-0103',
            Buffer.from(
              JSON.stringify({
                ...target,
                catalogVariant: catalogVariant === 'DORMANT' ? 'SCENARIO_EDITOR_V1' : 'DORMANT',
              }),
            ).toString('base64'),
          ]);
          // No env timeout is supplied: the closed mode itself must bound advisory acquisition.
          const advisoryBlocker = await db.connect(),
            advisoryStarted = Date.now();
          try {
            await advisoryBlocker.query('select pg_advisory_lock($1)', [7_140_221]);
            await denied('timeout', main, game);
          } finally {
            await advisoryBlocker.query('select pg_advisory_unlock($1)', [7_140_221]);
            advisoryBlocker.release();
          }
          expect(Date.now() - advisoryStarted).toBeLessThan(20000);
          expect(await count()).toBe(106);
          expect(await catalog()).toEqual(pre);
          await denied('permission denied', main, game);
          expect(await count()).toBe(106);
          expect(await catalog()).toEqual(pre);
          const readTemporaryAcl = async (profile: 'game_start_0103' | 'subject_link_0104') =>
            (
              await db!.query<{ snapshot: unknown }>(
                `select (${closedApplicationAclSql(profile)}) snapshot`,
              )
            ).rows[0]!.snapshot;
          const gameAcl = closedApplicationAclPlan(
            'game_start_0103',
            await readTemporaryAcl('game_start_0103'),
          );
          const hostState = async (
            profile: 'game_start_0103' | 'subject_link_0104',
            phase: string,
          ) => {
            const client = await db!.connect();
            try {
              const result = (await client.query(
                closedApplicationStateSql(profile, phase),
              )) as unknown as { rows: Record<string, unknown>[] }[];
              return {
                ...(result.flatMap((row) => row.rows)[0]!.jsonb_build_object as Record<
                  string,
                  unknown
                >),
                target: CLOSED_APPLICATION_DATABASE_TARGET,
              };
            } finally {
              client.release();
            }
          };
          const verifyHostPrestate = async (
            profile: 'game_start_0103' | 'subject_link_0104',
            acl: typeof gameAcl,
          ) => {
            const client = await db!.connect();
            try {
              const result = (await client.query(
                closedApplicationStateSql(profile, 'pre'),
              )) as unknown as { rows: Record<string, unknown>[] }[];
              const observed = result.flatMap((row) => row.rows)[0]!.jsonb_build_object as Record<
                string,
                unknown
              >;
              const operation = {
                ...closedApplicationOperationFixture(profile),
                catalogVariant,
                expectedPrivilegePreimage: acl.preimage,
                aclPreimageSha256: acl.preimageSha256,
                bootstrapSha256: acl.bootstrapSha256,
                cleanupSha256: acl.cleanupSha256,
              };
              expect(() => validateClosedApplicationState(operation, observed, 'pre')).toThrow(
                'STATE',
              );
              const state = { ...observed, target: CLOSED_APPLICATION_DATABASE_TARGET };
              const evidence = await verifyClosedHostEvidence(operation, state);
              return { ...evidence, operation, state };
            } finally {
              client.release();
            }
          };
          const gameEvidence = await verifyHostPrestate('game_start_0103', gameAcl);
          await db.query(gameAcl.bootstrapSql);
          const gameBootstrap = await hostState('game_start_0103', 'bootstrap');
          const blocker = await db.connect(),
            started = Date.now();
          try {
            await blocker.query(
              'begin;lock table notifications.scenario_runs in access exclusive mode',
            );
            await denied('lock timeout', main, game);
          } finally {
            await blocker.query('rollback');
            blocker.release();
          }
          expect(Date.now() - started).toBeLessThan(20000);
          expect(await count()).toBe(106);
          expect(await catalog()).toEqual(pre);
          expect((await cli(main, game)).stdout.trim()).toBe(
            'Applied 0103_game_start_notification_scenarios.sql',
          );
          expect(await count()).toBe(107);
          expect(
            (
              await db.query<{ relation: string | null }>(
                "select to_regclass('identity.external_subject_link_commands') as relation",
              )
            ).rows[0]?.relation,
          ).toBeNull();
          const gamePost = await hostState('game_start_0103', 'post');
          await db.query(gameAcl.cleanupSql);
          const gameCleanup = await hostState('game_start_0103', 'cleanup');
          const completedGame = await verifyClosedKernelRecovery(
            gameEvidence.operation,
            {
              pre: gameEvidence.state,
              bootstrap: gameBootstrap,
              post: gamePost,
              cleanup: gameCleanup,
            },
            gameEvidence.proof,
          );
          expect(await acls()).toBe(aclPreimage);
          await denied('CLOSED_APPLICATION_MIGRATION_LEDGER', main, game);
          await denied('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
          await db.query(
            'alter table notifications.legacy_game_reminder_sources disable row level security',
          );
          await denied('CLOSED_APPLICATION_MIGRATION_CATALOG', main, subject);
          await db.query(
            'alter table notifications.legacy_game_reminder_sources enable row level security',
          );
          // These mutations evade the historical catalog; the additive contract must see them.
          const semanticProbe = await db.connect();
          try {
            for (const sql of [
              'create rule synthetic_no_insert as on insert to notifications.legacy_game_reminder_sources do instead nothing',
              'alter table notifications.legacy_game_reminder_sources add column synthetic_tombstone text;alter table notifications.legacy_game_reminder_sources drop column synthetic_tombstone',
              'alter table notifications.legacy_game_reminder_sources set (fillfactor=83)',
              'alter table games.games owner to phub',
            ]) {
              await semanticProbe.query('begin');
              try {
                const before = (
                  await semanticProbe.query(NOTIFICATION_CATALOG_SQL, [
                    CLOSED_APPLICATION_CATALOG_TABLES,
                  ])
                ).rows;
                await semanticProbe.query(sql);
                const after = (
                  await semanticProbe.query(NOTIFICATION_CATALOG_SQL, [
                    CLOSED_APPLICATION_CATALOG_TABLES,
                  ])
                ).rows;
                expect(after).toEqual(before);
                await expect(
                  verifyClosedCatalog(semanticProbe, 107, catalogVariant),
                ).rejects.toThrow('CLOSED_APPLICATION_MIGRATION_CATALOG');
              } finally {
                await semanticProbe.query('rollback');
              }
              await semanticProbe.query('begin read only');
              try {
                await verifyClosedCatalog(semanticProbe, 107, catalogVariant);
              } finally {
                await semanticProbe.query('rollback');
              }
            }
          } finally {
            semanticProbe.release();
          }
          const subjectAcl = closedApplicationAclPlan(
            'subject_link_0104',
            await readTemporaryAcl('subject_link_0104'),
          );
          const subjectEvidence = await verifyHostPrestate('subject_link_0104', subjectAcl);
          const next = {
            ...subjectEvidence.operation,
            previousMigrationSuccess: {
              path: `${closedApplicationProductionPaths(gameEvidence.operation).transactionRoot}/migration-success.json`,
              sha256: completedGame.successSha256,
              operationSha256: completedGame.operationSha256,
            },
          };
          const previousFiles = new Map([...gameEvidence.files, ...completedGame.files]);
          // The operator request now belongs to B. Retained A custody must never read B as A.
          previousFiles.set(
            '/opt/phub/timeweb-beta/operator/database-backup-restore.json',
            Buffer.from('{"stage":"second"}'),
          );
          const previousDeps = {
            ...gameEvidence.deps,
            read: (path: string) => {
              const bytes = previousFiles.get(path);
              if (!bytes) throw Error('MISSING_SYNTHETIC_PREVIOUS_FILE');
              return bytes;
            },
            effects: (() => completedGame.effects) as never,
          };
          expect(attestClosedApplicationPrevious(next, previousDeps)).toMatchObject({
            status: 'RECONCILED_SUCCESS',
            operationSha256: completedGame.operationSha256,
          });
          const previousReceiptPath = `${closedApplicationProductionPaths(gameEvidence.operation).transactionRoot}/migration-receipt.json`;
          const previousReceipt = previousFiles.get(previousReceiptPath)!;
          previousFiles.set(
            previousReceiptPath,
            Buffer.from(
              JSON.stringify({
                ...(JSON.parse(previousReceipt.toString()) as Record<string, unknown>),
                reconciledStatus: 'ABORTED',
              }),
            ),
          );
          expect(() => attestClosedApplicationPrevious(next, previousDeps)).toThrow(
            'PREVIOUS_SUCCESS',
          );
          previousFiles.set(previousReceiptPath, previousReceipt);
          await db.query(subjectAcl.bootstrapSql);
          const subjectBootstrap = await hostState('subject_link_0104', 'bootstrap');
          expect((await cli(main, subject)).stdout.trim()).toBe(
            'Applied 0104_identity_external_subject_link_commands.sql',
          );
          expect(await count()).toBe(108);
          const subjectPost = await hostState('subject_link_0104', 'post');
          await db.query(subjectAcl.cleanupSql);
          const subjectCleanup = await hostState('subject_link_0104', 'cleanup');
          await verifyClosedKernelRecovery(
            subjectEvidence.operation,
            {
              pre: subjectEvidence.state,
              bootstrap: subjectBootstrap,
              post: subjectPost,
              cleanup: subjectCleanup,
            },
            subjectEvidence.proof,
          );
          expect(await acls()).toBe(aclPreimage);
          expect(
            (
              await db.query<{ access: boolean }>(
                `select exists(select 1 from unnest($1::text[]) t(name) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege) where has_table_privilege('phub_runtime',name,privilege)) as access`,
                [[...closedNewTables]],
              )
            ).rows[0]?.access,
          ).toBe(false);
          await denied('CLOSED_APPLICATION_MIGRATION_LEDGER', main, subject);
          const stateClient = await db.connect();
          try {
            const response = (await stateClient.query(
              closedApplicationStateSql('subject_link_0104', 'cleanup'),
            )) as unknown as { rows: Record<string, unknown>[] }[];
            const observed = response.flatMap((result) => result.rows)[0]!
              .jsonb_build_object as Record<string, unknown>;
            const template = closedApplicationOperationFixture('subject_link_0104');
            const intent = {
              ...template,
              catalogVariant,
              expectedPrivilegePreimage: subjectAcl.preimage,
              aclPreimageSha256: subjectAcl.preimageSha256,
              bootstrapSha256: subjectAcl.bootstrapSha256,
              cleanupSha256: subjectAcl.cleanupSha256,
            };
            // A synthetic cluster is never a production target. The real readback must be refused.
            expect(() => validateClosedApplicationState(intent, observed, 'cleanup')).toThrow(
              'CLOSED_APPLICATION_PROFILE_STATE',
            );
            // Check the remaining SQL/catalog/ACL shape using an explicitly simulated target only.
            expect(() =>
              validateClosedApplicationState(
                intent,
                { ...observed, target: CLOSED_APPLICATION_DATABASE_TARGET },
                'cleanup',
              ),
            ).not.toThrow();
          } finally {
            stateClient.release();
          }
        } finally {
          await db?.end();
          if (created) await admin.query(`drop database ${database} with(force)`);
          for (const role of ownedRoles.reverse()) await admin.query(`drop role ${role}`);
          await admin.end();
          await rm(directory, { recursive: true, force: true });
        }
      },
      120000,
    );
    it.each(['game_start_0103', 'subject_link_0104'] as const)(
      'seals and restores only added temporary privileges for %s',
      async (profile) => {
        const admin = new Pool({ connectionString: disposable, max: 1 });
        const database = `closed_acl_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        const ownedRoles: string[] = [];
        let created = false;
        let db: Pool | undefined;
        try {
          for (const [role, password] of Object.entries(rolePasswords)) {
            if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
              await admin.query(
                `create role ${role} login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
              );
              ownedRoles.push(role);
            }
          }
          await admin.query(`create database ${database}`);
          created = true;
          const target = new URL(disposable!);
          target.pathname = '/' + database;
          db = new Pool({ connectionString: target.toString(), max: 1 });
          const client = await db.connect();
          try {
            await client.query(`create schema identity authorization phub_beta;create schema games authorization phub_beta;create schema notifications authorization phub_beta;
            set role phub_beta;
            create table identity.tenants(id uuid primary key);
            create table identity.users(tenant_id uuid,id uuid,unrelated text);
            create table games.games(tenant_id uuid,id uuid);
            grant usage on schema identity,games,notifications to phub_migrator;
            grant references(id) on identity.users to phub_migrator;
            grant select(id) on identity.users to phub_runtime;
            ${profile === 'game_start_0103' ? 'grant create on schema notifications to phub_migrator;' : ''}
            reset role;set search_path='pg_catalog'`);
            const read = async () =>
              (
                await client.query<{ snapshot: unknown }>(
                  `select (${closedApplicationAclSql(profile)}) snapshot`,
                )
              ).rows[0]!.snapshot;
            const preimage = await read();
            validateClosedApplicationAcl(profile, preimage);
            const plan = closedApplicationAclPlan(profile, preimage);
            expect(plan.added.some(([key]) => key === 'column:identity.users:id')).toBe(false);
            expect(plan.added.some(([key]) => key === 'schema:notifications')).toBe(false);
            // An unrelated ACL change after sealing must abort the entire bootstrap transaction.
            await client.query('grant update(id) on identity.users to phub_migrator');
            const drift = await read();
            await expect(client.query(plan.bootstrapSql)).rejects.toThrow(
              'CLOSED_APPLICATION_ACL_DRIFT',
            );
            await client.query('rollback');
            expect(await read()).toEqual(drift);
            await client.query('revoke update(id) on identity.users from phub_migrator');
            expect(await read()).toEqual(preimage);
            await client.query(plan.bootstrapSql);
            expect(await read()).toEqual(plan.bootstrap);
            // Repeating either apply is refused, and a failed repetition cannot corrupt its preimage.
            await expect(client.query(plan.bootstrapSql)).rejects.toThrow(
              'CLOSED_APPLICATION_ACL_DRIFT',
            );
            await client.query('rollback');
            expect(await read()).toEqual(plan.bootstrap);
            await client.query(plan.cleanupSql);
            expect(await read()).toEqual(preimage);
            await expect(client.query(plan.cleanupSql)).rejects.toThrow(
              'CLOSED_APPLICATION_ACL_DRIFT',
            );
            await client.query('rollback');
            expect(await read()).toEqual(preimage);
          } finally {
            client.release();
          }
        } finally {
          await db?.end();
          if (created) await admin.query(`drop database ${database} with(force)`);
          for (const role of ownedRoles.reverse()) await admin.query(`drop role ${role}`);
          await admin.end();
        }
      },
      45000,
    );
  },
);
