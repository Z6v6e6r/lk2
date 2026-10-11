import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkerForwardProgressTracker } from './worker-runtime-health.js';
import {
  runSupportTicketAutocloseBatch,
  runSupportTicketAutocloseTenantCycle,
} from './support-ticket-autoclose.js';

describe('runSupportTicketAutocloseBatch', () => {
  it('delegates a bounded tenant batch to the serialized repository close operation', async () => {
    const calls: unknown[] = [];
    const result = await runSupportTicketAutocloseBatch({
      repository: {
        closeResolvedBatch: (input: unknown) => {
          calls.push(input);
          return Promise.resolve(2);
        },
      },
      tenantId: '00000000-0000-4000-8000-000000000001',
      limit: 10,
      correlationId: 'test',
    });
    expect(result).toBe(2);
    expect(calls).toEqual([
      { tenantId: '00000000-0000-4000-8000-000000000001', limit: 10, correlationId: 'test' },
    ]);
  });
});

describe('support ticket tenant fairness', () => {
  it('continues later tenants after a failure and rotates the next cycle start', async () => {
    const attempted: string[] = [];
    const failures: string[] = [];
    const result = await runSupportTicketAutocloseTenantCycle({
      repository: {
        purgeClosedBatch: () => Promise.resolve(0),
        closeResolvedBatch: ({ tenantId }) => {
          attempted.push(tenantId);
          if (tenantId === 'tenant-a') return Promise.reject(new Error('synthetic'));
          return Promise.resolve(2);
        },
      },
      tenants: [{ id: 'tenant-a' }, { id: 'tenant-b' }],
      startOffset: 0,
      limit: 10,
      correlationId: () => 'synthetic',
      onTenantFailure: (tenant) => {
        failures.push(tenant.id);
      },
      onProgress: () => undefined,
      shouldStop: () => false,
    });
    expect(attempted).toEqual(['tenant-a', 'tenant-b']);
    expect(failures).toEqual(['tenant-a']);
    expect(result).toMatchObject({
      closed: 2,
      failedCount: 1,
      succeededCount: 1,
      nextStartOffset: 1,
    });
  });
});

describe('support lifecycle worker isolation', () => {
  it('runs bounded cleanup and cannot refresh stalled core outbox readiness', async () => {
    const core = new WorkerForwardProgressTracker(30_000);
    core.markCycleSucceeded(0);
    const calls: unknown[] = [];
    const result = await runSupportTicketAutocloseTenantCycle({
      repository: {
        closeResolvedBatch: () => Promise.resolve(0),
        purgeClosedBatch: (input) => {
          calls.push(input);
          return Promise.resolve(3);
        },
      },
      tenants: [{ id: 'tenant-a' }],
      startOffset: 0,
      limit: 10,
      correlationId: () => 'synthetic',
      onTenantFailure: () => undefined,
      onProgress: () => undefined,
      shouldStop: () => false,
    });
    expect(result.purged).toBe(3);
    expect(calls).toEqual([{ tenantId: 'tenant-a', limit: 10, correlationId: 'synthetic' }]);
    expect(core.snapshot(60_000)).toMatchObject({ ready: false, state: 'stalled' });
    const main = await readFile(resolve(import.meta.dirname, 'main.ts'), 'utf8');
    const supportCycle = main.slice(
      main.indexOf('const runSupportTicketAutocloseCycle'),
      main.indexOf('const runDeferredFriendRequestDeliveryCycle'),
    );
    expect(supportCycle).toContain('onProgress: () => undefined');
    expect(supportCycle).not.toContain('workerForwardProgress');
  });
});
