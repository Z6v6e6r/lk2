import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MigrationLedgerEntry } from '@phub/database';

import { verifyChatPushFoundationContour } from './chat-push-foundation-contour.js';
import { verifyChatPushFoundation } from './chat-push-foundation-verifier.js';

const runtimeConnectionString = process.env.DATABASE_ROLE_BOUNDARY_PG_VERIFY_RUNTIME_URL;
const migratorConnectionString = process.env.DATABASE_ROLE_BOUNDARY_PG_VERIFY_MIGRATOR_URL;
const describeDatabase =
  runtimeConnectionString && migratorConnectionString ? describe : describe.skip;

function parseDisposableDatabaseUrl(value: string, name: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`${name}_PROTOCOL_INVALID`);
  }
  if (parsed.search || parsed.hash) throw new Error(`${name}_OPTIONS_FORBIDDEN`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`${name}_NOT_LOOPBACK`);
  }
  if (!decodeURIComponent(parsed.pathname.slice(1)).endsWith('_verify')) {
    throw new Error(`${name}_DATABASE_NOT_DISPOSABLE`);
  }
  if (!parsed.username) throw new Error(`${name}_ROLE_REQUIRED`);
  return parsed;
}

function assertDisposableTargets(runtimeUrl: string, migratorUrl: string): void {
  const runtime = parseDisposableDatabaseUrl(runtimeUrl, 'FOUNDATION_RUNTIME_URL');
  const migrator = parseDisposableDatabaseUrl(migratorUrl, 'FOUNDATION_MIGRATOR_URL');
  if (
    runtime.hostname !== migrator.hostname ||
    runtime.port !== migrator.port ||
    runtime.pathname !== migrator.pathname
  ) {
    throw new Error('FOUNDATION_DATABASE_TARGETS_NOT_IDENTICAL');
  }
  if (decodeURIComponent(runtime.username) === decodeURIComponent(migrator.username)) {
    throw new Error('FOUNDATION_ROLES_NOT_DISTINCT');
  }
}

async function readPackagedMigrations(): Promise<readonly MigrationLedgerEntry[]> {
  const directory = fileURLToPath(
    new URL('../../../packages/database/migrations/', import.meta.url),
  );
  const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      checksum: createHash('sha256')
        .update(await readFile(join(directory, filename)))
        .digest('hex'),
    })),
  );
}

