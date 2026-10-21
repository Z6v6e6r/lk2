import { resolveScenarioIntentStates } from '@phub/database/notification-scenarios';
import { createHash, randomUUID } from 'node:crypto';

import {
  listNotificationFriendCandidates,
  readNotificationGameCandidate,
  withTenantTransaction,
} from '@phub/database';
import {
  notificationScenarioCategory,
  notificationScenarioInputSchema,
  notificationScenarioSchedule,
  type NotificationScenarioInput,
} from '@phub/domain/notification-scenarios';
import {
  gameDomainEventSchema,
  projectGameCard,
  GAME_PLAYER_LEVELS,
  type GameCardProjectionInput,
} from '@phub/games';
import {
  notificationSourceEventSchema,
  quietHoursActive,
  renderNotificationTemplate,
  type NotificationSourceEvent,
} from '@phub/notifications';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

export const SCENARIO_SOURCE_KEYS = [
  'booking.confirmed.v1',
  'booking.changed.v1',
  'booking.cancelled.v1',
  'game.published.v1',
  'game.cancelled.v1',
  'game.participation.confirmed.v1',
] as const;
/** A canonical run join and legacy infinity keep mixed/older workers from bypassing policy. */
export function scenarioDeliveryDueSql(enabled?: boolean): string {
  return enabled
    ? `(d.next_attempt_at <= now() or (d.scenario_available_at <= now() and d.next_attempt_at='infinity'::timestamptz and exists(select 1 from notifications.scenario_runs scenario_run where scenario_run.tenant_id=d.tenant_id and scenario_run.intent_id=d.intent_id and scenario_run.id::text=i.render_data->>'scenarioRunId')))`
    : 'd.next_attempt_at <= now()';
}
export interface ScenarioTransportSettings {
  readonly webPush?: { readonly appId: string; readonly environment: 'SANDBOX' | 'PRODUCTION' };
  readonly androidPush?: { readonly appId: string; readonly environment: 'SANDBOX' | 'PRODUCTION' };
}
interface ScenarioRow extends QueryResultRow {
  id: string;
  version: number;
  definition: NotificationScenarioInput;
  template_id: string;
}
interface ContextRow extends QueryResultRow {
  target_id: string;
  revision: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  source_event_id: string;
  recipient_cursor: string | null;
}
interface RunRow extends QueryResultRow {
  id: string;
  scenario_id: string;
  scenario_version: number;
  recipient_user_id: string;
  target_id: string;
  source_event_id: string;
  context_kind: 'BOOKING' | 'GAME';
  context_revision: string;
  state: string;
  reason: string | null;
  due_at: Date;
  expires_at: Date;
  intent_id: string | null;
  goal_state: string;
  goal_deadline: Date | null;
  queued_at: Date | null;
  rendered_title: string;
  rendered_body: string;
  deep_link: string;
  definition: NotificationScenarioInput;
  template_id: string;
  active: boolean;
  current_version: number;
}
interface Preference extends QueryResultRow {
  channel: string;
  enabled: boolean;
  quiet_from: string | null;
  quiet_until: string | null;
  timezone: string;
}

export function nextScenarioPushTime(
  now: Date,
  preference: Pick<Preference, 'quiet_from' | 'quiet_until' | 'timezone'>,
): Date {
  if (!preference.quiet_from || !preference.quiet_until) return now;
  if (
    !quietHoursActive({
      now,
      quietFrom: preference.quiet_from,
      quietUntil: preference.quiet_until,
      timezone: preference.timezone,
    })
  )
    return now;
  // Walking UTC minutes honours midnight and DST gaps/folds without guessing a local UTC offset.
  for (let minute = 1; minute <= 2_880; minute++) {
    const candidate = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + minute * 60_000);
    if (
      !quietHoursActive({
        now: candidate,
        quietFrom: preference.quiet_from,
        quietUntil: preference.quiet_until,
        timezone: preference.timezone,
      })
    )
      return candidate;
  }
  throw new Error('SCENARIO_QUIET_WINDOW_INVALID');
}

