import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createContactRepository } from './contact-repository.js';

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

  it('rolls contact and receipt back if mandatory audit insertion fails', async () => {
    const repo = createContactRepository(runtime);
    await admin.query(`revoke insert on audit.audit_log from ${roleName}`);
    const input = {
      ...context(),
      userId,
      type: 'EMAIL' as const,
      normalizedValue: 'rollback@example.test',
      sourceKind: 'LOCAL' as const,
    };
    try {
      await expect(repo.create(input)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query(`grant insert on audit.audit_log to ${roleName}`);
    }
    expect(await repo.listForUser(tenantId, userId)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedValue: 'rollback@example.test' }),
      ]),
    );
    expect(await repo.create(input)).toMatchObject({ outcome: 'created', replayed: false });
  });
});
