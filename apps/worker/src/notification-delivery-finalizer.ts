import { createHash } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import type { NotificationPushPlatform, PushDeliveryResult } from '@phub/notifications';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface DeliveryStateRow extends QueryResultRow {
  readonly state: string;
}

export interface ClaimedNotificationDelivery {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly intentId: string;
  readonly providerAccountId: string;
  readonly endpointId: string;
  readonly attemptNo: number;
  readonly startedAt: string;
}

export type NotificationDeliveryFinalization = 'sent' | 'retry' | 'dead' | 'stale';

export function notificationRetryDelayMs(attemptNo: number, baseMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attemptNo - 1), 3_600_000);
}

export function resolveNotificationIntentState(states: readonly string[]): {
  readonly state: 'PROCESSING' | 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'SUPPRESSED';
  readonly completed: boolean;
} {
  if (states.some((state) => state === 'PENDING' || state === 'SENDING')) {
    return { state: 'PROCESSING', completed: false };
  }
  const successful = states.some((state) => state === 'SENT' || state === 'DELIVERED');
  const failed = states.some((state) => state === 'FAILED' || state === 'DEAD');
  const suppressed = states.some((state) => state === 'SUPPRESSED');
  if (successful && (failed || suppressed)) return { state: 'PARTIAL', completed: true };
  if (successful) return { state: 'DELIVERED', completed: true };
  if (suppressed && !failed) return { state: 'SUPPRESSED', completed: true };
  return { state: 'FAILED', completed: true };
}

async function updateIntentState(
  client: PoolClient,
  tenantId: string,
  intentId: string,
): Promise<void> {
  const states = await client.query<DeliveryStateRow>(
    `select state
       from notifications.deliveries
      where tenant_id = $1 and intent_id = $2`,
    [tenantId, intentId],
  );
  const resolved = resolveNotificationIntentState(states.rows.map((row) => row.state));
  await client.query(
    `update notifications.intents
        set state = $3,
            completed_at = case when $4 then coalesce(completed_at, now()) else null end
      where tenant_id = $1 and id = $2`,
    [tenantId, intentId, resolved.state, resolved.completed],
  );
}

function validateExternalMessageId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 500) {
    throw new Error('NOTIFICATION_PROVIDER_MESSAGE_ID_INVALID');
  }
  return normalized;
}

/**
 * Atomically fences a claimed delivery and records its attempt, receipt, provider link and outbox.
 * A worker that lost its lease returns `stale` and is not allowed to append any evidence.
 */
