import { fcmRolloutClaimAllowed } from './fcm-rollout-gate.js';
import { withTenantTransaction } from '@phub/database';
import type {
  NotificationEndpointCipher,
  NotificationPushDeliveryPort,
  PushDeliveryResult,
} from '@phub/notifications';
import type { Logger } from 'pino';
import type { Pool, QueryResultRow } from 'pg';

import {
  checkScenarioPushDelivery,
  scenarioDeliveryDueSql,
  terminalizeExpiredScenarioDispatches,
} from './notification-scenarios.js';

import {
  deferNotificationDeliveryWithoutAttempt,
  finalizeNotificationDelivery,
} from './notification-delivery-finalizer.js';

interface Row extends QueryResultRow {
  readonly id: string;
  readonly intent_id: string;
  readonly endpoint_id: string;
  readonly attempt_count: number;
  readonly scenario_delivery?: boolean;
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
  readonly scenarioPolicyEnabled?: boolean;
  readonly gameReminderMaxSourceAgeMs?: number;
  readonly batchSize?: number;
}): Promise<{ claimed: number; sent: number; retried: number; dead: number; stale: number }> {
  if (!fcmRolloutClaimAllowed()) {
    options.logger.info({ reason: 'ROLLOUT_GATE_HELD' }, 'FCM claim deferred');
    return { claimed: 0, sent: 0, retried: 0, dead: 0, stale: 0 };
  }
  const jobs = await withTenantTransaction(options.pool, options.tenantId, async (client) => {
    // The rollout fence and admin writers use this order. Never wait behind a
    // long rollout: leave the delivery and its attempt untouched for the next cycle.
    for (const [gate, key] of [
      ['runtime', `notification-runtime:${options.tenantId}`],
      [
        'provider',
        `android-push-provider:${options.tenantId}:${options.appId}:${options.environment}`,
      ],
    ]) {
      const lock = await client.query<{ acquired: boolean }>(
        'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) acquired',
        [key],
      );
      if (lock.rows[0]?.acquired !== true) {
        options.logger.info({ gate, reason: 'ROLLOUT_GATE_BUSY' }, 'FCM claim deferred');
        return [];
      }
    }
    if (options.scenarioPolicyEnabled === true)
      await terminalizeExpiredScenarioDispatches(client, {
        tenantId: options.tenantId,
        provider: 'FCM',
        platform: 'ANDROID',
        appId: options.appId,
        environment: options.environment,
      });
    const found = await client.query<Row>(
      `select d.id, d.intent_id, d.endpoint_id, d.attempt_count, a.id provider_account_id,
              ${options.scenarioPolicyEnabled ? 'coalesce(d.scenario_v2_available_at,d.scenario_available_at) is not null' : 'false'} scenario_delivery,
              e.status endpoint_status, e.address_ciphertext, e.encryption_key_id,
              coalesce(inbox.id, i.id) notification_id, i.rendered_deep_link deep_link
         from notifications.deliveries d join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
         join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id
         join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
         left join notifications.inbox_items inbox on inbox.tenant_id=i.tenant_id and inbox.intent_id=i.id
        where d.tenant_id=$1 and d.channel='PUSH' and ${scenarioDeliveryDueSql(options.scenarioPolicyEnabled)}
          and (d.state='PENDING' or (d.state='SENDING' and d.lease_expires_at<=now()))
          and a.channel='PUSH' and a.platform='ANDROID' and a.provider='FCM' and a.app_id=$2 and a.environment=$3 and a.status='ACTIVE'
          and e.status in ('ACTIVE','INVALID','REVOKED')
          and exists (select 1 from notifications.tenant_runtime_settings r where r.tenant_id=d.tenant_id and r.android_push_enabled=true)
        order by ${options.scenarioPolicyEnabled ? 'coalesce(d.scenario_v2_available_at,d.scenario_available_at,d.next_attempt_at)' : 'd.next_attempt_at'},d.created_at for update of d skip locked limit $4`,
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
    if (options.scenarioPolicyEnabled !== undefined) {
      const decision = await checkScenarioPushDelivery({
        pool: options.pool,
        tenantId: options.tenantId,
        deliveryId: row.id,
        attemptNo: row.attempt_count + 1,
        enabled: options.scenarioPolicyEnabled,
        dispatchFence: true,
        ...(options.gameReminderMaxSourceAgeMs === undefined
          ? {}
          : { gameReminderMaxSourceAgeMs: options.gameReminderMaxSourceAgeMs }),
      });
      if (decision !== 'SEND') {
        if (decision === 'DEFERRED') retried++;
        else if (decision === 'STALE') stale++;
        else dead++;
        continue;
      }
    }
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
                title: 'ПадлхАБ',
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
      ...(row.scenario_delivery ? { scenarioDelivery: true } : {}),
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
