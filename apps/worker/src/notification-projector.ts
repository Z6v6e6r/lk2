import { createHash } from 'node:crypto';

import {
  notificationAudienceSelectorSchema,
  renderNotificationTemplate,
  resolveNotificationRecipients,
  type NotificationSourceEvent,
} from '@phub/notifications';
import { queryOne } from '@phub/database';
import type { Pool, QueryResultRow } from 'pg';

const CONSUMER_NAME = 'notification-intent-projector-v1';

interface RuntimeRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
  readonly web_push_enabled: boolean;
}

interface RuleRow extends QueryResultRow {
  readonly rule_id: string;
  readonly template_id: string;
  readonly audience_selector: unknown;
  readonly mandatory: boolean;
  readonly effective_channels: string[];
  readonly category: string;
  readonly title_template: string;
  readonly body_template: string;
  readonly deep_link_template: string | null;
}

interface IdRow extends QueryResultRow {
  readonly id: string;
}

interface PreferenceRow extends QueryResultRow {
  readonly channel: 'IN_APP' | 'PUSH';
  readonly enabled: boolean;
}

export type NotificationProjectionResult =
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'disabled' }
  | {
      readonly outcome: 'processed';
      readonly created: number;
      readonly suppressed: number;
      readonly pushQueued: number;
      readonly skippedRules: number;
    };

function dedupeKey(eventId: string, ruleId: string, recipientUserId: string): string {
  return createHash('sha256').update(`${eventId}:${ruleId}:${recipientUserId}`).digest('hex');
}

