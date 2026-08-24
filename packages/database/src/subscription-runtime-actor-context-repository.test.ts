import { describe, expect, it, vi } from 'vitest';

import { createSubscriptionRuntimeActorContextRepository } from './subscription-runtime-actor-context-repository.js';

const input = { tenantId: 'tenant-id', userId: 'user-id', sessionId: 'session-id' };

function pool(mappingRows: unknown[], sessionRows: unknown[] = []) {
  const query = vi.fn((sql: string) => ({
    rows: sql.includes('join integration.external_entity_map')
      ? mappingRows
      : sql.includes('select true as active')
        ? sessionRows
        : [],
  }));
  const client = { query, release: vi.fn() };
  return { connect: vi.fn().mockResolvedValue(client), client, query };
}

describe('subscription runtime actor context repository', () => {
  it('uses tenant RLS and returns only an active synced VIVA mapping', async () => {
    const db = pool([{ provider_client_id: 'opaque-viva-id', provider_mapping_id: 'mapping-id' }]);
    await expect(
      createSubscriptionRuntimeActorContextRepository(db as never).resolve(input),
    ).resolves.toEqual({
      outcome: 'ok',
      providerClientId: 'opaque-viva-id',
      providerMappingId: 'mapping-id',
    });
    expect(db.client.query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      'tenant-id',
    ]);
    const sql = db.client.query.mock.calls.at(2)?.[0];
    expect(sql).toContain("mapping.external_system = 'VIVA'");
    expect(sql).toContain("mapping.entity_type = 'viva_profile'");
    expect(sql).toContain("mapping.sync_status = 'synced'");
  });

  it.each(['missing', 'revoked', 'rotated', 'inactive_user'])(
    'fails closed for %s session authority',
    async () => {
      const db = pool([]);
      await expect(
        createSubscriptionRuntimeActorContextRepository(db as never).resolve(input),
      ).resolves.toEqual({ outcome: 'session_inactive' });
    },
  );

  it.each(['missing', 'unsynced', 'duplicate'])('fails closed for %s provider map', async () => {
    const db = pool([], [{ active: true }]);
    await expect(
      createSubscriptionRuntimeActorContextRepository(db as never).resolve(input),
    ).resolves.toEqual({ outcome: 'provider_mapping_unavailable' });
  });
});
