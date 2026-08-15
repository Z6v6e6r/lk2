import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyDatabaseRoleBoundary } from './database-role-boundary.js';

const runtimeConnectionString = process.env.DATABASE_ROLE_BOUNDARY_PG_VERIFY_RUNTIME_URL;
const migratorConnectionString = process.env.DATABASE_ROLE_BOUNDARY_PG_VERIFY_MIGRATOR_URL;
const describeDatabase =
  runtimeConnectionString && migratorConnectionString ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

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

function assertDisposableRoleBoundaryUrls(runtimeUrl: string, migratorUrl: string): void {
  const runtime = parseDisposableDatabaseUrl(runtimeUrl, 'ROLE_BOUNDARY_RUNTIME_URL');
  const migrator = parseDisposableDatabaseUrl(migratorUrl, 'ROLE_BOUNDARY_MIGRATOR_URL');
  if (
    runtime.hostname !== migrator.hostname ||
    runtime.port !== migrator.port ||
    runtime.pathname !== migrator.pathname
  ) {
    throw new Error('ROLE_BOUNDARY_DATABASE_TARGETS_NOT_IDENTICAL');
  }
  if (decodeURIComponent(runtime.username) === decodeURIComponent(migrator.username)) {
    throw new Error('ROLE_BOUNDARY_ROLES_NOT_DISTINCT');
  }
}

describe('database role boundary PostgreSQL verifier guard', () => {
  it('accepts distinct loopback roles for the same disposable database', () => {
    expect(() =>
      assertDisposableRoleBoundaryUrls(
        'postgresql://runtime:secret@127.0.0.1:55443/padlhub_verify',
        'postgresql://migrator:secret@127.0.0.1:55443/padlhub_verify',
      ),
    ).not.toThrow();
  });

  it.each([
    [
      'ROLE_BOUNDARY_RUNTIME_URL_OPTIONS_FORBIDDEN',
      'postgresql://runtime@127.0.0.1/padlhub_verify?host=remote.example',
      'postgresql://migrator@127.0.0.1/padlhub_verify',
    ],
    [
      'ROLE_BOUNDARY_MIGRATOR_URL_NOT_LOOPBACK',
      'postgresql://runtime@127.0.0.1/padlhub_verify',
      'postgresql://migrator@database.example/padlhub_verify',
    ],
    [
      'ROLE_BOUNDARY_RUNTIME_URL_DATABASE_NOT_DISPOSABLE',
      'postgresql://runtime@127.0.0.1/padlhub',
      'postgresql://migrator@127.0.0.1/padlhub',
    ],
    [
      'ROLE_BOUNDARY_DATABASE_TARGETS_NOT_IDENTICAL',
      'postgresql://runtime@127.0.0.1:55443/padlhub_verify',
      'postgresql://migrator@127.0.0.1:55444/padlhub_verify',
    ],
    [
      'ROLE_BOUNDARY_ROLES_NOT_DISTINCT',
      'postgresql://runtime@127.0.0.1/padlhub_verify',
      'postgresql://runtime@127.0.0.1/padlhub_verify',
    ],
  ] as const)('rejects %s', (code, runtimeUrl, migratorUrl) => {
    expect(() => assertDisposableRoleBoundaryUrls(runtimeUrl, migratorUrl)).toThrow(code);
  });
});

