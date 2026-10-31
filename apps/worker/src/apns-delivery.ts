import { withTenantTransaction } from '@phub/database';
import {
  quietHoursActive,
  type NotificationEndpointCipher,
  type NotificationPushDeliveryPort,
  type PushDeliveryResult,
} from '@phub/notifications';
import type { Pool, PoolClient } from 'pg';

import {
  deferNotificationDeliveryWithoutAttempt,
  finalizeNotificationDelivery,
  resolveNotificationIntentState,
  type ClaimedNotificationDelivery,
} from './notification-delivery-finalizer.js';

interface Claim {
  id: string;
  intent_id: string;
  endpoint_id: string;
  provider_account_id: string;
  attempt_count: number;
}
interface DispatchRow {
  provider_account_id: string;
  recipient_user_id: string;
  endpoint_user_id: string;
  endpoint_status: string;
  endpoint_channel: string;
  address_ciphertext: Buffer;
  encryption_key_id: string;
  provider: string;
  platform: string;
  provider_channel: string;
  app_id: string;
  environment: string;
  credential_ref: string;
  provider_status: string;
  user_status: string;
  ios_push_enabled: boolean;
  rule_active: boolean;
  template_active: boolean;
  mandatory: boolean;
  preference_enabled: boolean | null;
  quiet_from: string | null;
  quiet_until: string | null;
  timezone: string | null;
  database_now: Date;
}
interface Options {
  pool: Pool;
  tenantId: string;
  appId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  credentialRef: string;
  cipher: NotificationEndpointCipher;
  adapter: NotificationPushDeliveryPort;
  enabled: boolean;
}

async function updateIntent(client: PoolClient, tenantId: string, intentId: string): Promise<void> {
  // Match the common finalizer's delivery -> intent ordering across transports.
  await client.query(
    'select id from notifications.intents where tenant_id=$1 and id=$2 for update',
    [tenantId, intentId],
  );
  const states = await client.query<{ state: string }>(
    'select state from notifications.deliveries where tenant_id=$1 and intent_id=$2',
    [tenantId, intentId],
  );
  const resolved = resolveNotificationIntentState(states.rows.map((row) => row.state));
  await client.query(
    `update notifications.intents set state=$3,completed_at=case when $4 then coalesce(completed_at,now()) else null end where tenant_id=$1 and id=$2`,
    [tenantId, intentId, resolved.state, resolved.completed],
  );
}

async function changed(
  client: PoolClient,
  tenantId: string,
  job: Claim,
  state: string,
  errorCode: string,
): Promise<void> {
  await updateIntent(client, tenantId, job.intent_id);
  await client.query(
    `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,'notifications.delivery.changed.v1',$2,$3,$4::jsonb)`,
    [tenantId, job.id, `apns-${job.id}`, JSON.stringify({ deliveryId: job.id, state, errorCode })],
  );
}

