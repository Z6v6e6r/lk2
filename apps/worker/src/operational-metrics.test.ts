import { describe, expect, it, vi } from 'vitest';

import { DEAD_LETTER_QUEUE } from './broker-topology.js';
import { collectWorkerOperationalSnapshot } from './operational-metrics.js';

describe('worker operational metrics', () => {
  it('collects aggregate outbox age through tenant-scoped transactions and reads DLQ depth', async () => {
    const release = vi.fn();
    const tenantContexts: string[] = [];
    const connect = vi.fn(() => ({
      query: vi.fn((text: string, values: readonly unknown[] = []) => {
        if (text.includes("set_config('app.tenant_id'")) {
          tenantContexts.push(String(values[0]));
        }
        if (text.includes('oldest_age_seconds')) {
          return Promise.resolve({
            rows: values[0] === 'tenant-a' ? [{ oldest_age_seconds: 42.5 }] : [],
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
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(tenantContexts.sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(channel.checkQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE);
  });
});
