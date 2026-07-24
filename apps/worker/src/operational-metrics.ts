import { metrics } from '@opentelemetry/api';
import { withTenantTransaction } from '@phub/database';
import type { Channel } from 'amqplib';
import type { Pool, QueryResultRow } from 'pg';

import { DEAD_LETTER_QUEUE } from './broker-topology.js';

export const WORKER_OPERATIONAL_METRICS_INTERVAL_MS = 15_000;
const METRICS_TENANT_CONCURRENCY = 4;

export const WORKER_METRIC_INSTRUMENTS = {
  outboxOldestAgeSeconds: 'phub.worker.outbox.oldest_age_seconds',
  outboxBackloggedTenants: 'phub.worker.outbox.backlogged_tenants',
  outboxPublishedEvents: 'phub.worker.outbox.published_events',
  outboxPublishFailures: 'phub.worker.outbox.publish_failures',
  outboxPublishCycleDurationMilliseconds: 'phub.worker.outbox.publish_cycle_duration_milliseconds',
  deadLetterMessagesReady: 'phub.worker.dlq.messages_ready',
  operationalCollectionSuccess: 'phub.worker.operational.collection_success',
  operationalCollectionFailures: 'phub.worker.operational.collection_failures',
  operationalCollectionDurationMilliseconds:
    'phub.worker.operational.collection_duration_milliseconds',
} as const;

interface OutboxAgeRow extends QueryResultRow {
  readonly oldest_age_seconds: number | string;
}

export interface WorkerOperationalSnapshot {
  readonly outboxOldestAgeSeconds: number;
  readonly outboxBackloggedTenants: number;
  readonly deadLetterMessagesReady: number;
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  operation: (input: TInput) => Promise<TOutput>,
): Promise<readonly TOutput[]> {
  const results = new Array<TOutput>(inputs.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async (): Promise<void> => {
      while (cursor < inputs.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(inputs[index] as TInput);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parseNonNegativeMetric(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} metric value`);
  }
  return parsed;
}

export async function collectWorkerOperationalSnapshot(options: {
  readonly pool: Pool;
  readonly channel: Pick<Channel, 'checkQueue'>;
}): Promise<WorkerOperationalSnapshot> {
  const tenants = await options.pool.query<{ id: string }>(
    'select id from identity.tenants where active = true',
  );
  const tenantAges = await mapWithConcurrency(
    tenants.rows,
    METRICS_TENANT_CONCURRENCY,
    async (tenant): Promise<number> =>
      withTenantTransaction(options.pool, tenant.id, async (client) => {
        const result = await client.query<OutboxAgeRow>(
          `select extract(epoch from (clock_timestamp() - occurred_at))::double precision
                    as oldest_age_seconds
             from audit.outbox_events
            where tenant_id = $1 and published_at is null
            order by occurred_at
            limit 1`,
          [tenant.id],
        );
        const row = result.rows[0];
        return row ? parseNonNegativeMetric(row.oldest_age_seconds, 'outbox oldest age') : 0;
      }),
  );
  const queue = await options.channel.checkQueue(DEAD_LETTER_QUEUE);
  return {
    outboxOldestAgeSeconds: Math.max(0, ...tenantAges),
    outboxBackloggedTenants: tenantAges.filter((age) => age > 0).length,
    deadLetterMessagesReady: queue.messageCount,
  };
}

export interface WorkerMetricRecorder {
  recordOperationalSnapshot(
    snapshot: WorkerOperationalSnapshot,
    durationMilliseconds: number,
  ): void;
  recordOperationalCollectionFailure(durationMilliseconds: number): void;
  recordOutboxPublishCycle(
    publishedEvents: number,
    durationMilliseconds: number,
    failed: boolean,
  ): void;
}

export function createWorkerMetricRecorder(): WorkerMetricRecorder {
  const meter = metrics.getMeter('@phub/worker');
  const outboxOldestAge = meter.createGauge(WORKER_METRIC_INSTRUMENTS.outboxOldestAgeSeconds);
  const outboxBackloggedTenants = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.outboxBackloggedTenants,
  );
  const outboxPublished = meter.createCounter(WORKER_METRIC_INSTRUMENTS.outboxPublishedEvents);
  const outboxPublishFailures = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.outboxPublishFailures,
  );
  const outboxPublishDuration = meter.createHistogram(
    WORKER_METRIC_INSTRUMENTS.outboxPublishCycleDurationMilliseconds,
  );
  const deadLetterReady = meter.createGauge(WORKER_METRIC_INSTRUMENTS.deadLetterMessagesReady);
  const collectionSuccess = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.operationalCollectionSuccess,
  );
  const collectionFailures = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.operationalCollectionFailures,
  );
  const collectionDuration = meter.createHistogram(
    WORKER_METRIC_INSTRUMENTS.operationalCollectionDurationMilliseconds,
  );

  return {
    recordOperationalSnapshot(snapshot, durationMilliseconds) {
      outboxOldestAge.record(snapshot.outboxOldestAgeSeconds);
      outboxBackloggedTenants.record(snapshot.outboxBackloggedTenants);
      deadLetterReady.record(snapshot.deadLetterMessagesReady);
      collectionSuccess.record(1);
      collectionDuration.record(durationMilliseconds);
    },
    recordOperationalCollectionFailure(durationMilliseconds) {
      collectionSuccess.record(0);
      collectionFailures.add(1);
      collectionDuration.record(durationMilliseconds);
    },
    recordOutboxPublishCycle(publishedEvents, durationMilliseconds, failed) {
      if (publishedEvents > 0) outboxPublished.add(publishedEvents);
      if (failed) outboxPublishFailures.add(1);
      outboxPublishDuration.record(durationMilliseconds);
    },
  };
}
