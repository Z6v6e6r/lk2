import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { linkVivaProfileByVerifiedPhone } from './viva-profile-phone-link-repository.js';
import {
  readVivaSubscriptionSyncProfile,
  recordVivaSubscriptionMappings,
} from './viva-subscription-mapping-repository.js';

const suppliedConnectionString = process.env.VIVA_SUBSCRIPTION_MAPPING_TEST_DATABASE_URL;
// The CI quality job applies every migration to a disposable database and exports APP_ENV=ci.
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres('Viva subscription mappings against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const correlationId = 'corr-viva-subscription-mapping';

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query('insert into identity.users(tenant_id, id, status) values ($1, $2, $3)', [
        tenantId,
        userId,
        'ACTIVE',
      ]),
    );
    return userId;
  }

  async function mappedUser(): Promise<{
    readonly userId: string;
    readonly clientId: string;
    readonly profileMappingId: string;
  }> {
    const userId = await createUser();
    const clientId = randomUUID();
    await expect(
      linkVivaProfileByVerifiedPhone({
        pool,
        tenantId,
        userId,
        providerClientId: clientId,
        correlationId,
      }),
    ).resolves.toBe('linked');
    const profile = await readVivaSubscriptionSyncProfile({ pool, tenantId, userId });
    expect(profile?.providerClientId).toBe(clientId);
    return { userId, clientId, profileMappingId: profile!.profileMappingId };
  }

  const record = (
    actor: {
      readonly userId: string;
      readonly clientId: string;
      readonly profileMappingId: string;
    },
    providerSubscriptionIds: readonly string[],
    observedAt = '2026-11-09T10:00:00.000Z',
  ) =>
    recordVivaSubscriptionMappings({
      pool,
      tenantId,
      userId: actor.userId,
      profileMappingId: actor.profileMappingId,
      providerClientId: actor.clientId,
      providerSubscriptionIds,
      observedAt,
      correlationId,
    });

  async function mapping(externalId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{
        id: string;
        internal_id: string;
        external_id: string;
        external_version: string | null;
        last_synced_at: Date | null;
        sync_status: string;
        sync_error_code: string | null;
        owner_user_id: string | null;
        owner_profile_mapping_id: string | null;
        last_observed_at: Date | null;
      }>(
        `select m.id, m.internal_id, m.external_id, m.external_version, m.last_synced_at,
                m.sync_status, m.sync_error_code, o.user_id owner_user_id,
                o.profile_mapping_id owner_profile_mapping_id, o.last_observed_at
           from integration.external_entity_map m
           left join integration.viva_subscription_owners o
             on o.tenant_id = m.tenant_id and o.subscription_mapping_id = m.id
          where m.tenant_id = $1 and m.external_system = 'VIVA' and m.entity_type = 'subscription'
            and lower(m.external_id) = lower($2)`,
        [tenantId, externalId],
      );
      return result.rows;
    });
  }

  async function auditRows(userId: string): Promise<readonly string[]> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ action: string; result: string; occurred_at: Date }>(
        `select action, result, occurred_at from audit.audit_log
          where tenant_id = $1 and actor_id = $2`,
        [tenantId, userId],
      );
      // Rows of one transaction share a timestamp; sort here so the order ignores DB collation.
      return result.rows
        .map((row) => ({ at: row.occurred_at.getTime(), label: `${row.action}:${row.result}` }))
        .sort((a, b) => a.at - b.at || (a.label < b.label ? -1 : 1))
        .map((row) => row.label);
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `viva-subscriptions-${tenantId}`, 'Viva subscription mapping integration'],
    );
  });

  afterAll(async () => {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('delete from audit.audit_log where tenant_id = $1', [tenantId]);
      await client.query('delete from integration.viva_subscription_owners where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from integration.external_entity_map where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from identity.users where tenant_id = $1', [tenantId]);
    });
    await pool.query('delete from identity.tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('writes reader-compatible mappings bound to the user and is idempotent', async () => {
    const actor = await mappedUser();
    const first = randomUUID();
    const second = randomUUID();
    await expect(record(actor, [first, second])).resolves.toEqual({
      outcome: 'synced',
      created: 2,
      refreshed: 0,
      conflicts: 0,
    });
    const [row] = await mapping(first);
    expect(row).toMatchObject({
      external_id: first,
      external_version: '2026-11-09T10:00:00.000Z',
      sync_status: 'synced',
      sync_error_code: null,
      owner_user_id: actor.userId,
      owner_profile_mapping_id: actor.profileMappingId,
    });
    expect(row!.last_synced_at?.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    const internalId = row!.internal_id;

    await expect(record(actor, [first], '2026-11-09T11:00:00.000Z')).resolves.toEqual({
      outcome: 'synced',
      created: 0,
      refreshed: 1,
      conflicts: 0,
    });
    const [again] = await mapping(first);
    // The PadlHub UUID the picker and JOIN readers hold never changes.
    expect(again!.internal_id).toBe(internalId);
    expect(again!.last_observed_at?.toISOString()).toBe('2026-11-09T11:00:00.000Z');
    // An instance missing from a later read keeps its row and binding.
    expect((await mapping(second))[0]?.owner_user_id).toBe(actor.userId);
    expect(await auditRows(actor.userId)).toEqual([
      'VIVA_PROFILE_LINKED_BY_PHONE:SUCCESS',
      'VIVA_SUBSCRIPTION_MAPPINGS_SYNCED:SUCCESS',
      'VIVA_SUBSCRIPTION_MAPPINGS_SYNCED:SUCCESS',
    ]);
  });

  it('never moves freshness backwards for an older observation', async () => {
    const actor = await mappedUser();
    const id = randomUUID();
    await record(actor, [id], '2026-11-09T12:00:00.000Z');
    await record(actor, [id], '2026-11-09T09:00:00.000Z');
    const [row] = await mapping(id);
    expect(row!.last_synced_at?.toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(row!.external_version).toBe('2026-11-09T12:00:00.000Z');
    expect(row!.last_observed_at?.toISOString()).toBe('2026-11-09T12:00:00.000Z');
  });

  it('treats an instance bound to another user as a conflict and never overwrites it', async () => {
    const owner = await mappedUser();
    const intruder = await mappedUser();
    const shared = randomUUID();
    const own = randomUUID();
    await record(owner, [shared], '2026-11-09T10:00:00.000Z');
    const [before] = await mapping(shared);
    await expect(record(intruder, [shared, own], '2026-11-09T13:00:00.000Z')).resolves.toEqual({
      outcome: 'synced',
      created: 1,
      refreshed: 0,
      conflicts: 1,
    });
    const [after] = await mapping(shared);
    expect(after).toEqual(before);
    expect((await mapping(own))[0]?.owner_user_id).toBe(intruder.userId);
    expect(await auditRows(intruder.userId)).toEqual([
      'VIVA_PROFILE_LINKED_BY_PHONE:SUCCESS',
      'VIVA_SUBSCRIPTION_MAPPINGS_SYNCED:PARTIAL',
      'VIVA_SUBSCRIPTION_MAPPING_OWNER_CONFLICT:DENIED',
    ]);
  });

  it('binds an existing unowned mapping without changing its PadlHub UUID', async () => {
    const actor = await mappedUser();
    const id = randomUUID();
    const internalId = randomUUID();
    // A row in the Home worker format, written before any owner binding existed.
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `insert into integration.external_entity_map (
           tenant_id, external_system, entity_type, internal_id, external_id,
           external_version, last_synced_at, sync_status, sync_error_code
         ) values ($1, 'VIVA', 'subscription', $2, $3, 'v0', now(), 'synced', null)`,
        [tenantId, internalId, id],
      ),
    );
    await expect(record(actor, [id.toUpperCase()])).resolves.toMatchObject({
      created: 0,
      refreshed: 1,
    });
    const rows = await mapping(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      internal_id: internalId,
      external_id: id,
      owner_user_id: actor.userId,
    });
  });

  it('writes nothing when the profile mapping moved or is no longer synced', async () => {
    const actor = await mappedUser();
    const id = randomUUID();
    await expect(record({ ...actor, clientId: randomUUID() }, [id])).resolves.toMatchObject({
      outcome: 'profile_changed',
    });
    await expect(record({ ...actor, profileMappingId: randomUUID() }, [id])).resolves.toMatchObject(
      { outcome: 'profile_changed' },
    );
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update integration.external_entity_map set sync_status = 'error', sync_error_code = 'X'
          where tenant_id = $1 and id = $2`,
        [tenantId, actor.profileMappingId],
      ),
    );
    await expect(record(actor, [id])).resolves.toMatchObject({ outcome: 'profile_changed' });
    await expect(
      readVivaSubscriptionSyncProfile({ pool, tenantId, userId: actor.userId }),
    ).resolves.toBeNull();
    expect(await mapping(id)).toEqual([]);
  });

  it('lets exactly one of two concurrent users bind the same instance', async () => {
    const a = await mappedUser();
    const b = await mappedUser();
    const id = randomUUID();
    const results = await Promise.all([record(a, [id]), record(b, [id])]);
    expect(results.map((result) => result.conflicts).sort()).toEqual([0, 1]);
    const rows = await mapping(id);
    expect(rows).toHaveLength(1);
    expect([a.userId, b.userId]).toContain(rows[0]!.owner_user_id);
  });

  it('rejects malformed input before opening a transaction', async () => {
    const actor = await mappedUser();
    await expect(record(actor, ['not-a-uuid'])).rejects.toThrow(
      'VIVA_SUBSCRIPTION_MAPPING_ID_INVALID',
    );
    await expect(record({ ...actor, clientId: 'bad' }, [randomUUID()])).rejects.toThrow(
      'VIVA_SUBSCRIPTION_MAPPING_CLIENT_ID_INVALID',
    );
    await expect(record(actor, [randomUUID()], 'yesterday')).rejects.toThrow(
      'VIVA_SUBSCRIPTION_MAPPING_OBSERVED_AT_INVALID',
    );
  });

  it('enforces tenant isolation on the owner table', async () => {
    const actor = await mappedUser();
    await record(actor, [randomUUID()]);
    const superuser = await pool.query<{ is: string }>(
      `select current_setting('is_superuser') "is"`,
    );
    // Superusers bypass even forced RLS; the policy is then covered by the migration test only.
    if (superuser.rows[0]?.is === 'on') return;
    const otherTenant = randomUUID();
    const visible = await withTenantTransaction(pool, otherTenant, (client) =>
      client.query('select 1 from integration.viva_subscription_owners where tenant_id = $1', [
        tenantId,
      ]),
    );
    expect(visible.rows).toHaveLength(0);
  });
});
