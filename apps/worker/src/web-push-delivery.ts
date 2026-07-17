import { createHash } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import {
  webPushSubscriptionSchema,
  type NotificationEndpointCipher,
  type NotificationPushDeliveryPort,
  type PushDeliveryResult,
} from '@phub/notifications';
import type { Logger } from 'pino';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface DeliveryRow extends QueryResultRow {
  readonly id: string;
  readonly intent_id: string;
  readonly provider_account_id: string;
  readonly endpoint_id: string;
  readonly endpoint_status: 'ACTIVE' | 'INVALID' | 'REVOKED';
  readonly address_ciphertext: Buffer;
  readonly encryption_key_id: string;
  readonly notification_id: string;
  readonly deep_link: string | null;
  readonly attempt_count: number;
}

interface DeliveryStateRow extends QueryResultRow {
  readonly state: string;
}

interface ClaimedDelivery {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly intentId: string;
  readonly providerAccountId: string;
  readonly endpointId: string;
  readonly endpointStatus: 'ACTIVE' | 'INVALID' | 'REVOKED';
  readonly addressCiphertext: Buffer;
  readonly encryptionKeyId: string;
  readonly notificationId: string;
  readonly deepLink?: string;
  readonly attemptNo: number;
  readonly startedAt: string;
}

export function webPushRetryDelayMs(attemptNo: number, baseMs: number): number {
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

async function claimBatch(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly appId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly batchSize: number;
}): Promise<readonly ClaimedDelivery[]> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    const result = await client.query<DeliveryRow>(
      `select d.id, d.intent_id, d.endpoint_id, d.attempt_count,
              a.id as provider_account_id,
              e.status as endpoint_status, e.address_ciphertext, e.encryption_key_id,
              coalesce(inbox.id, i.id) as notification_id,
              i.rendered_deep_link as deep_link
         from notifications.deliveries d
         join notifications.intents i
           on i.tenant_id = d.tenant_id and i.id = d.intent_id
         join integration.notification_endpoints e
           on e.tenant_id = d.tenant_id and e.id = d.endpoint_id
         join integration.notification_provider_accounts a
           on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
         left join notifications.inbox_items inbox
           on inbox.tenant_id = i.tenant_id and inbox.intent_id = i.id
        where d.tenant_id = $1
          and d.channel = 'PUSH'
          and d.next_attempt_at <= now()
          and (d.state = 'PENDING' or (d.state = 'SENDING' and d.lease_expires_at <= now()))
          and a.channel = 'PUSH'
          and a.platform = 'WEB'
          and a.provider = 'WEB_PUSH'
          and a.app_id = $2
          and a.environment = $3
          and a.status = 'ACTIVE'
          and exists (
            select 1
              from notifications.tenant_runtime_settings runtime
             where runtime.tenant_id = d.tenant_id and runtime.web_push_enabled = true
          )
        order by d.next_attempt_at, d.created_at
        for update of d skip locked
        limit $4`,
      [options.tenantId, options.appId, options.environment, options.batchSize],
    );
    const claimed: ClaimedDelivery[] = [];
    for (const row of result.rows) {
      const attemptNo = row.attempt_count + 1;
      await client.query(
        `update notifications.deliveries
            set state = 'SENDING',
                attempt_count = $3,
                lease_expires_at = now() + interval '30 seconds',
                updated_at = now()
          where tenant_id = $1 and id = $2`,
        [options.tenantId, row.id, attemptNo],
      );
      claimed.push({
        tenantId: options.tenantId,
        deliveryId: row.id,
        intentId: row.intent_id,
        providerAccountId: row.provider_account_id,
        endpointId: row.endpoint_id,
        endpointStatus: row.endpoint_status,
        addressCiphertext: row.address_ciphertext,
        encryptionKeyId: row.encryption_key_id,
        notificationId: row.notification_id,
        ...(row.deep_link ? { deepLink: row.deep_link } : {}),
        attemptNo,
        startedAt: new Date().toISOString(),
      });
    }
    return claimed;
  });
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