export async function finalizeNotificationDelivery(options: {
  readonly pool: Pool;
  readonly job: ClaimedNotificationDelivery;
  readonly result: PushDeliveryResult;
  readonly platform: NotificationPushPlatform;
  readonly transport: 'WEB_PUSH' | 'APNS' | 'FCM';
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
}): Promise<NotificationDeliveryFinalization> {
  return withTenantTransaction(options.pool, options.job.tenantId, async (client) => {
    const now = new Date().toISOString();
    let terminalState: Exclude<NotificationDeliveryFinalization, 'stale'>;
    let attemptOutcome: 'SENT' | 'RETRYABLE_FAILURE' | 'TERMINAL_FAILURE';
    let errorCode: string | null = null;
    let deliveryState: 'SENT' | 'PENDING' | 'DEAD';
    let updatedRows: number;

    if (options.result.outcome === 'accepted') {
      terminalState = 'sent';
      attemptOutcome = 'SENT';
      deliveryState = 'SENT';
      const updated = await client.query(
        `update notifications.deliveries
            set state = 'SENT', lease_expires_at = null, completed_at = now(),
                updated_at = now(), last_error_code = null
          where tenant_id = $1 and id = $2 and state = 'SENDING' and attempt_count = $3
            and lease_expires_at > now()`,
        [options.job.tenantId, options.job.deliveryId, options.job.attemptNo],
      );
      updatedRows = updated.rowCount ?? 0;
    } else {
      errorCode = options.result.errorCode;
      const exhausted = options.job.attemptNo >= options.maxAttempts;
      const retryable = options.result.outcome === 'retryable_failure' && !exhausted;
      terminalState = retryable ? 'retry' : 'dead';
      attemptOutcome = retryable ? 'RETRYABLE_FAILURE' : 'TERMINAL_FAILURE';
      deliveryState = retryable ? 'PENDING' : 'DEAD';
      if (retryable) {
        const delayMs = notificationRetryDelayMs(options.job.attemptNo, options.retryBaseMs);
        const updated = await client.query(
          `update notifications.deliveries
              set state = 'PENDING',
                  next_attempt_at = now() + ($4::integer * interval '1 millisecond'),
                  lease_expires_at = null,
                  updated_at = now(),
                  last_error_code = $5
            where tenant_id = $1 and id = $2 and state = 'SENDING' and attempt_count = $3
              and lease_expires_at > now()`,
          [options.job.tenantId, options.job.deliveryId, options.job.attemptNo, delayMs, errorCode],
        );
        updatedRows = updated.rowCount ?? 0;
      } else {
        const updated = await client.query(
          `update notifications.deliveries
              set state = 'DEAD', lease_expires_at = null, completed_at = now(),
                  updated_at = now(), last_error_code = $4
            where tenant_id = $1 and id = $2 and state = 'SENDING' and attempt_count = $3
              and lease_expires_at > now()`,
          [options.job.tenantId, options.job.deliveryId, options.job.attemptNo, errorCode],
        );
        updatedRows = updated.rowCount ?? 0;
      }
    }

    if (updatedRows !== 1) return 'stale';

    if (options.result.outcome === 'accepted') {
      if (options.result.externalMessageId) {
        const linked = await client.query(
          `insert into integration.notification_provider_links (
             tenant_id, delivery_id, provider_account_id, external_message_id
           ) values ($1, $2, $3, $4)
           on conflict (tenant_id, delivery_id) do update
             set external_message_id = integration.notification_provider_links.external_message_id
           where integration.notification_provider_links.provider_account_id = excluded.provider_account_id
             and integration.notification_provider_links.external_message_id = excluded.external_message_id
           returning delivery_id`,
          [
            options.job.tenantId,
            options.job.deliveryId,
            options.job.providerAccountId,
            validateExternalMessageId(options.result.externalMessageId),
          ],
        );
        if (linked.rowCount !== 1) {
          throw new Error('NOTIFICATION_PROVIDER_MESSAGE_LINK_CONFLICT');
        }
      }
      const receiptKey = createHash('sha256')
        .update(`${options.transport}:provider-accepted:${options.job.deliveryId}`)
        .digest('hex');
      await client.query(
        `insert into notifications.delivery_receipts (
           tenant_id, delivery_id, receipt_key, receipt_type, source, platform, occurred_at
         ) values ($1, $2, $3, 'PROVIDER_ACCEPTED', 'PROVIDER', $4, $5)
         on conflict (tenant_id, receipt_key) do nothing`,
        [options.job.tenantId, options.job.deliveryId, receiptKey, options.platform, now],
      );
    } else if (options.result.outcome === 'terminal_failure' && options.result.invalidate) {
      await client.query(
        `update integration.notification_endpoints
            set status = 'INVALID', updated_at = now()
          where tenant_id = $1 and id = $2`,
        [options.job.tenantId, options.job.endpointId],
      );
      await client.query(
        `insert into audit.audit_log (
           tenant_id, action, resource_type, resource_id, result, reason,
           correlation_id, new_value
         ) values ($1, $2, 'NOTIFICATION_ENDPOINT', $3,
                   'SUCCESS', $4, $5, $6::jsonb)`,
        [
          options.job.tenantId,
          `${options.transport}_ENDPOINT_INVALIDATED`,
          options.job.endpointId,
          errorCode,
          `${options.transport.toLowerCase()}-delivery-${options.job.deliveryId}`,
          JSON.stringify({ status: 'INVALID' }),
        ],
      );
    }

    await client.query(
      `insert into notifications.delivery_attempts (
         tenant_id, delivery_id, attempt_no, outcome, error_code, started_at, completed_at
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        options.job.tenantId,
        options.job.deliveryId,
        options.job.attemptNo,
        attemptOutcome,
        errorCode,
        options.job.startedAt,
        now,
      ],
    );
    await client.query(
      `insert into audit.outbox_events (
         tenant_id, event_type, aggregate_id, correlation_id, payload
       ) values ($1, 'notifications.delivery.changed.v1', $2, $3, $4::jsonb)`,
      [
        options.job.tenantId,
        options.job.deliveryId,
        `${options.transport.toLowerCase()}-delivery-${options.job.deliveryId}`,
        JSON.stringify({
          deliveryId: options.job.deliveryId,
          state: deliveryState,
          ...(errorCode ? { errorCode } : {}),
        }),
      ],
    );
    await updateIntentState(client, options.job.tenantId, options.job.intentId);
    return terminalState;
  });
}
