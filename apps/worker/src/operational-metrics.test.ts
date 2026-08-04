import { describe, expect, it, vi } from 'vitest';

import { DEAD_LETTER_QUEUE } from './broker-topology.js';
import { collectWorkerOperationalSnapshot } from './operational-metrics.js';

describe('worker operational metrics', () => {
  it('retains messaging metrics and adds Communities projection metrics per tenant', async () => {
    const release = vi.fn();
    const tenantContexts: string[] = [];
    const connect = vi.fn(() => ({
      query: vi.fn((text: string, values: readonly unknown[] = []) => {
        if (text.includes("set_config('app.tenant_id'")) tenantContexts.push(String(values[0]));
        if (text.includes('oldest_age_seconds') && text.includes('audit.outbox_events')) {
          return Promise.resolve({
            rows: values[0] === 'tenant-a' ? [{ oldest_age_seconds: 42.5 }] : [],
          });
        }
        if (text.includes("channel = 'PUSH'")) {
          return Promise.resolve({
            rows: [
              values[0] === 'tenant-a'
                ? { due_count: '2', oldest_due_age_seconds: 31.25, dead_count: '1' }
                : { due_count: '3', oldest_due_age_seconds: 12, dead_count: '4' },
            ],
          });
        }
        if (text.includes('building_count')) {
          return Promise.resolve({
            rows: [
              values[0] === 'tenant-a'
                ? { building_count: 2, stale_count: 1, not_ready_age_seconds: 15 }
                : { building_count: 0, stale_count: 1, not_ready_age_seconds: 30 },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
      release,
    }));
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-a' }, { id: 'tenant-b' }] }),
      connect,
    };
    const channel = {
      checkQueue: vi.fn().mockResolvedValue({
        queue: DEAD_LETTER_QUEUE,
        messageCount: 3,
        consumerCount: 0,
      }),
    };

    await expect(
      collectWorkerOperationalSnapshot({ pool: pool as never, channel }),
    ).resolves.toEqual({
      outboxOldestAgeSeconds: 42.5,
      outboxBackloggedTenants: 1,
      deadLetterMessagesReady: 3,
      pushDeliveriesDue: 5,
      pushDeliveryOldestDueAgeSeconds: 31.25,
      pushDeliveriesDead: 5,
      communityMemberCountBuilding: 2,
      communityMemberCountStale: 2,
      communityMemberCountNotReadyAgeSeconds: 30,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(tenantContexts.sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(channel.checkQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE);
  });
});
