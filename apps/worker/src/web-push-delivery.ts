import { withTenantTransaction } from '@phub/database';
import {
  webPushSubscriptionSchema,
  type NotificationEndpointCipher,
  type NotificationPushDeliveryPort,
  type PushDeliveryResult,
} from '@phub/notifications';
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';

import {
  deferNotificationDeliveryWithoutAttempt,
  finalizeNotificationDelivery,
} from './notification-delivery-finalizer.js';

export {
  notificationRetryDelayMs as webPushRetryDelayMs,
  resolveNotificationIntentState,
} from './notification-delivery-finalizer.js';

interface DeliveryRow extends QueryResultRow {
  readonly id: string;
  readonly intent_id: string;
  readonly provider_account_id: string;
  readonly endpoint_id: string;
  readonly endpoint_status: 'ACTIVE' | 'INVALID' | 'REVOKED' | 'SUSPENDED_POLICY';
  readonly address_ciphertext: Buffer;
  readonly encryption_key_id: string;
  readonly notification_id: string;
  readonly rendered_title: string;
  readonly rendered_body: string;
  readonly category: string;
  readonly deep_link: string | null;
  readonly attempt_count: number;
}

interface ClaimedDelivery {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly intentId: string;
  readonly providerAccountId: string;
  readonly endpointId: string;
  readonly endpointStatus: 'ACTIVE' | 'INVALID' | 'REVOKED' | 'SUSPENDED_POLICY';
  readonly addressCiphertext: Buffer;
  readonly encryptionKeyId: string;
  readonly notificationId: string;
  readonly renderedTitle: string;
  readonly renderedBody: string;
  readonly category: string;
  readonly deepLink?: string;
  readonly attemptNo: number;
  readonly startedAt: string;
}

// Provider calls time out at no more than 30 seconds; the extra margin keeps finalization fenced.
export const WEB_PUSH_DELIVERY_LEASE_SECONDS = 60;

// Booking changes and game reminders are time-bound: send them as an urgent push with a longer TTL so
// a dozing phone still wakes up for them and a briefly offline one does not miss the change. Every
// other category keeps the transport default, because an urgent flag on informational messages only
// trains the operating system to deprioritize the app.
export const WEB_PUSH_URGENT_CATEGORIES = ['BOOKING', 'GAME'] as const;
export const WEB_PUSH_URGENT_TTL_SECONDS = 3_600;

export function webPushDeliveryHints(category: string): {
  readonly urgency: 'normal' | 'high';
  readonly ttlSeconds?: number;
} {
  return (WEB_PUSH_URGENT_CATEGORIES as readonly string[]).includes(category)
    ? { urgency: 'high', ttlSeconds: WEB_PUSH_URGENT_TTL_SECONDS }
    : { urgency: 'normal' };
}

// The rendered intent snapshot is already stored for the in-app inbox. A push payload may repeat a
// bounded part of it because the transport is encrypted end to end to the browser subscription.
// `web-push` rejects an aes128gcm payload above 3_993 bytes, and any rejection here would repeat as
// a retryable failure, so the payload is fitted before the provider call instead of failing late.
export const WEB_PUSH_PAYLOAD_MAX_BYTES = 3_500;
export const WEB_PUSH_TITLE_MAX_CHARACTERS = 300;
export const WEB_PUSH_PREVIEW_MAX_CHARACTERS = 300;

export interface WebPushNotificationPayload {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  readonly deepLink?: string;
  /**
   * Authorises the service worker to record a display or click receipt for this delivery without a
   * session. It is built per delivery in the adapter, because only the adapter knows the delivery id.
   */
  readonly receiptToken?: string;
}

function collapseNotificationText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function codePoints(value: string): readonly string[] {
  return [...value];
}

function dropTrailingCodePoints(value: string, count: number): string {
  const points = codePoints(value);
  return points.slice(0, Math.max(0, points.length - count)).join('');
}

function truncateCodePoints(value: string, maximum: number): string {
  return dropTrailingCodePoints(value, Math.max(0, codePoints(value).length - maximum));
}

