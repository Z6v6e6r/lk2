import { randomUUID } from 'node:crypto';
import { TOURNAMENT_MESSAGE_NOTIFICATION as contract, quietHoursActive } from '@phub/notifications';
import type { TournamentMessageNotificationRepository } from '@phub/database/tournament-message-notifications';
import {
  verifyTournamentIdentity,
  verifyTournamentSource,
  type TournamentRecipientRow,
} from '@phub/database/tournament-message-notifications';
import type { TournamentNotificationOwnerClient } from './tournament-chat-notification-owner.js';
export interface TournamentProvider {
  provider: 'FCM' | 'APNS' | 'WEB_PUSH';
  appId: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  credentialRef?: string;
}
/** Concrete recipient outbox and notification facts share ONE PostgreSQL commit. */
export async function projectTournamentRecipient(
  repo: TournamentMessageNotificationRepository,
  p: TournamentRecipientRow,
  proof: Awaited<ReturnType<TournamentNotificationOwnerClient['eligibilityWithIdentity']>>,
  providers: readonly TournamentProvider[],
) {
  const { observation, identity, fresh } = proof;
  if (
    observation.userId !== identity.userId ||
    observation.witnessHash !== p.witness_hash ||
    observation.baselineSequence !== Number(p.baseline_sequence) ||
    observation.fact.factHash !== p.fact_hash ||
    observation.fact.messageId !== p.message_id
  )
    throw Error('TOURNAMENT_PROOF_MISMATCH');
  const allow = observation.decision === 'ALLOW';
  return repo.tx(p.tenant_id, async (c) => {
    await verifyTournamentSource(c, p);
    const locked = await c.query(
      `select id from notifications.tournament_message_recipient_outbox where tenant_id=$1 and id=$2 and state='PENDING' and lease_token=$3 and lease_until>clock_timestamp() for update`,
      [p.tenant_id, p.context_id, p.recipient_lease_token],
    );
    if (locked.rowCount !== 1) return 'STALE';
    if (!fresh()) throw Error('TOURNAMENT_AUTHORIZATION_EXPIRED');
    if (!allow) {
      await c.query(
        `update notifications.tournament_message_recipient_outbox set state='SUPPRESSED',completed_at=clock_timestamp(),lease_token=null,lease_until=null where tenant_id=$1 and id=$2`,
        [p.tenant_id, p.context_id],
      );
      return 'SUPPRESSED';
    }
    if (identity.userId === p.author_user_id) throw Error('TOURNAMENT_AUTHOR_FORBIDDEN');
    const mapping = await verifyTournamentIdentity(c, p, identity);
    if (
      (
        await c.query<{ ok: boolean }>(
          'select pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',
          ['tournament-notification:' + p.tenant_id + ':' + p.fact_id + ':' + identity.userId],
        )
      ).rows[0]?.ok !== true
    )
      throw Error('TOURNAMENT_RECIPIENT_BUSY');
    const chosen = await c.query<{ id: string }>(
      `select id from notifications.tournament_message_recipient_outbox where tenant_id=$1 and fact_id=$2 and user_id=$3`,
      [p.tenant_id, p.fact_id, identity.userId],
    );
    if (chosen.rows.some((row) => row.id !== p.context_id)) {
      await c.query(
        `update notifications.tournament_message_recipient_outbox set state='SUPPRESSED',completed_at=clock_timestamp(),lease_token=null,lease_until=null,last_error_code='TOURNAMENT_USER_CONTEXT_ALREADY_CHOSEN' where tenant_id=$1 and id=$2`,
        [p.tenant_id, p.context_id],
      );
      return 'SUPPRESSED';
    }
    if (!fresh()) throw Error('TOURNAMENT_AUTHORIZATION_EXPIRED');
    const rule = await c.query<{ id: string; template_id: string }>(
      `select r.id,r.template_id from notifications.trigger_rules r join notifications.templates t on t.tenant_id=r.tenant_id and t.id=r.template_id where r.tenant_id=$1 and r.rule_key=$2 and r.source_event_type=$3 and r.active and not r.mandatory and t.active and t.template_key=$4 and t.version=1 and t.category='MESSAGING' and t.channels=array['IN_APP','PUSH']::text[] and t.title_template=$5 and t.body_template=$6 and t.deep_link_template=$7 and r.audience_selector=$8::jsonb and (r.channel_override is null or r.channel_override=array['IN_APP','PUSH']::text[])`,
      [
        p.tenant_id,
        contract.ruleKey,
        contract.eventType,
        contract.templateKey,
        contract.title,
        contract.body,
        contract.deepLink,
        JSON.stringify({ type: 'EVENT_USERS', field: 'recipientUserIds' }),
      ],
    );
    if (rule.rowCount !== 1) throw Error('TOURNAMENT_RULE_UNAVAILABLE');
    const settings = await c.query<{
      in_app_enabled: boolean;
      web_push_enabled: boolean;
      android_push_enabled: boolean;
      ios_push_enabled: boolean;
      now: Date;
    }>(
      'select *,clock_timestamp() now from notifications.tenant_runtime_settings where tenant_id=$1',
      [p.tenant_id],
    );
    const runtime = settings.rows[0];
    if (!runtime || !runtime.in_app_enabled) throw Error('TOURNAMENT_RUNTIME_UNAVAILABLE');
    const prefs = await c.query<{
      channel: string;
      enabled: boolean;
      quiet_from: string | null;
      quiet_until: string | null;
      timezone: string;
    }>(
      `select channel,enabled,left(quiet_from::text,5) quiet_from,left(quiet_until::text,5) quiet_until,timezone from notifications.user_preferences where tenant_id=$1 and user_id=$2 and category='MESSAGING'`,
      [p.tenant_id, mapping.internal_id],
    );
    const allowed = (channel: string) => {
      const v = prefs.rows.find((x) => x.channel === channel);
      return (
        v?.enabled !== false &&
        !(
          channel === 'PUSH' &&
          v?.quiet_from &&
          v.quiet_until &&
          quietHoursActive({
            now: runtime.now,
            quietFrom: v.quiet_from,
            quietUntil: v.quiet_until,
            timezone: v.timezone,
          })
        )
      );
    };
    const inApp = allowed('IN_APP'),
      push = allowed('PUSH');
    const all = await c.query<{
      id: string;
      provider: string;
      platform: string;
      app_id: string;
      environment: string;
      credential_ref: string;
    }>(
      `select e.id,a.provider,a.platform,a.app_id,a.environment,a.credential_ref from integration.notification_endpoints e join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id where e.tenant_id=$1 and e.user_id=$2 and e.channel='PUSH' and e.status='ACTIVE' and a.status='ACTIVE' and a.channel='PUSH' order by e.id`,
      [p.tenant_id, mapping.internal_id],
    );
    const endpoints = push
      ? all.rows.filter(
          (e) =>
            providers.some(
              (v) =>
                v.provider === e.provider &&
                v.appId === e.app_id &&
                v.environment === e.environment &&
                (v.credentialRef === undefined || v.credentialRef === e.credential_ref),
            ) &&
            ((e.provider === 'FCM' && e.platform === 'ANDROID' && runtime.android_push_enabled) ||
              (e.provider === 'APNS' && e.platform === 'IOS' && runtime.ios_push_enabled) ||
              (e.provider === 'WEB_PUSH' && e.platform === 'WEB' && runtime.web_push_enabled)),
        )
      : [];
    if (!fresh()) throw Error('TOURNAMENT_AUTHORIZATION_EXPIRED');
    await c.query(
      'update notifications.tournament_message_recipient_outbox set mapping_id=$3,user_id=$4,provider_client_id=$5 where tenant_id=$1 and id=$2',
      [p.tenant_id, p.context_id, mapping.id, mapping.internal_id, identity.providerClientId],
    );
    const state = endpoints.length ? 'PROCESSING' : inApp ? 'DELIVERED' : 'SUPPRESSED',
      intentId = randomUUID();
    await c.query(
      `insert into notifications.intents(tenant_id,id,recipient_user_id,source_event_id,trigger_rule_id,template_id,dedupe_key,render_data,rendered_title,rendered_body,rendered_deep_link,state,completed_at,tournament_notification_context_id) values($1,$2,$3,$4,$5,$6,$7,'{}',$8,$9,$10,$11,case when $11='PROCESSING' then null else clock_timestamp() end,$4)`,
      [
        p.tenant_id,
        intentId,
        mapping.internal_id,
        p.context_id,
        rule.rows[0]!.id,
        rule.rows[0]!.template_id,
        'tournament:' + p.context_id,
        contract.title,
        contract.body,
        contract.deepLink,
        state,
      ],
    );
    const outbox = async (event: string, id: string, payload: unknown) =>
      c.query(
        `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,$2,$3,$4,$5::jsonb)`,
        [p.tenant_id, event, id, p.context_id, JSON.stringify(payload)],
      );
    await outbox('notifications.intent.created.v1', intentId, {
      intentId,
      recipientUserId: mapping.internal_id,
    });
    const inAppId = randomUUID();
    await c.query(
      `insert into notifications.deliveries(tenant_id,id,intent_id,channel,state,completed_at,tournament_notification_context_id) values($1,$2,$3,'IN_APP',$4,clock_timestamp(),$5)`,
      [p.tenant_id, inAppId, intentId, inApp ? 'DELIVERED' : 'SUPPRESSED', p.context_id],
    );
    await outbox('notifications.delivery.changed.v1', inAppId, {
      deliveryId: inAppId,
      state: inApp ? 'DELIVERED' : 'SUPPRESSED',
    });
    if (inApp) {
      const inboxId = randomUUID();
      await c.query(
        `insert into notifications.inbox_items(tenant_id,id,intent_id,user_id,category,title,body,deep_link) values($1,$2,$3,$4,'MESSAGING',$5,$6,$7)`,
        [
          p.tenant_id,
          inboxId,
          intentId,
          mapping.internal_id,
          contract.title,
          contract.body,
          contract.deepLink,
        ],
      );
      await outbox('notifications.inbox.created.v1', inboxId, {
        inboxItemId: inboxId,
        recipientUserId: mapping.internal_id,
      });
    }
    for (const e of endpoints) {
      const deliveryId = randomUUID();
      await c.query(
        `insert into notifications.deliveries(tenant_id,id,intent_id,endpoint_id,channel,state,tournament_notification_context_id) values($1,$2,$3,$4,'PUSH','TOURNAMENT_PENDING',$5)`,
        [p.tenant_id, deliveryId, intentId, e.id, p.context_id],
      );
      await outbox('notifications.delivery.changed.v1', deliveryId, {
        deliveryId,
        state: 'PENDING',
      });
    }
    await c.query(
      `insert into audit.audit_log(tenant_id,action,resource_type,resource_id,result,correlation_id,new_value) values($1,'TOURNAMENT_NOTIFICATION_PROJECTED','NOTIFICATION_INTENT',$2,'SUCCESS',$3,$4::jsonb)`,
      [
        p.tenant_id,
        intentId,
        p.context_id,
        JSON.stringify({ intentId, recipientUserId: mapping.internal_id }),
      ],
    );
    await c.query(
      `update notifications.tournament_message_recipient_outbox set state='PROJECTED',completed_at=clock_timestamp(),lease_token=null,lease_until=null,last_error_code=null where tenant_id=$1 and id=$2`,
      [p.tenant_id, p.context_id],
    );
    if (!fresh()) throw Error('TOURNAMENT_AUTHORIZATION_EXPIRED');
    return 'PROJECTED';
  });
}
