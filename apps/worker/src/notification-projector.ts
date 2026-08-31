import { createHash } from 'node:crypto';

import {
  BOOKING_NOTIFICATION_EVENT_TYPES,
  GAME_NOTIFICATION_EVENT_TYPES,
  notificationAudienceSelectorSchema,
  renderNotificationTemplate,
  resolveNotificationRecipients,
  type BookingNotificationSourceEvent,
  type GameNotificationSourceEvent,
  type NotificationSourceEvent,
} from '@phub/notifications';
import { queryOne } from '@phub/database';
import type { Pool, QueryResultRow } from 'pg';

import { reconcileBookingReminderSchedules } from './booking-reminder-scheduler.js';

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

interface BookingNotificationFenceRow extends QueryResultRow {
  readonly lifecycle_revision: string;
  readonly lifecycle_event_type: LifecycleBookingNotificationEventType;
  readonly lifecycle_fingerprint: string;
  readonly reminder_hours_24_fingerprint: string | null;
  readonly reminder_hours_2_fingerprint: string | null;
}

interface GameNotificationFenceRow extends QueryResultRow {
  readonly game_revision: string;
  readonly game_event_type: GameNotificationEventType;
  readonly game_fingerprint: string;
}

type LifecycleBookingNotificationEventType =
  'booking.confirmed.v1' | 'booking.changed.v1' | 'booking.cancelled.v1';

type BookingFenceOutcome = 'accepted' | 'duplicate' | 'stale' | 'suppressed' | 'revision_conflict';
type GameNotificationEventType = (typeof GAME_NOTIFICATION_EVENT_TYPES)[number];
type GameFenceOutcome =
  | { readonly outcome: 'accepted'; readonly recipientUserIds: readonly string[] }
  | { readonly outcome: 'duplicate' | 'stale' | 'revision_conflict' };

const bookingProjectionTails = new Map<string, Promise<void>>();
const gameProjectionTails = new Map<string, Promise<void>>();

export type NotificationProjectionResult =
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'suppressed' }
  | { readonly outcome: 'revision_conflict' }
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

function isBookingNotificationEvent(
  event: NotificationSourceEvent,
): event is BookingNotificationSourceEvent {
  return BOOKING_NOTIFICATION_EVENT_TYPES.includes(
    event.type as (typeof BOOKING_NOTIFICATION_EVENT_TYPES)[number],
  );
}

function isGameNotificationEvent(
  event: NotificationSourceEvent,
): event is GameNotificationSourceEvent {
  return GAME_NOTIFICATION_EVENT_TYPES.includes(event.type as GameNotificationEventType);
}

function isLifecycleBookingNotificationEvent(
  event: BookingNotificationSourceEvent,
): event is BookingNotificationSourceEvent & {
  readonly type: LifecycleBookingNotificationEventType;
} {
  return event.type !== 'booking.reminder.due.v1';
}

function bookingNotificationFingerprint(event: BookingNotificationSourceEvent): string {
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const normalizedPayload = Object.fromEntries(
    Object.entries(payload)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        Array.isArray(value) && (key === 'recipientUserIds' || key === 'changedFields')
          ? [...(value as readonly string[])].sort()
          : value,
      ]),
  );
  return createHash('sha256')
    .update(JSON.stringify({ type: event.type, payload: normalizedPayload }))
    .digest('hex');
}

function gameNotificationFingerprint(event: GameNotificationSourceEvent): string {
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const normalizedPayload = Object.fromEntries(
    Object.entries(payload)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        Array.isArray(value) && key === 'participantUserIds'
          ? [...(value as readonly string[])].sort()
          : value,
      ]),
  );
  return createHash('sha256')
    .update(JSON.stringify({ type: event.type, payload: normalizedPayload }))
    .digest('hex');
}

async function serializeBookingProjection<T>(
  tenantId: string,
  bookingId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${tenantId}:${bookingId}`;
  const prior = bookingProjectionTails.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  bookingProjectionTails.set(key, current);
  try {
    await prior;
    return await operation();
  } finally {
    release();
    if (bookingProjectionTails.get(key) === current) bookingProjectionTails.delete(key);
  }
}

async function serializeGameProjection<T>(
  tenantId: string,
  gameId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${tenantId}:${gameId}`;
  const prior = gameProjectionTails.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  gameProjectionTails.set(key, current);
  try {
    await prior;
    return await operation();
  } finally {
    release();
    if (gameProjectionTails.get(key) === current) gameProjectionTails.delete(key);
  }
}