export function matchesFriendScenario(
  snapshot: GameCardProjectionInput,
  userId: string,
  preference: {
    favorite_station_ids: readonly string[];
    preferred_time_windows: readonly { weekday: string; startsAt: string; endsAt: string }[];
    level_label: string | null;
  },
  now: Date,
): boolean {
  const card = projectGameCard(snapshot, {
    surface: 'DISCOVER',
    now: now.toISOString(),
    viewerUserId: userId,
  });
  if (card.viewerRelation !== 'NONE' || !card.allowedActions.includes('JOIN')) return false;
  if (
    preference.favorite_station_ids.length &&
    !preference.favorite_station_ids.includes(card.station.id)
  )
    return false;
  if (card.levelRange) {
    const level = GAME_PLAYER_LEVELS.indexOf(
      preference.level_label as (typeof GAME_PLAYER_LEVELS)[number],
    );
    if (level < 0) return false; // Recommendations do not guess an unknown player's level.
    const from = card.levelRange.from ? GAME_PLAYER_LEVELS.indexOf(card.levelRange.from) : 0;
    const to = card.levelRange.to
      ? GAME_PLAYER_LEVELS.indexOf(card.levelRange.to)
      : GAME_PLAYER_LEVELS.length - 1;
    if (level < from || level > to) return false;
  }
  if (preference.preferred_time_windows.length) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: card.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(card.startsAt))
        .map((p) => [p.type, p.value]),
    );
    const weekday = parts.weekday?.toUpperCase();
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    const minutes = (text: string): number =>
      Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
    if (
      !preference.preferred_time_windows.some(
        (w) => w.weekday === weekday && minute >= minutes(w.startsAt) && minute < minutes(w.endsAt),
      )
    )
      return false;
  }
  return true;
}

async function scenarios(client: PoolClient, tenantId: string): Promise<ScenarioRow[]> {
  const result = await client.query<ScenarioRow>(
    `select s.id,s.version,s.definition,v.template_id from notifications.scenarios s join notifications.scenario_versions v on v.tenant_id=s.tenant_id and v.scenario_id=s.id and v.version=s.version where s.tenant_id=$1 and s.active=true order by s.id`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    ...row,
    definition: notificationScenarioInputSchema.parse(row.definition),
  }));
}
async function timeout(client: PoolClient): Promise<void> {
  await client.query(
    "select set_config('lock_timeout','5s',true),set_config('statement_timeout','20s',true)",
  );
}
async function addRun(
  client: PoolClient,
  event: NotificationSourceEvent,
  scenario: ScenarioRow,
  userId: string,
  data: { serviceTitle: string; startsAt: string; locationName: string; gameId: string },
  kind: 'BOOKING' | 'GAME',
  revision: string,
): Promise<void> {
  const rendered = renderNotificationTemplate({
    titleTemplate: scenario.definition.title,
    bodyTemplate: scenario.definition.body,
    payload: data,
  });
  const schedule = notificationScenarioSchedule({
    definition: scenario.definition,
    occurredAt: event.occurredAt,
    startsAt: data.startsAt,
  });
  await client.query(
    `insert into notifications.scenario_runs(tenant_id,scenario_id,scenario_version,recipient_user_id,target_id,source_event_id,context_kind,context_revision,rendered_title,rendered_body,deep_link,due_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13) on conflict(tenant_id,scenario_id,source_event_id,recipient_user_id) do nothing`,
    [
      event.tenantId,
      scenario.id,
      scenario.version,
      userId,
      event.aggregateId,
      event.id,
      kind,
      revision,
      rendered.title,
      rendered.body,
      kind === 'GAME' ? `/games/${event.aggregateId}` : '/bookings',
      schedule.dueAt,
      schedule.expiresAt,
    ],
  );
}

