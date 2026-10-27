import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CLOSED_APPLICATION_BACKUPS,
  closedApplicationBackupBindingSha256,
  closedApplicationBackupDirectory,
  validateClosedApplicationBackupOperation,
} from './timeweb-closed-application-backup.js';
import { closedBackupFixture } from './timeweb-closed-application.fixture.js';

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
});
