import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '@phub/database';
import { organizerProfileReader } from './organizer-profile-lookup-runtime.js';
function ciDatabase(): string | undefined {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw new Error('ORGANIZER_CI_DATABASE_REQUIRED');
  const u = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['127.0.0.1', 'localhost'].includes(u.hostname) ||
    u.username !== 'phub' ||
    u.password !== 'ci-password' ||
    u.pathname !== '/phub' ||
    u.port !== '5432' ||
    u.search ||
    u.hash
  )
    throw new Error('ORGANIZER_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ciDatabase();
(url ? describe : describe.skip)(
  'organizer profile lookup on existing migrated CI PostgreSQL',
  () => {
    const pool = new Pool({ connectionString: url, max: 2 }),
      tenantId = randomUUID(),
      tenantKey = 'organizer-' + randomUUID();
    const reader = organizerProfileReader(pool);
    beforeAll(async () => {
      await pool.query(
        "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic organizer')",
        [tenantId, tenantKey],
      );
    });
    afterAll(async () => {
      try {
        await withTenantTransaction(pool, tenantId, async (c) => {
          for (const table of [
            'integration.external_entity_map',
            'integration.identity_provider_bindings',
            'profile.user_summaries',
            'identity.users',
          ]) {
            await c.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
          }
        });
        await pool.query('delete from identity.tenants where id=$1', [tenantId]);
      } finally {
        await pool.end();
      }
    });
    async function fixture() {
      const userId = randomUUID(),
        externalId = 'synthetic-' + userId;
      await withTenantTransaction(pool, tenantId, async (c) => {
        await c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
          tenantId,
          userId,
        ]);
        await c.query(
          "insert into profile.user_summaries(tenant_id,user_id,display_name) values($1,$2,'Synthetic organizer')",
          [tenantId, userId],
        );
        await c.query(
          "insert into integration.external_entity_map(tenant_id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,'VIVA','viva_profile',$2,$3,'synced',now())",
          [tenantId, userId, externalId],
        );
      });
      return { userId, externalId };
    }
    it('requires an authoritative provider binding; canonical and provider tenant keys deliberately differ', async () => {
      const f = await fixture();
      expect(await reader(tenantId, tenantKey, f.userId)).toBeNull();
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query(
          "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','provider-synthetic')",
          [tenantId],
        ),
      );
      expect(await reader(tenantId, tenantKey, f.userId)).toEqual({
        userId: f.userId,
        displayName: 'Synthetic organizer',
        ownerTenantKey: 'provider-synthetic',
      });
      expect(await reader(tenantId, 'foreign-canonical-tenant', f.userId)).toBeNull();
      expect(await reader(randomUUID(), tenantKey, f.userId)).toBeNull();
    });
    it('disabled user, inactive tenant, stale mapping and missing canonical profile are refused', async () => {
      const f = await fixture();
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query("update identity.users set status='DISABLED' where tenant_id=$1 and id=$2", [
          tenantId,
          f.userId,
        ]),
      );
      expect(await reader(tenantId, tenantKey, f.userId)).toBeNull();
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query("update identity.users set status='ACTIVE' where tenant_id=$1 and id=$2", [
          tenantId,
          f.userId,
        ]),
      );
      await pool.query('update identity.tenants set active=false where id=$1', [tenantId]);
      expect(await reader(tenantId, tenantKey, f.userId)).toBeNull();
      await pool.query('update identity.tenants set active=true where id=$1', [tenantId]);
      await withTenantTransaction(pool, tenantId, (c) =>
        c.query(
          'update integration.external_entity_map set last_synced_at=null where tenant_id=$1 and internal_id=$2',
          [tenantId, f.userId],
        ),
      );
      expect(await reader(tenantId, tenantKey, f.userId)).toBeNull();
      expect(await reader(tenantId, tenantKey, randomUUID())).toBeNull();
    });
    it('actual canonical mapping/binding constraints reject ambiguity without schema alterations', async () => {
      const f = await fixture(),
        another = await fixture();
      await expect(
        withTenantTransaction(pool, tenantId, (c) =>
          c.query(
            "insert into integration.external_entity_map(tenant_id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,'VIVA','viva_profile',$2,$3,'synced',now())",
            [tenantId, f.userId, 'other-' + randomUUID()],
          ),
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        withTenantTransaction(pool, tenantId, (c) =>
          c.query(
            'update integration.external_entity_map set external_id=$3 where tenant_id=$1 and internal_id=$2',
            [tenantId, another.userId, f.externalId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        withTenantTransaction(pool, tenantId, (c) =>
          c.query(
            "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','foreign-provider')",
            [tenantId],
          ),
        ),
      ).rejects.toMatchObject({ code: '23505' });
      expect(await reader(tenantId, tenantKey, f.userId)).toEqual({
        userId: f.userId,
        displayName: 'Synthetic organizer',
        ownerTenantKey: 'provider-synthetic',
      });
    });
  },
);