export async function ingestNotificationScenarioEvent(
  pool: Pool,
  raw: unknown,
): Promise<'APPLIED' | 'DUPLICATE' | 'STALE'> {
  const event = notificationSourceEventSchema.parse(raw);
  const payload = event.payload as Record<string, unknown>;
  if (!SCENARIO_SOURCE_KEYS.includes(event.type as (typeof SCENARIO_SOURCE_KEYS)[number]))
    throw new Error('SCENARIO_EVENT_UNSUPPORTED');
  if (event.type.startsWith('game.')) gameDomainEventSchema.parse(raw);
  return withTenantTransaction(pool, event.tenantId, async (client) => {
    await timeout(client);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scenario-admin:${event.tenantId}`,
    ]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scenario-target:${event.tenantId}:${event.aggregateId}`,
    ]);
    const inbox = await client.query(
      `insert into audit.inbox_events(consumer_name,event_id,tenant_id) values('notification-scenarios.v1',$1,$2) on conflict(consumer_name,event_id) do nothing returning event_id`,
      [event.id, event.tenantId],
    );
    if (inbox.rowCount === 0) return 'DUPLICATE';
    if (event.type === 'game.participation.confirmed.v1') {
      // The current owner row also covers a goal fact arriving before its invitation/run.
      await client.query(
        `update notifications.scenario_runs r set goal_state='ACHIEVED',goal_achieved_at=$4,goal_event_id=$5,updated_at=now() where r.tenant_id=$1 and r.target_id=$2 and r.recipient_user_id=$3 and r.context_kind='GAME' and r.goal_state in ('WAITING','EXPIRED') and r.queued_at<=$4::timestamptz and r.goal_deadline>=$4::timestamptz and exists(select 1 from games.participations p where p.tenant_id=$1 and p.game_id=$2 and p.user_id=$3 and p.id=$6)`,
        [
          event.tenantId,
          event.aggregateId,
          event.payload.userId,
          event.occurredAt,
          event.id,
          event.payload.participationId,
        ],
      );
      await suppressPendingDeliveries(
        client,
        event.tenantId,
        event.aggregateId,
        'GOAL_ACHIEVED',
        event.payload.userId as string,
      );
    } else if (event.type === 'game.cancelled.v1') {
      await client.query(
        `update notifications.scenario_runs set state=case when state='PENDING' then 'CANCELLED' else state end,reason='GAME_CANCELLED',updated_at=now() where tenant_id=$1 and target_id=$2 and context_kind='GAME' and state in ('PENDING','QUEUED')`,
        [event.tenantId, event.aggregateId],
      );
      await suppressPendingDeliveries(client, event.tenantId, event.aggregateId, 'GAME_CANCELLED');
      await client.query(
        `update notifications.scenario_contexts set fanout_pending=false where tenant_id=$1 and target_id=$2 and kind='GAME'`,
        [event.tenantId, event.aggregateId],
      );
    } else {
      const kind = event.type.startsWith('booking.') ? 'BOOKING' : 'GAME';
      const revision = String(kind === 'BOOKING' ? payload.revision : payload.aggregateRevision);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ type: event.type, payload: event.payload }))
        .digest('hex');
      const current = await client.query<ContextRow>(
        `select * from notifications.scenario_contexts where tenant_id=$1 and target_id=$2 and kind=$3 for update`,
        [event.tenantId, event.aggregateId, kind],
      );
      if (current.rows[0] && BigInt(current.rows[0].revision) > BigInt(revision)) {
        await client.query(
          `update audit.inbox_events set processed_at=now() where consumer_name='notification-scenarios.v1' and event_id=$1`,
          [event.id],
        );
        return 'STALE';
      }
      if (current.rows[0] && current.rows[0].revision === revision) {
        const previous = current.rows[0] as ContextRow & { fingerprint: string };
        if (previous.fingerprint !== fingerprint) throw new Error('SCENARIO_REVISION_CONFLICT');
        await client.query(
          `update audit.inbox_events set processed_at=now() where consumer_name='notification-scenarios.v1' and event_id=$1`,
          [event.id],
        );
        return 'DUPLICATE';
      }
      const active = await scenarios(client, event.tenantId);
      const data =
        kind === 'BOOKING'
          ? {
              serviceTitle: String(payload.serviceTitle),
              startsAt: String(payload.startsAt),
              locationName: String(payload.locationName),
              gameId: '',
            }
          : {
              ...event.payload,
              scenarioVersions: active
                .filter((s) => s.definition.trigger === 'FRIEND_GAME_PUBLISHED')
                .map((s) => ({ id: s.id, version: s.version })),
            };
      await client.query(
        `insert into notifications.scenario_contexts(tenant_id,target_id,kind,revision,event_type,fingerprint,payload,occurred_at,source_event_id,fanout_pending) values($1,$2,$3,$4::numeric,$5,$6,$7::jsonb,$8,$9,$10) on conflict(tenant_id,kind,target_id) do update set revision=excluded.revision,event_type=excluded.event_type,fingerprint=excluded.fingerprint,payload=excluded.payload,occurred_at=excluded.occurred_at,source_event_id=excluded.source_event_id,fanout_pending=excluded.fanout_pending,recipient_cursor=null`,
        [
          event.tenantId,
          event.aggregateId,
          kind,
          revision,
          event.type,
          fingerprint,
          JSON.stringify(data),
          event.occurredAt,
          event.id,
          kind === 'GAME',
        ],
      );
      if (kind === 'BOOKING') {
        await client.query(
          `update notifications.scenario_runs set state=case when state='PENDING' then 'CANCELLED' else state end,reason='SOURCE_CHANGED',updated_at=now() where tenant_id=$1 and target_id=$2 and context_kind='BOOKING' and context_revision<$3::numeric and state in ('PENDING','QUEUED')`,
          [event.tenantId, event.aggregateId, revision],
        );
        await suppressPendingDeliveries(
          client,
          event.tenantId,
          event.aggregateId,
          'SOURCE_CHANGED',
        );
        const trigger =
          event.type === 'booking.confirmed.v1'
            ? 'BOOKING_CONFIRMED'
            : event.type === 'booking.changed.v1'
              ? 'BOOKING_CHANGED'
              : 'BOOKING_CANCELLED';
        const recipients = payload.recipientUserIds as string[];
        for (const scenario of active.filter(
          (s) =>
            s.definition.trigger === trigger ||
            (s.definition.trigger === 'BOOKING_STARTS' && trigger !== 'BOOKING_CANCELLED'),
        )) {
          for (const userId of recipients)
            await addRun(
              client,
              event,
              scenario,
              userId,
              data as {
                serviceTitle: string;
                startsAt: string;
                locationName: string;
                gameId: string;
              },
              kind,
              revision,
            );
        }
      }
    }
    await client.query(
      `update audit.inbox_events set processed_at=now() where consumer_name='notification-scenarios.v1' and event_id=$1`,
      [event.id],
    );
    return 'APPLIED';
  });
}
async function suppressPendingDeliveries(
  client: PoolClient,
  tenantId: string,
  targetId: string,
  reason: string,
  userId?: string,
): Promise<void> {
  const suppressed = await client.query<{ intent_id: string }>(
    `update notifications.deliveries d set state='SUPPRESSED',last_error_code=$3,completed_at=now(),updated_at=now() from notifications.scenario_runs r where r.tenant_id=$1 and r.target_id=$2 and ($4::uuid is null or r.recipient_user_id=$4) and d.tenant_id=r.tenant_id and d.intent_id=r.intent_id and d.state='PENDING' returning d.intent_id`,
    [tenantId, targetId, reason, userId ?? null],
  );
  await resolveScenarioIntentStates(
    client,
    tenantId,
    suppressed.rows.map((row) => row.intent_id),
  );
}

