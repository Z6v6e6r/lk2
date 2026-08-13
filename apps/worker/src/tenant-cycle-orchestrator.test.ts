import { describe, expect, it, vi } from 'vitest';

import { rotateTenantCycle, runFairTenantCycle } from './tenant-cycle-orchestrator.js';

const tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }, { id: 'tenant-c' }] as const;

describe('fair tenant cycle orchestration', () => {
  it('isolates one tenant failure and still processes every remaining tenant', async () => {
    const visited: string[] = [];
    const failures: string[] = [];
    const onProgress = vi.fn();

    const result = await runFairTenantCycle({
      tenants,
      startOffset: 0,
      runTenant: (tenant) => {
        visited.push(tenant.id);
        return tenant.id === 'tenant-a'
          ? Promise.reject(new Error('tenant-local failure'))
          : Promise.resolve();
      },
      onTenantFailure: (tenant) => failures.push(tenant.id),
      onProgress,
    });

    expect(visited).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    expect(failures).toEqual(['tenant-a']);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      attemptedCount: 3,
      succeededCount: 2,
      failedCount: 1,
      interrupted: false,
      nextStartOffset: 1,
    });
  });

  it('rotates the starting tenant on every cycle so a repeated failure cannot starve peers', async () => {
    const visited: string[] = [];
    let startOffset = 0;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const result = await runFairTenantCycle({
        tenants,
        startOffset,
        runTenant: (tenant) => {
          visited.push(tenant.id);
          return tenant.id === 'tenant-a'
            ? Promise.reject(new Error('repeated tenant-local failure'))
            : Promise.resolve();
        },
        onTenantFailure: () => undefined,
        onProgress: () => undefined,
      });
      startOffset = result.nextStartOffset;
    }

    expect(visited).toEqual([
      'tenant-a',
      'tenant-b',
      'tenant-c',
      'tenant-b',
      'tenant-c',
      'tenant-a',
      'tenant-c',
      'tenant-a',
      'tenant-b',
    ]);
  });

  it('normalizes offsets when the active tenant set changes', () => {
    expect(rotateTenantCycle(tenants.slice(0, 2), 5).map((tenant) => tenant.id)).toEqual([
      'tenant-b',
      'tenant-a',
    ]);
    expect(rotateTenantCycle([], 5)).toEqual([]);
  });

  it('stops starting tenants after a terminal runtime failure', async () => {
    const visited: string[] = [];
    let stopped = false;
    const result = await runFairTenantCycle({
      tenants,
      startOffset: 0,
      shouldStop: () => stopped,
      runTenant: (tenant) => {
        visited.push(tenant.id);
        stopped = true;
        return Promise.reject(new Error('RabbitMQ connection closed'));
      },
      onTenantFailure: () => undefined,
      onProgress: () => undefined,
    });

    expect(visited).toEqual(['tenant-a']);
    expect(result).toMatchObject({ attemptedCount: 1, failedCount: 1, interrupted: true });
  });
});