/**
 * Builds the transport payload from the rendered intent snapshot. The notification id and the
 * internal deep link stay exact; the visible text is bounded and, when the deep link alone cannot
 * fit the transport budget, it is dropped so the service worker falls back to its own safe
 * `/notifications` route instead of navigating to a truncated address.
 */
export function buildWebPushNotification(input: {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink?: string | null;
  readonly receiptToken?: string;
}): WebPushNotificationPayload {
  const title = truncateCodePoints(
    collapseNotificationText(input.title),
    WEB_PUSH_TITLE_MAX_CHARACTERS,
  );
  const body = truncateCodePoints(
    collapseNotificationText(input.body),
    WEB_PUSH_PREVIEW_MAX_CHARACTERS,
  );
  const payload: WebPushNotificationPayload = {
    id: input.id,
    title,
    preview: body || title,
    ...(input.receiptToken ? { receiptToken: input.receiptToken } : {}),
  };
  if (!input.deepLink) return payload;
  const routed: WebPushNotificationPayload = { ...payload, deepLink: input.deepLink };
  // Bounded title and preview alone always fit; only the deep link can exceed the budget.
  return webPushPayloadBytes(routed) <= WEB_PUSH_PAYLOAD_MAX_BYTES ? routed : payload;
}

function webPushPayloadBytes(payload: WebPushNotificationPayload): number {
  // Mirrors the exact wire shape built by the Web Push adapter, including its key order.
  return Buffer.byteLength(
    JSON.stringify({
      notificationId: payload.id,
      title: payload.title,
      preview: payload.preview,
      ...(payload.deepLink ? { deepLink: payload.deepLink } : {}),
      ...(payload.receiptToken ? { receiptToken: payload.receiptToken } : {}),
    }),
    'utf8',
  );
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
              i.rendered_title, i.rendered_body,
              t.category,
              i.rendered_deep_link as deep_link
         from notifications.deliveries d
         join notifications.intents i
           on i.tenant_id = d.tenant_id and i.id = d.intent_id
         join notifications.templates t
           on t.tenant_id = i.tenant_id and t.id = i.template_id
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
          -- INVALID/REVOKED jobs are claimed only to terminalize retained delivery references
          -- without a provider call. SUSPENDED_POLICY remains pending for reversible review.
          and e.status in ('ACTIVE', 'INVALID', 'REVOKED')
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
                lease_expires_at = now() + interval '60 seconds',
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
        renderedTitle: row.rendered_title,
        renderedBody: row.rendered_body,
        category: row.category,
        ...(row.deep_link ? { deepLink: row.deep_link } : {}),
        attemptNo,
        startedAt: new Date().toISOString(),
      });
    }
    return claimed;
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
  readonly circuitOpenRetryMs?: number;
  readonly batchSize?: number;
}): Promise<{
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  readonly stale: number;
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
  let stale = 0;
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
          notification: buildWebPushNotification({
            id: job.notificationId,
            title: job.renderedTitle,
            body: job.renderedBody,
            deepLink: job.deepLink ?? null,
          }),
          ...webPushDeliveryHints(job.category),
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
    const outcome =
      result.outcome === 'retryable_failure' && result.errorCode === 'WEB_PUSH_CIRCUIT_OPEN'
        ? await deferNotificationDeliveryWithoutAttempt({
            pool: options.pool,
            job,
            retryAfterMs: options.circuitOpenRetryMs ?? 30_000,
            errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
          })
        : await finalizeNotificationDelivery({
            pool: options.pool,
            job,
            result,
            platform: 'WEB',
            transport: 'WEB_PUSH',
            maxAttempts: options.maxAttempts,
            retryBaseMs: options.retryBaseMs,
          });
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'retry') retried += 1;
    else if (outcome === 'dead') dead += 1;
    else stale += 1;
  }
  if (jobs.length > 0) {
    options.logger.info(
      { tenantId: options.tenantId, claimed: jobs.length, sent, retried, dead, stale },
      'Web Push delivery batch completed',
    );
  }
  return { claimed: jobs.length, sent, retried, dead, stale };
}