describeDatabase.sequential('chat/push foundation PostgreSQL verifier', () => {
  let runtime: Client;
  let migrator: Client;
  let packaged: readonly MigrationLedgerEntry[];
  let tenantKeys: string;
  let catalogDigest = '';
  let databaseName = '';
  let systemIdentifier = '';

  async function verifyPost(): Promise<void> {
    await verifyChatPushFoundation({
      runtimeClient: runtime,
      migratorClient: migrator,
      packaged,
      phase: 'post',
      approvedTenantKeys: tenantKeys,
      expectedCatalogDigest: catalogDigest,
    });
  }

  beforeAll(async () => {
    assertDisposableTargets(runtimeConnectionString as string, migratorConnectionString as string);
    runtime = new Client({
      connectionString: runtimeConnectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    migrator = new Client({
      connectionString: migratorConnectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    packaged = await readPackagedMigrations();
    await Promise.all([runtime.connect(), migrator.connect()]);
    tenantKeys = String(
      (
        await migrator.query<{ tenant_keys: string }>(
          `select pg_catalog.string_agg(tenant_key, ',' order by tenant_key) as tenant_keys
             from identity.tenants`,
        )
      ).rows[0]?.tenant_keys ?? '',
    );
    if (!tenantKeys) throw new Error('FOUNDATION_TENANT_INVENTORY_EMPTY');
    const target = (
      await migrator.query<{ database_name: string; system_identifier: string }>(
        `select pg_catalog.current_database() as database_name,
                system_identifier::text as system_identifier
           from pg_catalog.pg_control_system()`,
      )
    ).rows[0];
    if (!target) throw new Error('FOUNDATION_DATABASE_TARGET_MISSING');
    databaseName = target.database_name;
    systemIdentifier = target.system_identifier;
    const baseline = await verifyChatPushFoundation({
      runtimeClient: runtime,
      migratorClient: migrator,
      packaged,
      phase: 'post',
      approvedTenantKeys: tenantKeys,
      captureCatalogBaseline: true,
    });
    if (!baseline.catalogDigest) throw new Error('FOUNDATION_CATALOG_DIGEST_MISSING');
    catalogDigest = baseline.catalogDigest;
  });

  afterAll(async () => {
    if (migrator) {
      await migrator
        .query(
          `alter index if exists integration.notification_endpoints_live_address_owner_unique_idx_drift
                  rename to notification_endpoints_live_address_owner_unique_idx`,
        )
        .catch(() => undefined);
    }
    await Promise.all([
      runtime?.end().catch(() => undefined),
      migrator?.end().catch(() => undefined),
    ]);
  });

  it('accepts the exact migrated, default-off catalog', async () => {
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('binds API, realtime and migrator credentials to one server-observed target', async () => {
    await expect(
      verifyChatPushFoundationContour({
        runtimeConnectionString: runtimeConnectionString as string,
        realtimeConnectionString: runtimeConnectionString as string,
        migratorConnectionString: migratorConnectionString as string,
        expectedDatabaseName: databaseName,
        expectedSystemIdentifier: systemIdentifier,
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyChatPushFoundationContour({
        runtimeConnectionString: runtimeConnectionString as string,
        realtimeConnectionString: migratorConnectionString as string,
        migratorConnectionString: migratorConnectionString as string,
        expectedDatabaseName: databaseName,
        expectedSystemIdentifier: systemIdentifier,
      }),
    ).rejects.toThrow('CHAT_PUSH_FOUNDATION_REALTIME_ROLE_MISMATCH');
    await expect(
      verifyChatPushFoundationContour({
        runtimeConnectionString: runtimeConnectionString as string,
        realtimeConnectionString: runtimeConnectionString as string,
        migratorConnectionString: migratorConnectionString as string,
        expectedDatabaseName: `${databaseName}_wrong`,
        expectedSystemIdentifier: systemIdentifier,
      }),
    ).rejects.toThrow('CHAT_PUSH_FOUNDATION_DATABASE_TARGET_MISMATCH');
  });

  it('rejects an incomplete tenant inventory without database writes', async () => {
    await expect(
      verifyChatPushFoundation({
        runtimeClient: runtime,
        migratorClient: migrator,
        packaged,
        phase: 'post',
        approvedTenantKeys: `${tenantKeys},unapproved-tenant`,
      }),
    ).rejects.toThrow('CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_MISMATCH');
  });

  it('rejects a drifted expected index identity and restores it', async () => {
    await migrator.query(`alter index integration.notification_endpoints_live_address_owner_unique_idx
                            rename to notification_endpoints_live_address_owner_unique_idx_drift`);
    try {
      await expect(verifyPost()).rejects.toThrow('CHAT_PUSH_FOUNDATION_POST_CATALOG_MISMATCH');
    } finally {
      await migrator.query(`alter index integration.notification_endpoints_live_address_owner_unique_idx_drift
                              rename to notification_endpoints_live_address_owner_unique_idx`);
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects a same-name validated CHECK with weakened grouping through the catalog digest', async () => {
    await migrator.query('begin');
    try {
      await migrator.query(
        `alter table notifications.tenant_runtime_settings
           drop constraint tenant_runtime_booking_reminder_binding_check,
           add constraint tenant_runtime_booking_reminder_binding_check check (true)`,
      );
      await expect(verifyPost()).rejects.toThrow('CHAT_PUSH_FOUNDATION_CATALOG_DIGEST_MISMATCH');
    } finally {
      await migrator.query('rollback');
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects another runtime-role session in the drained phase', async () => {
    const extraRuntime = new Client({
      connectionString: runtimeConnectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    await extraRuntime.connect();
    try {
      await expect(
        verifyChatPushFoundation({
          runtimeClient: runtime,
          migratorClient: migrator,
          packaged,
          phase: 'drained',
          approvedTenantKeys: tenantKeys,
        }),
      ).rejects.toThrow('CHAT_PUSH_FOUNDATION_RUNTIME_SESSION_PRESENT');
    } finally {
      await extraRuntime.end();
    }
  });
});
