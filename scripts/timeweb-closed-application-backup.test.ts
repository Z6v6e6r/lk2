import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CLOSED_APPLICATION_BACKUPS,
  closedApplicationBackupBindingSha256,
  closedApplicationBackupDirectory,
  validateClosedApplicationBackupOperation,
  validateClosedApplicationBackupReceipt,
} from './timeweb-closed-application-backup.js';
import { validateClosedApplicationPlan } from './timeweb-closed-application-profile.js';
import {
  closedApplicationCustodyFixture,
  closedBackupFixture,
} from './timeweb-closed-application.fixture.js';

// Only frozen catalog rows are synthetic here; every operation/generation,
// binding, plan/receipt path, crypto hash and freshness validator remains real.
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

describe('closed backup immutable migration binding', () => {
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'binds %s source, stage and independent backup',
    (kind) => {
      const backup = closedBackupFixture(kind);
      expect(
        validateClosedApplicationBackupOperation(backup, Date.parse('2026-10-27T07:30:00.000Z')),
      ).toBe(backup);
      expect(closedApplicationBackupDirectory(backup)).toContain(
        CLOSED_APPLICATION_BACKUPS[kind].mode,
      );
      for (const change of [
        { catalogVariant: 'DORMANT' },
        { expectedLedgerSha256: '0'.repeat(64) },
        { controllerSourceCiRunId: '123457' },
        { catalogBuilderSha256: '0'.repeat(64) },
        { migrationIntent: { ...backup.migrationIntent, controllerTree: '0'.repeat(40) } },
        { expectedPostgres: { ...backup.expectedPostgres, id: '0'.repeat(64) } },
        { extra: true },
      ])
        expect(() => validateClosedApplicationBackupOperation({ ...backup, ...change })).toThrow();
      expect(() =>
        validateClosedApplicationBackupOperation(backup, Date.parse(backup.expiresAt)),
      ).toThrow('AUTHORITY');
    },
  );
  it('uses the same canonical migration binding as Python and permits only authority renewal', () => {
    const operation = closedBackupFixture('game_start_0103');
    const result = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        "import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('backup','scripts/control-timeweb-database-backup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(m.closed_application_binding_sha(json.load(sys.stdin)))",
      ],
      {
        input: JSON.stringify(operation),
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const intent = operation.migrationIntent,
      digest = closedApplicationBackupBindingSha256(intent);
    expect(result.stdout.trim()).toBe(digest);
    expect(
      closedApplicationBackupBindingSha256({ ...intent, expiresAt: '2026-10-27T09:00:00.000Z' }),
    ).toBe(digest);
    expect(closedApplicationBackupBindingSha256({ ...intent, catalogVariant: 'DORMANT' })).not.toBe(
      digest,
    );
  });
  it('matches Python directory/binding derivation for both stages, absent generations and distinct R1 generations', () => {
    const operations = (['game_start_0103', 'subject_link_0104'] as const).flatMap((kind) => {
      const legacy = closedBackupFixture(kind),
        r1 = closedBackupFixture(kind, 'R1_PACKAGE119');
      return [
        legacy,
        r1,
        ...['0'.repeat(32), 'a'.repeat(32)].map((backupGeneration) => ({
          ...r1,
          migrationIntent: { ...r1.migrationIntent, backupGeneration },
        })),
      ];
    });
    const result = spawnSync(
      'python3',
      [
        '-I',
        '-S',
        '-B',
        '-c',
        "import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('backup','scripts/control-timeweb-database-backup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(json.dumps([{'binding':m.closed_application_binding_sha(op),'directory':str(m.ROOT/'backups'/(op['releaseId']+'-'+m.closed_application_backup_mode(op)))} for op in json.load(sys.stdin)]))",
      ],
      {
        input: JSON.stringify(operations),
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      operations.map((operation) => ({
        binding: closedApplicationBackupBindingSha256(operation.migrationIntent),
        directory: closedApplicationBackupDirectory(operation),
      })),
    );
    const r1 = operations[2]!;
    expect(() =>
      validateClosedApplicationBackupOperation({ ...r1, backupGeneration: 'a'.repeat(32) }),
    ).toThrow('SHAPE');
    expect(closedApplicationBackupBindingSha256(r1.migrationIntent)).not.toBe(
      closedApplicationBackupBindingSha256({
        ...r1.migrationIntent,
        backupGeneration: 'b'.repeat(32),
      }),
    );
  });
  it.each(['game_start_0103', 'subject_link_0104'] as const)(
    'binds real%s receipt/plan paths to generation and keeps one-hour freshness',
    (kind) => {
      const a = closedApplicationCustodyFixture(kind, 'a'.repeat(32)),
        b = closedApplicationCustodyFixture(kind, 'b'.repeat(32));
      const now = Date.parse(a.receipt.completedAt) + 1000;
      const proof = validateClosedApplicationBackupReceipt(
        a.operation,
        a.backup,
        a.backupBytes,
        a.receiptBytes,
        a.preimageBytes,
        { now },
      );
      expect(proof).toEqual(a.backupProof);
      expect(validateClosedApplicationPlan(a.plan, a.operationBytes)).toBe(a.plan);
      expect(validateClosedApplicationPlan(b.plan, b.operationBytes)).toBe(b.plan);
      const renewed = { ...a.operation, expiresAt: '2026-10-27T09:00:00.000Z' };
      expect(
        validateClosedApplicationBackupReceipt(
          renewed,
          a.backup,
          a.backupBytes,
          a.receiptBytes,
          a.preimageBytes,
          { now },
        ),
      ).toEqual(proof);
      expect(() =>
        validateClosedApplicationBackupReceipt(
          b.operation,
          a.backup,
          a.backupBytes,
          a.receiptBytes,
          a.preimageBytes,
          { now },
        ),
      ).toThrow('MIGRATION_BINDING');
      expect(() =>
        validateClosedApplicationBackupReceipt(
          b.operation,
          b.backup,
          b.backupBytes,
          a.receiptBytes,
          b.preimageBytes,
          { now },
        ),
      ).toThrow('RECEIPT');
      const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
      expect(() =>
        validateClosedApplicationPlan(
          { ...a.plan, operationSha256: hash(b.operationBytes) },
          b.operationBytes,
        ),
      ).toThrow('PLAN_BACKUP');
      const stale = Date.parse(a.receipt.completedAt) + 3600001;
      expect(() =>
        validateClosedApplicationBackupReceipt(
          renewed,
          a.backup,
          a.backupBytes,
          a.receiptBytes,
          a.preimageBytes,
          { now: stale },
        ),
      ).toThrow('RECEIPT');
      expect(
        validateClosedApplicationBackupReceipt(
          renewed,
          a.backup,
          a.backupBytes,
          a.receiptBytes,
          a.preimageBytes,
          { now: stale, fresh: false },
        ),
      ).toEqual(proof);
    },
  );
});
