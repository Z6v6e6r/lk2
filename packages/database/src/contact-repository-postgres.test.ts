import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createContactRepository } from './contact-repository.js';
import { createContactReader } from './contact-reader.js';

function disposableAdminUrl(): string | undefined {
  const explicit = process.env.CONTACT_TEST_ADMIN_DATABASE_URL;
  const candidate =
    explicit ?? (process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined);
  if (!candidate) return undefined;
  const url = new URL(candidate);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const localTaskDatabase =
    Boolean(explicit) &&
    process.env.CONTACT_TEST_DISPOSABLE_ACK === 'kya01a-contacts' &&
    url.username === 'kya01a' &&
    /^\/kya01a_[a-z0-9_]+$/.test(url.pathname);
  const ciService =
    !explicit &&
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.APP_ENV === 'ci' &&
    url.username === 'phub' &&
    url.pathname === '/phub' &&
    url.port === '5432';
  if (!loopback || !(localTaskDatabase || ciService)) {
    throw new Error('CONTACT_TEST_DISPOSABLE_DATABASE_REQUIRED');
  }
  return candidate;
}

const adminUrl = disposableAdminUrl();
const describePostgres = adminUrl ? describe : describe.skip;

describePostgres('profile contacts with a separate non-bypass runtime role', () => {
  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = randomUUID();
  const sharedUserId = randomUUID();
  const otherUserId = randomUUID();
  const actorId = randomUUID();
  const roleName = `contact_test_${randomUUID().replaceAll('-', '')}`;
  const rolePassword = randomUUID().replaceAll('-', '');
  let runtime: Pool;
  let sequence = 0;

  function context(tenant = tenantId) {
    sequence += 1;
    return {
      tenantId: tenant,
      actorId,
      correlationId: `contact-synthetic-${sequence}`,
      idempotencyKey: `contact-synthetic-key-${String(sequence).padStart(8, '0')}`,
    };
  }

  async function count(
    tenant: string,
    table: 'audit.audit_log' | 'audit.outbox_events',
    contactId: string,
  ): Promise<number> {
    return withTenantTransaction(admin, tenant, async (client) => {
      const row = await client.query<{ count: number }>(
        `select count(*)::integer as count from ${table} where tenant_id = $1 and ` +
          (table === 'audit.audit_log' ? 'resource_id' : 'aggregate_id') +
          ' = $2',
        [tenant, contactId],
      );
      return row.rows[0]?.count ?? 0;
    });
  }

  beforeAll(async () => {
    await admin.query(`create role ${roleName} login password '${rolePassword}'
      nosuperuser nobypassrls nocreatedb nocreaterole noinherit`);
    await admin.query(`grant usage on schema identity, profile, audit to ${roleName}`);
    await admin.query(`grant select on identity.users to ${roleName}`);
    await admin.query(`grant select, insert, update on profile.contacts to ${roleName}`);
    await admin.query(`grant select, insert on profile.contact_commands to ${roleName}`);
    await admin.query(`grant insert on audit.audit_log, audit.outbox_events to ${roleName}`);
    const url = new URL(adminUrl!);
    url.username = roleName;
    url.password = rolePassword;
    runtime = new Pool({ connectionString: url.toString(), max: 8 });

    await admin.query(
      `insert into identity.tenants (id, tenant_key, display_name)
      values ($1, $2, 'Contact synthetic'), ($3, $4, 'Contact synthetic other')`,
      [tenantId, `contact-${tenantId}`, otherTenantId, `contact-${otherTenantId}`],
    );
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
        values ($1, $2, 'ACTIVE'), ($1, $3, 'ACTIVE')`,
        [tenantId, userId, sharedUserId],
      );
    });
    await withTenantTransaction(admin, otherTenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
        values ($1, $2, 'ACTIVE')`,
        [otherTenantId, otherUserId],
      );
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.end();
    for (const tenant of [tenantId, otherTenantId]) {
      await withTenantTransaction(admin, tenant, async (client) => {
        await client.query(
          `delete from audit.audit_log where tenant_id = $1 and resource_type = 'PROFILE_CONTACT'`,
          [tenant],
        );
        await client.query(
          `delete from audit.outbox_events where tenant_id = $1 and event_type like 'profile.contact.%'`,
          [tenant],
        );
        await client.query('delete from profile.contact_commands where tenant_id = $1', [tenant]);
        await client.query('delete from profile.contacts where tenant_id = $1', [tenant]);
        await client.query('delete from identity.users where tenant_id = $1', [tenant]);
      });
    }
    await admin.query('delete from identity.tenants where id in ($1, $2)', [
      tenantId,
      otherTenantId,
    ]);
    await admin.query(`drop owned by ${roleName}`);
    await admin.query(`drop role if exists ${roleName}`);
    await admin.end();
  });

  it('stores shared phone and email for two UUIDs, while isolating another tenant', async () => {
    const repo = createContactRepository(runtime);
    for (const [type, normalizedValue] of [
      ['PHONE', '+79990000001'],
      ['EMAIL', 'shared@example.test'],
    ] as const) {
      const first = await repo.create({
        ...context(),
        userId,
        type,
        normalizedValue,
        sourceKind: 'LOCAL',
      });
      const second = await repo.create({
        ...context(),
        userId: sharedUserId,
        type,
        normalizedValue,
        sourceKind: 'LOCAL',
      });
      const other = await repo.create({
        ...context(otherTenantId),
        userId: otherUserId,
        type,
        normalizedValue,
        sourceKind: 'LOCAL',
      });
      expect(first.outcome).toBe('created');
      expect(second.outcome).toBe('created');
      expect(other.outcome).toBe('created');
      if (first.outcome === 'created' && second.outcome === 'created') {
        expect(first.contactId).not.toBe(second.contactId);
      }
    }
    expect(await repo.listForUser(tenantId, userId)).toHaveLength(2);
    expect(await repo.listForUser(tenantId, otherUserId)).toHaveLength(0);
    expect(await repo.listForUser(otherTenantId, userId)).toHaveLength(0);
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('reads contacts through a SELECT-only non-bypass capability with no command/audit privileges', async () => {
    for (const [tenant, subject] of [
      [tenantId, userId],
      [tenantId, sharedUserId],
      [otherTenantId, otherUserId],
    ]) {
      await createContactRepository(runtime).create({
        ...context(tenant),
        userId: subject!,
        type: 'EMAIL',
        normalizedValue: 'shared-reader@example.test',
        sourceKind: 'LOCAL',
      });
    }
    const readRole = `contact_reader_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID().replaceAll('-', '');
    let readPool: Pool | undefined;
    await admin.query(`create role ${readRole} login password '${password}'
      nosuperuser nobypassrls nocreatedb nocreaterole noinherit`);
    try {
      await admin.query(`grant usage on schema profile to ${readRole}`);
      await admin.query(`grant select on profile.contacts to ${readRole}`);
      const url = new URL(adminUrl!);
      url.username = readRole;
      url.password = password;
      readPool = new Pool({ connectionString: url.toString(), max: 2 });
      const role = await readPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const reader = createContactReader(readPool);
      const own = await reader.listForUser(tenantId, userId);
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((contact) => contact.userId === userId)).toBe(true);
      expect(await reader.listForUser(tenantId, otherUserId)).toEqual([]);
      expect(await reader.listForUser(otherTenantId, userId)).toEqual([]);
      expect(await reader.listForUser(tenantId, randomUUID())).toEqual([]);
      expect(
        (await reader.listForUser(tenantId, sharedUserId)).every(
          (contact) => contact.userId === sharedUserId,
        ),
      ).toBe(true);
      // Local tenant context was reset after releasing the pooled connection.
      const noContext = await readPool.query('select id from profile.contacts');
      expect(noContext.rows).toEqual([]);
      const acl = await readPool.query<{
        writes: boolean;
        commands: boolean;
        audit: boolean;
        outbox: boolean;
      }>(
        `select has_table_privilege(current_user, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'profile' and c.relname = 'contacts'), 'INSERT,UPDATE,DELETE') as writes,
                has_table_privilege(current_user, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'profile' and c.relname = 'contact_commands'), 'SELECT,INSERT,UPDATE,DELETE') as commands,
                has_table_privilege(current_user, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'audit' and c.relname = 'audit_log'), 'INSERT') as audit,
                has_table_privilege(current_user, (select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'audit' and c.relname = 'outbox_events'), 'INSERT') as outbox`,
      );
      expect(acl.rows[0]).toEqual({ writes: false, commands: false, audit: false, outbox: false });
      await expect(
        readPool.query('update profile.contacts set version = version + 1'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(readPool.query('select * from profile.contact_commands')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      if (readPool) await readPool.end();
      await admin.query(`drop owned by ${readRole}`);
      await admin.query(`drop role ${readRole}`);
    }
  });

  it('deduplicates sequential and concurrent create without duplicate audit or outbox', async () => {
    const repo = createContactRepository(runtime);
    const firstInput = {
      ...context(),
      userId,
      type: 'PHONE' as const,
      normalizedValue: '+79990000002',
      sourceKind: 'LOCAL' as const,
    };
    const first = await repo.create(firstInput);
    expect(first.outcome).toBe('created');
    expect(await repo.create(firstInput)).toMatchObject({ outcome: 'created', replayed: true });
    const raced = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo.create({
          ...context(),
          userId,
          type: 'PHONE',
          normalizedValue: '+79990000002',
          sourceKind: 'LOCAL',
        }),
      ),
    );
    expect(raced.every((result) => result.outcome === 'existing')).toBe(true);
    if (first.outcome !== 'created') throw new Error('CONTACT_TEST_SETUP_FAILED');
    expect(await count(tenantId, 'audit.audit_log', first.contactId)).toBe(1);
    expect(await count(tenantId, 'audit.outbox_events', first.contactId)).toBe(1);
    const evidence = await withTenantTransaction(admin, tenantId, async (client) => {
      const audit = await client.query<{ new_value: unknown }>(
        `select new_value from audit.audit_log where tenant_id = $1 and resource_id = $2`,
        [tenantId, first.contactId],
      );
      const events = await client.query<{ payload: unknown }>(
        `select payload from audit.outbox_events where tenant_id = $1 and aggregate_id = $2`,
        [tenantId, first.contactId],
      );
      return JSON.stringify([audit.rows[0]?.new_value, events.rows[0]?.payload]);
    });
    expect(evidence).not.toContain('+79990000002');
    expect(evidence).not.toContain('shared@example.test');
  });

  it('serializes a first-insert race and rejects reuse of its command key', async () => {
    const repo = createContactRepository(runtime);
    const input = {
      ...context(),
      userId,
      type: 'EMAIL' as const,
      normalizedValue: 'first-race@example.test',
      sourceKind: 'LOCAL' as const,
    };
    const results = await Promise.all([
      repo.create(input),
      repo.create(input),
      ...Array.from({ length: 4 }, () => repo.create({ ...input, ...context() })),
    ]);
    const created = results.find((result) => result.outcome === 'created' && !result.replayed);
    if (!created || created.outcome !== 'created') throw new Error('CONTACT_TEST_SETUP_FAILED');
    expect(
      results.filter((result) => result.outcome === 'created' && !result.replayed),
    ).toHaveLength(1);
    expect(results.filter((result) => 'replayed' in result && result.replayed)).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'existing' && !result.replayed),
    ).toHaveLength(4);
    expect(await count(tenantId, 'audit.audit_log', created.contactId)).toBe(1);
    expect(await count(tenantId, 'audit.outbox_events', created.contactId)).toBe(1);
    expect(await repo.create({ ...input, normalizedValue: 'other-race@example.test' })).toEqual({
      outcome: 'idempotency_conflict',
    });
    expect(
      await repo.updateProvenance({
        tenantId,
        actorId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        contactId: created.contactId,
        expectedVersion: 1,
        sourceKind: 'LOCAL',
      }),
    ).toEqual({ outcome: 'idempotency_conflict' });
    const evidence = await withTenantTransaction(admin, tenantId, async (client) => {
      const rows = await client.query(
        'select new_value from audit.audit_log where tenant_id = $1 and resource_id = $2',
        [tenantId, created.contactId],
      );
      return JSON.stringify(rows.rows);
    });
    expect(evidence).not.toContain(input.normalizedValue);
  });

  it('forces tenant isolation on command receipts and rejects invalid direct provenance', async () => {
    const repo = createContactRepository(runtime);
    const input = {
      ...context(),
      userId,
      type: 'EMAIL' as const,
      normalizedValue: 'receipt-rls@example.test',
      sourceKind: 'LOCAL' as const,
    };
    const created = await repo.create(input);
    if (created.outcome !== 'created') throw new Error('CONTACT_TEST_SETUP_FAILED');
    const catalogs = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where oid in ('profile.contacts'::regclass, 'profile.contact_commands'::regclass) order by relname`,
    );
    expect(catalogs.rows).toEqual([
      { relname: 'contact_commands', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'contacts', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const missing = await runtime.query<{ count: number }>(
      'select count(*)::integer as count from profile.contact_commands',
    );
    expect(missing.rows[0]?.count).toBe(0);
    await withTenantTransaction(runtime, otherTenantId, async (client) => {
      const rows = await client.query(
        'select * from profile.contact_commands where tenant_id = $1',
        [tenantId],
      );
      expect(rows.rows).toHaveLength(0);
    });
    const insertReceipt = (client: Pool) =>
      client.query(
        `insert into profile.contact_commands
       (tenant_id, actor_id, idempotency_key, request_hash, operation, contact_id, outcome, result_version)
       values ($1, $2, $3, $4, 'CREATE', $5, 'created', 1)`,
        [tenantId, actorId, context().idempotencyKey, '0'.repeat(64), created.contactId],
      );
    await expect(insertReceipt(runtime)).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, otherTenantId, (client) =>
        client.query(
          `insert into profile.contact_commands
       (tenant_id, actor_id, idempotency_key, request_hash, operation, contact_id, outcome, result_version)
       values ($1, $2, $3, $4, 'CREATE', $5, 'created', 1)`,
          [tenantId, actorId, context().idempotencyKey, '0'.repeat(64), created.contactId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `insert into profile.contacts
       (tenant_id, user_id, type, normalized_value, source_kind, created_by_actor_id, updated_by_actor_id)
       values ($1, $2, 'EMAIL', 'missing-source-date@example.test', 'VIVA', $3, $3)`,
          [tenantId, userId, actorId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces composite FK, FORCE RLS, and a missing tenant context at the runtime role', async () => {
    const repo = createContactRepository(runtime);
    await expect(
      repo.create({
        ...context(),
        userId: otherUserId,
        type: 'EMAIL',
        normalizedValue: 'foreign@example.test',
        sourceKind: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: '23503' });
    const table = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class
        where oid = 'profile.contacts'::regclass`,
    );
    expect(table.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const noContext = await runtime.query<{ count: number }>(
      'select count(*)::integer as count from profile.contacts',
    );
    expect(noContext.rows[0]?.count).toBe(0);
    await expect(
      runtime.query(
        `insert into profile.contacts
      (tenant_id, user_id, type, normalized_value, source_kind, created_by_actor_id, updated_by_actor_id)
      values ($1, $2, 'EMAIL', 'no-context@example.test', 'LOCAL', $3, $3)`,
        [tenantId, userId, actorId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await withTenantTransaction(runtime, tenantId, async (client) => {
      const wrong = await client.query<{ count: number }>(
        'select count(*)::integer as count from profile.contacts where tenant_id = $1',
        [otherTenantId],
      );
      expect(wrong.rows[0]?.count).toBe(0);
      await expect(
        client.query(
          `insert into profile.contacts
        (tenant_id, user_id, type, normalized_value, source_kind, created_by_actor_id, updated_by_actor_id)
        values ($1, $2, 'EMAIL', 'wrong-tenant@example.test', 'LOCAL', $3, $3)`,
          [otherTenantId, otherUserId, actorId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code !== '25P02') throw error;
    });
  });

  it('has no verification setter or columns and replaces an address with a separate contact', async () => {
    const repo = createContactRepository(runtime);
    const old = await repo.create({
      ...context(),
      userId,
      type: 'EMAIL',
      normalizedValue: 'old@example.test',
      sourceKind: 'LOCAL',
    });
    if (old.outcome !== 'created') throw new Error('CONTACT_TEST_SETUP_FAILED');
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `update profile.contacts set verified_at = now() where tenant_id = $1 and id = $2`,
          [tenantId, old.contactId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42703' });
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `insert into profile.contacts
        (tenant_id, user_id, type, normalized_value, source_kind, verified_at,
         created_by_actor_id, updated_by_actor_id)
       values ($1, $2, 'EMAIL', 'forged@example.test', 'LOCAL', now(), $3, $3)`,
          [tenantId, userId, actorId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42703' });
    const updated = await repo.updateProvenance({
      ...context(),
      contactId: old.contactId,
      expectedVersion: 1,
      sourceKind: 'VIVA',
      sourceUpdatedAt: '2026-09-29T00:00:00Z',
    });
    expect(updated).toMatchObject({ outcome: 'updated', version: 2 });
    const stale = await repo.updateProvenance({
      ...context(),
      contactId: old.contactId,
      expectedVersion: 2,
      sourceKind: 'VIVA',
      sourceUpdatedAt: '2026-09-28T00:00:00Z',
    });
    expect(stale).toEqual({ outcome: 'source_stale' });
    const replacement = await repo.create({
      ...context(),
      userId,
      type: 'EMAIL',
      normalizedValue: 'new@example.test',
      sourceKind: 'LOCAL',
    });
    expect(replacement.outcome).toBe('created');
    if (replacement.outcome !== 'created') throw new Error('CONTACT_TEST_SETUP_FAILED');
    const values = await repo.listForUser(tenantId, userId);
    expect(values.find((value) => value.id === old.contactId)?.version).toBe(2);
    expect(values.find((value) => value.id === replacement.contactId)?.version).toBe(1);
    expect(values.find((value) => value.id === old.contactId)?.normalizedValue).toBe(
      'old@example.test',
    );
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query(
          `update profile.contacts set normalized_value = 'mutated@example.test'
        where tenant_id = $1 and id = $2`,
          [tenantId, old.contactId],
        ),
      ),
    ).rejects.toThrow('CONTACT_IDENTITY_IMMUTABLE');
  });

  it('returns stable CAS conflicts and replays one concurrent update', async () => {
    const repo = createContactRepository(runtime);
    const created = await repo.create({
      ...context(),
      userId,
      type: 'EMAIL',
      normalizedValue: 'race@example.test',
      sourceKind: 'LOCAL',
    });
    if (created.outcome !== 'created') throw new Error('CONTACT_TEST_SETUP_FAILED');
    const input = {
      ...context(),
      contactId: created.contactId,
      expectedVersion: 1,
      sourceKind: 'VIVA' as const,
      sourceUpdatedAt: '2026-09-29T00:00:00Z',
    };
    const race = await Promise.all([
      repo.updateProvenance(input),
      repo.updateProvenance({
        ...context(),
        contactId: created.contactId,
        expectedVersion: 1,
        sourceKind: 'VIVA',
        sourceUpdatedAt: '2026-09-30T00:00:00Z',
      }),
    ]);
    expect(race.filter((result) => result.outcome === 'updated')).toHaveLength(1);
    expect(race.filter((result) => result.outcome === 'conflict')).toHaveLength(1);
    expect(await repo.updateProvenance(input)).toMatchObject({
      outcome: race[0]?.outcome === 'updated' ? 'updated' : 'conflict',
    });
    expect(await count(tenantId, 'audit.audit_log', created.contactId)).toBe(2);
    expect(await count(tenantId, 'audit.outbox_events', created.contactId)).toBe(2);
  });

  it.each(['audit.audit_log', 'audit.outbox_events'] as const)(
    'rolls contact, receipt and earlier evidence back when %s insertion fails',
    async (table) => {
      const repo = createContactRepository(runtime);
      await admin.query(`revoke insert on ${table} from ${roleName}`);
      const input = {
        ...context(),
        userId,
        type: 'EMAIL' as const,
        normalizedValue:
          table === 'audit.audit_log'
            ? 'audit-rollback@example.test'
            : 'outbox-rollback@example.test',
        sourceKind: 'LOCAL' as const,
      };
      try {
        await expect(repo.create(input)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query(`grant insert on ${table} to ${roleName}`);
      }
      expect(await repo.listForUser(tenantId, userId)).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ normalizedValue: input.normalizedValue }),
        ]),
      );
      await withTenantTransaction(admin, tenantId, async (client) => {
        expect(
          (
            await client.query(
              'select * from profile.contact_commands where tenant_id = $1 and idempotency_key = $2',
              [tenantId, input.idempotencyKey],
            )
          ).rows,
        ).toHaveLength(0);
        for (const evidenceTable of ['audit.audit_log', 'audit.outbox_events']) {
          expect(
            (
              await client.query(
                `select * from ${evidenceTable} where tenant_id = $1 and correlation_id = $2`,
                [tenantId, input.correlationId],
              )
            ).rows,
          ).toHaveLength(0);
        }
      });
      expect(await repo.create(input)).toMatchObject({ outcome: 'created', replayed: false });
    },
  );

  it('upgrades 0095 with the canonical migrator, reapplies as no-op and rolls failed DDL back', async () => {
    // The connection is already restricted to the explicit local task fixture or Actions service.
    // Every destructive operation below names only this test-created random database.
    const database = `kya01a_rehearsal_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(resolve(tmpdir(), 'kya01a-migrations-'));
    const migrationDirectory = resolve(directory, 'packages/database/migrations');
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    let fixture: Pool | undefined;
    let created = false;
    const migration = '0096_profile_contacts.sql';
    try {
      await admin.query(`create database ${database}`);
      created = true;
      fixture = new Pool({ connectionString: url.toString(), max: 2 });
      await mkdir(migrationDirectory, { recursive: true });
      const sourceDirectory = resolve(process.cwd(), 'packages/database/migrations');
      const predecessorFiles = (await readdir(sourceDirectory))
        .filter((name) => /^\d+.*\.sql$/.test(name) && name < migration)
        .sort();
      expect(predecessorFiles.at(-1)).toBe('0095_chat_media_constraint_validation.sql');
      for (const filename of predecessorFiles) {
        await copyFile(resolve(sourceDirectory, filename), resolve(migrationDirectory, filename));
      }
      const migrate = () =>
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs'),
            resolve(process.cwd(), 'scripts/migrate.ts'),
          ],
          {
            cwd: directory,
            timeout: 120_000,
            maxBuffer: 1_000_000,
            env: {
              PATH: process.env.PATH ?? '',
              DATABASE_URL: url.toString(),
              TSX_TSCONFIG_PATH: resolve(process.cwd(), 'tsconfig.json'),
              CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
            },
          },
        );
      await migrate();
      expect(
        (
          await fixture.query<{ contacts: string | null }>(
            "select to_regclass('profile.contacts') as contacts",
          )
        ).rows[0]?.contacts,
      ).toBeNull();
      const before = (
        await fixture.query(
          'select filename, checksum, applied_at from schema_migrations order by filename',
        )
      ).rows;
      await copyFile(resolve(sourceDirectory, migration), resolve(migrationDirectory, migration));
      expect((await migrate()).stdout.trim()).toBe(`Applied ${migration}`);
      const checksum = createHash('sha256')
        .update(await readFile(resolve(sourceDirectory, migration)))
        .digest('hex');
      const after = (
        await fixture.query(
          'select filename, checksum, applied_at from schema_migrations order by filename',
        )
      ).rows;
      expect(after.slice(0, -1)).toEqual(before);
      expect(after.at(-1)).toMatchObject({ filename: migration, checksum });
      expect((await migrate()).stdout.trim()).toBe('');
      expect(
        (
          await fixture.query(
            'select filename, checksum, applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(after);
      await writeFile(
        resolve(migrationDirectory, '9999_kya01a_failure.sql'),
        'create table profile.kya01a_failure_probe (id integer); select 1 / 0;',
      );
      await expect(migrate()).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await fixture.query<{ probe: string | null }>(
            "select to_regclass('profile.kya01a_failure_probe') as probe",
          )
        ).rows[0]?.probe,
      ).toBeNull();
      expect(
        (
          await fixture.query(
            'select filename, checksum, applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(after);
    } finally {
      if (fixture) await fixture.end();
      if (created) await admin.query(`drop database ${database}`);
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
