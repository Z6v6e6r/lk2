import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { runFcmTenantCycle } from './fcm-tenant-cycle.js';

describe('FCM tenant cycle', () => {
  it('uses the shared fair traversal without turning an empty tenant into a retry loop', async () => {
    const runTenant = vi.fn((tenantId: string) => Promise.resolve(tenantId === 'tenant-a' ? 0 : 1));
    const output = await runFcmTenantCycle({
      pool: {
        query: vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }] }),
      } as unknown as Pool,
      startOffset: 0,
      maxDeliveriesPerTenant: 2,
      shouldStop: () => false,
      runTenant,
      onTenantFailure: vi.fn(),
      onProgress: vi.fn(),
    });
    expect(runTenant.mock.calls.map(([id]) => id)).toEqual(['tenant-a', 'tenant-b', 'tenant-b']);
    expect(output).toMatchObject({ interrupted: false, failedCount: 0 });
  });
});
