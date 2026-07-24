import { randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import type { ConfirmChannel } from 'amqplib';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { publishOutboxRows, type OutboxRow } from './outbox-event-publisher.js';

export interface OutboxPublisherVerificationHooks {
  readonly afterClaim?: (claimedCount: number) => void | Promise<void>;
  readonly afterConfirm?: (confirmedCount: number) => void | Promise<void>;
}

export class OutboxClaimLostError extends Error {
  readonly code = 'OUTBOX_CLAIM_LOST_AFTER_CONFIRM';

  constructor(claimedCount: number, finalizedCount: number) {
    super(
      `Outbox claim changed after RabbitMQ confirm: claimed ${claimedCount}, finalized ${finalizedCount}`,
    );
    this.name = 'OutboxClaimLostError';
  }
}

async function claimOutboxRows(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly claimToken: string;
  readonly batchSize: number;
  readonly claimTtlMs: number;
}): Promise<readonly OutboxRow[]> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    const result = await client.query<OutboxRow>(
      `with candidates as (
         select id
           from audit.outbox_events
          where tenant_id = $1
            and published_at is null
            and (
              publish_claim_expires_at is null
              or publish_claim_expires_at <= clock_timestamp()
            )
          order by occurred_at, id
          for update skip locked
          limit $2
       )
       update audit.outbox_events as event
          set publish_claim_token = $3::uuid,
              publish_claim_expires_at =
                clock_timestamp() + ($4::integer * interval '1 millisecond'),
              publish_attempts = event.publish_attempts + 1
         from candidates
        where event.tenant_id = $1
          and event.id = candidates.id
       returning event.id, event.event_type, event.aggregate_id, event.tenant_id,
                 event.correlation_id, event.occurred_at, event.payload`,
      [options.tenantId, options.batchSize, options.claimToken, options.claimTtlMs],
    );
    return result.rows;
  });
}

async function finalizeClaim(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly claimToken: string;
  readonly eventIds: readonly string[];
}): Promise<number> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `update audit.outbox_events
          set published_at = clock_timestamp(),
              publish_claim_token = null,
              publish_claim_expires_at = null
        where tenant_id = $1
          and publish_claim_token = $2::uuid
          and id = any($3::uuid[])
          and published_at is null
       returning id`,
      [options.tenantId, options.claimToken, [...options.eventIds]],
    );
    return result.rowCount ?? 0;
  });
}

async function deferClaim(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly claimToken: string;
  readonly eventIds: readonly string[];
  readonly failureBackoffMs: number;
}): Promise<void> {
  await withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await client.query(
      `update audit.outbox_events
          set publish_claim_expires_at =
                clock_timestamp() + ($4::integer * interval '1 millisecond')
        where tenant_id = $1
          and publish_claim_token = $2::uuid
          and id = any($3::uuid[])
          and published_at is null`,
      [options.tenantId, options.claimToken, [...options.eventIds], options.failureBackoffMs],
    );
  });
}

export async function publishLeasedOutboxBatch(options: {
  readonly pool: Pool;
  readonly channel: ConfirmChannel;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly batchSize: number;
  readonly claimTtlMs: number;
  readonly confirmTimeoutMs: number;
  readonly failureBackoffMs: number;
  readonly claimTokenFactory?: () => string;
  readonly verificationHooks?: OutboxPublisherVerificationHooks;
}): Promise<number> {
  const claimToken = (options.claimTokenFactory ?? randomUUID)();
  const rows = await claimOutboxRows({
    pool: options.pool,
    tenantId: options.tenantId,
    claimToken,
    batchSize: options.batchSize,
    claimTtlMs: options.claimTtlMs,
  });
  if (rows.length === 0) return 0;
  await options.verificationHooks?.afterClaim?.(rows.length);

  const eventIds = rows.map((row) => row.id);
  try {
    await publishOutboxRows({
      channel: options.channel,
      rows,
      confirmTimeoutMs: options.confirmTimeoutMs,
    });
  } catch (error) {
    try {
      await deferClaim({
        pool: options.pool,
        tenantId: options.tenantId,
        claimToken,
        eventIds,
        failureBackoffMs: options.failureBackoffMs,
      });
    } catch (deferError) {
      options.logger.error(
        { error: deferError, tenantId: options.tenantId, count: rows.length },
        'leased outbox failure backoff could not be persisted',
      );
    }
    options.logger.error(
      { error, tenantId: options.tenantId, count: rows.length },
      'leased outbox publish failed',
    );
    throw error;
  }
  await options.verificationHooks?.afterConfirm?.(rows.length);

  let finalizedCount: number;
  try {
    finalizedCount = await finalizeClaim({
      pool: options.pool,
      tenantId: options.tenantId,
      claimToken,
      eventIds,
    });
  } catch (error) {
    options.logger.error(
      { error, tenantId: options.tenantId, count: rows.length },
      'leased outbox confirm could not be finalized',
    );
    throw error;
  }
  if (finalizedCount !== rows.length) {
    const error = new OutboxClaimLostError(rows.length, finalizedCount);
    options.logger.error(
      { error, tenantId: options.tenantId, claimedCount: rows.length, finalizedCount },
      'leased outbox claim lost after RabbitMQ confirm',
    );
    throw error;
  }

  return finalizedCount;
}
