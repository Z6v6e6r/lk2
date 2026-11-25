import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildCup0119Sql,
  CUP_0119,
  CUP_0119_BACKUP,
  CUP_0119_TARGET,
  validateCup0119Request,
  validateCup0119RetainedBackup,
} from './timeweb-cup-0119-migration.js';

const bytes = readFileSync(
  new URL(`../packages/database/migrations/${CUP_0119.filename}`, import.meta.url),
);
const enrollment = { controllerSha: 'a'.repeat(40), owner: 'fixture-operator' };
const now = Date.parse('2026-11-25T06:00:00.000Z');
const request = {
  schema: 'PHUB_TIMEWEB_CUP_0119_REQUEST_V1',
  attemptId: '01234567-89ab-4cde-8f00-0123456789ab',
  controllerSha: enrollment.controllerSha,
  migrationSourceSha: CUP_0119.source,
  postgresContainerId: 'b'.repeat(64),
  expiresAt: '2026-11-25T06:45:00.000Z',
  retainedBackupReceiptSha256: 'c'.repeat(64),
  externalRestoreDecision: {
    status: 'OWNER_WAIVED_EXTERNAL_RESTORE_FOR_CUP_0119',
    owner: enrollment.owner,
    referenceSha256: 'd'.repeat(64),
  },
};

describe('exact Timeweb CUP 0119 operation', () => {
  it('binds the waiver, retained backup, source and target to the enrolled owner', () => {
    expect(validateCup0119Request(request, enrollment, now)).toBe(request);
    for (const invalid of [
      { ...request, migrationSourceSha: 'f'.repeat(40) },
      { ...request, controllerSha: 'f'.repeat(40) },
      { ...request, retainedBackupReceiptSha256: 'unbound' },
      { ...request, extra: true },
      {
        ...request,
        externalRestoreDecision: { ...request.externalRestoreDecision, owner: 'another' },
      },
      {
        ...request,
        externalRestoreDecision: { ...request.externalRestoreDecision, status: 'WAIVED' },
      },
    ]) {
      expect(() => validateCup0119Request(invalid, enrollment, now)).toThrow('CUP_0119_REQUEST');
    }
    expect(() => validateCup0119Request(request, enrollment, now + 46 * 60_000)).toThrow(
      'CUP_0119_EXPIRED',
    );
  });

  it('recognizes only the retained schedule backup and keeps the archived restore status truthful', () => {
    const path = '/fixture/database.pgcustom';
    const receipt = {
      schema: 'PHUB_TIMEWEB_CANONICAL_FRESH_DUMP_PRIOR_RESTORE_V1',
      baselineReleaseId: CUP_0119_BACKUP.baselineReleaseId,
      restoreAdmissionPolicy: 'EXACT_CANONICAL_PRIOR_FULL_RESTORE_OWNER_WAIVER_V1',
      databaseTarget: {
        databaseName: CUP_0119_TARGET.database,
        systemIdentifier: CUP_0119_TARGET.systemIdentifier,
      },
      sourceLedgerSha256: CUP_0119_BACKUP.ledger,
      freshDumpRestored: false,
      freshDumpIntegrityStatus: 'PG16_TOC_PARSE_VERIFIED',
      backupFile: path,
      dumpBytes: 123,
      backupSha256: 'a'.repeat(64),
      completedAt: '2026-11-25T05:30:01.309Z',
    };
    const archive = { size: 123, nlink: 1, isFile: () => true };
    expect(() => validateCup0119RetainedBackup(receipt, archive, path)).not.toThrow();
    expect(() => validateCup0119RetainedBackup(receipt, { ...archive, size: 124 }, path)).toThrow(
      'CUP_0119_RETAINED_BACKUP',
    );
    expect(() =>
      validateCup0119RetainedBackup({ ...receipt, baselineReleaseId: 'other' }, archive, path),
    ).toThrow('CUP_0119_RETAINED_BACKUP');
    expect(() =>
      validateCup0119RetainedBackup({ ...receipt, freshDumpRestored: true }, archive, path),
    ).toThrow('CUP_0119_RETAINED_BACKUP');
  });

  it('checks the exact SQL bytes and uses a read-only, locked reconciliation query', () => {
    const read = buildCup0119Sql(bytes, CUP_0119_TARGET, 'readback');
    const write = buildCup0119Sql(bytes, CUP_0119_TARGET, 'apply', 'e'.repeat(64));
    expect(read.startsWith('begin read only;')).toBe(true);
    expect(read).not.toContain('insert into public.schema_migrations');
    expect(read).toContain('catalogSha256');
    expect(read).toContain('pg_try_advisory_xact_lock(7140221)');
    expect(write).toContain(bytes.toString());
    expect(write).toContain('pg_temp.cup_0119_preimage');
    expect(write.indexOf('CUP_0119_PREIMAGE')).toBeLessThan(write.indexOf(bytes.toString()));
    expect(write.indexOf('CUP_0119_POSTIMAGE')).toBeLessThan(write.lastIndexOf('commit;'));
    expect(() =>
      buildCup0119Sql(Buffer.concat([bytes, Buffer.from('\n')]), CUP_0119_TARGET, 'apply'),
    ).toThrow('CUP_0119_SQL_CHECKSUM');
    expect(() =>
      buildCup0119Sql(bytes, { ...CUP_0119_TARGET, projectionOid: -1 }, 'apply'),
    ).toThrow('CUP_0119_TARGET');
  });
});