async function applyBookingNotificationFence(options: {
  readonly client: { query: Pool['query'] };
  readonly event: BookingNotificationSourceEvent;
}): Promise<BookingFenceOutcome> {
  const { client, event } = options;
  const fingerprint = bookingNotificationFingerprint(event);
  const revision = BigInt(event.payload.revision);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${event.tenantId}:${event.aggregateId}`,
  ]);
  const existing = await client.query<BookingNotificationFenceRow>(
    `select lifecycle_revision::text as lifecycle_revision, lifecycle_event_type,
            lifecycle_fingerprint, reminder_hours_24_fingerprint, reminder_hours_2_fingerprint
       from notifications.booking_notification_projection_fences
      where tenant_id = $1 and booking_id = $2
      for update`,
    [event.tenantId, event.aggregateId],
  );
  const fence = existing.rows[0];

  if (isLifecycleBookingNotificationEvent(event)) {
    if (!fence) {
      await client.query(
        `insert into notifications.booking_notification_projection_fences (
           tenant_id, booking_id, lifecycle_revision, lifecycle_event_type, lifecycle_fingerprint
         ) values ($1, $2, $3::numeric, $4, $5)`,
        [event.tenantId, event.aggregateId, event.payload.revision, event.type, fingerprint],
      );
      return 'accepted';
    }
    const currentRevision = BigInt(fence.lifecycle_revision);
    if (revision < currentRevision) return 'stale';
    if (revision === currentRevision) {
      return fence.lifecycle_event_type === event.type &&
        fence.lifecycle_fingerprint === fingerprint
        ? 'duplicate'
        : 'revision_conflict';
    }
    await client.query(
      `update notifications.booking_notification_projection_fences
          set lifecycle_revision = $3::numeric,
              lifecycle_event_type = $4,
              lifecycle_fingerprint = $5,
              reminder_hours_24_fingerprint = null,
              reminder_hours_2_fingerprint = null,
              updated_at = now()
        where tenant_id = $1 and booking_id = $2`,
      [event.tenantId, event.aggregateId, event.payload.revision, event.type, fingerprint],
    );
    return 'accepted';
  }

  if (!fence || revision > BigInt(fence.lifecycle_revision)) {
    throw new Error('BOOKING_REMINDER_AHEAD_OF_LIFECYCLE');
  }
  if (revision < BigInt(fence.lifecycle_revision)) return 'stale';
  if (fence.lifecycle_event_type === 'booking.cancelled.v1') return 'suppressed';

  const fingerprintColumn =
    event.payload.reminderKind === 'HOURS_24'
      ? 'reminder_hours_24_fingerprint'
      : 'reminder_hours_2_fingerprint';
  const currentFingerprint = fence[fingerprintColumn];
  if (currentFingerprint === fingerprint) return 'duplicate';
  if (currentFingerprint) return 'revision_conflict';
  await client.query(
    `update notifications.booking_notification_projection_fences
        set ${fingerprintColumn} = $3,
            updated_at = now()
      where tenant_id = $1 and booking_id = $2`,
    [event.tenantId, event.aggregateId, fingerprint],
  );
  return 'accepted';
}

async function applyGameNotificationFence(options: {
  readonly client: { query: Pool['query'] };
  readonly event: GameNotificationSourceEvent;
}): Promise<GameFenceOutcome> {
  const { client, event } = options;
  const fingerprint = gameNotificationFingerprint(event);
  const revision = BigInt(event.payload.aggregateRevision);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${event.tenantId}:${event.aggregateId}`,
  ]);
  const recipientUserIds =
    event.type === 'game.cancelled.v1' ? event.payload.participantUserIds : [event.payload.userId];
  const acceptedRecipientUserIds: string[] = [];
  let sawStale = false;

  for (const recipientUserId of [...recipientUserIds].sort()) {
    const existing = await client.query<GameNotificationFenceRow>(
      `select game_revision::text as game_revision, game_event_type, game_fingerprint
         from notifications.game_notification_projection_fences
        where tenant_id = $1 and game_id = $2 and recipient_user_id = $3
        for update`,
      [event.tenantId, event.aggregateId, recipientUserId],
    );
    const fence = existing.rows[0];
    if (!fence) {
      await client.query(
        `insert into notifications.game_notification_projection_fences (
           tenant_id, game_id, recipient_user_id, game_revision, game_event_type, game_fingerprint
         ) values ($1, $2, $3, $4::numeric, $5, $6)`,
        [
          event.tenantId,
          event.aggregateId,
          recipientUserId,
          event.payload.aggregateRevision,
          event.type,
          fingerprint,
        ],
      );
      acceptedRecipientUserIds.push(recipientUserId);
      continue;
    }
    const currentRevision = BigInt(fence.game_revision);
    if (revision < currentRevision) {
      sawStale = true;
      continue;
    }
    if (revision === currentRevision) {
      if (fence.game_event_type !== event.type || fence.game_fingerprint !== fingerprint) {
        return { outcome: 'revision_conflict' };
      }
      continue;
    }
    await client.query(
      `update notifications.game_notification_projection_fences
          set game_revision = $4::numeric,
              game_event_type = $5,
              game_fingerprint = $6,
              updated_at = now()
        where tenant_id = $1 and game_id = $2 and recipient_user_id = $3`,
      [
        event.tenantId,
        event.aggregateId,
        recipientUserId,
        event.payload.aggregateRevision,
        event.type,
        fingerprint,
      ],
    );
    acceptedRecipientUserIds.push(recipientUserId);
  }

  if (acceptedRecipientUserIds.length > 0) {
    return { outcome: 'accepted', recipientUserIds: acceptedRecipientUserIds };
  }
  return { outcome: sawStale ? 'stale' : 'duplicate' };
}

