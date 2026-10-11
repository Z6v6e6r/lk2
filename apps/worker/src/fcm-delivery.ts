import { withTenantTransaction } from '@phub/database';
import type {
  NotificationEndpointCipher,
  NotificationPushDeliveryPort,
  PushDeliveryResult,
} from '@phub/notifications';
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';

import {
  deferNotificationDeliveryWithoutAttempt,
  finalizeNotificationDelivery,
} from './notification-delivery-finalizer.js';

interface Row extends QueryResultRow {
  readonly id: string;
  readonly intent_id: string;
  readonly endpoint_id: string;
  readonly attempt_count: number;
  readonly provider_account_id: string;
  readonly endpoint_status: 'ACTIVE' | 'INVALID' | 'REVOKED';
  readonly address_ciphertext: Buffer;
  readonly encryption_key_id: string;
  readonly notification_id: string;
  readonly deep_link: string | null;
}

export function buildFcmData(input: {
  endpointId: string;
  deliveryId: string;
  notificationId: string;
  deepLink?: string | null;
}): Readonly<Record<string, string>> {
  return {
    endpointId: input.endpointId,
    deliveryId: input.deliveryId,
    notificationId: input.notificationId,
    ...(input.deepLink
      ? {
          deepLink:
            /^\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
              input.deepLink,
            )
              ? input.deepLink
              : '/notifications',
        }
      : {}),
  };
}

export async function runFcmDeliveryBatch(options: {
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
}): Promise<{ claimed: number; sent: number; retried: number; dead: number; stale: number }> {
  const jobs = await withTenantTransaction(options.pool, options.tenantId, async (client) => {
    const found = await client.query<Row>(
      `select d.id, d.intent_id, d.endpoint_id, d.attempt_count, a.id provider_account_id,
              e.status endpoint_status, e.address_ciphertext, e.encryption_key_id,
              coalesce(inbox.id, i.id) notification_id, i.rendered_deep_link deep_link
         from notifications.deliveries d join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
         join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id
         join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
         left join notifications.inbox_items inbox on inbox.tenant_id=i.tenant_id and inbox.intent_id=i.id
        where d.tenant_id=$1 and d.channel='PUSH' and d.next_attempt_at<=now()
          and (d.state='PENDING' or (d.state='SENDING' and d.lease_expires_at<=now()))
          and a.channel='PUSH' and a.platform='ANDROID' and a.provider='FCM' and a.app_id=$2 and a.environment=$3 and a.status='ACTIVE'
          and e.status in ('ACTIVE','INVALID','REVOKED')
          and exists (select 1 from notifications.tenant_runtime_settings r where r.tenant_id=d.tenant_id and r.android_push_enabled=true)
        order by d.next_attempt_at,d.created_at for update of d skip locked limit $4`,
      // One provider call per lease: queued jobs must not expire before their serial send starts.
      [options.tenantId, options.appId, options.environment, 1],
    );
    for (const row of found.rows)
      await client.query(
        `update notifications.deliveries set state='SENDING',attempt_count=$3,lease_expires_at=now()+interval '60 seconds',updated_at=now() where tenant_id=$1 and id=$2`,
        [options.tenantId, row.id, row.attempt_count + 1],
      );
    return found.rows;
  });
  let sent = 0;
  let retried = 0;
  let dead = 0;
  let stale = 0;
  for (const row of jobs) {
    const startedAt = new Date().toISOString();
    let result: PushDeliveryResult;
    try {
      result =
        row.endpoint_status === 'ACTIVE'
          ? await options.adapter.send({
              tenantId: options.tenantId,
              deliveryId: row.id,
              providerAccountId: row.provider_account_id,
              platform: 'ANDROID',
              endpoint: options.cipher.decrypt(row.address_ciphertext, row.encryption_key_id),
              notification: {
                id: row.notification_id,
                title: 'ПадлХАБ',
                preview: 'Новое уведомление',
                ...(row.deep_link ? { deepLink: row.deep_link } : {}),
              },
              data: buildFcmData({
                endpointId: row.endpoint_id,
                deliveryId: row.id,
                notificationId: row.notification_id,
                deepLink: row.deep_link,
              }),
              providerIdempotencyKey: `fcm:${row.id}`,
            })
          : { outcome: 'terminal_failure', errorCode: 'FCM_ENDPOINT_INACTIVE', invalidate: false };
    } catch {
      result = { outcome: 'retryable_failure', errorCode: 'FCM_DELIVERY_FAILURE' };
    }
    const job = {
      tenantId: options.tenantId,
      deliveryId: row.id,
      intentId: row.intent_id,
      providerAccountId: row.provider_account_id,
      endpointId: row.endpoint_id,
      attemptNo: row.attempt_count + 1,
      startedAt,
    };
    const outcome =
      result.outcome === 'retryable_failure' && result.errorCode === 'FCM_CIRCUIT_OPEN'
        ? await deferNotificationDeliveryWithoutAttempt({
            pool: options.pool,
            job,
            retryAfterMs: result.retryAfterMs ?? 30_000,
            errorCode: 'FCM_CIRCUIT_OPEN',
          })
        : await finalizeNotificationDelivery({
            pool: options.pool,
            job,
            result,
            platform: 'ANDROID',
            transport: 'FCM',
            maxAttempts: options.maxAttempts,
            retryBaseMs: options.retryBaseMs,
          });
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'retry') retried += 1;
    else if (outcome === 'dead') dead += 1;
    else stale += 1;
  }
  if (jobs.length)
    options.logger.info(
      { tenantId: options.tenantId, claimed: jobs.length, sent, retried, dead, stale },
      'FCM delivery batch completed',
    );
  return { claimed: jobs.length, sent, retried, dead, stale };
}
