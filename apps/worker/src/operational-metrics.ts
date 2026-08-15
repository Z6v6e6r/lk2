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
  pushDeliveriesDue: 'phub.worker.notifications.push_deliveries_due',
  pushDeliveryOldestDueAgeSeconds: 'phub.worker.notifications.push_delivery_oldest_due_age_seconds',
  pushDeliveriesDead: 'phub.worker.notifications.push_deliveries_dead',
  communityMemberCountBuilding: 'phub.worker.communities.member_count.building',
  communityMemberCountStale: 'phub.worker.communities.member_count.stale',
  communityMemberCountNotReadyAgeSeconds:
    'phub.worker.communities.member_count.not_ready_age_seconds',
  communityEventRetentionPurged: 'phub.worker.communities.events.retention_purged',
  communityEventRetentionClaimLost: 'phub.worker.communities.events.retention_claim_lost',
  communityEventRetentionFailures: 'phub.worker.communities.events.retention_failures',
  communityEventRetentionCycleDurationMilliseconds:
    'phub.worker.communities.events.retention_cycle_duration_milliseconds',
  communityMediaExpired: 'phub.worker.communities.media.expired',
  communityMediaScanned: 'phub.worker.communities.media.scanned',
  communityMediaRejected: 'phub.worker.communities.media.rejected',
  communityMediaScanRetried: 'phub.worker.communities.media.scan_retried',
  communityMediaScanFailed: 'phub.worker.communities.media.scan_failed',
  communityMediaGcCompleted: 'phub.worker.communities.media.gc_completed',
  communityMediaGcRetried: 'phub.worker.communities.media.gc_retried',
  communityMediaGcDead: 'phub.worker.communities.media.gc_dead',
  communityMediaScanBacklog: 'phub.worker.communities.media.scan_backlog',
  communityMediaScanOldestAgeSeconds: 'phub.worker.communities.media.scan_oldest_age_seconds',
  communityMediaFailedScans: 'phub.worker.communities.media.failed_scans',
  communityMediaGcBacklog: 'phub.worker.communities.media.gc_backlog',
  communityMediaGcOldestAgeSeconds: 'phub.worker.communities.media.gc_oldest_age_seconds',
  communityMediaDeadGcJobs: 'phub.worker.communities.media.dead_gc_jobs',
  communityMediaFailures: 'phub.worker.communities.media.failures',
  communityMediaCycleDurationMilliseconds:
    'phub.worker.communities.media.cycle_duration_milliseconds',
  operationalCollectionSuccess: 'phub.worker.operational.collection_success',
  operationalCollectionFailures: 'phub.worker.operational.collection_failures',
  operationalCollectionDurationMilliseconds:
    'phub.worker.operational.collection_duration_milliseconds',
} as const;

interface OutboxAgeRow extends QueryResultRow {
  readonly oldest_age_seconds: number | string;
}

interface PushDeliveryMetricRow extends QueryResultRow {
  readonly due_count: number | string;
  readonly oldest_due_age_seconds: number | string;
  readonly dead_count: number | string;
}

interface CommunityMemberCountRow extends QueryResultRow {
  readonly building_count: number | string;
  readonly stale_count: number | string;
  readonly not_ready_age_seconds: number | string;
}

interface CommunityMediaMetricRow extends QueryResultRow {
  readonly scan_backlog: number | string;
  readonly scan_oldest_age_seconds: number | string;
  readonly failed_scans: number | string;
  readonly gc_backlog: number | string;
  readonly gc_oldest_age_seconds: number | string;
  readonly dead_gc_jobs: number | string;
}

