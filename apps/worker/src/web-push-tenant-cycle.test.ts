import { readFileSync } from 'node:fs';

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { runWebPushTenantCycle } from './web-push-tenant-cycle.js';

describe('Web Push tenant cycle', () => {
  it('wires the configured per-tenant budget while keeping each fair claim at one', () => {
    const workerMain = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

    expect(workerMain).toContain('maxDeliveriesPerTenant: config.WEB_PUSH_BATCH_SIZE');
    expect(workerMain).toContain('batchSize: 1');
  });

  it('orders tenants, isolates failures and advances the fair start offset', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }, { id: 'tenant-c' }],
    });
    const visited: string[] = [];
    const failures: string[] = [];
    const onProgress = vi.fn();

    const result = await runWebPushTenantCycle({
      pool: { query } as unknown as Pool,
      startOffset: 1,
      maxDeliveriesPerTenant: 20,
      shouldStop: () => false,
      runTenant: (tenantId) => {
        visited.push(tenantId);
        return tenantId === 'tenant-b'
          ? Promise.reject(new Error('tenant-local failure'))
          : Promise.resolve(0);
      },
      onTenantFailure: (tenantId) => failures.push(tenantId),
      onProgress,
    });

    expect(query).toHaveBeenCalledWith(
      'select id from identity.tenants where active = true order by id',
    );
    expect(visited).toEqual(['tenant-b', 'tenant-c', 'tenant-a']);
    expect(failures).toEqual(['tenant-b']);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      failedCount: 1,
      nextStartOffset: 2,
      interrupted: false,
      rounds: 1,
    });
  });

  it('uses one claim per tenant per fair round until the bounded budget or empty round', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }] });
    const claims = new Map([
      ['tenant-a', [1, 1, 0]],
      ['tenant-b', [1, 0, 0]],
    ]);
    const visited: string[] = [];

    const result = await runWebPushTenantCycle({
      pool: { query } as unknown as Pool,
      startOffset: 0,
      maxDeliveriesPerTenant: 20,
      shouldStop: () => false,
      runTenant: (tenantId) => {
        visited.push(tenantId);
        return Promise.resolve(claims.get(tenantId)?.shift() ?? 0);
      },
      onTenantFailure: vi.fn(),
      onProgress: vi.fn(),
    });

    expect(visited).toEqual(['tenant-a', 'tenant-b', 'tenant-b', 'tenant-a', 'tenant-a']);
    expect(result).toEqual({
      attemptedCount: 5,
      succeededCount: 5,
      failedCount: 0,
      interrupted: false,
      nextStartOffset: 1,
      rounds: 3,
    });
  });

  it('checks an empty tenant once while another tenant continues draining', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }] });
    const attempts = { tenantA: 0, tenantB: 0 };

    const result = await runWebPushTenantCycle({
      pool: { query } as unknown as Pool,
      startOffset: 0,
      maxDeliveriesPerTenant: 3,
      shouldStop: () => false,
      runTenant: (tenantId) => {
        if (tenantId === 'tenant-a') {
          attempts.tenantA += 1;
          return Promise.resolve(0);
        }
        attempts.tenantB += 1;
        return Promise.resolve(1);
      },
      onTenantFailure: vi.fn(),
      onProgress: vi.fn(),
    });

    expect(attempts).toEqual({ tenantA: 1, tenantB: 3 });
    expect(result).toMatchObject({ failedCount: 0, rounds: 3 });
  });

  it('does not retry a failed tenant repeatedly while another tenant drains its fair budget', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }] });
    const attempts = { tenantA: 0, tenantB: 0 };

    const result = await runWebPushTenantCycle({
      pool: { query } as unknown as Pool,
      startOffset: 0,
      maxDeliveriesPerTenant: 3,
      shouldStop: () => false,
      runTenant: (tenantId) => {
        if (tenantId === 'tenant-a') {
          attempts.tenantA += 1;
          return Promise.reject(new Error('tenant-local failure'));
        }
        attempts.tenantB += 1;
        return Promise.resolve(1);
      },
      onTenantFailure: vi.fn(),
      onProgress: vi.fn(),
    });

    expect(attempts).toEqual({ tenantA: 1, tenantB: 3 });
    expect(result).toMatchObject({ failedCount: 1, rounds: 3 });
  });
});
