import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertClosedApplicationMigrationsNotPending } from '../../../scripts/closed-schema-migration-guard.js';
import {
  closedSingleMode,
  closedProfile,
  assertClosedRun,
  beforeClosedStep,
  afterClosedSql,
  afterClosedStep,
  type ClosedSingleProfile,
  type ClosedSingleTarget,
} from './closed-single-migration.js';

import {
  assertMigrationExecutionAllowed,
  assertMigrationLedgerCompatible,
  CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_CATALOG_SQL,
  type CommunitiesStagedRehearsalRequest,
  createDatabasePool,
  selectCommunitiesStagedRehearsalMigrations,
} from '@phub/database';
import {
  notificationMode,
  isNotificationMigrationStep,
  assertNotificationRun,
  beforeNotificationStep,
  afterNotificationSql,
  afterNotificationStep,
  type NotificationTarget,
} from './notification-migration.js';

type MigrationRunMode =
  | { readonly mode: 'ordinary' }
  | { readonly mode: typeof notificationMode; readonly target: NotificationTarget }
  | {
      readonly mode: typeof closedSingleMode;
      readonly profile: ClosedSingleProfile;
      readonly target: ClosedSingleTarget;
    }
  | {
      readonly mode: 'communities_staged_rehearsal';
      readonly request: CommunitiesStagedRehearsalRequest;
    };

export async function runMigrationProcess(input: MigrationRunMode): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const advisoryLockTimeoutValue = process.env.MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS;
  if (
    advisoryLockTimeoutValue !== undefined &&
    (!/^[1-9][0-9]*$/.test(advisoryLockTimeoutValue) || Number(advisoryLockTimeoutValue) > 300_000)
  ) {
    throw new Error('MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS is invalid');
  }

  const migrationsDirectory = resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  const packagedMigrations = await Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      return {
        filename,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  const pool = createDatabasePool(connectionString);
  const client = await pool.connect();

  try {
    // Closed application steps must bound lock acquisition even without caller env.
    // Preserve the historical optional timeout for every existing mode.
    const closed = input.mode === closedSingleMode;
    const advisoryTimeout = closed
      ? Math.min(Number(advisoryLockTimeoutValue ?? 5_000), 5_000)
      : advisoryLockTimeoutValue;
    if (closed) await client.query("set lock_timeout='5s'; set statement_timeout='30s'");
    if (advisoryTimeout) {
      await client.query("select pg_catalog.set_config('statement_timeout', $1, false)", [
        `${advisoryTimeout}ms`,
      ]);
    }
    await client.query('select pg_advisory_lock($1)', [7_140_221]);
    if (!closed && advisoryLockTimeoutValue)
      await client.query("select pg_catalog.set_config('statement_timeout', '0', false)");
    if (input.mode === closedSingleMode)
      await client.query("set lock_timeout='5s'; set statement_timeout='30s'");
    const ledgerExists = await client.query<{ ledger: string | null }>(
      "select to_regclass('public.schema_migrations')::text as ledger",
    );
    const applied = ledgerExists.rows[0]?.ledger
      ? (
          await client.query<{ filename: string; checksum: string }>(
            'select filename, checksum from public.schema_migrations order by filename',
          )
        ).rows
      : [];

    assertMigrationLedgerCompatible({ applied, packaged: packagedMigrations });
    if (input.mode === notificationMode)
      await assertNotificationRun(client, packagedMigrations, input.target);
    else if (
      input.mode === 'ordinary' &&
      applied.length > 0 &&
      packagedMigrations.some(
        (m) =>
          [
            '0099_local_password_reset_proofs.sql',
            '0100_notification_scenarios.sql',
            '0101_notification_lifecycle_channels.sql',
          ].includes(m.filename) && !applied.some((a) => a.filename === m.filename),
      )
    )
      throw new Error('NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED');
    if (input.mode === 'ordinary')
      assertClosedApplicationMigrationsNotPending({ applied, packaged: packagedMigrations });
    if (input.mode === closedSingleMode)
      await assertClosedRun(
        client,
        packagedMigrations.map(({ filename, checksum }) => ({ filename, checksum })),
        input.profile,
        input.target,
      );

    const appliedFilenames = new Set(applied.map((entry) => entry.filename));
    const packagedFilenames = packagedMigrations.map((migration) => migration.filename);
    const stagedFilenames =
      input.mode === 'communities_staged_rehearsal'
        ? new Set(
            selectCommunitiesStagedRehearsalMigrations({
              request: input.request,
              appliedFilenames,
              packagedFilenames,
            }),
          )
        : null;
    if (!stagedFilenames) {
      const emptyDatabaseCatalogVerified =
        appliedFilenames.size === 0
          ? ((
              await client.query<{ empty_database_catalog: boolean }>(
                CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_CATALOG_SQL,
              )
            ).rows[0]?.empty_database_catalog ?? false)
          : false;
      assertMigrationExecutionAllowed({
        appliedFilenames,
        packagedFilenames,
        emptyDatabaseCatalogVerified,
        ...(process.env.CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK
          ? {
              maintenanceAcknowledgement: process.env.CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK,
            }
          : {}),
      });
    }

    if (input.mode !== closedSingleMode)
      await client.query(`
      create table if not exists public.schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const { filename, sql, checksum } of packagedMigrations) {
      if (appliedFilenames.has(filename)) continue;
      if (stagedFilenames && !stagedFilenames.has(filename)) continue;
      if (input.mode === notificationMode && !isNotificationMigrationStep(filename)) continue;
      if (input.mode === closedSingleMode && filename !== closedProfile(input.profile).filename)
        continue;

      await client.query('begin');
      try {
        const notificationAclPreimage =
          input.mode === notificationMode ? await beforeNotificationStep(client, filename) : null;
        const closedAclPreimage =
          input.mode === closedSingleMode
            ? await beforeClosedStep(client, input.profile, input.target)
            : null;
        await client.query(sql);
        if (input.mode === notificationMode)
          await afterNotificationSql(client, filename, notificationAclPreimage);
        if (input.mode === closedSingleMode)
          await afterClosedSql(client, input.profile, closedAclPreimage!);
        await client.query(
          'insert into public.schema_migrations (filename, checksum) values ($1, $2)',
          [filename, checksum],
        );
        if (input.mode === notificationMode) await afterNotificationStep(client, filename);
        if (input.mode === closedSingleMode)
          await afterClosedStep(client, input.profile, input.target.catalogVariant);
        await client.query('commit');
        process.stdout.write(`Applied ${filename}\n`);
        const refreshedApplied = await client.query<{ filename: string }>(
          'select filename from public.schema_migrations order by filename',
        );
        appliedFilenames.clear();
        for (const entry of refreshedApplied.rows) appliedFilenames.add(entry.filename);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [7_140_221]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}
