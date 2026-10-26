import { withTenantTransaction } from '@phub/database';
import type {
  NotificationEndpointCipher,
  NotificationPushDeliveryPort,
  PushDeliveryResult,
} from '@phub/notifications';
import type { Pool } from 'pg';
import { checkScenarioPushDelivery, scenarioDeliveryDueSql } from './notification-scenarios.js';
import {
  deferNotificationDeliveryWithoutAttempt,
  finalizeNotificationDelivery,
} from './notification-delivery-finalizer.js';
import type { YandexSmtpAdapter } from './yandex-smtp-adapter.js';

interface Job {
  id: string;
  intent_id: string;
  endpoint_id: string;
  attempt_count: number;
  provider_account_id: string;
  address_ciphertext: Buffer;
  encryption_key_id: string;
  endpoint_status: string;
  recipient_user_id: string;
  rendered_title: string;
  rendered_body: string;
}
/** Only canonical scenario deliveries; providers never select tenant, endpoint or address. */
export async function runExtendedScenarioDelivery(input: {
  pool: Pool;
  tenantId: string;
  appId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  cipher: NotificationEndpointCipher;
  transport: 'APNS' | 'YANDEX_SMTP';
  adapter: NotificationPushDeliveryPort | Pick<YandexSmtpAdapter, 'send'>;
  enabled: boolean;
  gameReminderMaxSourceAgeMs?: number;
  credentialRef: string;
}): Promise<number> {
  if (!input.enabled) return 0;
  const email = input.transport === 'YANDEX_SMTP';
  const jobs = await withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      "select set_config('statement_timeout','15s',true),set_config('lock_timeout','5s',true)",
    );
    // A crash after the committed dispatch marker must never cause a second provider call.
    const unknown = await client.query<{ id: string; intent_id: string; attempt_count: number }>(
      `update notifications.deliveries d set state='DEAD',last_error_code=$2,completed_at=clock_timestamp(),lease_expires_at=null,updated_at=clock_timestamp() from notifications.intents i,integration.notification_endpoints e,integration.notification_provider_accounts a where d.tenant_id=$1 and i.tenant_id=d.tenant_id and i.id=d.intent_id and e.tenant_id=d.tenant_id and e.id=d.endpoint_id and a.tenant_id=e.tenant_id and a.id=e.provider_account_id and a.provider=$3 and a.credential_ref=$4 and a.app_id=$5 and a.environment=$6 and d.scenario_v2_available_at is not null and d.state='SENDING' and d.lease_expires_at<=clock_timestamp() and d.scenario_dispatch_started_at is not null returning d.id,d.intent_id,d.attempt_count`,
      [
        input.tenantId,
        email ? 'SMTP_OUTCOME_UNKNOWN' : 'APNS_OUTCOME_UNKNOWN',
        input.transport,
        input.credentialRef,
        input.appId,
        input.environment,
      ],
    );
    for (const lost of unknown.rows) {
      await client.query(
        `insert into notifications.delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,error_code,started_at,completed_at) select tenant_id,id,attempt_count,'TERMINAL_FAILURE',last_error_code,scenario_dispatch_started_at,clock_timestamp() from notifications.deliveries where tenant_id=$1 and id=$2 on conflict do nothing`,
        [input.tenantId, lost.id],
      );
      await client.query(
        `update notifications.intents set state=case when exists(select 1 from notifications.deliveries where tenant_id=$1 and intent_id=$2 and state in ('PENDING','SENDING')) then 'PROCESSING' when exists(select 1 from notifications.deliveries where tenant_id=$1 and intent_id=$2 and state in ('SENT','DELIVERED')) then 'PARTIAL' else 'FAILED' end,completed_at=case when exists(select 1 from notifications.deliveries where tenant_id=$1 and intent_id=$2 and state in ('PENDING','SENDING')) then null else clock_timestamp() end where tenant_id=$1 and id=$2`,
        [input.tenantId, lost.intent_id],
      );
      await client.query(
        `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,'notifications.delivery.changed.v1',$2,$3,$4::jsonb)`,
        [
          input.tenantId,
          lost.id,
          `scenario-recovery-${lost.id}`,
          JSON.stringify({
            deliveryId: lost.id,
            state: 'DEAD',
            errorCode: email ? 'SMTP_OUTCOME_UNKNOWN' : 'APNS_OUTCOME_UNKNOWN',
          }),
        ],
      );
    }
    const result = await client.query<Job>(
      `select d.id,d.intent_id,d.endpoint_id,d.attempt_count,e.provider_account_id,e.address_ciphertext,e.encryption_key_id,e.status endpoint_status,i.recipient_user_id,i.rendered_title,i.rendered_body
    from notifications.deliveries d join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
    join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id and e.channel=d.channel
    join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
    where d.tenant_id=$1 and d.channel=$4 and d.scenario_v2_available_at is not null and ${scenarioDeliveryDueSql(true)}
      and (d.state='PENDING' or (d.state='SENDING' and d.lease_expires_at<=clock_timestamp()))
      and e.user_id=i.recipient_user_id and e.status in ('ACTIVE','INVALID','REVOKED') and a.status='ACTIVE' and a.channel=d.channel
      and a.credential_ref=$7 and d.scenario_dispatch_started_at is null and a.provider=$5 and a.platform is not distinct from $6::text and a.app_id=$2 and a.environment=$3
      and ($4='EMAIL' or exists(select 1 from notifications.tenant_runtime_settings r where r.tenant_id=d.tenant_id and r.ios_push_enabled=true))
    order by d.scenario_v2_available_at,d.created_at for update of d skip locked limit 1`,
      [
        input.tenantId,
        input.appId,
        input.environment,
        email ? 'EMAIL' : 'PUSH',
        email ? 'YANDEX_SMTP' : 'APNS',
        email ? null : 'IOS',
        input.credentialRef,
      ],
    );
    for (const row of result.rows)
      await client.query(
        `update notifications.deliveries set state='SENDING',attempt_count=attempt_count+1,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=now() where tenant_id=$1 and id=$2`,
        [input.tenantId, row.id],
      );
    return result.rows;
  });
  for (const row of jobs) {
    const startedAt = new Date().toISOString();
    let address: string | undefined;
    let result: PushDeliveryResult | undefined;
    try {
      address = input.cipher.decrypt(row.address_ciphertext, row.encryption_key_id);
      const owned =
        !email ||
        (await withTenantTransaction(input.pool, input.tenantId, async (client) => {
          await client.query(
            "select set_config('statement_timeout','5s',true),set_config('lock_timeout','3s',true)",
          );
          return (
            (
              await client.query(
                `select 1 from identity.local_email_credentials where tenant_id=$1 and user_id=$2 and email_key=$3 and status='ACTIVE' and email_verified_at<=clock_timestamp()`,
                [input.tenantId, row.recipient_user_id, address],
              )
            ).rowCount === 1
          );
        }));
      if (row.endpoint_status !== 'ACTIVE' || !owned)
        result = {
          outcome: 'terminal_failure',
          errorCode: email ? 'SMTP_ADDRESS_NOT_VERIFIED' : 'APNS_TOKEN_INVALID',
          invalidate: true,
        };
    } catch {
      result = {
        outcome: 'terminal_failure',
        errorCode: 'NOTIFICATION_ADDRESS_UNAVAILABLE',
        invalidate: false,
      };
    }
    if (!result && address) {
      // All potentially slow preflight work precedes this final policy/lease/dispatch fence.
      const decision = await checkScenarioPushDelivery({
        pool: input.pool,
        tenantId: input.tenantId,
        deliveryId: row.id,
        attemptNo: row.attempt_count + 1,
        enabled: true,
        channel: email ? 'EMAIL' : 'PUSH',
        dispatchFence: true,
        ...(input.gameReminderMaxSourceAgeMs === undefined
          ? {}
          : { gameReminderMaxSourceAgeMs: input.gameReminderMaxSourceAgeMs }),
      });
      if (decision !== 'SEND') continue;
      try {
        result = email
          ? await (input.adapter as Pick<YandexSmtpAdapter, 'send'>).send({
              deliveryId: row.id,
              address,
              title: row.rendered_title,
              body: row.rendered_body,
            })
          : await (input.adapter as NotificationPushDeliveryPort).send({
              tenantId: input.tenantId,
              deliveryId: row.id,
              providerAccountId: row.provider_account_id,
              platform: 'IOS',
              endpoint: address,
              notification: {
                id: row.intent_id,
                title: 'ПадлхАБ',
                preview: 'Новое уведомление',
                deepLink: '/notifications',
              },
              providerIdempotencyKey: `apns:${row.id}`,
            });
      } catch {
        result = {
          outcome: 'terminal_failure',
          errorCode: email ? 'SMTP_OUTCOME_UNKNOWN' : 'APNS_OUTCOME_UNKNOWN',
          invalidate: false,
        };
      }
    }
    if (!result) throw new Error('SCENARIO_DELIVERY_RESULT_MISSING');
    const job = {
      tenantId: input.tenantId,
      deliveryId: row.id,
      intentId: row.intent_id,
      providerAccountId: row.provider_account_id,
      endpointId: row.endpoint_id,
      attemptNo: row.attempt_count + 1,
      startedAt,
      scenarioDelivery: true,
    };
    if (result.outcome === 'retryable_failure' && result.errorCode.endsWith('_CIRCUIT_OPEN'))
      await deferNotificationDeliveryWithoutAttempt({
        pool: input.pool,
        job,
        retryAfterMs: result.retryAfterMs ?? 30000,
        errorCode: result.errorCode,
      });
    else
      await finalizeNotificationDelivery({
        pool: input.pool,
        job,
        result,
        platform: email ? null : 'IOS',
        transport: input.transport,
        maxAttempts: 5,
        retryBaseMs: 5000,
      });
  }
  return jobs.length;
}
