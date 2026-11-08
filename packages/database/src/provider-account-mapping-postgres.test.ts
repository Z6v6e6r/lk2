import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  ProviderAccountMappingConflict,
  ProviderAccountTenantUnbound,
  createProviderAccountMappingRepository,
} from './provider-account-mapping-repository.js';

// Runs only against the existing disposable CI PostgreSQL, like the other CRITICAL repository tests.
function ci() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw Error('PROVIDER_ACCOUNT_CI_DATABASE_REQUIRED');
  const u = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost', '127.0.0.1'].includes(u.hostname) ||
    u.username !== 'phub' ||
    u.password !== 'ci-password' ||
    u.pathname !== '/phub' ||
    u.port !== '5432' ||
    u.search ||
    u.hash
  )
    throw Error('PROVIDER_ACCOUNT_CI_DATABASE_REQUIRED');
  return u.href;
}

const url = ci();
(url ? describe : describe.skip)('provider account mapping on disposable CI PostgreSQL', () => {
  const admin = new Pool({ connectionString: url, max: 2 }),
    tenantId = randomUUID(),
    unbound = randomUUID(),
    role = 'provider_account_' + randomUUID().replaceAll('-', ''),
    password = randomUUID();
  let pool: Pool;
  let repository: ReturnType<typeof createProviderAccountMappingRepository>;

  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(`grant usage on schema identity,integration,audit to ${role}`);
    await admin.query(`grant select,insert,update on integration.external_entity_map to ${role}`);
    await admin.query(`grant select on integration.identity_provider_bindings to ${role}`);
    await admin.query(`grant insert on audit.audit_log to ${role}`);
    const u = new URL(url!);
    u.username = role;
    u.password = password;
    pool = new Pool({ connectionString: u.href, max: 4 });
    repository = createProviderAccountMappingRepository(pool);
    await admin.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic attest'),($3,$4,'Unbound attest')",
      [tenantId, 'attest-' + tenantId, unbound, 'attest-' + unbound],
    );
    await withTenantTransaction(admin, tenantId, (c) =>
      c.query(
        "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','iSkq6G')",
        [tenantId],
      ),
    );
  });

  afterAll(async () => {
    try {
      await pool?.end();
      for (const t of [tenantId, unbound])
        await withTenantTransaction(admin, t, async (c) => {
          for (const table of [
            'audit.audit_log',
            'integration.external_entity_map',
            'integration.identity_provider_bindings',
            'identity.users',
          ])
            await c.query(`delete from ${table} where tenant_id=$1`, [t]);
        });
      await admin.query('delete from identity.tenants where id=any($1::uuid[])', [
        [tenantId, unbound],
      ]);
      await admin.query(`drop owned by ${role}`);
      await admin.query(`drop role ${role}`);
    } finally {
      await admin.end();
    }
  });

  async function user(t = tenantId) {
    const id = randomUUID();
    await withTenantTransaction(admin, t, (c) =>
      c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [t, id]),
    );
    return id;
  }
  const attestation = (userId: string, providerClientId: string, t = tenantId) => ({
    tenantId: t,
    userId,
    operationId: randomUUID(),
    correlationId: 'synthetic-attest-0001',
    providerClientId,
    attestedAt: new Date().toISOString(),
    subscriptions: [
      {
        clientSubscriptionId: 'sub-' + providerClientId,
        productId: null,
        title: 'Synthetic',
        state: 'ACTIVE' as const,
        remainingUnits: 3,
        validUntil: null,
      },
    ],
  });
  const profileOwner = async (clientId: string) =>
    (
      await withTenantTransaction(admin, tenantId, (c) =>
        c.query<{ internal_id: string }>(
          "select internal_id from integration.external_entity_map where tenant_id=$1 and external_system='VIVA' and entity_type='viva_profile' and external_id=$2",
          [tenantId, clientId],
        ),
      )
    ).rows.map((r) => r.internal_id);

  it('records profile and subscription mappings idempotently with stable PadlHub ids', async () => {
    const userId = await user();
    const clientId = 'client-' + randomUUID();
    const first = await repository.recordAttestation(attestation(userId, clientId));
    const second = await repository.recordAttestation(attestation(userId, clientId));
    expect(second.profileMappingId).toBe(first.profileMappingId);
    expect(second.subscriptions[0]!.subscriptionId).toBe(first.subscriptions[0]!.subscriptionId);
    expect(await profileOwner(clientId)).toEqual([userId]);
  });

  it('never moves a Viva client to another user and audits the refusal', async () => {
    const owner = await user();
    const other = await user();
    const clientId = 'client-' + randomUUID();
    await repository.recordAttestation(attestation(owner, clientId));
    await expect(repository.recordAttestation(attestation(other, clientId))).rejects.toBeInstanceOf(
      ProviderAccountMappingConflict,
    );
    expect(await profileOwner(clientId)).toEqual([owner]);
    const audit = await withTenantTransaction(admin, tenantId, (c) =>
      c.query<{ result: string }>(
        "select result from audit.audit_log where tenant_id=$1 and action='PROVIDER_ACCOUNT_ATTESTED' and resource_id=$2",
        [tenantId, other],
      ),
    );
    expect(audit.rows.map((r) => r.result)).toEqual(['FAILURE']);
  });

  it('never silently switches a user to another Viva client', async () => {
    const userId = await user();
    const first = 'client-' + randomUUID();
    await repository.recordAttestation(attestation(userId, first));
    await expect(
      repository.recordAttestation(attestation(userId, 'client-' + randomUUID())),
    ).rejects.toThrow();
    expect(await profileOwner(first)).toEqual([userId]);
  });

  it('lets exactly one of two concurrent users claim the same Viva client', async () => {
    const a = await user();
    const b = await user();
    const clientId = 'client-' + randomUUID();
    const results = await Promise.allSettled([
      repository.recordAttestation(attestation(a, clientId)),
      repository.recordAttestation(attestation(b, clientId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const owners = await profileOwner(clientId);
    expect(owners).toHaveLength(1);
    expect([a, b]).toContain(owners[0]);
  });

  it('refuses a tenant without the attested Viva binding and writes nothing', async () => {
    const userId = await user(unbound);
    const clientId = 'client-' + randomUUID();
    await expect(
      repository.recordAttestation(attestation(userId, clientId, unbound)),
    ).rejects.toBeInstanceOf(ProviderAccountTenantUnbound);
    const rows = await withTenantTransaction(admin, unbound, (c) =>
      c.query('select 1 from integration.external_entity_map where tenant_id=$1', [unbound]),
    );
    expect(rows.rowCount).toBe(0);
  });
});
