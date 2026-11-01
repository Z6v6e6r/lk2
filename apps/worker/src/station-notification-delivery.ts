import { fcmRolloutClaimAllowed } from './fcm-rollout-gate.js';
import type {
  NotificationEndpointCipher,
  NotificationPushDeliveryPort,
  PushDeliveryResult,
} from '@phub/notifications';
import type { StationMessageNotificationRepository } from '@phub/database/station-message-notifications';
import {
  stationRecipientJoin,
  stationMapping,
  verifyStationSource,
  type StationRecipientRow,
} from '@phub/database/station-message-notifications';
import type { StationNotificationClient } from './station-notification-client.js';
import { stationScope, stationFact, stationRecipient } from './station-notification-importer.js';
import type { StationProvider } from './station-notification-projector.js';
import { buildFcmData } from './fcm-delivery.js';
import { checkOrdinaryPushPolicy } from './ordinary-push-policy.js';
import {
  finalizeNotificationDelivery,
  resolveNotificationIntentState,
  type ClaimedNotificationDelivery,
} from './notification-delivery-finalizer.js';
interface Claim extends StationRecipientRow {
  delivery_id: string;
  intent_id: string;
  endpoint_id: string;
  provider_account_id: string;
  attempt_count: number;
  station_claim_generation: string;
  station_dispatch_started_at: Date | null;
  started_at: Date;
  notification_id: string;
}
export interface StationTransport extends StationProvider {
  adapter: NotificationPushDeliveryPort;
  cipher: NotificationEndpointCipher;
  maxAttempts: number;
  retryBaseMs: number;
}
const unknown = (): PushDeliveryResult => ({
  outcome: 'terminal_failure',
  errorCode: 'STATION_PROVIDER_OUTCOME_UNKNOWN',
  invalidate: false,
});
export function stationProviderResult(result: PushDeliveryResult): PushDeliveryResult {
  if (result.outcome === 'accepted') return result;
  if (
    [
      'STATION_NOT_SUBMITTED',
      'FCM_CIRCUIT_OPEN',
      'WEB_PUSH_CIRCUIT_OPEN',
      'APNS_CIRCUIT_OPEN',
      'FCM_AUTH_REJECTED',
      'WEB_PUSH_AUTH_REJECTED',
      'APNS_AUTH_REJECTED',
      'APNS_NETWORK_FAILURE',
    ].includes(result.errorCode) &&
    result.outcome === 'retryable_failure'
  )
    return result;
  if (
    result.outcome === 'terminal_failure' &&
    [
      'FCM_TOKEN_UNREGISTERED',
      'WEB_PUSH_SUBSCRIPTION_GONE',
      'WEB_PUSH_SUBSCRIPTION_INVALID',
      'WEB_PUSH_ENDPOINT_ORIGIN_NOT_ALLOWED',
      'WEB_PUSH_EGRESS_BLOCKED',
      'APNS_TOKEN_INVALID',
    ].includes(result.errorCode)
  )
    return result;
  return unknown();
}
async function claim(
  repo: StationMessageNotificationRepository,
  tenantId: string,
  t: StationTransport,
) {
  return repo.tx(tenantId, async (c) => {
    if (t.provider === 'FCM')
      for (const key of [
        `notification-runtime:${tenantId}`,
        `android-push-provider:${tenantId}:${t.appId}:${t.environment}`,
      ])
        if (
          (
            await c.query<{ ok: boolean }>(
              'select pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',
              [key],
            )
          ).rows[0]?.ok !== true
        )
          return null;
    const d = await c.query<{ id: string; context_id: string }>(
      `select d.id,d.station_notification_context_id context_id from notifications.deliveries d join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id where d.tenant_id=$1 and d.channel='PUSH' and a.provider=$2 and a.app_id=$3 and a.environment=$4 and ($5::text is null or a.credential_ref=$5) and ((d.state='STATION_PENDING' and d.next_attempt_at<=clock_timestamp()) or(d.state='STATION_SENDING' and d.lease_expires_at<=clock_timestamp())) order by d.next_attempt_at,d.id for update of d skip locked limit 1`,
      [tenantId, t.provider, t.appId, t.environment, t.credentialRef ?? null],
    );
    if (!d.rows[0]) return null;
    const p = await c.query<Claim>(
      stationRecipientJoin +
        ` join notifications.deliveries d on d.tenant_id=r.tenant_id and d.station_notification_context_id=r.id join integration.notification_endpoints e on e.tenant_id=d.tenant_id and e.id=d.endpoint_id where d.tenant_id=$1 and d.id=$2`,
      [tenantId, d.rows[0].id],
    );
    const base = p.rows[0];
    if (!base) return null;
    const updated = await c.query<{
      attempt_count: number;
      station_claim_generation: string;
      station_dispatch_started_at: Date | null;
      intent_id: string;
      endpoint_id: string;
      started_at: Date;
    }>(
      `update notifications.deliveries set state='STATION_SENDING',attempt_count=attempt_count+case when state='STATION_PENDING' then 1 else 0 end,station_claim_generation=station_claim_generation+1,lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where tenant_id=$1 and id=$2 returning attempt_count,station_claim_generation,station_dispatch_started_at,intent_id,endpoint_id,clock_timestamp() started_at`,
      [tenantId, d.rows[0].id],
    );
    const e = await c.query<{ provider_account_id: string }>(
      'select provider_account_id from integration.notification_endpoints where tenant_id=$1 and id=$2',
      [tenantId, updated.rows[0]!.endpoint_id],
    );
    const notification = await c.query<{ notification_id: string }>(
      `select coalesce(n.id,i.id) notification_id from notifications.intents i left join notifications.inbox_items n on n.tenant_id=i.tenant_id and n.intent_id=i.id where i.tenant_id=$1 and i.id=$2`,
      [tenantId, updated.rows[0]!.intent_id],
    );
    if (notification.rowCount !== 1) throw Error('STATION_INTENT_MISSING');
    return {
      ...base,
      notification_id: notification.rows[0]!.notification_id,
      ...updated.rows[0]!,
      delivery_id: d.rows[0].id,
      provider_account_id: e.rows[0]!.provider_account_id,
    };
  });
}
async function defer(
  repo: StationMessageNotificationRepository,
  j: ClaimedNotificationDelivery,
  reason: string,
  suppress = false,
) {
  return repo.tx(j.tenantId, async (c) => {
    const r = await c.query(
      `update notifications.deliveries set state=$6,attempt_count=attempt_count-1,lease_expires_at=null,next_attempt_at=clock_timestamp()+interval '30 seconds',completed_at=case when $6='SUPPRESSED' then clock_timestamp() else null end,last_error_code=$7 where tenant_id=$1 and id=$2 and intent_id=$3 and station_notification_context_id=$4 and station_claim_generation=$5 and state='STATION_SENDING' and station_dispatch_started_at is null and lease_expires_at>clock_timestamp() and attempt_count=$8 returning id`,
      [
        j.tenantId,
        j.deliveryId,
        j.intentId,
        j.station!.contextId,
        j.station!.generation,
        suppress ? 'SUPPRESSED' : 'STATION_PENDING',
        reason,
        j.attemptNo,
      ],
    );
    if (r.rowCount !== 1) return;
    await c.query('select id from notifications.intents where tenant_id=$1 and id=$2 for update', [
      j.tenantId,
      j.intentId,
    ]);
    const states = await c.query<{ state: string }>(
      'select state from notifications.deliveries where tenant_id=$1 and intent_id=$2',
      [j.tenantId, j.intentId],
    );
    const state = resolveNotificationIntentState(states.rows.map((x) => x.state));
    await c.query(
      'update notifications.intents set state=$3,completed_at=case when $4 then clock_timestamp() else null end where tenant_id=$1 and id=$2',
      [j.tenantId, j.intentId, state.state, state.completed],
    );
    await c.query(
      `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,'notifications.delivery.changed.v1',$2,$3,$4::jsonb)`,
      [
        j.tenantId,
        j.deliveryId,
        j.deliveryId,
        JSON.stringify({
          deliveryId: j.deliveryId,
          state: suppress ? 'SUPPRESSED' : 'PENDING',
          errorCode: reason,
        }),
      ],
    );
  });
}
export async function runStationDelivery(
  repo: StationMessageNotificationRepository,
  owner: StationNotificationClient,
  tenantId: string,
  t: StationTransport,
) {
  if (t.provider === 'FCM' && !fcmRolloutClaimAllowed()) return false;
  const c = await claim(repo, tenantId, t);
  if (!c) return false;
  let job: ClaimedNotificationDelivery = {
    tenantId,
    deliveryId: c.delivery_id,
    intentId: c.intent_id,
    endpointId: c.endpoint_id,
    providerAccountId: c.provider_account_id,
    attemptNo: c.attempt_count,
    startedAt: c.started_at.toISOString(),
    station: { contextId: c.context_id, generation: Number(c.station_claim_generation) },
  };
  const finish = (result: PushDeliveryResult) =>
    finalizeNotificationDelivery({
      pool: repo.pool,
      job,
      result,
      platform: t.adapter.platform,
      transport: t.provider,
      maxAttempts: t.maxAttempts,
      retryBaseMs: t.retryBaseMs,
    });
  if (c.station_dispatch_started_at) {
    await finish(unknown());
    return true;
  }
  try {
    await repo.tx(tenantId, async (client) => {
      await verifyStationSource(client, c);
      if (!c.user_id || !c.recipient_mapping_id) throw Error('STATION_MAPPING_UNAVAILABLE');
      await stationMapping(client, tenantId, 'VIVA', 'viva_profile', c.player_id, {
        id: c.recipient_mapping_id,
        internalId: c.user_id,
      });
    });
    const eligibility = await owner.read('eligibility', {
      ...stationScope(c),
      fact: stationFact(c),
      recipient: stationRecipient(c),
    });
    if (eligibility.value.outcome === 'DENY') {
      await defer(repo, job, 'STATION_OWNER_DENIED', true);
      return true;
    }
    const decision = await checkOrdinaryPushPolicy({
      pool: repo.pool,
      job,
      provider: t.provider,
      appId: t.appId,
      environment: t.environment,
      ...(t.credentialRef ? { credentialRef: t.credentialRef } : {}),
      stationFresh: eligibility.fresh,
      stationValidate: async (client) => {
        await verifyStationSource(client, c);
        await stationMapping(client, tenantId, 'VIVA', 'viva_profile', c.player_id, {
          id: c.recipient_mapping_id!,
          internalId: c.user_id!,
        });
      },
    });
    if (decision.outcome !== 'SEND') {
      if (decision.outcome !== 'SUPPRESSED') await defer(repo, job, 'STATION_POLICY_UNAVAILABLE');
      return true;
    }
    job = { ...job, dispatchedEndpoint: decision.endpoint };
    let result: PushDeliveryResult;
    try {
      const endpoint = t.cipher.decrypt(
        decision.endpoint.ciphertext,
        decision.endpoint.encryptionKeyId,
      );
      result = stationProviderResult(
        await t.adapter.send({
          tenantId,
          deliveryId: job.deliveryId,
          providerAccountId: job.providerAccountId,
          platform: t.adapter.platform,
          endpoint,
          notification: {
            id: c.notification_id,
            title: 'ПадлхАБ',
            preview: 'Новое уведомление',
            deepLink: '/notifications',
          },
          data: buildFcmData({
            endpointId: job.endpointId,
            deliveryId: job.deliveryId,
            notificationId: c.notification_id,
            deepLink: '/notifications',
          }),
          providerIdempotencyKey: job.deliveryId,
          stationCanSubmit: eligibility.fresh,
        }),
      );
    } catch {
      result = unknown();
    }
    await finish(result);
  } catch {
    await defer(repo, job, 'STATION_DEPENDENCY_UNAVAILABLE');
  }
  return true;
}