export interface WorkerOperationalSnapshot {
  readonly outboxOldestAgeSeconds: number;
  readonly outboxBackloggedTenants: number;
  readonly deadLetterMessagesReady: number;
  readonly pushDeliveriesDue: number;
  readonly pushDeliveryOldestDueAgeSeconds: number;
  readonly pushDeliveriesDead: number;
  readonly communityMemberCountBuilding: number;
  readonly communityMemberCountStale: number;
  readonly communityMemberCountNotReadyAgeSeconds: number;
  readonly communityMediaScanBacklog: number;
  readonly communityMediaScanOldestAgeSeconds: number;
  readonly communityMediaFailedScans: number;
  readonly communityMediaGcBacklog: number;
  readonly communityMediaGcOldestAgeSeconds: number;
  readonly communityMediaDeadGcJobs: number;
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
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${field} metric value`);
  return parsed;
}

export async function collectWorkerOperationalSnapshot(options: {
  readonly pool: Pool;
  readonly channel: Pick<Channel, 'checkQueue'>;
}): Promise<WorkerOperationalSnapshot> {
  const tenants = await options.pool.query<{ id: string }>(
    'select id from identity.tenants where active = true',
  );
  const tenantSnapshots = await mapWithConcurrency(
    tenants.rows,
    METRICS_TENANT_CONCURRENCY,
    async (tenant) =>
      withTenantTransaction(options.pool, tenant.id, async (client) => {
        const outbox = await client.query<OutboxAgeRow>(
          `select extract(epoch from (clock_timestamp() - occurred_at))::double precision
                    as oldest_age_seconds
             from audit.outbox_events
            where tenant_id = $1 and published_at is null
            order by occurred_at
            limit 1`,
          [tenant.id],
        );
        const deliveries = await client.query<PushDeliveryMetricRow>(
          `select count(*) filter (
                    where (state = 'PENDING' and next_attempt_at <= clock_timestamp())
                       or (state = 'SENDING' and lease_expires_at <= clock_timestamp())
                  )::bigint as due_count,
                  coalesce(max(
                    extract(epoch from (clock_timestamp() - created_at))
                  ) filter (
                    where (state = 'PENDING' and next_attempt_at <= clock_timestamp())
                       or (state = 'SENDING' and lease_expires_at <= clock_timestamp())
                  ), 0)::double precision as oldest_due_age_seconds,
                  count(*) filter (where state = 'DEAD')::bigint as dead_count
             from notifications.deliveries
            where tenant_id = $1 and channel = 'PUSH'`,
          [tenant.id],
        );
        const memberCount = await client.query<CommunityMemberCountRow>(
          `select
             count(*) filter (where state = 'BUILDING')::integer as building_count,
             count(*) filter (where state = 'STALE')::integer as stale_count,
             coalesce(max(extract(epoch from (clock_timestamp() - updated_at)))
               filter (where state <> 'READY'), 0)::double precision
               as not_ready_age_seconds
             from communities.member_count_projections
            where tenant_id = $1`,
          [tenant.id],
        );
        const media = await client.query<CommunityMediaMetricRow>(
          `select
             count(*) filter (
               where asset.state = 'SCANNING' and asset.scan_failed_at is null
             )::bigint as scan_backlog,
             coalesce(max(extract(epoch from (clock_timestamp() - asset.finalized_at))) filter (
               where asset.state = 'SCANNING' and asset.scan_failed_at is null
             ), 0)::double precision as scan_oldest_age_seconds,
             count(*) filter (where asset.scan_failed_at is not null)::bigint as failed_scans,
             (select count(*)::bigint from community_content.media_gc_jobs job
               where job.tenant_id = $1 and job.state <> 'DONE' and job.dead_at is null) as gc_backlog,
             (select coalesce(max(extract(epoch from (clock_timestamp() - job.created_at))), 0)
                ::double precision from community_content.media_gc_jobs job
               where job.tenant_id = $1 and job.state <> 'DONE' and job.dead_at is null)
               as gc_oldest_age_seconds,
             (select count(*)::bigint from community_content.media_gc_jobs job
               where job.tenant_id = $1 and job.dead_at is not null) as dead_gc_jobs
             from community_content.media_assets asset
            where asset.tenant_id = $1`,
          [tenant.id],
        );
        const outboxRow = outbox.rows[0];
        const deliveryRow = deliveries.rows[0];
        const projection = memberCount.rows[0];
        const mediaState = media.rows[0];
        return {
          outboxAge: outboxRow
            ? parseNonNegativeMetric(outboxRow.oldest_age_seconds, 'outbox oldest age')
            : 0,
          pushDue: deliveryRow
            ? parseNonNegativeMetric(deliveryRow.due_count, 'push deliveries due')
            : 0,
          pushOldestDueAge: deliveryRow
            ? parseNonNegativeMetric(
                deliveryRow.oldest_due_age_seconds,
                'push delivery oldest due age',
              )
            : 0,
          pushDead: deliveryRow
            ? parseNonNegativeMetric(deliveryRow.dead_count, 'push deliveries dead')
            : 0,
          building: projection
            ? parseNonNegativeMetric(projection.building_count, 'member count building')
            : 0,
          stale: projection
            ? parseNonNegativeMetric(projection.stale_count, 'member count stale')
            : 0,
          notReadyAge: projection
            ? parseNonNegativeMetric(projection.not_ready_age_seconds, 'member count not-ready age')
            : 0,
          mediaScanBacklog: mediaState
            ? parseNonNegativeMetric(mediaState.scan_backlog, 'community media scan backlog')
            : 0,
          mediaScanOldestAge: mediaState
            ? parseNonNegativeMetric(
                mediaState.scan_oldest_age_seconds,
                'community media scan oldest age',
              )
            : 0,
          mediaFailedScans: mediaState
            ? parseNonNegativeMetric(mediaState.failed_scans, 'community media failed scans')
            : 0,
          mediaGcBacklog: mediaState
            ? parseNonNegativeMetric(mediaState.gc_backlog, 'community media GC backlog')
            : 0,
          mediaGcOldestAge: mediaState
            ? parseNonNegativeMetric(
                mediaState.gc_oldest_age_seconds,
                'community media GC oldest age',
              )
            : 0,
          mediaDeadGcJobs: mediaState
            ? parseNonNegativeMetric(mediaState.dead_gc_jobs, 'community media dead GC jobs')
            : 0,
        };
      }),
  );
  const queue = await options.channel.checkQueue(DEAD_LETTER_QUEUE);
  return {
    outboxOldestAgeSeconds: Math.max(0, ...tenantSnapshots.map(({ outboxAge }) => outboxAge)),
    outboxBackloggedTenants: tenantSnapshots.filter(({ outboxAge }) => outboxAge > 0).length,
    deadLetterMessagesReady: queue.messageCount,
    pushDeliveriesDue: tenantSnapshots.reduce((sum, snapshot) => sum + snapshot.pushDue, 0),
    pushDeliveryOldestDueAgeSeconds: Math.max(
      0,
      ...tenantSnapshots.map(({ pushOldestDueAge }) => pushOldestDueAge),
    ),
    pushDeliveriesDead: tenantSnapshots.reduce((sum, snapshot) => sum + snapshot.pushDead, 0),
    communityMemberCountBuilding: tenantSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.building,
      0,
    ),
    communityMemberCountStale: tenantSnapshots.reduce((sum, snapshot) => sum + snapshot.stale, 0),
    communityMemberCountNotReadyAgeSeconds: Math.max(
      0,
      ...tenantSnapshots.map(({ notReadyAge }) => notReadyAge),
    ),
    communityMediaScanBacklog: tenantSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.mediaScanBacklog,
      0,
    ),
    communityMediaScanOldestAgeSeconds: Math.max(
      0,
      ...tenantSnapshots.map(({ mediaScanOldestAge }) => mediaScanOldestAge),
    ),
    communityMediaFailedScans: tenantSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.mediaFailedScans,
      0,
    ),
    communityMediaGcBacklog: tenantSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.mediaGcBacklog,
      0,
    ),
    communityMediaGcOldestAgeSeconds: Math.max(
      0,
      ...tenantSnapshots.map(({ mediaGcOldestAge }) => mediaGcOldestAge),
    ),
    communityMediaDeadGcJobs: tenantSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.mediaDeadGcJobs,
      0,
    ),
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
  recordCommunityEventRetentionCycle(
    purged: number,
    claimLost: number,
    failures: number,
    durationMilliseconds: number,
  ): void;
  recordCommunityMediaCycle(
    result: {
      readonly expired: number;
      readonly scanned: number;
      readonly rejected: number;
      readonly scanRetried: number;
      readonly scanFailed: number;
      readonly gcCompleted: number;
      readonly gcRetried: number;
      readonly gcDead: number;
    },
    failures: number,
    durationMilliseconds: number,
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
  const pushDeliveriesDue = meter.createGauge(WORKER_METRIC_INSTRUMENTS.pushDeliveriesDue);
  const pushDeliveryOldestDueAge = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.pushDeliveryOldestDueAgeSeconds,
  );
  const pushDeliveriesDead = meter.createGauge(WORKER_METRIC_INSTRUMENTS.pushDeliveriesDead);
  const communityMemberCountBuilding = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMemberCountBuilding,
  );
  const communityMemberCountStale = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMemberCountStale,
  );
  const communityMemberCountNotReadyAge = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMemberCountNotReadyAgeSeconds,
  );
  const communityEventRetentionPurged = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityEventRetentionPurged,
  );
  const communityEventRetentionClaimLost = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityEventRetentionClaimLost,
  );
  const communityEventRetentionFailures = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityEventRetentionFailures,
  );
  const communityEventRetentionDuration = meter.createHistogram(
    WORKER_METRIC_INSTRUMENTS.communityEventRetentionCycleDurationMilliseconds,
  );
  const communityMediaExpired = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaExpired,
  );
  const communityMediaScanned = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaScanned,
  );
  const communityMediaRejected = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaRejected,
  );
  const communityMediaScanRetried = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaScanRetried,
  );
  const communityMediaScanFailed = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaScanFailed,
  );
  const communityMediaGcCompleted = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaGcCompleted,
  );
  const communityMediaGcRetried = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaGcRetried,
  );
  const communityMediaGcDead = meter.createCounter(WORKER_METRIC_INSTRUMENTS.communityMediaGcDead);
  const communityMediaScanBacklog = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMediaScanBacklog,
  );
  const communityMediaScanOldestAge = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMediaScanOldestAgeSeconds,
  );
  const communityMediaFailedScans = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMediaFailedScans,
  );
  const communityMediaGcBacklog = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMediaGcBacklog,
  );
  const communityMediaGcOldestAge = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMediaGcOldestAgeSeconds,
  );
  const communityMediaDeadGcJobs = meter.createGauge(
    WORKER_METRIC_INSTRUMENTS.communityMediaDeadGcJobs,
  );
  const communityMediaFailures = meter.createCounter(
    WORKER_METRIC_INSTRUMENTS.communityMediaFailures,
  );
  const communityMediaDuration = meter.createHistogram(
    WORKER_METRIC_INSTRUMENTS.communityMediaCycleDurationMilliseconds,
  );
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
      pushDeliveriesDue.record(snapshot.pushDeliveriesDue);
      pushDeliveryOldestDueAge.record(snapshot.pushDeliveryOldestDueAgeSeconds);
      pushDeliveriesDead.record(snapshot.pushDeliveriesDead);
      communityMemberCountBuilding.record(snapshot.communityMemberCountBuilding);
      communityMemberCountStale.record(snapshot.communityMemberCountStale);
      communityMemberCountNotReadyAge.record(snapshot.communityMemberCountNotReadyAgeSeconds);
      communityMediaScanBacklog.record(snapshot.communityMediaScanBacklog);
      communityMediaScanOldestAge.record(snapshot.communityMediaScanOldestAgeSeconds);
      communityMediaFailedScans.record(snapshot.communityMediaFailedScans);
      communityMediaGcBacklog.record(snapshot.communityMediaGcBacklog);
      communityMediaGcOldestAge.record(snapshot.communityMediaGcOldestAgeSeconds);
      communityMediaDeadGcJobs.record(snapshot.communityMediaDeadGcJobs);
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
    recordCommunityEventRetentionCycle(purged, claimLost, failures, durationMilliseconds) {
      if (purged > 0) communityEventRetentionPurged.add(purged);
      if (claimLost > 0) communityEventRetentionClaimLost.add(claimLost);
      if (failures > 0) communityEventRetentionFailures.add(failures);
      communityEventRetentionDuration.record(durationMilliseconds);
    },
    recordCommunityMediaCycle(result, failures, durationMilliseconds) {
      if (result.expired > 0) communityMediaExpired.add(result.expired);
      if (result.scanned > 0) communityMediaScanned.add(result.scanned);
      if (result.rejected > 0) communityMediaRejected.add(result.rejected);
      if (result.scanRetried > 0) communityMediaScanRetried.add(result.scanRetried);
      if (result.scanFailed > 0) communityMediaScanFailed.add(result.scanFailed);
      if (result.gcCompleted > 0) communityMediaGcCompleted.add(result.gcCompleted);
      if (result.gcRetried > 0) communityMediaGcRetried.add(result.gcRetried);
      if (result.gcDead > 0) communityMediaGcDead.add(result.gcDead);
      if (failures > 0) communityMediaFailures.add(failures);
      communityMediaDuration.record(durationMilliseconds);
    },
  };
}