describeDatabase.sequential('database role boundary PostgreSQL drift verification', () => {
  let migrator: Client;
  const runtimeRole = quoteIdentifier(
    decodeURIComponent(
      new URL(runtimeConnectionString ?? 'postgresql://missing@localhost').username,
    ),
  );

  const canonicalPolicySql = `create policy booking_reminder_schedules_tenant_isolation
    on notifications.booking_reminder_schedules
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`;

  async function restoreCanonicalPolicy(): Promise<void> {
    await migrator.query(
      'drop policy if exists booking_reminder_schedules_extra_permissive on notifications.booking_reminder_schedules',
    );
    await migrator.query(
      'drop policy if exists booking_reminder_schedules_tenant_isolation on notifications.booking_reminder_schedules',
    );
    await migrator.query(canonicalPolicySql);
  }

  async function restoreAclBoundary(): Promise<void> {
    await migrator.query(`grant usage on schema notifications to ${runtimeRole}`);
    await migrator.query('alter default privileges revoke all on tables from public');
    await migrator.query(
      `alter default privileges in schema notifications
         revoke grant option for select, insert, update, delete on tables from ${runtimeRole}`,
    );
    await migrator.query(
      `alter default privileges in schema notifications
         revoke references on tables from ${runtimeRole}`,
    );
    await migrator.query(
      'alter default privileges in schema notifications revoke all on tables from pg_monitor',
    );
    await migrator.query('revoke all on notifications.booking_reminder_schedules from public');
    await migrator.query(
      'revoke select (tenant_id) on notifications.booking_reminder_schedules from public',
    );
    await migrator.query(
      `revoke grant option for select on notifications.booking_reminder_schedules from ${runtimeRole}`,
    );
    await migrator.query(
      `revoke update (tenant_id) on notifications.booking_reminder_schedules from ${runtimeRole}`,
    );
    await migrator.query(
      `revoke references on notifications.booking_reminder_schedules from ${runtimeRole}`,
    );
    await migrator.query('revoke all on notifications.booking_reminder_schedules from pg_monitor');
    await migrator.query(
      'revoke update (tenant_id) on notifications.booking_reminder_schedules from pg_monitor',
    );
  }

  async function verifyPost(): Promise<void> {
    await verifyDatabaseRoleBoundary({
      runtimeConnectionString: runtimeConnectionString as string,
      migratorConnectionString: migratorConnectionString as string,
      phase: 'post',
    });
  }

  beforeAll(async () => {
    assertDisposableRoleBoundaryUrls(
      runtimeConnectionString as string,
      migratorConnectionString as string,
    );
    migrator = new Client({
      connectionString: migratorConnectionString as string,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    await migrator.connect();
    await verifyPost();
  });

  afterAll(async () => {
    if (!migrator) return;
    await restoreCanonicalPolicy().catch(() => undefined);
    await restoreAclBoundary().catch(() => undefined);
    await migrator.end().catch(() => undefined);
  });

  it('rejects an additional permissive policy from the real PostgreSQL catalog', async () => {
    try {
      await migrator.query(
        `create policy booking_reminder_schedules_extra_permissive
           on notifications.booking_reminder_schedules
           using (true)
           with check (true)`,
      );
      await expect(verifyPost()).rejects.toThrow('POST_MIGRATION_RUNTIME_TABLE_POLICY_INVALID');
    } finally {
      await restoreCanonicalPolicy();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects an OR true policy expression from the real PostgreSQL catalog', async () => {
    try {
      await migrator.query(
        'drop policy booking_reminder_schedules_tenant_isolation on notifications.booking_reminder_schedules',
      );
      await migrator.query(
        `create policy booking_reminder_schedules_tenant_isolation
           on notifications.booking_reminder_schedules
           using (true or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
           with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`,
      );
      await expect(verifyPost()).rejects.toThrow('POST_MIGRATION_RUNTIME_TABLE_POLICY_INVALID');
    } finally {
      await restoreCanonicalPolicy();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects a global PUBLIC default table grant from the real PostgreSQL catalog', async () => {
    try {
      await migrator.query('alter default privileges grant select on tables to public');
      await expect(verifyPost()).rejects.toThrow(
        'MIGRATOR_DATABASE_ROLE_UNSAFE_GLOBAL_DEFAULT_ACL',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects default DML WITH GRANT OPTION for the runtime role', async () => {
    try {
      await migrator.query(
        `alter default privileges in schema notifications
           grant select, insert, update, delete on tables to ${runtimeRole} with grant option`,
      );
      await expect(verifyPost()).rejects.toThrow(
        'MIGRATOR_DATABASE_ROLE_NOTIFICATION_DEFAULT_GRANT_OPTION',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects a missing runtime schema USAGE grant before DDL', async () => {
    try {
      await migrator.query(`revoke usage on schema notifications from ${runtimeRole}`);
      await expect(verifyPost()).rejects.toThrow(
        'MIGRATOR_DATABASE_ROLE_MISSING_NOTIFICATION_DEFAULT_DML',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects a non-DML runtime default privilege and its grant option before DDL', async () => {
    try {
      await migrator.query(
        `alter default privileges in schema notifications
           grant references on tables to ${runtimeRole} with grant option`,
      );
      await expect(verifyPost()).rejects.toThrow(
        'MIGRATOR_DATABASE_ROLE_NOTIFICATION_DEFAULT_GRANT_OPTION',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects a schema-local default grant to an unrelated role', async () => {
    try {
      await migrator.query(
        'alter default privileges in schema notifications grant select on tables to pg_monitor',
      );
      await expect(verifyPost()).rejects.toThrow(
        'MIGRATOR_DATABASE_ROLE_UNEXPECTED_NOTIFICATION_DEFAULT_GRANTEE',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects an explicit PUBLIC grant on a runtime-written table', async () => {
    try {
      await migrator.query('grant select on notifications.booking_reminder_schedules to public');
      await expect(verifyPost()).rejects.toThrow('POST_MIGRATION_RUNTIME_TABLE_PUBLIC_ACL');
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects an explicit PUBLIC column grant on a runtime-written table', async () => {
    try {
      await migrator.query(
        'grant select (tenant_id) on notifications.booking_reminder_schedules to public',
      );
      await expect(verifyPost()).rejects.toThrow('POST_MIGRATION_RUNTIME_TABLE_PUBLIC_ACL');
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects an actual runtime DML grant option on a runtime-written table', async () => {
    try {
      await migrator.query(
        `grant select on notifications.booking_reminder_schedules to ${runtimeRole} with grant option`,
      );
      await expect(verifyPost()).rejects.toThrow(
        'POST_MIGRATION_RUNTIME_TABLE_GRANT_OPTION_UNSAFE',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects an actual runtime column grant option on a runtime-written table', async () => {
    try {
      await migrator.query(
        `grant update (tenant_id) on notifications.booking_reminder_schedules
           to ${runtimeRole} with grant option`,
      );
      await expect(verifyPost()).rejects.toThrow(
        'POST_MIGRATION_RUNTIME_TABLE_GRANT_OPTION_UNSAFE',
      );
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects a plain non-DML runtime privilege on a runtime-written table', async () => {
    try {
      await migrator.query(
        `grant references on notifications.booking_reminder_schedules to ${runtimeRole}`,
      );
      await expect(verifyPost()).rejects.toThrow('POST_MIGRATION_RUNTIME_TABLE_PRIVILEGE_UNSAFE');
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });

  it('rejects actual table and column grants to an unrelated role', async () => {
    try {
      await migrator.query(
        'grant select on notifications.booking_reminder_schedules to pg_monitor',
      );
      await migrator.query(
        'grant update (tenant_id) on notifications.booking_reminder_schedules to pg_monitor',
      );
      await expect(verifyPost()).rejects.toThrow('POST_MIGRATION_RUNTIME_TABLE_UNEXPECTED_GRANTEE');
    } finally {
      await restoreAclBoundary();
    }
    await expect(verifyPost()).resolves.toBeUndefined();
  });
});
