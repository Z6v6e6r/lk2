import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { closedApplicationOperationFixture } from './timeweb-closed-application.fixture.js';
import {
  closedApplicationCustodyFixture,
  closedBackupFixture,
} from './timeweb-closed-application.fixture.js';
import { closedApplicationAclPlan } from './closed-application-migration-acl.js';
import { closedApplicationSchemas } from './timeweb-closed-application-profile.js';
import { encodeApiWorkerMigrationCapsule } from './timeweb-api-worker-migration.js';
import {
  attestClosedApplicationPrevious,
  createClosedApplicationProductionBinding,
  readClosedApplicationBackupProof,
  readClosedApplicationPrefetchProof,
  readClosedApplicationDatabaseState,
  runClosedApplicationPrefetchAdapter,
  validateClosedApplicationPrefetchRequest,
} from './timeweb-closed-application-runtime.js';

// LOCAL mocked transport/custody only: golden catalog rows are the sole
// validator stub. Real schema/family, generation, hashes, plan, receipt,
// expiry, predecessor identity and no-replay validators are exercised below.
vi.mock('../deploy/timeweb/closed-application-migrations-0103-0104.v1.json', async (original) => {
  const source = await original<{
    default: {
      checkpoints: Record<
        string,
        { catalogs: Record<string, { sha256: string; rowCount: number }> }
      >;
    };
  }>();
  const value = structuredClone(source.default);
  const sha = (await import('node:crypto')).createHash('sha256').update('[]\n').digest('hex');
  for (const point of Object.values(value.checkpoints))
    for (const catalog of Object.values(point.catalogs))
      Object.assign(catalog, { sha256: sha, rowCount: 0 });
  return { ...source, default: value };
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('closed host runtime no-effects gates', () => {
  it('creates distinct fresh generation prefetch proofs after prior files exist, preserves old files and refuses same-generation replay', async () => {
    const a = closedApplicationCustodyFixture('game_start_0103', 'a'.repeat(32));
    const b = closedApplicationCustodyFixture('game_start_0103', 'b'.repeat(32));
    expect(a.paths.prefetchRoot).not.toBe(b.paths.prefetchRoot);
    expect(a.paths.transactionRoot).toBe(b.paths.transactionRoot);
    expect(a.paths.containerName).toBe(b.paths.containerName);
    const root = mkdtempSync(join(tmpdir(), 'phub-prefetch-generations-'));
    let pulls = 0;
    const effects = (f: typeof a) => {
      const directory = join(root, basename(f.paths.prefetchRoot));
      const read = (name: string) =>
        existsSync(join(directory, name)) ? readFileSync(join(directory, name)) : null;
      const write = (name: string, bytes: Buffer) => {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
      };
      return {
        time: () => Date.parse('2026-10-27T07:30:00.000Z'),
        prefetchUnused: () => {},
        assertSource: () => {},
        authority: () => {},
        hostPreflight: () => Promise.resolve(f.input),
        prefetchIntent: () => read('intent.json'),
        prefetchReceipt: () => read('receipt.json'),
        imageInventory: () => [],
        writePrefetchIntent: (bytes: Buffer) => write('intent.json', bytes),
        writePrefetchReceipt: (bytes: Buffer) => write('receipt.json', bytes),
        pullMigrator: () => {
          pulls++;
        },
        image: () => f.operation.publishedMigrator.imageId,
        prefetchImagePresent: () => true,
        assertPrefetchOwner: () => {},
      };
    };
    try {
      await runClosedApplicationPrefetchAdapter('pull', a.prefetchRequestBytes, effects(a));
      const oldFile = join(root, basename(a.paths.prefetchRoot), 'receipt.json');
      const before = {
        bytes: readFileSync(oldFile),
        mtime: statSync(oldFile).mtimeMs,
        ino: statSync(oldFile).ino,
      };
      await runClosedApplicationPrefetchAdapter('pull', b.prefetchRequestBytes, effects(b));
      expect(pulls).toBe(2);
      expect(readFileSync(oldFile)).toEqual(before.bytes);
      expect(statSync(oldFile).mtimeMs).toBe(before.mtime);
      expect(statSync(oldFile).ino).toBe(before.ino);
      await expect(
        runClosedApplicationPrefetchAdapter('pull', a.prefetchRequestBytes, effects(a)),
      ).rejects.toThrow('PREFETCH_USE_RECONCILE');
      expect(pulls).toBe(2);
      const staleFiles = new Map(a.files);
      staleFiles.set(b.paths.prefetchRequestPath, a.prefetchRequestBytes);
      staleFiles.set(b.paths.prefetchRoot + '/intent.json', a.prefetchIntentBytes);
      staleFiles.set(b.paths.prefetchRoot + '/receipt.json', a.prefetchReceiptBytes);
      expect(() =>
        readClosedApplicationPrefetchProof(b.operation, {
          read: (path) => {
            const value = staleFiles.get(path);
            if (!value) throw Error('MISSING_EXPECTED_TEST_FILE');
            return value;
          },
          secure: () => ({ isDirectory: () => true }),
          present: () => true,
        }),
      ).toThrow('PREFETCH_BINDING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('reads generated retained backup proof from the exact namespace and preserves real0103→0104 predecessor request hashes', () => {
    const f = closedApplicationCustodyFixture('game_start_0103', 'a'.repeat(32));
    const schemas = closedApplicationSchemas('game_start_0103'),
      opSha = hash(f.operationBytes),
      planSha = hash(f.planBytes);
    const root = f.paths.transactionRoot,
      migrationId = '7'.repeat(64);
    const aclProofs = Object.fromEntries(
      (['bootstrap', 'cleanup'] as const).map((phase) => [
        phase,
        encode({
          schema: phase === 'bootstrap' ? schemas.bootstrapProof : schemas.cleanupProof,
          operationSha256: opSha,
          sqlSha256: f.plan.inputs[`${phase}Sha256`],
          state: f.state(phase),
        }),
      ]),
    );
    const roles = Object.fromEntries(
      (['pre', 'bootstrap'] as const).map((phase, index) => {
        const acl = closedApplicationAclPlan(
          'game_start_0103',
          f.operation.expectedPrivilegePreimage,
          'R1_PACKAGE119',
        );
        const readback = {
          schema: 'PHUB_CLOSED_APPLICATION_MIGRATOR_READBACK_V1',
          migrationProfile: 'game_start_0103',
          phase,
          wireRoleName: 'phub_migrator',
          target: f.operation.expectedDatabaseTarget,
          currentRoleName: 'phub_migrator',
          sessionRoleName: 'phub_migrator',
          roleOverride: 'none',
          readOnly: 'on',
          recovery: false,
          rolesSafe: true,
          migrationLockAvailable: true,
          acl: phase === 'pre' ? acl.preimage : acl.bootstrap,
        };
        return [phase, { id: String(index + 5).repeat(64), readback }];
      }),
    );
    const roleProofs = Object.fromEntries(
      ['pre', 'bootstrap'].map((phase) => [
        phase,
        encode({
          schema: schemas.roleProof,
          operationSha256: opSha,
          planSha256: planSha,
          phase,
          containerId: roles[phase]!.id,
          readback: roles[phase]!.readback,
        }),
      ]),
    );
    const successBytes = encode({
      schema: schemas.success,
      status: 'SUCCESS',
      planSha256: planSha,
      operationSha256: opSha,
      containerId: migrationId,
      bootstrapSha256: hash(aclProofs.bootstrap!),
      cleanupSha256: hash(aclProofs.cleanup!),
      migratorPreSha256: hash(roleProofs.pre!),
      migratorBootstrapSha256: hash(roleProofs.bootstrap!),
      backup: f.backupProof,
      ledgerSha256: f.plan.postLedgerSha256,
      stateSha256: hash(encode(f.state('cleanup'))),
      observedAt: '2026-10-27T07:35:00.000Z',
    });
    const files = new Map(f.files);
    files.set(
      root + '/preparation.json',
      encodeApiWorkerMigrationCapsule(f.operationBytes, f.planBytes),
    );
    files.set(f.paths.requestPath, f.operationBytes);
    files.set(root + '/plan.json', f.planBytes);
    files.set(root + '/migration-success.json', successBytes);
    files.set(
      root + '/migration-receipt.json',
      encode({
        schema: schemas.receipt,
        status: 'RECONCILED',
        planSha256: planSha,
        operationSha256: opSha,
        observedAt: '2026-10-27T07:36:00.000Z',
        containerId: migrationId,
        successSha256: hash(successBytes),
        reconciledStatus: 'SUCCESS',
      }),
    );
    for (const phase of ['bootstrap', 'cleanup'])
      files.set(root + '/' + phase + '.json', aclProofs[phase]!);
    for (const phase of ['pre', 'bootstrap'])
      files.set(root + '/migrator-' + phase + '.json', roleProofs[phase]!);
    const reads: string[] = [],
      terminals: string[][] = [];
    const deps = {
      secure: () => ({ isDirectory: () => true }),
      present: () => true,
      read: (path: string) => {
        reads.push(path);
        const bytes = files.get(path);
        if (!bytes) throw Error('UNEXPECTED_TEST_PATH:' + path);
        return bytes;
      },
      terminal: (args: string[]) => {
        terminals.push(args);
        return f.terminalBytes;
      },
      effects: () => ({
        loadPlan: () => {},
        lookup: (kind: string) => ({
          Id:
            kind === 'migration'
              ? migrationId
              : roles[kind === 'migrator' ? 'pre' : 'bootstrap']!.id,
          State: { Status: 'exited', ExitCode: 0 },
        }),
        logs: (id: string) =>
          id === roles.pre!.id ? roles.pre!.readback : roles.bootstrap!.readback,
      }),
    } as unknown as NonNullable<Parameters<typeof attestClosedApplicationPrevious>[1]>;
    expect(
      readClosedApplicationBackupProof(f.operation, { fresh: false, retained: true }, deps),
    ).toEqual(f.backupProof);
    const next = {
      ...closedApplicationOperationFixture('subject_link_0104', 'R1_PACKAGE119'),
      backupGeneration: 'b'.repeat(32),
      previousMigrationSuccess: {
        path: root + '/migration-success.json',
        sha256: hash(successBytes),
        operationSha256: opSha,
      },
    };
    const proof = attestClosedApplicationPrevious(next, deps) as {
      requestHashes: Record<string, string>;
    };
    expect(
      proof.requestHashes['/opt/phub/timeweb-beta/operator/database-backup-restore.json'],
    ).toBe(hash(f.backupBytes));
    expect(reads).toContain(f.directory + '/backup-operation.json');
    expect(
      terminals.every(
        (args) =>
          args.includes('--attest-closed-retained') &&
          args.includes(f.directory + '/backup-operation.json'),
      ),
    ).toBe(true);
    expect(() =>
      attestClosedApplicationPrevious(
        {
          ...next,
          controllerTree: 'f'.repeat(40),
          publishedMigrator: { ...next.publishedMigrator, sourceTree: 'f'.repeat(40) },
        },
        deps,
      ),
    ).toThrow('PREVIOUS_BINDING');
  });
  it('constructs a lazy binding without IO and refuses a foreign target', () => {
    const op = closedApplicationOperationFixture('game_start_0103');
    const binding = createClosedApplicationProductionBinding(op);
    expect(binding.kind).toBe('game_start_0103');
    expect(() =>
      createClosedApplicationProductionBinding({
        ...op,
        expectedPostgres: { ...op.expectedPostgres, id: '0'.repeat(64) },
      }),
    ).toThrow();
  });
  it('reads only a short target proof before any catalog query', () => {
    let calls = 0;
    const op = closedApplicationOperationFixture('game_start_0103');
    expect(() =>
      readClosedApplicationDatabaseState(op, 'pre', {
        read: () => {
          throw Error('READ_FORBIDDEN');
        },
        secure: () => {
          throw Error('SECURE_FORBIDDEN');
        },
        present: () => false,
        postgresSql: (sql, readOnly, id) => {
          calls++;
          expect(readOnly).toBe(true);
          expect(id).toBe(op.expectedPostgres.id);
          expect(sql).not.toContain('schema_migrations');
          return { databaseName: 'other', systemIdentifier: '1' };
        },
      }),
    ).toThrow('DATABASE_TARGET');
    expect(calls).toBe(1);
  });
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'validates %s prefetch intent before effects',
    async (kind) => {
      const op = closedApplicationOperationFixture(kind),
        backup = closedBackupFixture(kind);
      const request = {
        schema:
          kind === 'game_start_0103'
            ? 'PHUB_GAME_START_0103_PREFETCH_OPERATION_V1'
            : 'PHUB_SUBJECT_LINK_0104_PREFETCH_OPERATION_V1',
        migrationIntent: op,
        expiresAt: op.expiresAt,
        confirmation: `PULL_${kind.toUpperCase()}_MIGRATOR_ONLY_NO_DATABASE_MUTATION`,
      };
      const bytes = Buffer.from(JSON.stringify(request));
      expect(validateClosedApplicationPrefetchRequest(bytes).migrationIntent).toEqual(
        backup.migrationIntent,
      );
      expect(() =>
        validateClosedApplicationPrefetchRequest(bytes, Date.parse(op.expiresAt)),
      ).toThrow();
      const forbidden = new Proxy(
        {},
        {
          get() {
            throw Error('EFFECT_FORBIDDEN');
          },
        },
      );
      await expect(
        runClosedApplicationPrefetchAdapter(
          'attest',
          Buffer.from(JSON.stringify({ ...request, extra: true })),
          forbidden as never,
        ),
      ).rejects.toThrow('SHAPE');
      await expect(
        runClosedApplicationPrefetchAdapter('arbitrary', bytes, forbidden as never),
      ).rejects.toThrow('PREFETCH_MODE');
    },
  );
  it('retained backup entry is a separate read-only terminal route and never substitutes the shared request', () => {
    const python = readFileSync('scripts/control-timeweb-database-backup.py', 'utf8');
    const branch = python.slice(
      python.indexOf("if len(sys.argv)==3 and sys.argv[1]=='--attest-closed-retained':"),
      python.indexOf("if len(sys.argv)==3 and sys.argv[1]=='--attest-closed-retained':") + 2100,
    );
    expect(branch).toContain('notification_backup_reference(op,raw,file_sha)');
    expect(branch).not.toContain('execute(');
    expect(branch).not.toContain('request_bytes=read_secure(REQUEST)');
  });
});