async function fanoutFriendGames(client: PoolClient, tenantId: string, now: Date): Promise<void> {
  const contexts = await client.query<ContextRow>(
    `select * from notifications.scenario_contexts where tenant_id=$1 and kind='GAME' and fanout_pending=true order by occurred_at,target_id for update skip locked limit 1`,
    [tenantId],
  );
  for (const context of contexts.rows) {
    const snapshot = await readNotificationGameCandidate(
      client,
      tenantId,
      context.target_id,
      context.revision,
    );
    if (!snapshot) {
      // Projection lag is retryable. A terminal/cancelled canonical game or old event is not.
      const owner = await client.query(
        `select 1 from games.games where tenant_id=$1 and id=$2 and lifecycle_state='SCHEDULED' and visibility='PUBLIC' and starts_at>now()`,
        [tenantId, context.target_id],
      );
      if (
        owner.rowCount === 0 ||
        now.getTime() - new Date(context.occurred_at).getTime() > 86_400_000
      )
        await client.query(
          `update notifications.scenario_contexts set fanout_pending=false where tenant_id=$1 and kind='GAME' and target_id=$2`,
          [tenantId, context.target_id],
        );
      continue;
    }
    const active = (await scenarios(client, tenantId)).filter(
      (s) =>
        s.definition.trigger === 'FRIEND_GAME_PUBLISHED' &&
        (context.payload.scenarioVersions as { id: string; version: number }[]).some(
          (v) => v.id === s.id && v.version === s.version,
        ),
    );
    const candidates = await listNotificationFriendCandidates(client, {
      tenantId,
      organizerUserId: snapshot.organizerUserId,
      after: context.recipient_cursor,
    });
    const event: NotificationSourceEvent = {
      id: context.source_event_id,
      type: 'game.published.v1',
      tenantId,
      aggregateId: context.target_id,
      occurredAt: new Date(context.occurred_at).toISOString(),
      correlationId: `scenario-${context.source_event_id}`,
      payload: {},
    };
    for (const recipient of candidates) {
      if (!matchesFriendScenario(snapshot, recipient.user_id, recipient, now)) continue;
      for (const scenario of active)
        await addRun(
          client,
          event,
          scenario,
          recipient.user_id,
          {
            serviceTitle: snapshot.title,
            startsAt: snapshot.startsAt,
            locationName: snapshot.station.name,
            gameId: context.target_id,
          },
          'GAME',
          context.revision,
        );
    }
    await client.query(
      `update notifications.scenario_contexts set fanout_pending=$3,recipient_cursor=$4 where tenant_id=$1 and kind='GAME' and target_id=$2`,
      [
        tenantId,
        context.target_id,
        candidates.length === 100,
        candidates.at(-1)?.user_id ?? context.recipient_cursor,
      ],
    );
  }
}

