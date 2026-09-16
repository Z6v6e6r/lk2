import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import {
  linkLegacyViewerPhone,
  readLegacyViewerPhone,
} from './legacy-viewer-identity-repository.js';

const suppliedConnectionString = process.env.LEGACY_VIEWER_IDENTITY_TEST_DATABASE_URL;
// The CI quality job applies every migration to a disposable database and exports APP_ENV=ci, which is
// the only place this repository contract can be exercised without an operator-supplied database.
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const connectionString = suppliedConnectionString ?? ciConnectionString;
const describePostgres = connectionString ? describe : describe.skip;

/**
 * `integration.external_entity_map` lost its table-level unique constraint on
 * `(tenant_id, external_system, entity_type, internal_id)` in migration 0042, which replaced it with
 * the partial unique index `external_entity_map_canonical_internal_idx`. An `on conflict` clause
 * naming the dropped constraint target compiles fine and fails at runtime with `42P10`, so the link
 * command needs a real database to prove it still works.
 */
describePostgres('legacy viewer phone link against real PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 4 });
  const tenantId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const fetchedAt = (): string => new Date().toISOString();

  async function linkedPhones(): Promise<readonly string[]> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ internal_id: string; external_id: string }>(
        `select internal_id, external_id
           from integration.external_entity_map
          where tenant_id = $1 and entity_type = 'legacy_viewer_phone'
          order by external_id`,
        [tenantId],
      );
      return result.rows.map((row) => `${row.internal_id}:${row.external_id}`);
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `legacy-phone-${tenantId}`, 'Legacy phone link integration'],
    );
  });

  afterAll(async () => {
    await pool.query('delete from integration.external_entity_map where tenant_id = $1', [
      tenantId,
    ]);
    await pool.query('delete from identity.tenants where id = $1', [tenantId]);
    await pool.end();
  });

  it('links, replays, replaces and refuses a phone through the live index contract', async () => {
    expect(
      await linkLegacyViewerPhone({
        pool,
        tenantId,
        userId,
        phoneE164: '+79990000001',
        fetchedAt: fetchedAt(),
      }),
    ).toBe('linked');
    expect(await readLegacyViewerPhone({ pool, tenantId, userId })).toBe('+79990000001');

    expect(
      await linkLegacyViewerPhone({
        pool,
        tenantId,
        userId,
        phoneE164: '+79990000001',
        fetchedAt: fetchedAt(),
      }),
    ).toBe('unchanged');
    expect(await linkedPhones()).toEqual([`${userId}:+79990000001`]);

    // A provider-owned value stays correctable: the same user may replace a wrong CRM number.
    expect(
      await linkLegacyViewerPhone({
        pool,
        tenantId,
        userId,
        phoneE164: '+79990000002',
        fetchedAt: fetchedAt(),
      }),
    ).toBe('linked');
    expect(await linkedPhones()).toEqual([`${userId}:+79990000002`]);

    // A phone already claimed by another active user is never shared.
    expect(
      await linkLegacyViewerPhone({
        pool,
        tenantId,
        userId: otherUserId,
        phoneE164: '+79990000002',
        fetchedAt: fetchedAt(),
      }),
    ).toBe('conflict');
    expect(await readLegacyViewerPhone({ pool, tenantId, userId: otherUserId })).toBeUndefined();
    expect(await linkedPhones()).toEqual([`${userId}:+79990000002`]);

    expect(
      await linkLegacyViewerPhone({
        pool,
        tenantId,
        userId,
        phoneE164: undefined,
        fetchedAt: fetchedAt(),
      }),
    ).toBe('absent');
    expect(await linkedPhones()).toEqual([`${userId}:+79990000002`]);
  });
});
