import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { closedApplicationOperationFixture } from './timeweb-closed-application.fixture.js';
import { closedBackupFixture } from './timeweb-closed-application.fixture.js';
import {
  createClosedApplicationProductionBinding,
  readClosedApplicationDatabaseState,
  runClosedApplicationPrefetchAdapter,
  validateClosedApplicationPrefetchRequest,
} from './timeweb-closed-application-runtime.js';

describe('closed host runtime no-effects gates', () => {
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