async function runValidity(
  client: PoolClient,
  tenantId: string,
  run: RunRow,
  now: Date,
): Promise<string | null> {
  if (!run.active || run.current_version !== run.scenario_version) return 'SCENARIO_REVISED';
  if (new Date(run.expires_at).getTime() <= now.getTime()) return 'MESSAGE_EXPIRED';
  if (run.goal_state === 'ACHIEVED') return 'GOAL_ACHIEVED';
  const active = await client.query(
    `select 1 from identity.users where tenant_id=$1 and id=$2 and status='ACTIVE'`,
    [tenantId, run.recipient_user_id],
  );
  if (active.rowCount !== 1) return 'RECIPIENT_INACTIVE';
  if (run.context_kind === 'BOOKING') {
    const context = await client.query<{
      revision: string;
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `select revision::text,event_type,payload from notifications.scenario_contexts where tenant_id=$1 and kind='BOOKING' and target_id=$2`,
      [tenantId, run.target_id],
    );
    if (context.rows[0]?.revision !== run.context_revision) return 'SOURCE_CHANGED';
    const fence = await client.query<{ revision: string }>(
      `select lifecycle_revision::text revision from notifications.booking_notification_projection_fences where tenant_id=$1 and booking_id=$2`,
      [tenantId, run.target_id],
    );
    if (fence.rows[0] && BigInt(fence.rows[0].revision) > BigInt(run.context_revision))
      return 'SOURCE_CHANGED';
  } else {
    const snapshot = await readNotificationGameCandidate(
      client,
      tenantId,
      run.target_id,
      run.context_revision,
    );
    if (!snapshot) return 'GAME_UNAVAILABLE';
    const recipient = (
      await listNotificationFriendCandidates(client, {
        tenantId,
        organizerUserId: snapshot.organizerUserId,
        after: null,
        onlyUserId: run.recipient_user_id,
      })
    )[0];
    if (!recipient || !matchesFriendScenario(snapshot, run.recipient_user_id, recipient, now))
      return 'AUDIENCE_CHANGED';
  }
  return null;
}
async function preferences(
  client: PoolClient,
  tenantId: string,
  run: RunRow,
): Promise<Preference[]> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${tenantId}:NOTIFICATION_PREFERENCES:${run.recipient_user_id}`,
  ]);
  const result = await client.query<Preference>(
    `select channel,enabled,left(quiet_from::text,5) quiet_from,left(quiet_until::text,5) quiet_until,timezone from notifications.user_preferences where tenant_id=$1 and user_id=$2 and category=$3`,
    [tenantId, run.recipient_user_id, notificationScenarioCategory(run.definition)],
  );
  if (!result.rows.some((row) => row.channel === 'PUSH')) {
    // The Web settings expose one quiet window; new categories inherit the last saved window.
    const quiet = await client.query<Preference>(
      `select 'PUSH' channel,true enabled,left(quiet_from::text,5) quiet_from,left(quiet_until::text,5) quiet_until,timezone from notifications.user_preferences where tenant_id=$1 and user_id=$2 and channel='PUSH' order by updated_at desc,category limit 1`,
      [tenantId, run.recipient_user_id],
    );
    result.rows.push(...quiet.rows);
  }
  return result.rows;
}
async function queueRun(
  client: PoolClient,
  tenantId: string,
  run: RunRow,
  settings: ScenarioTransportSettings,
  now: Date,
): Promise<void> {
  const reason = await runValidity(client, tenantId, run, now);
  if (reason) {
    await client.query(
      `update notifications.scenario_runs set state=$3,reason=$4,updated_at=now() where tenant_id=$1 and id=$2`,
      [tenantId, run.id, reason === 'MESSAGE_EXPIRED' ? 'EXPIRED' : 'CANCELLED', reason],
    );
    return;
  }
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
    `scenario-recipient:${tenantId}:${run.recipient_user_id}`,
  ]);
  const category = notificationScenarioCategory(run.definition);
  const prefs = await preferences(client, tenantId, run);
  const enabled = (channel: string): boolean =>
    prefs.find((p) => p.channel === channel)?.enabled !== false;
  const runtime = (
    await client.query<{
      in_app_enabled: boolean;
      web_push_enabled: boolean;
      android_push_enabled: boolean;
    }>(
      `select in_app_enabled,web_push_enabled,android_push_enabled from notifications.tenant_runtime_settings where tenant_id=$1`,
      [tenantId],
    )
  ).rows[0];
  const inApp =
    run.definition.channels.includes('IN_APP') &&
    enabled('IN_APP') &&
    runtime?.in_app_enabled === true;
  if (run.definition.goal !== 'NONE' && !inApp) {
    await client.query(
      `update notifications.scenario_runs set state='SUPPRESSED',reason='NO_ALLOWED_CHANNEL',updated_at=now() where tenant_id=$1 and id=$2`,
      [tenantId, run.id],
    );
    return;
  }
  if (category === 'GAME_RECOMMENDATION') {
    const sent = await client.query<{ count: string; duplicate: boolean }>(
      `select count(*)::text count,coalesce(bool_or(r.target_id=$3),false) duplicate from notifications.scenario_runs r join notifications.scenario_versions v on v.tenant_id=r.tenant_id and v.scenario_id=r.scenario_id and v.version=r.scenario_version where r.tenant_id=$1 and r.recipient_user_id=$2 and r.queued_at>$4::timestamptz-interval '24 hours' and v.definition->>'trigger'='FRIEND_GAME_PUBLISHED'`,
      [tenantId, run.recipient_user_id, run.target_id, now],
    );
    const count = sent.rows[0];
    if (
      count &&
      (count.duplicate || Number(count.count) >= Math.min(run.definition.dailyLimit, 3))
    ) {
      await client.query(
        `update notifications.scenario_runs set state='SUPPRESSED',reason=$3,updated_at=now() where tenant_id=$1 and id=$2`,
        [tenantId, run.id, count.duplicate ? 'DUPLICATE_INVITATION' : 'FREQUENCY_LIMIT'],
      );
      return;
    }
  }
  const preference = prefs.find((p) => p.channel === 'PUSH');
  const nextPush = preference ? nextScenarioPushTime(now, preference) : now;
  const quiet = nextPush.getTime() > now.getTime();
  const allowPush =
    enabled('PUSH') &&
    (!quiet || run.definition.quietHours === 'DEFER') &&
    nextPush < new Date(run.expires_at);
  let endpoint: { id: string } | undefined;
  if (allowPush)
    for (const channel of run.definition.channels) {
      const configuration =
        channel === 'WEB_PUSH' && runtime?.web_push_enabled
          ? settings.webPush
          : channel === 'ANDROID_PUSH' && inApp && runtime?.android_push_enabled
            ? settings.androidPush
            : undefined;
      if (!configuration) continue;
      const result = await client.query<{ id: string }>(
        `select e.id from integration.notification_endpoints e join integration.notification_provider_accounts a on a.tenant_id=e.tenant_id and a.id=e.provider_account_id where e.tenant_id=$1 and e.user_id=$2 and e.channel='PUSH' and e.status='ACTIVE' and a.status='ACTIVE' and a.platform=$3 and a.app_id=$4 and a.environment=$5 and a.provider=$6 order by e.updated_at desc,e.id limit 1`,
        [
          tenantId,
          run.recipient_user_id,
          channel === 'WEB_PUSH' ? 'WEB' : 'ANDROID',
          configuration.appId,
          configuration.environment,
          channel === 'WEB_PUSH' ? 'WEB_PUSH' : 'FCM',
        ],
      );
      endpoint = result.rows[0];
      if (endpoint) break;
    }
  if (!inApp && !endpoint) {
    await client.query(
      `update notifications.scenario_runs set state='SUPPRESSED',reason=$3,updated_at=now() where tenant_id=$1 and id=$2`,
      [tenantId, run.id, quiet ? 'QUIET_HOURS' : 'NO_ALLOWED_CHANNEL'],
    );
    return;
  }
  const intentId = randomUUID();
  await client.query(
    `insert into notifications.intents(tenant_id,id,recipient_user_id,source_event_id,template_id,dedupe_key,render_data,rendered_title,rendered_body,rendered_deep_link,state,completed_at) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,case when $11='DELIVERED' then now() else null end)`,
    [
      tenantId,
      intentId,
      run.recipient_user_id,
      run.source_event_id,
      run.template_id,
      `scenario:${run.id}`,
      JSON.stringify({ scenarioRunId: run.id }),
      run.rendered_title,
      run.rendered_body,
      run.deep_link,
      endpoint ? 'PROCESSING' : 'DELIVERED',
    ],
  );
  if (inApp) {
    await client.query(
      `insert into notifications.inbox_items(tenant_id,intent_id,user_id,category,title,body,deep_link) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenantId,
        intentId,
        run.recipient_user_id,
        category,
        run.rendered_title,
        run.rendered_body,
        run.deep_link,
      ],
    );
    await client.query(
      `insert into notifications.deliveries(tenant_id,intent_id,channel,state,completed_at) values($1,$2,'IN_APP','DELIVERED',now())`,
      [tenantId, intentId],
    );
  }
  if (endpoint)
    await client.query(
      `insert into notifications.deliveries(tenant_id,intent_id,channel,endpoint_id,next_attempt_at,scenario_available_at) values($1,$2,'PUSH',$3,'infinity'::timestamptz,$4)`,
      [tenantId, intentId, endpoint.id, nextPush],
    );
  const deadline = new Date(
    Math.min(
      now.getTime() + run.definition.goalWindowMinutes * 60_000,
      new Date(run.expires_at).getTime(),
    ),
  );
  await client.query(
    `update notifications.scenario_runs set state='QUEUED',reason=$3,intent_id=$4,queued_at=$5,goal_state=$6,goal_deadline=$7,updated_at=now() where tenant_id=$1 and id=$2`,
    [
      tenantId,
      run.id,
      quiet && endpoint ? 'QUIET_HOURS_DEFERRED' : endpoint ? null : 'IN_APP_ONLY',
      intentId,
      now,
      run.definition.goal === 'NONE' ? 'NONE' : 'WAITING',
      run.definition.goal === 'NONE' ? null : deadline,
    ],
  );
  await client.query(
    `insert into audit.outbox_events(tenant_id,event_type,aggregate_id,correlation_id,payload) values($1,'notifications.intent.created.v1',$2,$3,$4::jsonb)`,
    [tenantId, intentId, `scenario-${run.id}`, JSON.stringify({ intentId, scenarioRunId: run.id })],
  );
}

