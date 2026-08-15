import { metrics } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const instruments = vi.hoisted(() => ({
  gaugeRecord: vi.fn(),
  counterAdd: vi.fn(),
  histogramRecord: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createGauge: (name: string) => ({
        record: (value: number, attributes?: Readonly<Record<string, string>>) => {
          instruments.gaugeRecord(name, value, attributes);
        },
      }),
      createCounter: (name: string) => ({
        add: (value: number, attributes?: Readonly<Record<string, string>>) => {
          instruments.counterAdd(name, value, attributes);
        },
      }),
      createHistogram: (name: string) => ({
        record: (value: number, attributes?: Readonly<Record<string, string>>) => {
          instruments.histogramRecord(name, value, attributes);
        },
      }),
    }),
  },
}));

import { DEAD_LETTER_QUEUE } from './broker-topology.js';
import {
  collectWorkerOperationalSnapshot,
  createWorkerMetricRecorder,
  WORKER_METRIC_INSTRUMENTS,
} from './operational-metrics.js';

describe('worker operational metrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('collects chat, push, booking and Communities metrics through tenant transactions', async () => {
    const release = vi.fn();
    const tenantContexts: string[] = [];
    const pushDeliveryQueries: string[] = [];
    const bookingReminderQueries: string[] = [];
    const connect = vi.fn(() => ({
      query: vi.fn((text: string, values: readonly unknown[] = []) => {
        if (text.includes("set_config('app.tenant_id'")) {
          tenantContexts.push(String(values[0]));
        }
        if (text.includes("schedule.state = 'MISSED'")) {
          bookingReminderQueries.push(text);
          return Promise.resolve({
            rows:
              values[0] === 'tenant-a'
                ? [{ latest_missed_unixtime: 1_777_777_777 }]
                : [{ latest_missed_unixtime: 1_666_666_666 }],
          });
        }
        if (text.includes('from notifications.booking_reminder_schedules')) {
          bookingReminderQueries.push(text);
          return Promise.resolve({
            rows: [
              values[0] === 'tenant-a'
                ? { due_count: '4', oldest_due_age_seconds: 50 }
                : { due_count: '1', oldest_due_age_seconds: 10 },
            ],
          });
        }
        if (text.includes('oldest_age_seconds') && text.includes('audit.outbox_events')) {
          return Promise.resolve({
            rows: values[0] === 'tenant-a' ? [{ oldest_age_seconds: 42.5 }] : [],
          });
        }
        if (text.includes("channel = 'PUSH'")) {
          pushDeliveryQueries.push(text);
          return Promise.resolve({
            rows: [
              values[0] === 'tenant-a'
                ? {
                    due_count: '2',
                    oldest_due_age_seconds: 31.25,
                    dead_count: '1',
                    policy_suspended_count: '2',
                  }
                : {
                    due_count: '3',
                    oldest_due_age_seconds: 12,
                    dead_count: '4',
                    policy_suspended_count: '1',
                  },
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
        if (text.includes('scan_backlog')) {
          return Promise.resolve({
            rows: [
              values[0] === 'tenant-a'
                ? {
                    scan_backlog: 3,
                    scan_oldest_age_seconds: 44,
                    failed_scans: 1,
                    gc_backlog: 2,
                    gc_oldest_age_seconds: 55,
                    dead_gc_jobs: 1,
                  }
                : {
                    scan_backlog: 4,
                    scan_oldest_age_seconds: 22,
                    failed_scans: 2,
                    gc_backlog: 5,
                    gc_oldest_age_seconds: 33,
                    dead_gc_jobs: 3,
                  },
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
      communityMediaScanBacklog: 7,
      communityMediaScanOldestAgeSeconds: 44,
      communityMediaFailedScans: 3,
      communityMediaGcBacklog: 7,
      communityMediaGcOldestAgeSeconds: 55,
      communityMediaDeadGcJobs: 4,
      pushDeliveriesPolicySuspended: 3,
      bookingRemindersDue: 5,
      bookingReminderOldestDueAgeSeconds: 50,
      bookingReminderLatestMissedUnixTime: 1_777_777_777,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(tenantContexts.sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(channel.checkQueue).toHaveBeenCalledWith(DEAD_LETTER_QUEUE);
    const deliverySql = pushDeliveryQueries[0] ?? '';
    expect(deliverySql).toContain("endpoint.status in ('ACTIVE', 'INVALID', 'REVOKED')");
    expect(deliverySql).toContain("endpoint.status = 'SUSPENDED_POLICY'");
    expect(bookingReminderQueries).toHaveLength(4);
    const pendingSql = bookingReminderQueries.find((text) =>
      text.includes("schedule.state = 'PENDING'"),
    );
    const missedSql = bookingReminderQueries.find((text) =>
      text.includes("schedule.state = 'MISSED'"),
    );
    expect(pendingSql).toContain('runtime.booking_reminders_enabled');
    expect(missedSql).toContain('order by schedule.completed_at desc');
  });

  it('labels every scheduler process measurement by worker instance', () => {
    const recorder = createWorkerMetricRecorder({
      instanceId: 'worker-replica-b',
      now: () => 123_456,
    });

    recorder.recordBookingReminderSchedulerCycle(2, 1, 45, true);

    const attributes = { 'service.instance.id': 'worker-replica-b' };
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderSchedulerHeartbeatUnixTime,
      123,
      attributes,
    );
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderSchedulerSuccess,
      0,
      attributes,
    );
    expect(instruments.counterAdd).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderSchedulerEmitted,
      2,
      attributes,
    );
    expect(instruments.counterAdd).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderSchedulerMissed,
      1,
      attributes,
    );
    expect(instruments.counterAdd).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderSchedulerFailures,
      1,
      attributes,
    );
    expect(instruments.histogramRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderSchedulerDurationMilliseconds,
      45,
      attributes,
    );
  });

  it('records bounded Web Push provider outcomes per worker instance and environment', () => {
    const recorder = createWorkerMetricRecorder({ instanceId: 'worker-replica-push' });

    recorder.recordWebPushCycle(1, 2, 45, false);
    recorder.recordWebPushProviderOutcome('SANDBOX', 'WEB_PUSH_CIRCUIT_OPEN');

    const instanceAttributes = { 'service.instance.id': 'worker-replica-push' };
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.webPushCycleSuccess,
      0,
      instanceAttributes,
    );
    expect(instruments.counterAdd).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.webPushTenantFailures,
      1,
      instanceAttributes,
    );
    expect(instruments.counterAdd).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.webPushProviderOutcomes,
      1,
      {
        ...instanceAttributes,
        environment: 'SANDBOX',
        outcome: 'WEB_PUSH_CIRCUIT_OPEN',
      },
    );
  });

  it('binds operational success, heartbeat and booking gauges to the worker instance', () => {
    const recorder = createWorkerMetricRecorder({
      instanceId: 'worker-candidate',
      now: () => 123_456,
    });
    const attributes = { 'service.instance.id': 'worker-candidate' };

    recorder.recordOperationalSnapshot(
      {
        outboxOldestAgeSeconds: 0,
        outboxBackloggedTenants: 0,
        deadLetterMessagesReady: 0,
        pushDeliveriesDue: 0,
        pushDeliveryOldestDueAgeSeconds: 0,
        pushDeliveriesDead: 0,
        pushDeliveriesPolicySuspended: 0,
        bookingRemindersDue: 0,
        bookingReminderOldestDueAgeSeconds: 0,
        bookingReminderLatestMissedUnixTime: 0,
        communityMemberCountBuilding: 0,
        communityMemberCountStale: 0,
        communityMemberCountNotReadyAgeSeconds: 0,
        communityMediaScanBacklog: 0,
        communityMediaScanOldestAgeSeconds: 0,
        communityMediaFailedScans: 0,
        communityMediaGcBacklog: 0,
        communityMediaGcOldestAgeSeconds: 0,
        communityMediaDeadGcJobs: 0,
      },
      10,
    );
    recorder.recordOperationalCollectionFailure(11);

    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.operationalCollectionHeartbeatUnixTime,
      123,
      attributes,
    );
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.operationalCollectionSuccess,
      1,
      attributes,
    );
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.operationalCollectionSuccess,
      0,
      attributes,
    );
    expect(instruments.gaugeRecord).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.bookingReminderOldestDueAgeSeconds,
      0,
      attributes,
    );
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
      pushDeliveriesPolicySuspended: 0,
      bookingRemindersDue: 0,
      bookingReminderOldestDueAgeSeconds: 0,
      bookingReminderLatestMissedUnixTime: 0,
      communityMemberCountBuilding: 0,
      communityMemberCountStale: 0,
      communityMemberCountNotReadyAgeSeconds: 0,
      communityMediaScanBacklog: 0,
      communityMediaScanOldestAgeSeconds: 0,
      communityMediaFailedScans: 0,
      communityMediaGcBacklog: 0,
      communityMediaGcOldestAgeSeconds: 0,
      communityMediaDeadGcJobs: 0,
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
            rows: [
              {
                due_count: 0,
                oldest_due_age_seconds: 0,
                dead_count: 0,
                policy_suspended_count: 0,
              },
            ],
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
    const recorder = createWorkerMetricRecorder({ instanceId: 'worker-replica-c' });

    recorder.recordOperationalSnapshot(
      {
        outboxOldestAgeSeconds: 2,
        outboxBackloggedTenants: 1,
        deadLetterMessagesReady: 3,
        pushDeliveriesDue: 4,
        pushDeliveryOldestDueAgeSeconds: 5,
        pushDeliveriesDead: 6,
        pushDeliveriesPolicySuspended: 0,
        bookingRemindersDue: 0,
        bookingReminderOldestDueAgeSeconds: 0,
        bookingReminderLatestMissedUnixTime: 0,
        communityMemberCountBuilding: 7,
        communityMemberCountStale: 8,
        communityMemberCountNotReadyAgeSeconds: 9,
        communityMediaScanBacklog: 10,
        communityMediaScanOldestAgeSeconds: 11,
        communityMediaFailedScans: 12,
        communityMediaGcBacklog: 13,
        communityMediaGcOldestAgeSeconds: 14,
        communityMediaDeadGcJobs: 15,
      },
      10,
    );
    recorder.recordOperationalCollectionFailure(11);
    recorder.recordOutboxPublishCycle(2, 12, true);
    recorder.recordOutboxPublishCycle(0, 13, false);
    recorder.recordCommunityEventRetentionCycle(3, 2, 1, 14);
    recorder.recordCommunityEventRetentionCycle(0, 0, 0, 15);
    recorder.recordCommunityMediaCycle(
      {
        expired: 1,
        scanned: 2,
        rejected: 3,
        scanRetried: 4,
        scanFailed: 5,
        gcCompleted: 6,
        gcRetried: 7,
        gcDead: 8,
      },
      9,
      16,
    );
    recorder.recordCommunityMediaCycle(
      {
        expired: 0,
        scanned: 0,
        rejected: 0,
        scanRetried: 0,
        scanFailed: 0,
        gcCompleted: 0,
        gcRetried: 0,
        gcDead: 0,
      },
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
    ).toHaveBeenCalledWith(7);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaScanFailed)?.add,
    ).toHaveBeenCalledWith(5);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaGcDead)?.add,
    ).toHaveBeenCalledWith(8);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaScanOldestAgeSeconds)?.record,
    ).toHaveBeenCalledWith(11);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaFailures)?.add,
    ).toHaveBeenCalledWith(9);
    expect(
      instruments.get(WORKER_METRIC_INSTRUMENTS.communityMediaCycleDurationMilliseconds)?.record,
    ).toHaveBeenCalledTimes(2);
  });
});
