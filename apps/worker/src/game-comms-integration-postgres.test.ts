import { createHash, randomUUID } from 'node:crypto';

import {
  createGameRepository,
  createGameRosterRepository,
  createMessagingRepository,
  type GameMessagingMembershipSourceEventType,
  withTenantTransaction,
} from '@phub/database';
import { notificationSourceEventSchema, type NotificationSourceEvent } from '@phub/notifications';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyNotificationSourceEvent } from './notification-projector.js';

const connectionString = process.env.GAME_COMMS_INTEGRATION_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const applicationName = 'game-comms-integration-postgres-test';
const deadlineMs = 12_000;
const transitionBarrierPrefix = 'game-comms-transition-first-barrier:';

function requestHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertDisposableDatabase(url: string): void {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgresql:', 'postgres:'].includes(parsed.protocol) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    !database.endsWith('_verify')
  ) {
    throw new Error(
      'GAME_COMMS_INTEGRATION_TEST_DATABASE_URL must use a query-free loopback *_verify database',
    );
  }
}

if (connectionString) assertDisposableDatabase(connectionString);

function deadline<TResult>(promise: Promise<TResult>, label: string): Promise<TResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`POSTGRES_TEST_TIMEOUT:${label}`)), deadlineMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function waitForLockWaiters(observer: PoolClient, minimum: number, label: string) {
  const expiresAt = Date.now() + deadlineMs;
  while (Date.now() < expiresAt) {
    const result = await observer.query<{ count: string }>(
      `select count(*)::text as count
         from pg_stat_activity
        where application_name = $1 and pid <> pg_backend_pid() and wait_event_type = 'Lock'`,
      [applicationName],
    );
    if (Number(result.rows[0]?.count ?? '0') >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`POSTGRES_TEST_TIMEOUT:${label}`);
}

describe('GAME communications PostgreSQL verifier guard', () => {
  it('accepts only a query-free loopback disposable database URL', () => {
    expect(() =>
      assertDisposableDatabase('postgresql://verify@127.0.0.1:55432/game_comms_verify'),
    ).not.toThrow();
    expect(() =>
      assertDisposableDatabase('postgresql://verify@database.example/game_comms_verify'),
    ).toThrow('GAME_COMMS_INTEGRATION_TEST_DATABASE_URL');
  });
});

describePostgres('GAME lifecycle -> notification -> chat real PostgreSQL integration', () => {
  let pool: Pool;
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const organizerId = randomUUID();
  const playerId = randomUUID();
  const secondPlayerId = randomUUID();
  const foreignUserId = randomUUID();
  const stationId = randomUUID();

  const games = () => createGameRepository(pool);
  const roster = () => createGameRosterRepository(pool);
  const messaging = () => createMessagingRepository(pool);

  function command(label: string, gameId: string, actorUserId = playerId) {
    return {
      tenantId,
      actorUserId,
      gameId,
      idempotencyKey: `game-comms-${label}-${randomUUID()}`,
      requestHash: requestHash(`game-comms-${label}-${gameId}-${actorUserId}`),
      correlationId: `game-comms-${label}-${randomUUID()}`,
    };
  }

  async function createGame(label: string): Promise<string> {
    const result = await games().create({
      tenantId,
      actorUserId: organizerId,
      idempotencyKey: `game-comms-create-${label}-${randomUUID()}`,
      requestHash: requestHash(`game-comms-create-${label}`),
      correlationId: `game-comms-create-${label}-${randomUUID()}`,
      title: `Game comms ${label}`,
      kind: 'FRIENDLY',
      visibility: 'PRIVATE',
      stationId,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 90_000_000).toISOString(),
      timezone: 'Europe/Moscow',
      capacity: 4,
      waitlistEnabled: false,
      paymentMode: 'NO_PAYMENT',
    });
    expect(result).toMatchObject({ outcome: 'applied', replayed: false });
    if (result.outcome !== 'applied') throw new Error('GAME_COMMS_CREATE_FAILED');
    return result.gameId;
  }

  async function event(gameId: string, type: string): Promise<NotificationSourceEvent> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{
        id: string;
        event_type: string;
        aggregate_id: string;
        correlation_id: string;
        payload: unknown;
        occurred_at: Date | string;
      }>(
        `select id, event_type, aggregate_id, correlation_id, payload, occurred_at
           from audit.outbox_events
          where tenant_id = $1 and aggregate_id = $2 and event_type = $3
          order by occurred_at desc, id desc limit 1`,
        [tenantId, gameId, type],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`GAME_COMMS_OUTBOX_EVENT_MISSING:${type}`);
      return notificationSourceEventSchema.parse({
        id: row.id,
        type: row.event_type,
        aggregateId: row.aggregate_id,
        tenantId,
        correlationId: row.correlation_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
        payload: row.payload,
      });
    });
  }

  async function notificationCount(eventId: string): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        'select count(*)::text as count from notifications.intents where tenant_id = $1 and source_event_id = $2',
        [tenantId, eventId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  function reconcile(source: NotificationSourceEvent) {
    if (
      !('aggregateRevision' in source.payload) ||
      typeof source.payload.aggregateRevision !== 'string'
    ) {
      throw new Error('GAME_COMMS_EVENT_REVISION_MISSING');
    }
    return messaging().reconcileGameConversationMembership({
      tenantId: source.tenantId,
      gameId: source.aggregateId,
      sourceEventId: source.id,
      sourceEventType: source.type as GameMessagingMembershipSourceEventType,
      sourceAggregateRevision: source.payload.aggregateRevision,
      correlationId: source.correlationId,
      occurredAt: source.occurredAt,
    });
  }

  async function storedConversationState(gameId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const conversation = await client.query<{ id: string; state: string }>(
        `select id, state from messaging.conversations
          where tenant_id = $1 and kind = 'GAME' and context_id = $2`,
        [tenantId, gameId],
      );
      const members = await client.query<{
        user_id: string;
        state: string;
        left_at: string | null;
      }>(
        `select user_id, state, left_at::text as left_at
           from messaging.conversation_members
          where tenant_id = $1 and conversation_id = $2 and member_type = 'USER'
          order by user_id`,
        [tenantId, conversation.rows[0]?.id],
      );
      return { conversation: conversation.rows[0], members: members.rows };
    });
  }

  async function gameSnapshot(gameId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{
        revision: string;
        lifecycle_state: string;
        updated_at: string;
        participations: unknown;
      }>(
        `select game.revision::text as revision,
                game.lifecycle_state,
                game.updated_at::text as updated_at,
                coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'id', participation.id,
                      'userId', participation.user_id,
                      'role', participation.role,
                      'state', participation.state,
                      'leftAt', participation.left_at,
                      'updatedAt', participation.updated_at
                    ) order by participation.id
                  )
                    from games.participations participation
                   where participation.tenant_id = game.tenant_id
                     and participation.game_id = game.id
                ), '[]'::jsonb) as participations
           from games.games game
          where game.tenant_id = $1 and game.id = $2`,
        [tenantId, gameId],
      );
      return result.rows[0];
    });
  }

  async function reconciliationAuditCount(sourceEventId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count
           from audit.audit_log
          where tenant_id = $1
            and action = 'GAME_CONVERSATION_MEMBERSHIP_RECONCILED'
            and new_value ->> 'sourceEventId' = $2`,
        [tenantId, sourceEventId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  async function effectiveMembershipCount(gameId: string, userId: string): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count
           from messaging.conversation_members member
           join messaging.conversations conversation
             on conversation.tenant_id = member.tenant_id and conversation.id = member.conversation_id
           join games.games game
             on game.tenant_id = conversation.tenant_id and game.id = conversation.context_id
           join games.participations participation
             on participation.tenant_id = game.tenant_id and participation.game_id = game.id
            and participation.user_id = member.user_id and participation.state = 'ACTIVE'
          where member.tenant_id = $1 and conversation.context_id = $2 and member.user_id = $3
            and member.state = 'ACTIVE' and conversation.kind = 'GAME'
            and conversation.state = 'OPEN' and game.lifecycle_state <> 'CANCELLED'`,
        [tenantId, gameId, userId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  async function countRows(
    table: 'games.participations' | 'messaging.messages',
    gameId: string,
  ): Promise<number> {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ count: string }>(
        table === 'games.participations'
          ? 'select count(*)::text as count from games.participations where tenant_id = $1 and game_id = $2 and user_id = $3'
          : `select count(*)::text as count
               from messaging.messages message
               join messaging.conversations conversation
                 on conversation.tenant_id = message.tenant_id and conversation.id = message.conversation_id
               join messaging.conversation_members member
                 on member.tenant_id = message.tenant_id and member.id = message.sender_member_id
              where message.tenant_id = $1 and conversation.context_id = $2 and member.user_id = $3`,
        [tenantId, gameId, playerId],
      );
      return Number(result.rows[0]?.count ?? '0');
    });
  }

  function send(conversationId: string, label: string) {
    return messaging().sendMessage({
      tenantId,
      userId: playerId,
      conversationId,
      clientMessageId: `game-comms-${label}-client-${randomUUID()}`,
      idempotencyKey: `game-comms-${label}-send-${randomUUID()}`,
      body: `GAME comms ${label}`,
      correlationId: `game-comms-${label}-${randomUUID()}`,
    });
  }

  async function assertClosed(gameId: string, conversationId: string) {
    await expect(effectiveMembershipCount(gameId, playerId)).resolves.toBe(0);
    await expect(
      messaging().listConversations({ tenantId, userId: playerId, limit: 50 }),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: conversationId })]),
    );
    await expect(
      messaging().listMessages({
        tenantId,
        userId: playerId,
        conversationId,
        afterSequence: 0,
        limit: 50,
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
    await expect(send(conversationId, 'post-transition')).resolves.toEqual({
      outcome: 'not_found',
    });
    await expect(
      messaging().authorizeRealtimeSubscription({ tenantId, userId: playerId, conversationId }),
    ).resolves.toEqual({ outcome: 'not_found' });
  }

  beforeAll(async () => {
    if (!connectionString) throw new Error('GAME_COMMS_INTEGRATION_TEST_DATABASE_URL_REQUIRED');
    pool = new Pool({
      connectionString,
      max: 16,
      application_name: applicationName,
      options: '-c statement_timeout=12000 -c lock_timeout=12000',
    });
    await pool.query(
      'drop trigger if exists game_comms_transition_barrier_verify on audit.outbox_events',
    );
    await pool.query(`
      create or replace function audit.game_comms_transition_barrier_verify()
      returns trigger
      language plpgsql
      as $barrier$
      begin
        if new.correlation_id like '${transitionBarrierPrefix}%' then
          perform pg_advisory_xact_lock(hashtextextended(new.correlation_id, 0));
        end if;
        return new;
      end;
      $barrier$
    `);
    await pool.query(
      `create trigger game_comms_transition_barrier_verify
         before insert on audit.outbox_events
         for each row execute function audit.game_comms_transition_barrier_verify()`,
    );
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'GAME communications'), ($3, $4, 'Foreign GAME communications')`,
      [
        tenantId,
        `game-comms-${tenantId}`,
        foreignTenantId,
        `game-comms-foreign-${foreignTenantId}`,
      ],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         select $1, user_id, 'ACTIVE' from unnest($2::uuid[]) users(user_id)`,
        [tenantId, [organizerId, playerId, secondPlayerId]],
      );
      await client.query(
        `insert into identity.user_access_profiles (tenant_id, user_id, roles, permissions)
         select $1, user_id, array['client']::text[], array['games.play']::text[]
           from unnest($2::uuid[]) users(user_id)`,
        [tenantId, [organizerId, playerId, secondPlayerId]],
      );
      await client.query(
        `insert into locations.profiles (tenant_id, id, slug, title, publication_status, created_by, updated_by, published_at)
         values ($1, $2, $3, 'GAME communications station', 'PUBLISHED', $4, $4, now())`,
        [tenantId, stationId, `game-comms-${stationId}`, organizerId],
      );
      await client.query(
        `insert into messaging.tenant_runtime_settings (tenant_id, http_enabled, realtime_enabled, contextual_enabled)
         values ($1, true, true, true)`,
        [tenantId],
      );
      await client.query(
        `insert into notifications.tenant_runtime_settings (tenant_id, in_app_enabled) values ($1, true)`,
        [tenantId],
      );
      for (const [key, eventType, audience] of [
        ['joined', 'game.participation.confirmed.v1', '{"type":"EVENT_USER","field":"userId"}'],
        ['left', 'game.participation.left.v1', '{"type":"EVENT_USER","field":"userId"}'],
        ['cancelled', 'game.cancelled.v1', '{"type":"EVENT_USERS","field":"participantUserIds"}'],
      ] as const) {
        const templateId = randomUUID();
        await client.query(
          `insert into notifications.templates (tenant_id, id, template_key, version, category, channels, title_template, body_template, deep_link_template, active)
           values ($1, $2, $3, 1, 'GAME', array['IN_APP'], 'GAME', 'Lifecycle', '/games/{{gameId}}', true)`,
          [tenantId, templateId, `game-comms-${key}-${tenantId}`],
        );
        await client.query(
          `insert into notifications.trigger_rules (tenant_id, id, rule_key, source_event_type, template_id, audience_selector, mandatory, active)
           values ($1, $2, $3, $4, $5, $6::jsonb, true, true)`,
          [
            tenantId,
            randomUUID(),
            `game-comms-${key}-${tenantId}`,
            eventType,
            templateId,
            audience,
          ],
        );
      }
    });
    await withTenantTransaction(pool, foreignTenantId, (client) =>
      client.query(`insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`, [
        foreignTenantId,
        foreignUserId,
      ]),
    );
  });

  afterAll(async () => {
    await pool?.query(
      'drop trigger if exists game_comms_transition_barrier_verify on audit.outbox_events',
    );
    await pool?.query('drop function if exists audit.game_comms_transition_barrier_verify()');
    await pool?.end();
  });

  it('JOIN reads its canonical outbox event, projects exactly once on replay, and grants GAME chat', async () => {
    const gameId = await createGame('join');
    const joinCommand = command('join', gameId);
    const joined = await roster().join(joinCommand);
    expect(joined).toMatchObject({
      outcome: 'applied',
      viewerRelation: 'PARTICIPANT',
      replayed: false,
    });
    await expect(roster().join(joinCommand)).resolves.toMatchObject({
      outcome: 'applied',
      replayed: true,
    });
    await expect(countRows('games.participations', gameId)).resolves.toBe(1);
    const source = await event(gameId, 'game.participation.confirmed.v1');
    await expect(applyNotificationSourceEvent({ pool, event: source })).resolves.toMatchObject({
      outcome: 'processed',
    });
    await expect(applyNotificationSourceEvent({ pool, event: source })).resolves.toEqual({
      outcome: 'duplicate',
    });
    await expect(notificationCount(source.id)).resolves.toBe(1);
    const conversation = await messaging().getOrCreateGameConversation({
      tenantId,
      actorUserId: playerId,
      gameId,
      idempotencyKey: `game-comms-join-chat-${randomUUID()}`,
      correlationId: `game-comms-join-chat-${randomUUID()}`,
    });
    expect(conversation).toMatchObject({ outcome: 'ok', created: true });
    if (conversation.outcome !== 'ok') throw new Error('GAME_COMMS_CONVERSATION_MISSING');
    await expect(effectiveMembershipCount(gameId, playerId)).resolves.toBe(1);
    await expect(send(conversation.conversation.id, 'join')).resolves.toMatchObject({
      outcome: 'ok',
      replayed: false,
    });
  });

  it('LEAVE projects its canonical event and denies every effective chat surface despite stale member storage', async () => {
    const gameId = await createGame('leave');
    await expect(roster().join(command('leave-join', gameId))).resolves.toMatchObject({
      outcome: 'applied',
    });
    const chat = await messaging().getOrCreateGameConversation({
      tenantId,
      actorUserId: playerId,
      gameId,
      idempotencyKey: `game-comms-leave-chat-${randomUUID()}`,
      correlationId: `game-comms-leave-chat-${randomUUID()}`,
    });
    if (chat.outcome !== 'ok') throw new Error('GAME_COMMS_LEAVE_CHAT_MISSING');
    const leaveCommand = command('leave', gameId);
    await expect(roster().leave(leaveCommand)).resolves.toMatchObject({
      outcome: 'applied',
      viewerRelation: 'NONE',
    });
    await expect(roster().leave(leaveCommand)).resolves.toMatchObject({
      outcome: 'applied',
      replayed: true,
    });
    const source = await event(gameId, 'game.participation.left.v1');
    const authoritativeBefore = await gameSnapshot(gameId);
    // Authorization is already revoked before materialized membership converges.
    await assertClosed(gameId, chat.conversation.id);
    await expect(applyNotificationSourceEvent({ pool, event: source })).resolves.toMatchObject({
      outcome: 'processed',
    });
    await expect(applyNotificationSourceEvent({ pool, event: source })).resolves.toEqual({
      outcome: 'duplicate',
    });
    await expect(notificationCount(source.id)).resolves.toBe(1);
    await expect(reconcile(source)).resolves.toMatchObject({
      outcome: 'applied',
      conversationClosed: false,
      leftUserIds: [playerId],
    });
    await expect(reconcile(source)).resolves.toEqual({ outcome: 'no_op' });
    await expect(gameSnapshot(gameId)).resolves.toEqual(authoritativeBefore);
    await expect(reconciliationAuditCount(source.id)).resolves.toBe(1);
    const stored = await storedConversationState(gameId);
    expect(stored.conversation?.state).toBe('OPEN');
    const storedPlayer = stored.members.find((member) => member.user_id === playerId);
    expect(storedPlayer?.state).toBe('LEFT');
    expect(typeof storedPlayer?.left_at).toBe('string');
    await assertClosed(gameId, chat.conversation.id);
  });

  it('CANCEL projects its canonical event, rejects new/replayed GAME chat, and leaves no effective authorization', async () => {
    const gameId = await createGame('cancel');
    await expect(roster().join(command('cancel-join', gameId))).resolves.toMatchObject({
      outcome: 'applied',
    });
    const chat = await messaging().getOrCreateGameConversation({
      tenantId,
      actorUserId: playerId,
      gameId,
      idempotencyKey: `game-comms-cancel-chat-${randomUUID()}`,
      correlationId: `game-comms-cancel-chat-${randomUUID()}`,
    });
    if (chat.outcome !== 'ok') throw new Error('GAME_COMMS_CANCEL_CHAT_MISSING');
    await expect(send(chat.conversation.id, 'cancel-before')).resolves.toMatchObject({
      outcome: 'ok',
    });
    const messageCountBefore = await countRows('messaging.messages', gameId);
    const cancellation = command('cancel', gameId, organizerId);
    const cancelled = await games().cancel({ ...cancellation, reasonCode: 'ORGANIZER_REQUEST' });
    expect(cancelled).toMatchObject({ outcome: 'applied', replayed: false });
    await expect(
      games().cancel({ ...cancellation, reasonCode: 'ORGANIZER_REQUEST' }),
    ).resolves.toMatchObject({ outcome: 'applied', replayed: true });
    const source = await event(gameId, 'game.cancelled.v1');
    const authoritativeBefore = await gameSnapshot(gameId);
    await expect(applyNotificationSourceEvent({ pool, event: source })).resolves.toMatchObject({
      outcome: 'processed',
    });
    await expect(applyNotificationSourceEvent({ pool, event: source })).resolves.toEqual({
      outcome: 'duplicate',
    });
    // Cancellation targets both active participants: organizer and joined player.
    // Replay must keep exactly one intent per recipient, not one intent total.
    await expect(notificationCount(source.id)).resolves.toBe(2);
    await expect(reconcile(source)).resolves.toMatchObject({
      outcome: 'applied',
      conversationClosed: true,
    });
    await expect(reconcile(source)).resolves.toEqual({ outcome: 'no_op' });
    await expect(gameSnapshot(gameId)).resolves.toEqual(authoritativeBefore);
    await expect(reconciliationAuditCount(source.id)).resolves.toBe(1);
    const stored = await storedConversationState(gameId);
    expect(stored.conversation?.state).toBe('CLOSED');
    expect(stored.members.filter((member) => member.state === 'ACTIVE')).toHaveLength(0);
    expect(
      stored.members.filter((member) => member.state === 'LEFT').map((member) => member.user_id),
    ).toEqual(expect.arrayContaining([organizerId, playerId]));
    await expect(countRows('messaging.messages', gameId)).resolves.toBe(messageCountBefore);
    await assertClosed(gameId, chat.conversation.id);
    await expect(
      messaging().getOrCreateGameConversation({
        tenantId,
        actorUserId: playerId,
        gameId,
        idempotencyKey: `game-comms-cancel-new-${randomUUID()}`,
        correlationId: `game-comms-cancel-new-${randomUUID()}`,
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('projects the current rejoined roster when an older leave event arrives late', async () => {
    const gameId = await createGame('rejoin-stale-leave');
    await roster().join(command('rejoin-first', gameId));
    const chat = await messaging().getOrCreateGameConversation({
      tenantId,
      actorUserId: playerId,
      gameId,
      idempotencyKey: `game-comms-rejoin-chat-${randomUUID()}`,
      correlationId: `game-comms-rejoin-chat-${randomUUID()}`,
    });
    if (chat.outcome !== 'ok') throw new Error('GAME_COMMS_REJOIN_CHAT_MISSING');
    await roster().leave(command('rejoin-leave', gameId));
    const staleLeave = await event(gameId, 'game.participation.left.v1');
    await roster().join(command('rejoin-second', gameId));
    await expect(reconcile(staleLeave)).resolves.toMatchObject({
      outcome: 'no_op',
    });
    const stored = await storedConversationState(gameId);
    expect(stored.conversation?.state).toBe('OPEN');
    expect(stored.members.find((member) => member.user_id === playerId)).toMatchObject({
      state: 'ACTIVE',
      left_at: null,
    });
  });

  it.each(['leave', 'cancel'] as const)(
    'physically serializes real %s vs send without deadlock or post-transition message',
    async (transition) => {
      const gameId = await createGame(`race-${transition}`);
      await roster().join(command(`race-${transition}-join`, gameId));
      const chat = await messaging().getOrCreateGameConversation({
        tenantId,
        actorUserId: playerId,
        gameId,
        idempotencyKey: `game-comms-race-chat-${randomUUID()}`,
        correlationId: `game-comms-race-chat-${randomUUID()}`,
      });
      if (chat.outcome !== 'ok') throw new Error('GAME_COMMS_RACE_CHAT_MISSING');
      const observer = await pool.connect();
      const barrierKey = `${tenantId}:MESSAGE_COMMAND:${playerId}:${`race-${transition}-barrier`}`;
      // A fresh send input is needed because the barrier must match its idempotency key.
      const sendInput = {
        tenantId,
        userId: playerId,
        conversationId: chat.conversation.id,
        clientMessageId: `game-comms-race-${transition}-client-${randomUUID()}`,
        idempotencyKey: `race-${transition}-barrier`,
        body: `race ${transition}`,
        correlationId: `game-comms-race-${transition}-${randomUUID()}`,
      };
      let sendPromise: ReturnType<ReturnType<typeof messaging>['sendMessage']> | undefined;
      let transitionPromise: Promise<unknown> | undefined;
      try {
        await observer.query('select pg_advisory_lock(hashtextextended($1, 0))', [barrierKey]);
        sendPromise = messaging().sendMessage(sendInput);
        await waitForLockWaiters(observer, 1, `${transition}:send-at-command-barrier`);
        transitionPromise =
          transition === 'leave'
            ? roster().leave(command(`race-${transition}-leave`, gameId))
            : games().cancel({
                ...command(`race-${transition}-cancel`, gameId, organizerId),
                reasonCode: 'ORGANIZER_REQUEST',
              });
        await observer.query('select pg_advisory_unlock(hashtextextended($1, 0))', [barrierKey]);
        const [sent, changed] = await deadline(
          Promise.all([sendPromise, transitionPromise]),
          `${transition}:completion`,
        );
        expect(changed).toMatchObject({ outcome: 'applied' });
        expect(sent.outcome === 'ok' || sent.outcome === 'not_found').toBe(true);
        const source = await event(
          gameId,
          transition === 'leave' ? 'game.participation.left.v1' : 'game.cancelled.v1',
        );
        await expect(reconcile(source)).resolves.toMatchObject({ outcome: 'applied' });
        await assertClosed(gameId, chat.conversation.id);
        await expect(countRows('messaging.messages', gameId)).resolves.toBeLessThanOrEqual(1);
        await expect(send(chat.conversation.id, `race-${transition}-after`)).resolves.toEqual({
          outcome: 'not_found',
        });
      } finally {
        await observer
          .query('select pg_advisory_unlock(hashtextextended($1, 0))', [barrierKey])
          .catch(() => undefined);
        await Promise.allSettled(
          [sendPromise, transitionPromise].filter(Boolean) as Promise<unknown>[],
        );
        observer.release();
      }
    },
    20_000,
  );

  it.each(['leave', 'cancel'] as const)(
    'serializes a real %s that already changed GAME before a waiting send',
    async (transition) => {
      const gameId = await createGame(`transition-first-${transition}`);
      await roster().join(command(`transition-first-${transition}-join`, gameId));
      const chat = await messaging().getOrCreateGameConversation({
        tenantId,
        actorUserId: playerId,
        gameId,
        idempotencyKey: `game-comms-transition-first-chat-${randomUUID()}`,
        correlationId: `game-comms-transition-first-chat-${randomUUID()}`,
      });
      if (chat.outcome !== 'ok') throw new Error('GAME_COMMS_TRANSITION_FIRST_CHAT_MISSING');

      const observer = await pool.connect();
      const barrierKey = `${transitionBarrierPrefix}${randomUUID()}`;
      let transitionPromise: Promise<unknown> | undefined;
      let sendPromise: ReturnType<ReturnType<typeof messaging>['sendMessage']> | undefined;
      try {
        await observer.query('select pg_advisory_lock(hashtextextended($1, 0))', [barrierKey]);
        const transitionInput = {
          ...command(`transition-first-${transition}`, gameId, organizerId),
          correlationId: barrierKey,
        };
        transitionPromise =
          transition === 'leave'
            ? roster().leave({ ...transitionInput, actorUserId: playerId })
            : games().cancel({ ...transitionInput, reasonCode: 'ORGANIZER_REQUEST' });

        // The transition reaches its outbox trigger only after changing the authoritative
        // GAME rows. It remains uncommitted while retaining those row locks here.
        await waitForLockWaiters(observer, 1, `${transition}:transition-at-outbox-barrier`);
        sendPromise = send(chat.conversation.id, `transition-first-${transition}`);
        await waitForLockWaiters(observer, 2, `${transition}:send-waits-for-game-transition`);
        await observer.query('select pg_advisory_unlock(hashtextextended($1, 0))', [barrierKey]);

        const [changed, sent] = await deadline(
          Promise.all([transitionPromise, sendPromise]),
          `${transition}:transition-first-completion`,
        );
        expect(changed).toMatchObject({ outcome: 'applied' });
        expect(sent).toEqual({ outcome: 'not_found' });
        await expect(countRows('messaging.messages', gameId)).resolves.toBe(0);

        const source = await event(
          gameId,
          transition === 'leave' ? 'game.participation.left.v1' : 'game.cancelled.v1',
        );
        await expect(reconcile(source)).resolves.toMatchObject({ outcome: 'applied' });
        await assertClosed(gameId, chat.conversation.id);
        await expect(countRows('messaging.messages', gameId)).resolves.toBe(0);
      } finally {
        await observer
          .query('select pg_advisory_unlock(hashtextextended($1, 0))', [barrierKey])
          .catch(() => undefined);
        await Promise.allSettled(
          [transitionPromise, sendPromise].filter(Boolean) as Promise<unknown>[],
        );
        observer.release();
      }
    },
    20_000,
  );

  it.each(['leave', 'cancel'] as const)(
    'preserves a send committed before %s and converges all later access',
    async (transition) => {
      const gameId = await createGame(`send-first-${transition}`);
      await roster().join(command(`send-first-${transition}-join`, gameId));
      const chat = await messaging().getOrCreateGameConversation({
        tenantId,
        actorUserId: playerId,
        gameId,
        idempotencyKey: `game-comms-send-first-chat-${randomUUID()}`,
        correlationId: `game-comms-send-first-chat-${randomUUID()}`,
      });
      if (chat.outcome !== 'ok') throw new Error('GAME_COMMS_SEND_FIRST_CHAT_MISSING');
      await expect(send(chat.conversation.id, `send-first-${transition}`)).resolves.toMatchObject({
        outcome: 'ok',
      });
      if (transition === 'leave') {
        await roster().leave(command(`send-first-${transition}-leave`, gameId));
      } else {
        await games().cancel({
          ...command(`send-first-${transition}-cancel`, gameId, organizerId),
          reasonCode: 'ORGANIZER_REQUEST',
        });
      }
      const source = await event(
        gameId,
        transition === 'leave' ? 'game.participation.left.v1' : 'game.cancelled.v1',
      );
      await expect(reconcile(source)).resolves.toMatchObject({ outcome: 'applied' });
      await expect(countRows('messaging.messages', gameId)).resolves.toBe(1);
      await assertClosed(gameId, chat.conversation.id);
    },
    20_000,
  );
});