/** One ordinary delivery per call keeps tenant scheduling fair and the lease bounded. */
async function claim(options: Options): Promise<Claim | undefined> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await client.query(
      "select set_config('statement_timeout','15s',true),set_config('lock_timeout','5s',true)",
    );
    // APNs does not guarantee deduplication by apns-id. A committed dispatch with a lost result
    // is terminal UNKNOWN, including a process crash before the socket write. Never auto-resend it.
    const expired = await client.query<Claim>(
      `select d.id,d.intent_id,d.endpoint_id,d.attempt_count,e.provider_account_id
       from notifications.deliveries d
       join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
       join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id
       join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
       where d.tenant_id=$1 and d.channel='PUSH' and a.provider='APNS' and a.platform='IOS'
         and a.app_id=$2 and a.environment=$3 and a.credential_ref=$4
         and d.scenario_available_at is null and d.scenario_v2_available_at is null
         and i.trigger_rule_id is not null and i.render_data->>'scenarioRunId' is null
         and d.state='SENDING' and d.lease_expires_at<=clock_timestamp()
         and d.scenario_dispatch_started_at is not null
       order by d.lease_expires_at,d.id for update of d skip locked limit 20`,
      [options.tenantId, options.appId, options.environment, options.credentialRef],
    );
    for (const lost of expired.rows) {
      await client.query(
        `update notifications.deliveries set state='DEAD',last_error_code='APNS_OUTCOME_UNKNOWN',completed_at=clock_timestamp(),lease_expires_at=null,updated_at=clock_timestamp() where tenant_id=$1 and id=$2`,
        [options.tenantId, lost.id],
      );
      await client.query(
        `insert into notifications.delivery_attempts(tenant_id,delivery_id,attempt_no,outcome,error_code,started_at,completed_at)
         select tenant_id,id,attempt_count,'TERMINAL_FAILURE','APNS_OUTCOME_UNKNOWN',scenario_dispatch_started_at,clock_timestamp()
         from notifications.deliveries where tenant_id=$1 and id=$2 on conflict do nothing`,
        [options.tenantId, lost.id],
      );
      await changed(client, options.tenantId, lost, 'DEAD', 'APNS_OUTCOME_UNKNOWN');
    }
    const rows = await client.query<Claim>(
      `select d.id,d.intent_id,d.endpoint_id,d.attempt_count,e.provider_account_id
       from notifications.deliveries d
       join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
       join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id and e.channel=d.channel
       join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
       where d.tenant_id=$1 and d.channel='PUSH'
         and d.scenario_available_at is null and d.scenario_v2_available_at is null
         and i.trigger_rule_id is not null and i.render_data->>'scenarioRunId' is null
         and d.scenario_dispatch_started_at is null and d.next_attempt_at<=clock_timestamp()
         and (d.state='PENDING' or (d.state='SENDING' and d.lease_expires_at<=clock_timestamp()))
         and a.provider='APNS' and a.platform='IOS' and a.channel='PUSH'
         and a.app_id=$2 and a.environment=$3 and a.credential_ref=$4 and a.status='ACTIVE'
         and exists(select 1 from notifications.tenant_runtime_settings r where r.tenant_id=d.tenant_id and r.ios_push_enabled=true)
       order by d.next_attempt_at,d.created_at for update of d skip locked limit 1`,
      [options.tenantId, options.appId, options.environment, options.credentialRef],
    );
    const row = rows.rows[0];
    if (row)
      await client.query(
        `update notifications.deliveries set state='SENDING',attempt_count=attempt_count+1,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where tenant_id=$1 and id=$2`,
        [options.tenantId, row.id],
      );
    return row;
  });
}

async function fence(
  options: Options,
  job: Claim,
): Promise<
  | { address: string; endpoint: NonNullable<ClaimedNotificationDelivery['dispatchedEndpoint']> }
  | { result: PushDeliveryResult }
  | undefined
> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await client.query(
      "select set_config('statement_timeout','5s',true),set_config('lock_timeout','3s',true)",
    );
    // Read the current address, ownership and preference after claim, never a cached token.
    // Lock the endpoint with the delivery to order this dispatch against token rotation/revocation.
    const result = await client.query<DispatchRow>(
      `select e.provider_account_id,i.recipient_user_id,e.user_id endpoint_user_id,e.status endpoint_status,
         e.channel endpoint_channel,e.address_ciphertext,e.encryption_key_id,
         a.provider,a.platform,a.channel provider_channel,a.app_id,a.environment,a.credential_ref,a.status provider_status,
         u.status user_status,r.ios_push_enabled,tr.active rule_active,t.active template_active,tr.mandatory,
         p.enabled preference_enabled,left(p.quiet_from::text,5) quiet_from,left(p.quiet_until::text,5) quiet_until,p.timezone,
         clock_timestamp() database_now
       from notifications.deliveries d
       join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
       join notifications.templates t on t.tenant_id=i.tenant_id and t.id=i.template_id
       join notifications.trigger_rules tr on tr.tenant_id=i.tenant_id and tr.id=i.trigger_rule_id
       join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id
       join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
       join identity.users u on u.tenant_id=i.tenant_id and u.id=i.recipient_user_id
       left join notifications.tenant_runtime_settings r on r.tenant_id=d.tenant_id
       left join notifications.user_preferences p on p.tenant_id=i.tenant_id and p.user_id=i.recipient_user_id and p.category=t.category and p.channel='PUSH'
       where d.tenant_id=$1 and d.id=$2 and d.state='SENDING' and d.attempt_count=$3
         and d.lease_expires_at>clock_timestamp() and d.channel='PUSH'
         and d.scenario_available_at is null and d.scenario_v2_available_at is null
         and i.trigger_rule_id is not null and i.render_data->>'scenarioRunId' is null
         and d.scenario_dispatch_started_at is null and i.render_data->>'scenarioRunId' is null
       for update of d,e`,
      [options.tenantId, job.id, job.attempt_count + 1],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    let reason =
      row.provider_account_id !== job.provider_account_id ||
      row.endpoint_user_id !== row.recipient_user_id ||
      row.endpoint_status !== 'ACTIVE' ||
      row.endpoint_channel !== 'PUSH' ||
      row.provider !== 'APNS' ||
      row.platform !== 'IOS' ||
      row.provider_channel !== 'PUSH' ||
      row.app_id !== options.appId ||
      row.environment !== options.environment ||
      row.credential_ref !== options.credentialRef ||
      row.provider_status !== 'ACTIVE' ||
      row.user_status !== 'ACTIVE' ||
      row.ios_push_enabled !== true ||
      !row.rule_active ||
      !row.template_active
        ? 'APNS_DELIVERY_NOT_ELIGIBLE'
        : null;
    if (!reason && !row.mandatory) {
      if (row.preference_enabled === false) reason = 'OPTED_OUT';
      else if (
        row.quiet_from &&
        row.quiet_until &&
        row.timezone &&
        quietHoursActive({
          now: row.database_now,
          quietFrom: row.quiet_from,
          quietUntil: row.quiet_until,
          timezone: row.timezone,
        })
      )
        reason = 'QUIET_HOURS';
    }
    if (reason) {
      await client.query(
        `update notifications.deliveries set state='SUPPRESSED',attempt_count=attempt_count-1,lease_expires_at=null,completed_at=clock_timestamp(),last_error_code=$3,updated_at=clock_timestamp() where tenant_id=$1 and id=$2`,
        [options.tenantId, job.id, reason],
      );
      await changed(client, options.tenantId, job, 'SUPPRESSED', reason);
      return undefined;
    }
    let address: string;
    try {
      address = options.cipher.decrypt(row.address_ciphertext, row.encryption_key_id);
    } catch {
      return {
        result: {
          outcome: 'terminal_failure',
          errorCode: 'NOTIFICATION_ADDRESS_UNAVAILABLE',
          invalidate: false,
        },
      };
    }
    const dispatched = await client.query(
      `update notifications.deliveries set scenario_dispatch_started_at=clock_timestamp(),updated_at=clock_timestamp()
       where tenant_id=$1 and id=$2 and state='SENDING' and attempt_count=$3
         and lease_expires_at>clock_timestamp() and scenario_dispatch_started_at is null`,
      [options.tenantId, job.id, job.attempt_count + 1],
    );
    return dispatched.rowCount === 1
      ? {
          address,
          endpoint: {
            ciphertext: row.address_ciphertext,
            encryptionKeyId: row.encryption_key_id,
            recipientUserId: row.recipient_user_id,
          },
        }
      : undefined;
  });
}

/** Ordinary APNs is independent of scenario scheduling; all transport calls follow a durable fence. */
export async function runApnsDeliveryBatch(options: Options): Promise<number> {
  if (!options.enabled) return 0;
  const job = await claim(options);
  if (!job) return 0;
  const startedAt = new Date().toISOString();
  const dispatch = await fence(options, job);
  if (!dispatch) return 1;
  let result: PushDeliveryResult;
  if ('result' in dispatch) result = dispatch.result;
  else {
    try {
      result = await options.adapter.send({
        tenantId: options.tenantId,
        deliveryId: job.id,
        providerAccountId: job.provider_account_id,
        platform: 'IOS',
        endpoint: dispatch.address,
        notification: {
          id: job.intent_id,
          title: 'ПадлхАБ',
          preview: 'Новое уведомление',
          deepLink: '/notifications',
        },
        providerIdempotencyKey: `apns:${job.id}`,
      });
    } catch {
      result = {
        outcome: 'terminal_failure',
        errorCode: 'APNS_OUTCOME_UNKNOWN',
        invalidate: false,
      };
    }
  }
  const claimed = {
    tenantId: options.tenantId,
    deliveryId: job.id,
    intentId: job.intent_id,
    endpointId: job.endpoint_id,
    providerAccountId: job.provider_account_id,
    attemptNo: job.attempt_count + 1,
    startedAt,
    ...('endpoint' in dispatch ? { dispatchedEndpoint: dispatch.endpoint } : {}),
  };
  if (result.outcome === 'retryable_failure' && result.errorCode === 'APNS_CIRCUIT_OPEN')
    await deferNotificationDeliveryWithoutAttempt({
      pool: options.pool,
      job: claimed,
      retryAfterMs: result.retryAfterMs ?? 30000,
      errorCode: result.errorCode,
    });
  else
    await finalizeNotificationDelivery({
      pool: options.pool,
      job: claimed,
      result,
      platform: 'IOS',
      transport: 'APNS',
      maxAttempts: 5,
      retryBaseMs: 5000,
    });
  return 1;
}
