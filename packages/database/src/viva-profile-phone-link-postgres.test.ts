import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  hasVivaProfileMapping,
  linkVivaProfileByVerifiedPhone,
} from './viva-profile-phone-link-repository.js';

const suppliedConnectionString = process.env.VIVA_PROFILE_PHONE_LINK_TEST_DATABASE_URL;
// The CI quality job applies every migration to a disposable database and exports APP_ENV=ci.
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres('Viva profile phone link against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const correlationId = 'corr-viva-phone-link';

  async function mappings(): Promise<readonly string[]> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ internal_id: string; external_id: string }>(
        `select internal_id, external_id from integration.external_entity_map
          where tenant_id = $1 and entity_type = 'viva_profile' order by external_id`,
        [tenantId],
      );
      return result.rows.map((row) => `${row.internal_id}:${row.external_id}`);
    });
  }

  async function auditActions(userId: string): Promise<readonly string[]> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ action: string; result: string }>(
        `select action, result from audit.audit_log
          where tenant_id = $1 and actor_id = $2 order by occurred_at, action`,
        [tenantId, userId],
      );
      return result.rows.map((row) => `${row.action}:${row.result}`);
    });
  }

  const link = (userId: string, providerClientId: string) =>
    linkVivaProfileByVerifiedPhone({ pool, tenantId, userId, providerClientId, correlationId });

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `viva-phone-${tenantId}`, 'Viva phone link integration'],
    );
  });

  afterAll(async () => {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('delete from audit.audit_log where tenant_id = $1', [tenantId]);
      await client.query('delete from integration.external_entity_map where tenant_id = $1', [
        tenantId,
      ]);
    });
    await pool.query('delete from identity.tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('links once, is idempotent, and audits only the write', async () => {
    const userId = randomUUID();
    const clientId = randomUUID();
    await expect(hasVivaProfileMapping({ pool, tenantId, userId })).resolves.toBe(false);
    await expect(link(userId, clientId)).resolves.toBe('linked');
    await expect(link(userId, clientId.toUpperCase())).resolves.toBe('unchanged');
    await expect(hasVivaProfileMapping({ pool, tenantId, userId })).resolves.toBe(true);
    expect(await mappings()).toContain(`${userId}:${clientId}`);
    expect(await auditActions(userId)).toEqual(['VIVA_PROFILE_LINKED_BY_PHONE:SUCCESS']);
  });

  it('never moves a Viva client that belongs to another user', async () => {
    const owner = randomUUID();
    const intruder = randomUUID();
    const clientId = randomUUID();
    await expect(link(owner, clientId)).resolves.toBe('linked');
    await expect(link(intruder, clientId)).resolves.toBe('client_conflict');
    expect(await mappings()).toContain(`${owner}:${clientId}`);
    expect((await mappings()).some((row) => row.startsWith(`${intruder}:`))).toBe(false);
    expect(await auditActions(intruder)).toEqual([
      'VIVA_PROFILE_PHONE_LINK_CLIENT_CONFLICT:DENIED',
    ]);
  });

  it('never overwrites a user already mapped to a different client', async () => {
    const userId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await expect(link(userId, first)).resolves.toBe('linked');
    await expect(link(userId, second)).resolves.toBe('user_conflict');
    const rows = (await mappings()).filter((row) => row.startsWith(`${userId}:`));
    expect(rows).toEqual([`${userId}:${first}`]);
    expect(await auditActions(userId)).toEqual([
      'VIVA_PROFILE_LINKED_BY_PHONE:SUCCESS',
      'VIVA_PROFILE_PHONE_LINK_USER_CONFLICT:DENIED',
    ]);
  });

  it('lets exactly one of two concurrent users claim the same client', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const clientId = randomUUID();
    const outcomes = await Promise.all([link(a, clientId), link(b, clientId)]);
    expect([...outcomes].sort()).toEqual(['client_conflict', 'linked']);
    expect((await mappings()).filter((row) => row.endsWith(`:${clientId}`))).toHaveLength(1);
  });

  it('rejects a non-UUID client id before touching storage', async () => {
    await expect(link(randomUUID(), 'not-a-uuid')).rejects.toThrow(
      'VIVA_PROFILE_PHONE_LINK_CLIENT_ID_INVALID',
    );
  });
});
