import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assertClosedApplicationMigrationsNotPending } from './closed-schema-migration-guard.js';

const photo = { filename: '0102_location_recommendation_photos.sql' };
const game = { filename: '0103_game_start_notification_scenarios.sql' };
const subject = { filename: '0104_identity_external_subject_link_commands.sql' };
const packaged = [photo, game, subject];
describe('ordinary migration safety for GAME and authenticated subject linking', () => {
  it('preserves historical error precedence in the executable entrypoint guard blocks', async () => {
    const legacy = [
      { filename: '0099_local_password_reset_proofs.sql' },
      { filename: '0100_notification_scenarios.sql' },
      { filename: '0101_notification_lifecycle_channels.sql' },
    ];
    const all = [...legacy, ...packaged];
    for (const path of ['scripts/migrate.ts', 'apps/migrator/src/migration-runner.ts']) {
      const source = await readFile(path, 'utf8');
      const compatibility =
        'assertMigrationLedgerCompatible({ applied, packaged: packagedMigrations });';
      const start = source.indexOf(compatibility) + compatibility.length;
      const guards = source.slice(start, source.indexOf('const appliedFilenames', start));
      // Execute the real side-effect-free guard block from both entrypoints.
      const invoke = (applied: { filename: string }[], mode = 'ordinary') =>
        runInNewContext(`(async () => { ${guards} })()`, {
          applied,
          packagedMigrations: all,
          input: { mode },
          client: {},
          notificationMode: 'notification_0099_0101',
          closedSingleMode: 'closed_single_application_migration',
          assertClosedRun: () => Promise.resolve(),
          assertNotificationRun: () => Promise.resolve(),
          assertClosedApplicationMigrationsNotPending,
        }) as Promise<void>;
      await expect(invoke([{ filename: '0098_support_tickets.sql' }])).rejects.toThrow(
        'NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED',
      );
      await expect(invoke(legacy.slice(0, 2))).rejects.toThrow(
        'NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED',
      );
      await expect(invoke([...legacy, photo])).rejects.toThrow(
        'CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED',
      );
      if (path.startsWith('apps/')) {
        await expect(invoke([photo], 'notification_0099_0101')).resolves.toBeUndefined();
        await expect(invoke([photo], 'communities_staged_rehearsal')).resolves.toBeUndefined();
      }
    }
  });
  it('refuses GAME plus subject-link pending at the photo checkpoint', () => {
    expect(() =>
      assertClosedApplicationMigrationsNotPending({ applied: [photo], packaged }),
    ).toThrow('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
  });
  it('refuses subject linking pending after GAME has been independently applied', () => {
    expect(() =>
      assertClosedApplicationMigrationsNotPending({ applied: [photo, game], packaged }),
    ).toThrow('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
  });
  it('does not bypass a pending earlier guarded migration when a later one is recorded', () => {
    expect(() =>
      assertClosedApplicationMigrationsNotPending({ applied: [photo, subject], packaged }),
    ).toThrow('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
  });
  it('permits an already complete ledger and retains foundation-checked empty initialization', () => {
    expect(() =>
      assertClosedApplicationMigrationsNotPending({ applied: packaged, packaged }),
    ).not.toThrow();
    expect(() =>
      assertClosedApplicationMigrationsNotPending({ applied: [], packaged }),
    ).not.toThrow();
    expect(() =>
      assertClosedApplicationMigrationsNotPending({ applied: [photo], packaged: [photo] }),
    ).not.toThrow();
  });
  it('fences both entrypoints before any DDL and keeps the old notification guard', async () => {
    for (const path of ['scripts/migrate.ts', 'apps/migrator/src/migration-runner.ts']) {
      const source = await readFile(path, 'utf8');
      const guard = source.indexOf(
        'assertClosedApplicationMigrationsNotPending({ applied, packaged:',
      );
      expect(guard).toBeGreaterThan(source.indexOf('assertMigrationLedgerCompatible({ applied,'));
      expect(guard).toBeGreaterThan(
        source.indexOf("throw new Error('NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED')"),
      );
      expect(guard).toBeLessThan(
        source.indexOf('create table if not exists public.schema_migrations'),
      );
      expect(source).toContain('NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED');
    }
  });
});