const runSelect = `select r.*,v.definition,v.template_id,s.active,s.version current_version from notifications.scenario_runs r join notifications.scenario_versions v on v.tenant_id=r.tenant_id and v.scenario_id=r.scenario_id and v.version=r.scenario_version join notifications.scenarios s on s.tenant_id=r.tenant_id and s.id=r.scenario_id`;
export async function runNotificationScenarioBatch(
  options: ScenarioTransportSettings & {
    readonly pool: Pool;
    readonly tenantId: string;
    readonly now?: Date;
  },
): Promise<number> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await timeout(client);
    const now = options.now ?? new Date();
    // Shared admin lock defines pause/revision ordering before handing work to transport.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scenario-admin:${options.tenantId}`,
    ]);
    await fanoutFriendGames(client, options.tenantId, now);
    const runs = await client.query<RunRow>(
      `${runSelect} where r.tenant_id=$1 and r.state='PENDING' and least(r.due_at,r.expires_at)<=$2 order by least(r.due_at,r.expires_at),r.id for update of r skip locked limit 20`,
      [options.tenantId, now],
    );
    for (const run of runs.rows) await queueRun(client, options.tenantId, run, options, now);
    await client.query(
      `update notifications.scenario_runs set goal_state='EXPIRED',updated_at=now() where tenant_id=$1 and goal_state='WAITING' and goal_deadline<$2`,
      [options.tenantId, now],
    );
    return runs.rowCount ?? 0;
  });
}

