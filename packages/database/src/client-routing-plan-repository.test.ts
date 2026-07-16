import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createClientRoutingPlanRepository } from './client-routing-plan-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function poolWithRoutingRow(row: Record<string, unknown> | undefined) {
  const query = vi.fn((text: string, values?: readonly unknown[]) => {
    void values;
    if (text.includes('from integration.client_routing_plans')) {
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, query, client };
}

describe('client routing plan repository', () => {
  it('resolves plan, provider binding and this user delegation in one tenant transaction', async () => {
    const { pool, query, client } = poolWithRoutingRow({
      mode: 'MIXED_END_USER_READS',
      revision: '9',
      valid_for_seconds: 60,
      direct_read_operations: ['profile.read'],
      provider_tenant_key: 'iSkq6G',
      delegation_ready: true,
    });

    await expect(createClientRoutingPlanRepository(pool).get(tenantId, userId)).resolves.toEqual({
      mode: 'MIXED_END_USER_READS',
      revision: '9',
      validForSeconds: 60,
      directOperations: ['profile.read'],
      providerTenantKey: 'iSkq6G',
      delegationReady: true,
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const routingQuery = query.mock.calls.find(([text]) =>
      String(text).includes('from integration.client_routing_plans'),
    );
    expect(routingQuery?.[1]).toEqual([tenantId, userId]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns a short PadlHub-only plan when tenant configuration is absent', async () => {
    const { pool } = poolWithRoutingRow(undefined);

    await expect(createClientRoutingPlanRepository(pool).get(tenantId, userId)).resolves.toEqual({
      mode: 'PADLHUB_ONLY',
      revision: '0',
      validForSeconds: 30,
      directOperations: [],
      delegationReady: false,
    });
  });
});
