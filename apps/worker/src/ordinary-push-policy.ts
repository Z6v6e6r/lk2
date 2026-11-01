import { withTenantTransaction } from '@phub/database';
import { quietHoursActive } from '@phub/notifications';
import type { Pool } from 'pg';
import {
  resolveNotificationIntentState,
  type ClaimedNotificationDelivery,
} from './notification-delivery-finalizer.js';

type Job = Pick<
  ClaimedNotificationDelivery,
  'tenantId' | 'deliveryId' | 'intentId' | 'endpointId' | 'providerAccountId' | 'attemptNo'
>;
export type OrdinaryPushDecision =
  | { outcome: 'SEND'; endpoint: NonNullable<ClaimedNotificationDelivery['dispatchedEndpoint']> }
  | { outcome: 'SCENARIO' }
  | { outcome: 'BUSY' }
  | { outcome: 'STALE' }
  | { outcome: 'SUPPRESSED' };
interface PolicyRow {
  live_lease: boolean;
  scenario_marked: boolean;
  scenario_run_id: string | null;
  recipient_user_id: string;
  endpoint_user_id: string;
  endpoint_status: string;
  endpoint_channel: string;
  provider_account_id: string;
  address_ciphertext: Buffer;
  encryption_key_id: string;
  provider: string;
  platform: string;
  provider_channel: string;
  app_id: string;
  environment: string;
  provider_status: string;
  user_status: string;
  runtime_enabled: boolean | null;
  trigger_rule_id: string | null;
  rule_active: boolean | null;
  mandatory: boolean | null;
  template_active: boolean | null;
  category: string | null;
  preference_enabled: boolean | null;
  quiet_from: string | null;
  quiet_until: string | null;
  timezone: string | null;
  database_now: Date;
}