/** Final policy gate after claim, immediately before the transport call. No network is called here. */
export async function checkScenarioPushDelivery(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly attemptNo: number;
  readonly enabled: boolean;
  readonly now?: Date;
}): Promise<'SEND' | 'DEFERRED' | 'SUPPRESSED' | 'STALE'> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await timeout(client);
    const marker = await client.query<{ run_id: string | null }>(
      `select i.render_data->>'scenarioRunId' run_id from notifications.deliveries d join notifications.intents i on i.tenant_id=d.tenant_id and i.id=d.intent_id where d.tenant_id=$1 and d.id=$2`,
      [options.tenantId, options.deliveryId],
    );
    if (!marker.rows[0]?.run_id) return 'SEND';
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scenario-admin:${options.tenantId}`,
    ]);
    const run = (
      await client.query<RunRow>(`${runSelect} where r.tenant_id=$1 and r.id=$2 for update of r`, [
        options.tenantId,
        marker.rows[0].run_id,
      ])
    ).rows[0];
    const now = options.now ?? new Date();
    let reason = !options.enabled
      ? 'SCENARIO_RUNTIME_DISABLED'
      : !run
        ? 'SCENARIO_NOT_FOUND'
        : run.state !== 'QUEUED'
          ? 'SCENARIO_CANCELLED'
          : await runValidity(client, options.tenantId, run, now);
    let nextPush = now;
    if (!reason && run) {
      const pref = (await preferences(client, options.tenantId, run)).find(
        (p) => p.channel === 'PUSH',
      );
      if (pref?.enabled === false) reason = 'OPTED_OUT';
      if (pref) nextPush = nextScenarioPushTime(now, pref);
      if (
        nextPush > now &&
        (run.definition.quietHours === 'SKIP' || nextPush >= new Date(run.expires_at))
      )
        reason = 'QUIET_HOURS';
    }
    const claim = await client.query(
      `select 1 from notifications.deliveries where tenant_id=$1 and id=$2 and state='SENDING' and attempt_count=$3 and lease_expires_at>clock_timestamp() for update`,
      [options.tenantId, options.deliveryId, options.attemptNo],
    );
    if (claim.rowCount !== 1) return 'STALE';
    if (!reason && nextPush <= now) {
      // Policy checks can wait for locks: give the single bounded provider call a fresh lease.
      const renewed = await client.query(
        `update notifications.deliveries set lease_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where tenant_id=$1 and id=$2 and state='SENDING' and attempt_count=$3 and lease_expires_at>clock_timestamp() returning 1`,
        [options.tenantId, options.deliveryId, options.attemptNo],
      );
      if (renewed.rowCount !== 1) return 'STALE';
      return 'SEND';
    }
    const result = await client.query<{ intent_id: string }>(
      `update notifications.deliveries set state=$4,next_attempt_at='infinity'::timestamptz,scenario_available_at=$5,completed_at=case when $4='SUPPRESSED' then now() else null end,lease_expires_at=null,attempt_count=attempt_count-1,last_error_code=$6,updated_at=now() where tenant_id=$1 and id=$2 and state='SENDING' and attempt_count=$3 returning intent_id`,
      [
        options.tenantId,
        options.deliveryId,
        options.attemptNo,
        reason ? 'SUPPRESSED' : 'PENDING',
        nextPush,
        reason ?? 'QUIET_HOURS_DEFERRED',
      ],
    );
    if (result.rowCount !== 1) return 'STALE';
    if (reason && run)
      await client.query(
        `update notifications.scenario_runs set reason=$3,updated_at=now() where tenant_id=$1 and id=$2`,
        [options.tenantId, run.id, reason],
      );
    await resolveScenarioIntentStates(client, options.tenantId, [result.rows[0]!.intent_id]);
    return reason ? 'SUPPRESSED' : 'DEFERRED';
  });
}