async function finalizeDelivery(options: {
  readonly pool: Pool;
  readonly job: ClaimedDelivery;
  readonly result: PushDeliveryResult;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
}): Promise<'sent' | 'retry' | 'dead'> {
  return withTenantTransaction(options.pool, options.job.tenantId, async (client) => {
    const now = new Date().toISOString();
    let terminalState: 'sent' | 'retry' | 'dead';
    let attemptOutcome: 'SENT' | 'RETRYABLE_FAILURE' | 'TERMINAL_FAILURE';
    let errorCode: string | null = null;

    if (options.result.outcome === 'accepted') {
      terminalState = 'sent';
      attemptOutcome = 'SENT';
      await client.query(
        `update notifications.deliveries
            set state = 'SENT', lease_expires_at = null, completed_at = now(),
                updated_at = now(), last_error_code = null
          where tenant_id = $1 and id = $2 and state = 'SENDING' and attempt_count = $3`,
        [options.job.tenantId, options.job.deliveryId, options.job.attemptNo],
      );
      const receiptKey = createHash('sha256')
        .update(`provider-accepted:${options.job.deliveryId}:${options.job.attemptNo}`)
        .digest('hex');
      await client.query(
        `insert into notifications.delivery_receipts (
           tenant_id, delivery_id, receipt_key, receipt_type, source, platform, occurred_at
         ) values ($1, $2, $3, 'PROVIDER_ACCEPTED', 'PROVIDER', 'WEB', $4)
         on conflict (tenant_id, receipt_key) do nothing`,
        [options.job.tenantId, options.job.deliveryId, receiptKey, now],
      );
    } else {
      errorCode = options.result.errorCode;
      const exhausted = options.job.attemptNo >= options.maxAttempts;
      const retryable = options.result.outcome === 'retryable_failure' && !exhausted;
      terminalState = retryable ? 'retry' : 'dead';
      attemptOutcome = retryable ? 'RETRYABLE_FAILURE' : 'TERMINAL_FAILURE';
      if (retryable) {
        const delayMs = webPushRetryDelayMs(options.job.attemptNo, options.retryBaseMs);
        await client.query(
          `update notifications.deliveries
              set state = 'PENDING',
                  next_attempt_at = now() + ($4::integer * interval '1 millisecond'),
                  lease_expires_at = null,
                  updated_at = now(),
                  last_error_code = $5
            where tenant_id = $1 and id = $2 and state = 'SENDING' and attempt_count = $3`,
          [options.job.tenantId, options.job.deliveryId, options.job.attemptNo, delayMs, errorCode],
        );
      } else {
        await client.query(
          `update notifications.deliveries
              set state = 'DEAD', lease_expires_at = null, completed_at = now(),
                  updated_at = now(), last_error_code = $4
            where tenant_id = $1 and id = $2 and state = 'SENDING' and attempt_count = $3`,
          [options.job.tenantId, options.job.deliveryId, options.job.attemptNo, errorCode],
        );
      }
      if (options.result.outcome === 'terminal_failure' && options.result.invalidate) {
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
           ) values ($1, 'WEB_PUSH_ENDPOINT_INVALIDATED', 'NOTIFICATION_ENDPOINT', $2,
                     'SUCCESS', $3, $4, $5::jsonb)`,
          [
            options.job.tenantId,
            options.job.endpointId,
            errorCode,
            `web-push-delivery-${options.job.deliveryId}`,
            JSON.stringify({ status: 'INVALID' }),
          ],
        );
      }
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
        `web-push-delivery-${options.job.deliveryId}`,
        JSON.stringify({
          deliveryId: options.job.deliveryId,
          state: terminalState === 'sent' ? 'SENT' : terminalState === 'retry' ? 'PENDING' : 'DEAD',
          ...(errorCode ? { errorCode } : {}),
        }),
      ],
    );
    await updateIntentState(client, options.job.tenantId, options.job.intentId);
    return terminalState;
  });
}

export async function runWebPushDeliveryBatch(options: {
  readonly pool: Pool;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly appId: string;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
  readonly cipher: NotificationEndpointCipher;
  readonly adapter: NotificationPushDeliveryPort;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly batchSize?: number;
}): Promise<{
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
}> {
  const jobs = await claimBatch({
    pool: options.pool,
    tenantId: options.tenantId,
    appId: options.appId,
    environment: options.environment,
    batchSize: options.batchSize ?? 20,
  });
  let sent = 0;
  let retried = 0;
  let dead = 0;
  for (const job of jobs) {
    let result: PushDeliveryResult;
    if (job.endpointStatus !== 'ACTIVE') {
      result = {
        outcome: 'terminal_failure',
        errorCode: 'WEB_PUSH_ENDPOINT_INACTIVE',
        invalidate: false,
      };
    } else {
      try {
        const plaintext = options.cipher.decrypt(job.addressCiphertext, job.encryptionKeyId);
        const subscription = webPushSubscriptionSchema.parse(JSON.parse(plaintext) as unknown);
        result = await options.adapter.send({
          tenantId: job.tenantId,
          deliveryId: job.deliveryId,
          providerAccountId: job.providerAccountId,
          platform: 'WEB',
          endpoint: JSON.stringify(subscription),
          notification: {
            id: job.notificationId,
            title: 'ПаделХАБ',
            preview: 'Новое оповещение',
            ...(job.deepLink ? { deepLink: job.deepLink } : {}),
          },
          providerIdempotencyKey: `web-push:${job.deliveryId}`,
        });
      } catch {
        result = {
          outcome: 'terminal_failure',
          errorCode: 'WEB_PUSH_ENDPOINT_DECRYPT_FAILED',
          invalidate: false,
        };
      }
    }
    const outcome = await finalizeDelivery({
      pool: options.pool,
      job,
      result,
      maxAttempts: options.maxAttempts,
      retryBaseMs: options.retryBaseMs,
    });
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'retry') retried += 1;
    else dead += 1;
  }
  if (jobs.length > 0) {
    options.logger.info(
      { tenantId: options.tenantId, claimed: jobs.length, sent, retried, dead },
      'Web Push delivery batch completed',
    );
  }
  return { claimed: jobs.length, sent, retried, dead };
}
