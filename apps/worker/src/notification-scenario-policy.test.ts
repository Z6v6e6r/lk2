import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { NotificationScenarioInput } from '@phub/domain/notification-scenarios';
import type { GameCardProjectionInput } from '@phub/games';

const owner = vi.hoisted(() => ({
  readNotificationGameCandidate: vi.fn(),
  listNotificationFriendCandidates: vi.fn(),
}));
vi.mock('@phub/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...owner,
}));
import {
  checkScenarioPushDelivery,
  matchesFriendScenario,
  runNotificationScenarioBatch,
} from './notification-scenarios.js';

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  game: '22222222-2222-4222-8222-222222222222',
  user: '33333333-3333-4333-8333-333333333333',
  organizer: '44444444-4444-4444-8444-444444444444',
  station: '55555555-5555-4555-8555-555555555555',
  run: '66666666-6666-4666-8666-666666666666',
};
const now = new Date('2026-10-21T21:30:00Z');
const snapshot: GameCardProjectionInput = {
  id: ids.game,
  tenantId: ids.tenant,
  revision: 1,
  organizerUserId: ids.organizer,
  title: 'Синтетическая игра',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  lifecycleState: 'SCHEDULED',
  startsAt: '2026-10-22T16:00:00Z',
  endsAt: '2026-10-22T17:30:00Z',
  timezone: 'Europe/Moscow',
  station: { id: ids.station, name: 'Клуб', shortAddress: null },
  court: null,
  levelRange: { from: 'C', to: 'B' },
  capacity: 4,
  participants: [
    {
      userId: ids.organizer,
      displayName: 'Организатор',
      role: 'ORGANIZER',
      paymentState: 'NOT_REQUIRED',
    },
  ],
  seatReservations: [],
  waitlist: [],
  waitlistEnabled: false,
  joinCutoffAt: null,
  priceSummary: null,
};
const candidate = {
  user_id: ids.user,
  favorite_station_ids: [ids.station],
  preferred_time_windows: [{ weekday: 'THU', startsAt: '18:00', endsAt: '21:00' }],
  level_label: 'C',
};
const definition: NotificationScenarioInput = {
  name: 'Друг создал игру',
  trigger: 'FRIEND_GAME_PUBLISHED',
  delayMinutes: 0,
  ttlMinutes: 1440,
  title: 'Приглашение',
  body: 'Приходите в игру',
  channels: ['IN_APP', 'WEB_PUSH'],
  quietHours: 'DEFER',
  dailyLimit: 1,
  goal: 'NONE',
  goalWindowMinutes: 60,
  active: true,
};
function run(patch: Record<string, unknown> = {}) {
  return {
    id: ids.run,
    scenario_id: ids.run,
    scenario_version: 1,
    recipient_user_id: ids.user,
    target_id: ids.game,
    source_event_id: ids.game,
    context_kind: 'GAME',
    context_revision: '1',
    state: 'PENDING',
    reason: null,
    due_at: now,
    expires_at: new Date('2026-10-22T16:00:00Z'),
    intent_id: null,
    goal_state: 'NONE',
    goal_deadline: null,
    queued_at: null,
    rendered_title: 'Приглашение',
    rendered_body: 'Текст',
    deep_link: `/games/${ids.game}`,
    definition,
    template_id: ids.game,
    active: true,
    current_version: 1,
    ...patch,
  };
}
function fixture(
  options: {
    prefs?: unknown[];
    fallback?: {
      channel: string;
      enabled: boolean;
      quiet_from: string;
      quiet_until: string;
      timezone: string;
    }[];
    inApp?: boolean;
    run?: Record<string, unknown>;
    lease?: boolean;
    renewal?: boolean;
    currentVersion?: number;
  } = {},
) {
  owner.readNotificationGameCandidate.mockResolvedValue(snapshot);
  owner.listNotificationFriendCandidates.mockResolvedValue([candidate]);
  const source = run(options.run);
  const query = vi.fn((sql: string, _values: unknown[] = []) => {
    void _values;
    let rows: unknown[] = [];
    let rowCount = 1;
    if (sql.includes('render_data->>')) rows = [{ run_id: ids.run }];
    else if (sql.includes('select r.*,v.definition')) rows = [source];
    else if (sql.includes('from notifications.scenario_contexts') && sql.includes('fanout_pending'))
      rows = [];
    else if (sql.includes('from identity.users')) rows = [{}];
    else if (sql.includes('from notifications.user_preferences'))
      rows = sql.includes('order by updated_at')
        ? (options.fallback ?? []).map((row) => ({ ...row, enabled: sql.includes('true enabled') }))
        : (options.prefs ?? []);
    else if (sql.includes('from notifications.tenant_runtime_settings'))
      rows = [
        {
          in_app_enabled: options.inApp !== false,
          web_push_enabled: true,
          android_push_enabled: true,
        },
      ];
    else if (sql.includes('coalesce(bool_or')) rows = [{ count: '0', duplicate: false }];
    else if (sql.includes('select e.id from integration.notification_endpoints'))
      rows = [{ id: ids.game }];
    else if (sql.includes("state='SENDING'") && sql.includes('for update')) {
      rows = options.lease === false ? [] : [{}];
      rowCount = rows.length;
    } else if (sql.includes("lease_expires_at=clock_timestamp()+interval '60 seconds'"))
      rowCount = options.renewal === false ? 0 : 1;
    else if (sql.includes('returning intent_id')) rows = [{ intent_id: ids.game }];
    return Promise.resolve({ rows, rowCount });
  });
  const pool = { connect: () => Promise.resolve({ query, release: vi.fn() }) } as unknown as Pool;
  return { pool, query, source };
}
const transport = {
  webPush: { appId: 'synthetic.web', environment: 'SANDBOX' as const },
  androidPush: { appId: 'synthetic.android', environment: 'SANDBOX' as const },
};
describe('scenario recipient policy', () => {
  it('matches an explicit station, local time and known level', () =>
    expect(matchesFriendScenario(snapshot, ids.user, candidate, now)).toBe(true));
  it.each([
    { favorite_station_ids: ['00000000-0000-4000-8000-000000000000'] },
    { level_label: 'D' },
    { level_label: null },
    { preferred_time_windows: [{ weekday: 'MON', startsAt: '18:00', endsAt: '21:00' }] },
  ])('rejects a current preference mismatch %j', (patch) =>
    expect(matchesFriendScenario(snapshot, ids.user, { ...candidate, ...patch }, now)).toBe(false),
  );
  it('does not invite a current participant', () =>
    expect(
      matchesFriendScenario(
        {
          ...snapshot,
          participants: [
            ...snapshot.participants,
            {
              userId: ids.user,
              displayName: 'Игрок',
              role: 'PLAYER',
              paymentState: 'NOT_REQUIRED',
            },
          ],
        },
        ids.user,
        candidate,
        now,
      ),
    ).toBe(false));
  it('does not invite when no joinable capacity remains', () =>
    expect(
      matchesFriendScenario(
        {
          ...snapshot,
          capacity: 2,
          participants: [
            ...snapshot.participants,
            {
              userId: '77777777-7777-4777-8777-777777777777',
              displayName: 'Игрок',
              role: 'PLAYER',
              paymentState: 'NOT_REQUIRED',
            },
          ],
        },
        ids.user,
        candidate,
        now,
      ),
    ).toBe(false));
  it('inherits an established quiet window for a newly enabled recommendation category', async () => {
    const f = fixture({
      fallback: [
        {
          channel: 'PUSH',
          enabled: false,
          quiet_from: '23:00',
          quiet_until: '08:00',
          timezone: 'Europe/Moscow',
        },
      ],
    });
    await runNotificationScenarioBatch({ pool: f.pool, tenantId: ids.tenant, now, ...transport });
    const push = f.query.mock.calls.find(
      ([sql]) =>
        sql.includes('insert into notifications.deliveries') &&
        sql.includes('scenario_available_at'),
    );
    expect(push?.[0]).toContain("'infinity'::timestamptz");
    expect((push?.[1]?.[3] as Date).toISOString()).toBe('2026-10-22T05:00:00.000Z');
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes('insert into notifications.inbox_items')),
    ).toBe(true);
  });
  it('does not enqueue Android when the required actual inbox is opted out', async () => {
    const f = fixture({
      prefs: [{ channel: 'IN_APP', enabled: false }],
      run: { definition: { ...definition, channels: ['IN_APP', 'ANDROID_PUSH'] } },
    });
    await runNotificationScenarioBatch({ pool: f.pool, tenantId: ids.tenant, now, ...transport });
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes('insert into notifications.intents')),
    ).toBe(false);
    expect(
      f.query.mock.calls.some(
        ([sql, values]) =>
          sql.includes("state='SUPPRESSED'") && values?.includes('NO_ALLOWED_CHANNEL'),
      ),
    ).toBe(true);
  });
  it('does not start a goal window without the required actual inbox', async () => {
    const f = fixture({
      inApp: false,
      run: { definition: { ...definition, goal: 'GAME_JOINED' } },
    });
    await runNotificationScenarioBatch({ pool: f.pool, tenantId: ids.tenant, now, ...transport });
    expect(
      f.query.mock.calls.some(([sql]) => sql.includes('insert into notifications.intents')),
    ).toBe(false);
  });
});
describe('final scenario handoff', () => {
  it('renews the owned lease using wall-clock time after policy locks', async () => {
    const f = fixture({ run: { state: 'QUEUED', intent_id: ids.game } });
    expect(
      await checkScenarioPushDelivery({
        pool: f.pool,
        tenantId: ids.tenant,
        deliveryId: ids.game,
        attemptNo: 1,
        enabled: true,
        now,
      }),
    ).toBe('SEND');
    expect(
      f.query.mock.calls.some(
        ([sql]) =>
          sql.includes("lease_expires_at=clock_timestamp()+interval '60 seconds'") &&
          sql.includes('returning 1'),
      ),
    ).toBe(true);
  });
  it('refuses a stale/reclaimed lease without renewing it', async () => {
    const f = fixture({ run: { state: 'QUEUED', intent_id: ids.game }, lease: false });
    expect(
      await checkScenarioPushDelivery({
        pool: f.pool,
        tenantId: ids.tenant,
        deliveryId: ids.game,
        attemptNo: 1,
        enabled: true,
        now,
      }),
    ).toBe('STALE');
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.includes("lease_expires_at=clock_timestamp()+interval '60 seconds'"),
      ),
    ).toBe(false);
  });
  it('refuses handoff when the lease renewal itself loses the ownership fence', async () => {
    const f = fixture({ run: { state: 'QUEUED', intent_id: ids.game }, renewal: false });
    expect(
      await checkScenarioPushDelivery({
        pool: f.pool,
        tenantId: ids.tenant,
        deliveryId: ids.game,
        attemptNo: 1,
        enabled: true,
        now,
      }),
    ).toBe('STALE');
  });
  it('suppresses a current PUSH opt-out and rolls up the terminal intent', async () => {
    const f = fixture({
      run: { state: 'QUEUED', intent_id: ids.game },
      prefs: [{ channel: 'PUSH', enabled: false }],
    });
    expect(
      await checkScenarioPushDelivery({
        pool: f.pool,
        tenantId: ids.tenant,
        deliveryId: ids.game,
        attemptNo: 1,
        enabled: true,
        now,
      }),
    ).toBe('SUPPRESSED');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('with states as'))).toBe(true);
  });
});