/** Policy snapshot after claim and row-lock waits, not an exactly-once external dispatch fence. */
export async function checkOrdinaryPushPolicy(options: {
  pool: Pool;
  job: Job;
  provider: 'FCM' | 'WEB_PUSH';
  appId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
}): Promise<OrdinaryPushDecision> {
  const { job } = options;
  return withTenantTransaction(options.pool, job.tenantId, async (client) => {
    await client.query(
      "select set_config('statement_timeout','5s',true),set_config('lock_timeout','3s',true)",
    );
    if (options.provider === 'FCM') {
      // Same order as rollout/admin writers and the FCM claim. Never take these after row locks.
      for (const key of [
        `notification-runtime:${job.tenantId}`,
        `android-push-provider:${job.tenantId}:${options.appId}:${options.environment}`,
      ]) {
        const lock = await client.query<{ acquired: boolean }>(
          'select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',
          [key],
        );
        if (lock.rows[0]?.acquired !== true) return { outcome: 'BUSY' };
      }
    }
    const delivery = await client.query(
      `select id from notifications.deliveries where tenant_id=$1 and id=$2 and intent_id=$3
         and endpoint_id=$4 and state='SENDING' and attempt_count=$5 and channel='PUSH' for update`,
      [job.tenantId, job.deliveryId, job.intentId, job.endpointId, job.attemptNo],
    );
    if (delivery.rowCount !== 1) return { outcome: 'STALE' };
    const endpoint = await client.query(
      'select id from integration.notification_endpoints where tenant_id=$1 and id=$2 for update',
      [job.tenantId, job.endpointId],
    );
    if (endpoint.rowCount !== 1) return { outcome: 'STALE' };
    // Separate statement AFTER lock waits: READ COMMITTED sees policies committed while waiting.
    // Preferences are a decision-time snapshot, not a lock held across the provider call.
    const result = await client.query<PolicyRow>(
      `select d.lease_expires_at>clock_timestamp() live_lease,
         (d.scenario_available_at is not null or d.scenario_v2_available_at is not null
          or d.scenario_dispatch_started_at is not null or i.render_data ? 'scenarioRunId') scenario_marked,
         i.render_data->>'scenarioRunId' scenario_run_id,
         i.recipient_user_id,e.user_id endpoint_user_id,e.status endpoint_status,e.channel endpoint_channel,
         e.provider_account_id,e.address_ciphertext,e.encryption_key_id,
         a.provider,a.platform,a.channel provider_channel,a.app_id,a.environment,a.status provider_status,
         u.status user_status,${options.provider === 'FCM' ? 'r.android_push_enabled' : 'r.web_push_enabled'} runtime_enabled,
         i.trigger_rule_id,tr.active rule_active,tr.mandatory,t.active template_active,t.category,
         p.enabled preference_enabled,left(p.quiet_from::text,5) quiet_from,
         left(p.quiet_until::text,5) quiet_until,p.timezone,clock_timestamp() database_now
       from notifications.deliveries d
       join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id
       join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id
       left join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id
       left join identity.users u on u.tenant_id=i.tenant_id and u.id=i.recipient_user_id
       left join notifications.templates t on t.tenant_id=i.tenant_id and t.id=i.template_id
       left join notifications.trigger_rules tr on tr.tenant_id=i.tenant_id and tr.id=i.trigger_rule_id
       left join notifications.tenant_runtime_settings r on r.tenant_id=d.tenant_id
       left join notifications.user_preferences p on p.tenant_id=i.tenant_id and p.user_id=i.recipient_user_id
         and p.category=t.category and p.channel='PUSH'
       where d.tenant_id=$1 and d.id=$2`,
      [job.tenantId, job.deliveryId],
    );
    const row = result.rows[0];
    if (!row || row.live_lease !== true) return { outcome: 'STALE' };
    if (row.scenario_marked) {
      return {
        outcome:
          typeof row.scenario_run_id === 'string' && row.scenario_run_id.length > 0
            ? 'SCENARIO'
            : 'STALE',
      };
    }
    const ruleAllowed =
      row.trigger_rule_id === null
        ? row.category === 'ADMIN_MESSAGE'
        : row.rule_active === true && typeof row.mandatory === 'boolean';
    let reason =
      row.provider_account_id !== job.providerAccountId ||
      row.endpoint_user_id !== row.recipient_user_id ||
      row.endpoint_status !== 'ACTIVE' ||
      row.endpoint_channel !== 'PUSH' ||
      row.provider !== options.provider ||
      row.platform !== (options.provider === 'FCM' ? 'ANDROID' : 'WEB') ||
      row.provider_channel !== 'PUSH' ||
      row.app_id !== options.appId ||
      row.environment !== options.environment ||
      row.provider_status !== 'ACTIVE' ||
      row.user_status !== 'ACTIVE' ||
      row.runtime_enabled !== true ||
      row.template_active !== true ||
      !ruleAllowed
        ? `${options.provider}_DELIVERY_NOT_ELIGIBLE`
        : null;
    if (!reason && !(row.trigger_rule_id !== null && row.mandatory === true)) {
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
        `update notifications.deliveries set state='SUPPRESSED',attempt_count=attempt_count-1,
         lease_expires_at=null,completed_at=clock_timestamp(),last_error_code=$3,updated_at=clock_timestamp()
         where tenant_id=$1 and id=$2`,
        [job.tenantId, job.deliveryId, reason],
      );
      // Delivery -> endpoint -> intent. Sibling states must be read after intent lock acquisition.
      await client.query(
        'select id from notifications.intents where tenant_id=$1 and id=$2 for update',
        [job.tenantId, job.intentId],
      );
      const states = await client.query<{ state: string }>(
        'select state from notifications.deliveries where tenant_id=$1 and intent_id=$2',
        [job.tenantId, job.intentId],
      );
      const resolved = resolveNotificationIntentState(states.rows.map((item) => item.state));
      await client.query(
        `update notifications.intents set state=$3,completed_at=case when $4 then coalesce(completed_at,clock_timestamp()) else null end where tenant_id=$1 and id=$2`,
        [job.tenantId, job.intentId, resolved.state, resolved.completed],
      );
      await client.query(
        `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload)
         values($1,'notifications.delivery.changed.v1',$2,$3,$4::jsonb)`,
        [
          job.tenantId,
          job.deliveryId,
          `ordinary-push-${job.deliveryId}`,
          JSON.stringify({ deliveryId: job.deliveryId, state: 'SUPPRESSED', errorCode: reason }),
        ],
      );
      return { outcome: 'SUPPRESSED' };
    }
    return {
      outcome: 'SEND',
      endpoint: {
        ciphertext: row.address_ciphertext,
        encryptionKeyId: row.encryption_key_id,
        recipientUserId: row.recipient_user_id,
      },
    };
  });
}