export async function applyNotificationSourceEvent(options: {
  readonly pool: Pool;
  readonly event: NotificationSourceEvent;
  readonly webPush?: {
    readonly appId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
  };
}): Promise<NotificationProjectionResult> {
  const { event } = options;
  const client = await options.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [event.tenantId]);
    const inbox = await client.query(
      `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
       values ($1, $2, $3)
       on conflict (consumer_name, event_id) do nothing
       returning event_id`,
      [CONSUMER_NAME, event.id, event.tenantId],
    );
    if (inbox.rowCount === 0) {
      await client.query('commit');
      return { outcome: 'duplicate' };
    }

    const runtime = await client.query<RuntimeRow>(
      `select in_app_enabled, web_push_enabled
         from notifications.tenant_runtime_settings
        where tenant_id = $1`,
      [event.tenantId],
    );
    const inAppRuntimeEnabled = runtime.rows[0]?.in_app_enabled ?? false;
    const webPushRuntimeEnabled =
      Boolean(options.webPush) && (runtime.rows[0]?.web_push_enabled ?? false);
    if (!inAppRuntimeEnabled && !webPushRuntimeEnabled) {
      await client.query(
        `update audit.inbox_events
            set processed_at = now()
          where consumer_name = $1 and event_id = $2`,
        [CONSUMER_NAME, event.id],
      );
      await client.query('commit');
      return { outcome: 'disabled' };
    }

    const rules = await client.query<RuleRow>(
      `select r.id as rule_id, r.template_id, r.audience_selector, r.mandatory,
              coalesce(r.channel_override, t.channels) as effective_channels,
              t.category, t.title_template, t.body_template, t.deep_link_template
         from notifications.trigger_rules r
         join notifications.templates t
           on t.tenant_id = r.tenant_id and t.id = r.template_id
        where r.tenant_id = $1
          and r.source_event_type = $2
          and r.active = true
          and t.active = true
        order by r.id`,
      [event.tenantId, event.type],
    );

    let created = 0;
    let suppressed = 0;
    let pushQueued = 0;
    let skippedRules = 0;
    const renderData = {
      ...event.payload,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
    };

    for (const rule of rules.rows) {
      const inAppRequested = inAppRuntimeEnabled && rule.effective_channels.includes('IN_APP');
      const webPushRequested = webPushRuntimeEnabled && rule.effective_channels.includes('PUSH');
      if (!inAppRequested && !webPushRequested) {
        skippedRules += 1;
        continue;
      }
      const selector = notificationAudienceSelectorSchema.parse(rule.audience_selector);
      const recipients = resolveNotificationRecipients(event, selector);
      if (recipients.length === 0) {
        skippedRules += 1;
        continue;
      }

      const rendered = renderNotificationTemplate({
        titleTemplate: rule.title_template,
        bodyTemplate: rule.body_template,
        deepLinkTemplate: rule.deep_link_template,
        payload: renderData,
      });

      for (const recipientUserId of recipients) {
        const user = await client.query(
          `select 1
             from identity.users
            where tenant_id = $1 and id = $2 and status = 'ACTIVE'`,
          [event.tenantId, recipientUserId],
        );
        if (user.rowCount === 0) continue;

        const preferences = await client.query<PreferenceRow>(
          `select channel, enabled
             from notifications.user_preferences
            where tenant_id = $1
              and user_id = $2
              and category = $3
              and channel in ('IN_APP', 'PUSH')`,
          [event.tenantId, recipientUserId, rule.category],
        );
        const preferenceEnabled = (channel: 'IN_APP' | 'PUSH'): boolean =>
          preferences.rows.find((preference) => preference.channel === channel)?.enabled !== false;
        const deliverInApp = inAppRequested && (rule.mandatory || preferenceEnabled('IN_APP'));
        const deliverPush = webPushRequested && (rule.mandatory || preferenceEnabled('PUSH'));
        const endpoints =
          deliverPush && options.webPush
            ? await client.query<IdRow>(
                `select e.id
                   from integration.notification_endpoints e
                   join integration.notification_provider_accounts a
                     on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
                  where e.tenant_id = $1
                    and e.user_id = $2
                    and e.channel = 'PUSH'
                    and e.status = 'ACTIVE'
                    and a.channel = 'PUSH'
                    and a.platform = 'WEB'
                    and a.provider = 'WEB_PUSH'
                    and a.app_id = $3
                    and a.environment = $4
                    and a.status = 'ACTIVE'
                  order by e.created_at`,
                [
                  event.tenantId,
                  recipientUserId,
                  options.webPush.appId,
                  options.webPush.environment,
                ],
              )
            : { rows: [] as IdRow[] };
        const queuedPush = endpoints.rows.length > 0;
        const intentState = queuedPush ? 'PROCESSING' : deliverInApp ? 'DELIVERED' : 'SUPPRESSED';
        const intent = await client.query<IdRow>(
          `insert into notifications.intents (
             tenant_id, recipient_user_id, source_event_id, trigger_rule_id, template_id,
             dedupe_key, render_data, rendered_title, rendered_body, rendered_deep_link,
             state, completed_at
           ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
                     $11, case when $11 = 'PROCESSING' then null else now() end)
           on conflict (tenant_id, dedupe_key) do nothing
           returning id`,
          [
            event.tenantId,
            recipientUserId,
            event.id,
            rule.rule_id,
            rule.template_id,
            dedupeKey(event.id, rule.rule_id, recipientUserId),
            JSON.stringify(renderData),
            rendered.title,
            rendered.body,
            rendered.deepLink ?? null,
            intentState,
          ],
        );
        const intentId = intent.rows[0]?.id;
        if (!intentId) continue;

        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, 'notifications.intent.created.v1', $2, $3, $4::jsonb)`,
          [
            event.tenantId,
            intentId,
            event.correlationId,
            JSON.stringify({ intentId, recipientUserId }),
          ],
        );

        let inAppDeliveryId: string | undefined;
        if (inAppRequested) {
          const deliveryState = deliverInApp ? 'DELIVERED' : 'SUPPRESSED';
          const delivery = await client.query<IdRow>(
            `insert into notifications.deliveries (
               tenant_id, intent_id, channel, state, completed_at
             ) values ($1, $2, 'IN_APP', $3, now())
             returning id`,
            [event.tenantId, intentId, deliveryState],
          );
          const deliveryId = delivery.rows[0]?.id;
          if (!deliveryId) throw new Error('NOTIFICATION_IN_APP_DELIVERY_WRITE_LOST');
          inAppDeliveryId = deliveryId;
          if (!deliverInApp) {
            await client.query(
              `insert into audit.outbox_events (
                 tenant_id, event_type, aggregate_id, correlation_id, payload
               ) values ($1, 'notifications.delivery.changed.v1', $2, $3, $4::jsonb)`,
              [
                event.tenantId,
                deliveryId,
                event.correlationId,
                JSON.stringify({ deliveryId, state: deliveryState }),
              ],
            );
            suppressed += 1;
          }
        }

        if (deliverInApp) {
          if (!inAppDeliveryId) throw new Error('NOTIFICATION_IN_APP_DELIVERY_WRITE_LOST');
          const inboxItem = await client.query<IdRow>(
            `insert into notifications.inbox_items (
               tenant_id, intent_id, user_id, category, title, body, deep_link
             ) values ($1, $2, $3, $4, $5, $6, $7)
             returning id`,
            [
              event.tenantId,
              intentId,
              recipientUserId,
              rule.category,
              rendered.title,
              rendered.body,
              rendered.deepLink ?? null,
            ],
          );
          const inboxItemId = inboxItem.rows[0]?.id;
          if (!inboxItemId) throw new Error('NOTIFICATION_INBOX_WRITE_LOST');
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values
               ($1, 'notifications.inbox.created.v1', $2, $4, $5::jsonb),
               ($1, 'notifications.delivery.changed.v1', $3, $4, $6::jsonb)`,
            [
              event.tenantId,
              inboxItemId,
              inAppDeliveryId,
              event.correlationId,
              JSON.stringify({ inboxItemId, recipientUserId }),
              JSON.stringify({ deliveryId: inAppDeliveryId, state: 'DELIVERED' }),
            ],
          );
          created += 1;
        }

        for (const endpoint of endpoints.rows) {
          const pushDelivery = await queryOne<IdRow>(
            client,
            `insert into notifications.deliveries (
               tenant_id, intent_id, channel, endpoint_id, state
             ) values ($1, $2, 'PUSH', $3, 'PENDING')
             returning id`,
            [event.tenantId, intentId, endpoint.id],
          );
          if (!pushDelivery) throw new Error('NOTIFICATION_PUSH_DELIVERY_WRITE_LOST');
          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'notifications.delivery.changed.v1', $2, $3, $4::jsonb)`,
            [
              event.tenantId,
              pushDelivery.id,
              event.correlationId,
              JSON.stringify({ deliveryId: pushDelivery.id, state: 'PENDING' }),
            ],
          );
          pushQueued += 1;
        }
        if (!deliverInApp && endpoints.rows.length === 0 && !inAppRequested) {
          suppressed += 1;
        }

        await client.query(
          `insert into audit.audit_log (
             tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
           ) values ($1, 'NOTIFICATION_INTENT_PROJECTED', 'NOTIFICATION_INTENT', $2,
                     'SUCCESS', $3, $4::jsonb)`,
          [
            event.tenantId,
            intentId,
            event.correlationId,
            JSON.stringify({
              sourceEventId: event.id,
              triggerRuleId: rule.rule_id,
              recipientUserId,
              state: intentState,
              inAppDelivered: deliverInApp,
              pushDeliveryCount: endpoints.rows.length,
            }),
          ],
        );
      }
    }

    await client.query(
      `update audit.inbox_events
          set processed_at = now()
        where consumer_name = $1 and event_id = $2`,
      [CONSUMER_NAME, event.id],
    );
    await client.query('commit');
    return { outcome: 'processed', created, suppressed, pushQueued, skippedRules };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
