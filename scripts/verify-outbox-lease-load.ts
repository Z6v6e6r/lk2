import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createDatabasePool, withTenantTransaction } from '@phub/database';
import type { ConfirmChannel, Options } from 'amqplib';
import type { Logger } from 'pino';

import { publishLeasedOutboxBatch } from '../apps/worker/src/leased-outbox-publisher.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!databaseName.endsWith('_verify')) {
  throw new Error('Outbox lease load verification requires an isolated *_verify database');
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const eventCount = boundedInteger('OUTBOX_LOAD_EVENT_COUNT', 10_000, 1_000, 200_000);
const concurrency = boundedInteger('OUTBOX_LOAD_CONCURRENCY', 8, 1, 32);
const batchSize = boundedInteger('OUTBOX_LOAD_BATCH_SIZE', 100, 1, 500);
const maxDurationMs = boundedInteger('OUTBOX_LOAD_MAX_DURATION_MS', 30_000, 1_000, 300_000);
const pool = createDatabasePool(connectionString);
const tenantId = randomUUID();
const publishedMessageIds: string[] = [];
const logger = { error: () => undefined } as unknown as Logger;

function createSyntheticConfirmChannel(): ConfirmChannel {
  return {
    publish: (
      _exchange: string,
      _routingKey: string,
      _content: Buffer,
      options?: Options.Publish,
    ): boolean => {
      if (typeof options?.messageId !== 'string') {
        throw new Error('Synthetic confirm channel received an event without messageId');
      }
      publishedMessageIds.push(options.messageId);
      return true;
    },
    waitForConfirms: () => new Promise<void>((resolve) => setImmediate(resolve)),
  } as ConfirmChannel;
}

try {
  await pool.query(
    `insert into identity.tenants (id, tenant_key, display_name)
     values ($1, $2, 'Outbox lease load verification')`,
    [tenantId, `outbox-load-${tenantId.slice(0, 8)}`],
  );
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query(
      `insert into audit.outbox_events (
         tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
       )
       select $1, 'verification.outbox.load.v1', gen_random_uuid(),
              'outbox-load-' || source.ordinality,
              jsonb_build_object('sequence', source.ordinality),
              clock_timestamp() + source.ordinality * interval '1 microsecond'
         from generate_series(1, $2::integer) with ordinality source(value, ordinality)`,
      [tenantId, eventCount],
    );
  });

  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const channel = createSyntheticConfirmChannel();
      while (true) {
        const published = await publishLeasedOutboxBatch({
          pool,
          channel,
          logger,
          tenantId,
          batchSize,
          claimTtlMs: 60_000,
          confirmTimeoutMs: 10_000,
          failureBackoffMs: 5_000,
        });
        if (published === 0) return;
      }
    }),
  );
  const durationMs = performance.now() - startedAt;

  const databaseState = await withTenantTransaction(pool, tenantId, async (client) => {
    const result = await client.query<{
      total: number;
      published: number;
      active_claims: number;
      minimum_attempts: number;
      maximum_attempts: number;
    }>(
      `select count(*)::integer as total,
              count(*) filter (where published_at is not null)::integer as published,
              count(*) filter (where publish_claim_token is not null)::integer as active_claims,
              min(publish_attempts)::integer as minimum_attempts,
              max(publish_attempts)::integer as maximum_attempts
         from audit.outbox_events
        where tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0];
  });
  const uniquePublishedMessageIds = new Set(publishedMessageIds).size;

  if (
    !databaseState ||
    databaseState.total !== eventCount ||
    databaseState.published !== eventCount ||
    databaseState.active_claims !== 0 ||
    databaseState.minimum_attempts !== 1 ||
    databaseState.maximum_attempts !== 1 ||
    publishedMessageIds.length !== eventCount ||
    uniquePublishedMessageIds !== eventCount
  ) {
    throw new Error(
      `Outbox lease invariant failed: ${JSON.stringify({
        databaseState,
        brokerMessages: publishedMessageIds.length,
        uniqueBrokerMessages: uniquePublishedMessageIds,
      })}`,
    );
  }
  if (durationMs > maxDurationMs) {
    throw new Error(`Outbox lease load exceeded ${maxDurationMs}ms: ${Math.round(durationMs)}ms`);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'passed',
        eventCount,
        concurrency,
        batchSize,
        durationMs: Math.round(durationMs),
        eventsPerSecond: Math.round((eventCount * 1_000) / durationMs),
        databaseState,
        uniqueBrokerMessages: uniquePublishedMessageIds,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await withTenantTransaction(pool, tenantId, async (client) => {
    await client.query('delete from audit.outbox_events where tenant_id = $1', [tenantId]);
  }).catch(() => undefined);
  await pool.query('delete from identity.tenants where id = $1', [tenantId]).catch(() => undefined);
  await pool.end();
}
