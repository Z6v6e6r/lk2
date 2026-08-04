import { metrics } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { DEAD_LETTER_QUEUE } from './broker-topology.js';
import {
  collectWorkerOperationalSnapshot,
  createWorkerMetricRecorder,
  WORKER_METRIC_INSTRUMENTS,
} from './operational-metrics.js';

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

  it('returns a zero snapshot without opening tenant transactions when no tenant is active', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() };
    const channel = {
      checkQueue: vi.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
    };
    await expect(
      collectWorkerOperationalSnapshot({ pool: pool as never, channel }),
    ).resolves.toEqual({
      outboxOldestAgeSeconds: 0,
      outboxBackloggedTenants: 0,
      deadLetterMessagesReady: 0,
      pushDeliveriesDue: 0,
      pushDeliveryOldestDueAgeSeconds: 0,
      pushDeliveriesDead: 0,
      communityMemberCountBuilding: 0,
      communityMemberCountStale: 0,
      communityMemberCountNotReadyAgeSeconds: 0,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects an invalid negative Communities projection metric instead of exporting it', async () => {
    const client = {
      query: vi.fn((text: string) => {
        if (text.includes('oldest_age_seconds') && text.includes('audit.outbox_events')) {
          return Promise.resolve({ rows: [] });
        }
        if (text.includes("channel = 'PUSH'")) {
          return Promise.resolve({
            rows: [{ due_count: 0, oldest_due_age_seconds: 0, dead_count: 0 }],
          });
        }
        if (text.includes('building_count')) {
          return Promise.resolve({
            rows: [{ building_count: -1, stale_count: 0, not_ready_age_seconds: 0 }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-invalid' }] }),
      connect: vi.fn().mockResolvedValue(client),
    };

    await expect(
      collectWorkerOperationalSnapshot({
        pool: pool as never,
        channel: { checkQueue: vi.fn() },
      }),
    ).rejects.toThrow('Invalid member count building metric value');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('records positive Communities lifecycle outcomes and keeps zero cycles as no-op counters', () => {
    const instruments = new Map<
      string,
      { record: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> }
    >();
    const instrument = (name: string) => {
      const value = { record: vi.fn(), add: vi.fn() };
      instruments.set(name, value);
      return value;
    };
    const meter = {
      createGauge: vi.fn(instrument),
      createCounter: vi.fn(instrument),
      createHistogram: vi.fn(instrument),
    };
    vi.spyOn(metrics, 'getMeter').mockReturnValue(meter as never);
    const recorder = createWorkerMetricRecorder();

    recorder.recordOperationalSnapshot(
      {
        outboxOldestAgeSeconds: 2,
        outboxBackloggedTenants: 1,
        deadLetterMessagesReady: 3,
        pushDeliveriesDue: 4,
        pushDeliveryOldestDueAgeSeconds: 5,
        pushDeliveriesDead: 6,
        communityMemberCountBuilding: 7,
        communityMemberCountStale: 8,
        communityMemberCountNotReadyAgeSeconds: 9,
      },
      10,
    );
    recorder.recordOperationalCollectionFailure(11);
    recorder.recordOutboxPublishCycle(2, 12, true);
    recorder.recordOutboxPublishCycle(0, 13, false);
    recorder.recordCommunityEventRetentionCycle(3, 2, 1, 14);
    recorder.recordCommunityEventRetentionCycle(0, 0, 0, 15);
    recorder.recordCommunityMediaCycle(
      { expired: 1, scanned: 2, rejected: 3, scanRetried: 4, gcCompleted: 5, gcRetried: 6 },
      7,
      16,
    );
    recorder.recordCommunityMediaCycle(
      { expired: 0, scanned: 0, rejected: 0, scanRetried: 0, gcCompleted: 0, gcRetried: 0 },
      0,
      17,
    );

    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMemberCountBuilding)?.record,
    ).toHaveBeenCalledWith(7);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityEventRetentionPurged)?.add,
    ).toHaveBeenCalledOnce();
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaGcRetried)?.add,
    ).toHaveBeenCalledWith(6);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaFailures)?.add,
    ).toHaveBeenCalledWith(7);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaCycleDurationMilliseconds)?.record,
    ).toHaveBeenCalledTimes(2);
  });
});
