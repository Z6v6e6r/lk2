import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertMigrationExecutionAllowed,
  CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK,
  CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK,
  CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
} from './migration-execution-policy.js';

describe('migration execution policy', () => {
  it('allows ordinary rolling migration runs after the foundation is already applied', () => {
    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: new Set(CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES),
        packagedFilenames: CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
      }),
    ).not.toThrow();
  });

  it('fails before DDL when any maintenance-only foundation migration is pending', () => {
    const applied = new Set(CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.slice(0, -1));

    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: applied,
        packagedFilenames: CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED:0073_booking_reminder_scheduler.sql');
    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: applied,
        packagedFilenames: CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
        maintenanceAcknowledgement: 'yes',
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED');
  });

  it('allows the maintenance acknowledgement only when exactly the five gated files are pending', () => {
    const alreadyApplied = new Set(['0068_existing.sql', '0076_existing.sql']);
    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: alreadyApplied,
        packagedFilenames: [
          '0068_existing.sql',
          ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
          '0076_existing.sql',
        ],
        maintenanceAcknowledgement: CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK,
      }),
    ).not.toThrow();

    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: alreadyApplied,
        packagedFilenames: [
          '0068_existing.sql',
          ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
          '0076_existing.sql',
          '0082_unexpected.sql',
        ],
        maintenanceAcknowledgement: CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_MAINTENANCE_UNEXPECTED_PENDING:0082_unexpected.sql');
  });

  it('uses a distinct acknowledgement only for a truly empty database', () => {
    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: new Set(),
        packagedFilenames: ['0001_initial.sql', ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES],
        emptyDatabaseCatalogVerified: true,
        maintenanceAcknowledgement: CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK,
      }),
    ).not.toThrow();
    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: new Set(['0001_initial.sql']),
        packagedFilenames: ['0001_initial.sql', ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES],
        emptyDatabaseCatalogVerified: true,
        maintenanceAcknowledgement: CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED');

    expect(() =>
      assertMigrationExecutionAllowed({
        appliedFilenames: new Set(),
        packagedFilenames: ['0001_initial.sql', ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES],
        emptyDatabaseCatalogVerified: false,
        maintenanceAcknowledgement: CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK,
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED');
  });

  it.each(['../../../apps/migrator/src/main.ts', '../../../scripts/migrate.ts'])(
    'checks maintenance authorization before the first schema mutation in %s',
    (sourcePath) => {
      const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
      const emptyCatalogCheck = source.indexOf('const emptyDatabaseCatalogVerified =');
      const guard = source.indexOf('assertMigrationExecutionAllowed({');
      expect(emptyCatalogCheck).toBeGreaterThanOrEqual(0);
      expect(emptyCatalogCheck).toBeLessThan(guard);
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(
        source.indexOf('create table if not exists public.schema_migrations'),
      );
      expect(guard).toBeLessThan(source.indexOf("await client.query('begin')"));
    },
  );

  it('allows the acknowledgement only in the disposable empty-database CI step', () => {
    const pullRequestWorkflow = readFileSync(
      new URL('../../../.github/workflows/pull-request.yaml', import.meta.url),
      'utf8',
    );
    const stagingWorkflow = readFileSync(
      new URL('../../../.github/workflows/deploy-staging.yaml', import.meta.url),
      'utf8',
    );
    const productionWorkflow = readFileSync(
      new URL('../../../.github/workflows/deploy-production.yaml', import.meta.url),
      'utf8',
    );

    expect(pullRequestWorkflow).toContain(
      'CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
    );
    expect(pullRequestWorkflow.match(/CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK/g)).toHaveLength(1);
    expect(stagingWorkflow).not.toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK');
    expect(productionWorkflow).not.toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK');
  });

  it('keeps both documented maintenance invocations fail-closed before acknowledgement', () => {
    const runbook = readFileSync(
      new URL('../../../docs/runbooks/chats-notifications-moderation.md', import.meta.url),
      'utf8',
    );
    const maintenanceBlocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? '')
      .filter((block) => block.includes('CHAT_PUSH_FOUNDATION_MAINTENANCE_V1'));

    expect(maintenanceBlocks).toHaveLength(2);
    for (const block of maintenanceBlocks) {
      expect(block.startsWith('set -euo pipefail\n')).toBe(true);
      expect(block).toContain('|| return 1');
      expect(block).toMatch(/runtime_database_url="\$\([^\n]+\)" \|\| exit 64/);
      expect(block).toMatch(/migrator_database_url="\$\([^\n]+\)" \|\| exit 64/);
      const preflight = block.indexOf('DATABASE_ROLE_BOUNDARY_PHASE=pre');
      const acknowledgement = block.indexOf(
        'CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK=CHAT_PUSH_FOUNDATION_MAINTENANCE_V1',
      );
      expect(preflight).toBeGreaterThanOrEqual(0);
      expect(acknowledgement).toBeGreaterThan(preflight);
      expect(block.slice(preflight, acknowledgement)).toContain(
        'verify-role-boundary.js || exit 70',
      );
      expect(block.slice(acknowledgement)).toContain('migrator || exit 70');
    }
  });
});