export async function applyNotificationSourceEvent(options: {
  readonly pool: Pool;
  readonly event: NotificationSourceEvent;
  readonly webPush?: {
    readonly appId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
  };
}): Promise<NotificationProjectionResult> {
  if (isBookingNotificationEvent(options.event)) {
    return serializeBookingProjection(options.event.tenantId, options.event.aggregateId, () =>
      applyNotificationSourceEventInTransaction(options),
    );
  }
  if (isGameNotificationEvent(options.event)) {
    return serializeGameProjection(options.event.tenantId, options.event.aggregateId, () =>
      applyNotificationSourceEventInTransaction(options),
    );
  }
  return applyNotificationSourceEventInTransaction(options);
}

async function applyNotificationSourceEventInTransaction(options: {
  readonly pool: Pool;
  readonly event: NotificationSourceEvent;
  readonly webPush?: {
    readonly appId: string;
    readonly environment: 'SANDBOX' | 'PRODUCTION';
  };
}): Promise<NotificationProjectionResult> {
  const { event } = options;
  let gameFenceRecipientUserIds: ReadonlySet<string> | undefined;
  const client = await options.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('lock_timeout', '5s', true)");
    await client.query("select set_config('statement_timeout', '30s', true)");
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

    if (isBookingNotificationEvent(event)) {
      const fenceOutcome = await applyBookingNotificationFence({ client, event });
      if (fenceOutcome !== 'accepted') {
        if (fenceOutcome === 'revision_conflict') {
          // Keep the inbox claim uncommitted so a worker crash before RabbitMQ dead-lettering
          // cannot turn the conflict into an acknowledged event-id replay.
          await client.query('rollback');
          return { outcome: fenceOutcome };
        }
        await client.query(
          `update audit.inbox_events
              set processed_at = now()
            where consumer_name = $1 and event_id = $2`,
          [CONSUMER_NAME, event.id],
        );
        await client.query('commit');
        return { outcome: fenceOutcome };
      }
      if (isLifecycleBookingNotificationEvent(event)) {
        await reconcileBookingReminderSchedules({ client, event });
      }
    }

    if (isGameNotificationEvent(event)) {
      const fenceResult = await applyGameNotificationFence({ client, event });
      if (fenceResult.outcome !== 'accepted') {
        if (fenceResult.outcome === 'revision_conflict') {
          await client.query('rollback');
          return { outcome: fenceResult.outcome };
        }
        await client.query(
          `update audit.inbox_events
              set processed_at = now()
            where consumer_name = $1 and event_id = $2`,
          [CONSUMER_NAME, event.id],
        );
        await client.query('commit');
        return { outcome: fenceResult.outcome };
      }
      gameFenceRecipientUserIds = new Set(fenceResult.recipientUserIds);
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
      const recipients = resolveNotificationRecipients(event, selector).filter(
        (recipientUserId) =>
          !gameFenceRecipientUserIds || gameFenceRecipientUserIds.has(recipientUserId),
      );
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
