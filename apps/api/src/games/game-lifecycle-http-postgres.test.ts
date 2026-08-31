import { createHash, randomUUID } from 'node:crypto';

import {
  createGameRepository,
  createGameRosterRepository,
  withTenantTransaction,
} from '@phub/database';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';

const connectionString = process.env.GAME_LIFECYCLE_HTTP_TEST_DATABASE_URL;

function hash(value: string): string {
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
      'GAME_LIFECYCLE_HTTP_TEST_DATABASE_URL must use a query-free loopback *_verify database',
    );
  }
}

if (connectionString) assertDisposableDatabase(connectionString);
const describePostgres = connectionString ? describe : describe.skip;

describe('game lifecycle PostgreSQL verifier guard', () => {
  it('accepts a query-free loopback disposable database URL', () => {
    expect(() =>
      assertDisposableDatabase('postgresql://verify@127.0.0.1:55432/lifecycle_verify'),
    ).not.toThrow();
  });

  it.each([
    'https://127.0.0.1/lifecycle_verify',
    'postgresql://verify@127.0.0.1/lifecycle_verify?host=database.example',
    'postgresql://verify@127.0.0.1/lifecycle_verify#override',
    'postgresql://verify@database.example/lifecycle_verify',
    'postgresql://verify@127.0.0.1/lifecycle',
  ])('rejects unsafe verifier URL %s', (value) => {
    expect(() => assertDisposableDatabase(value)).toThrow(
      'GAME_LIFECYCLE_HTTP_TEST_DATABASE_URL must use a query-free loopback *_verify database',
    );
  });
});

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: connectionString ?? 'postgresql://phub:test@localhost:5432/phub_verify',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

describePostgres('FREE/LOCAL game lifecycle through HTTP and PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 8 });
  const management = createGameRepository(pool);
  const roster = createGameRosterRepository(pool);
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const playerAId = randomUUID();
  const playerBId = randomUUID();
  const unrelatedId = randomUUID();
  const adminId = randomUUID();
  const deniedId = randomUUID();
  const stationId = randomUUID();
  const tenantKey = `game-http-${tenantId.slice(0, 8)}`;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function token(
    userId: string,
    permissions: readonly string[] = ['games.play'],
    roles: readonly string[] = ['client'],
  ): Promise<string> {
    return new SignJWT({
      tenants: [tenantId],
      permissions,
      roles,
      sid: randomUUID(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setSubject(userId)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  }

  function commandHeaders(accessToken: string, key = randomUUID()) {
    return {
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': `game-http-${key}`,
      'x-correlation-id': randomUUID(),
    };
  }

  function createPayload(label: string, capacity = 4, station = stationId) {
    const startsAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const endsAt = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
    return {
      title: `HTTP lifecycle ${label} ${randomUUID()}`,
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId: station,
      startsAt,
      endsAt,
      timezone: 'Europe/Moscow',
      capacity,
      levelRange: null,
      paymentMode: 'NO_PAYMENT',
      waitlistEnabled: true,
    } as const;
  }

  async function createGame(label: string, capacity = 4) {
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers: commandHeaders(await token(ownerId)),
      payload: createPayload(label, capacity),
    });
    expect(response.statusCode).toBe(202);
    return response.json<{
      commandId: string;
      operation: { gameId: string; aggregateRevision: number };
    }>();
  }

  async function prepareWaitlistPromotion(label: string) {
    const game = await createGame(label, 2);
    const joined = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(await token(playerAId)),
    });
    expect(joined.statusCode).toBe(200);
    const waitlisted = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/waitlist`,
      headers: commandHeaders(await token(playerBId)),
    });
    expect(waitlisted.statusCode).toBe(200);
    const left = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/participants/me`,
      headers: commandHeaders(await token(playerAId)),
    });
    expect(left.statusCode).toBe(200);
    const command = await withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ id: string; waitlist_entry_id: string }>(
        `select id, payload ->> 'waitlistEntryId' as waitlist_entry_id
           from games.scheduled_commands
          where tenant_id = $1 and game_id = $2
            and command_type = 'game.waitlist.promote.v1'
          order by created_at desc, id desc limit 1`,
        [tenantId, game.operation.gameId],
      );
      return result.rows[0];
    });
    if (!command?.id || !command.waitlist_entry_id) {
      throw new Error('GAME_HTTP_PROMOTION_COMMAND_MISSING');
    }
    const commandId = command.id;
    const waitlistEntryId = command.waitlist_entry_id;
    return {
      gameId: game.operation.gameId,
      command: {
        tenantId,
        gameId: game.operation.gameId,
        commandId,
        idempotencyKey: `scheduled:${commandId}`,
        requestHash: hash(`promotion:${commandId}:${waitlistEntryId}`),
        correlationId: `game-http-promotion-${commandId}`,
        waitlistEntryId,
      },
    };
  }

  async function readState(gameId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const game = await client.query<{
        lifecycle_state: string;
        revision: string;
        capacity: number;
      }>(
        `select lifecycle_state, revision::text, capacity from games.games
            where tenant_id = $1 and id = $2`,
        [tenantId, gameId],
      );
      const participants = await client.query<{ active: string; distinct_users: string }>(
        `select count(*) filter (where state = 'ACTIVE')::text as active,
                  count(distinct user_id) filter (where state = 'ACTIVE')::text as distinct_users
             from games.participations where tenant_id = $1 and game_id = $2`,
        [tenantId, gameId],
      );
      const reservations = await client.query<{ active: string }>(
        `select count(*) filter (where state = 'ACTIVE')::text as active
             from games.seat_reservations where tenant_id = $1 and game_id = $2`,
        [tenantId, gameId],
      );
      const waitlist = await client.query<{ active: string; promoted: string }>(
        `select
           count(*) filter (where state = 'ACTIVE')::text as active,
           count(*) filter (where state = 'PROMOTED')::text as promoted
           from games.waitlist_entries where tenant_id = $1 and game_id = $2`,
        [tenantId, gameId],
      );
      const operations = await client.query<{ count: string }>(
        `select count(*)::text as count from games.operations where tenant_id = $1 and game_id = $2`,
        [tenantId, gameId],
      );
      const outbox = await client.query<{ count: string }>(
        `select count(*)::text as count from audit.outbox_events
            where tenant_id = $1 and aggregate_id = $2`,
        [tenantId, gameId],
      );
      const audit = await client.query<{
        count: string;
        cancel_rejected: string;
        cancelled_success: string;
        leave_success: string;
      }>(
        `select count(*)::text as count,
                count(*) filter (
                  where action = 'GAME_CANCEL_REJECTED' and result = 'REJECTED'
                )::text as cancel_rejected,
                count(*) filter (
                  where action = 'GAME_CANCELLED' and result = 'SUCCESS'
                )::text as cancelled_success,
                count(*) filter (
                  where action = 'GAME_LEAVE_V1' and result = 'SUCCESS'
                )::text as leave_success
           from audit.audit_log
            where tenant_id = $1 and resource_id = $2`,
        [tenantId, gameId],
      );
      return {
        game: game.rows[0],
        participants: participants.rows[0],
        reservations: reservations.rows[0],
        waitlist: waitlist.rows[0],
        operations: operations.rows[0],
        outbox: outbox.rows[0],
        audit: audit.rows[0],
      };
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'HTTP lifecycle verification')`,
      [tenantId, tenantKey],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         select $1, user_id, 'ACTIVE' from unnest($2::uuid[]) users(user_id)`,
        [tenantId, [ownerId, playerAId, playerBId, unrelatedId, adminId, deniedId]],
      );
      await client.query(
        `insert into locations.profiles (
           tenant_id, id, slug, title, publication_status, created_by, updated_by, published_at
         ) values ($1, $2, $3, 'HTTP lifecycle station', 'PUBLISHED', $4, $4, now())`,
        [tenantId, stationId, `game-http-${stationId}`, ownerId],
      );
    });
    app = await buildApp({
      config,
      logger: createLogger('game-lifecycle-http-postgres-test', 'silent'),
      pool,
      gameCommandRepository: management,
      gameReadRepository: management,
      gameRosterRepository: roster,
    });
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it('creates durably, replays the exact command, and rejects invalid or changed-key requests', async () => {
    const ownerToken = await token(ownerId);
    const payload = createPayload('create');
    const headers = commandHeaders(ownerToken);
    const created = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers,
      payload,
    });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json<{ commandId: string; operation: { gameId: string } }>();
    const replay = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      commandId: createdBody.commandId,
      replayed: true,
      operation: { gameId: createdBody.operation.gameId },
    });
    const changed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers,
      payload: { ...payload, title: `${payload.title} changed` },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const pastHeaders = commandHeaders(ownerToken);
    const past = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers: pastHeaders,
      payload: {
        ...createPayload('past'),
        startsAt: '2020-01-01T12:00:00.000Z',
        endsAt: '2020-01-01T13:00:00.000Z',
      },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ code: 'GAME_START_TIME_PASSED' });
    const invalidStationId = randomUUID();
    const invalidHeaders = commandHeaders(ownerToken);
    const invalidStation = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers: invalidHeaders,
      payload: createPayload('invalid-station', 4, invalidStationId),
    });
    expect(invalidStation.statusCode).toBe(400);
    const invalidRouteKeys: string[] = [];
    const invalidRouteTitles: string[] = [];
    const endBeforeStart = createPayload('end-before-start');
    const invalidRoutePayloads = [
      {
        ...endBeforeStart,
        endsAt: new Date(Date.parse(endBeforeStart.startsAt) - 60_000).toISOString(),
      },
      { ...createPayload('invalid-timezone'), timezone: 'Mars/Phobos' },
      {
        ...createPayload('reversed-level-range'),
        levelRange: { from: 'B', to: 'C' },
      },
    ];
    for (const invalidPayload of invalidRoutePayloads) {
      const invalidHeaders = commandHeaders(ownerToken);
      invalidRouteKeys.push(invalidHeaders['idempotency-key']);
      invalidRouteTitles.push(invalidPayload.title);
      const invalid = await app.inject({
        method: 'POST',
        url: `/user/api/v1/${tenantKey}/games`,
        headers: invalidHeaders,
        payload: invalidPayload,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{ games: string; commands: string }>(
          `select
             (select count(*) from games.games
               where tenant_id = $1
                 and (station_id = $2 or title = any($4::text[])))::text as games,
             (select count(*) from games.command_idempotency
               where tenant_id = $1 and idempotency_key = any($3::text[]))::text as commands`,
          [
            tenantId,
            invalidStationId,
            [
              pastHeaders['idempotency-key'],
              invalidHeaders['idempotency-key'],
              ...invalidRouteKeys,
            ],
            invalidRouteTitles,
          ],
        );
        return result.rows[0];
      }),
    ).resolves.toEqual({ games: '0', commands: '0' });
    const state = await readState(createdBody.operation.gameId);
    expect(state).toMatchObject({
      game: { lifecycle_state: 'SCHEDULED', revision: '1', capacity: 4 },
      participants: { active: '1', distinct_users: '1' },
      reservations: { active: '0' },
      operations: { count: '1' },
      outbox: { count: '3' },
      audit: { count: '1' },
    });
    const operation = await app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenantKey}/game-operations/${createdBody.commandId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(operation.statusCode).toBe(200);
    expect(operation.json()).toMatchObject({
      commandId: createdBody.commandId,
      operation: { type: 'CREATE_GAME', status: 'SUCCEEDED', gameId: createdBody.operation.gameId },
    });
  });

  it('rolls back every create side effect when the transactional outbox write fails', async () => {
    const ownerToken = await token(ownerId);
    const payload = createPayload('forced-rollback');
    const headers = commandHeaders(ownerToken);
    const correlationId = headers['x-correlation-id'];
    const idempotencyKey = headers['idempotency-key'];
    const failureToken = randomUUID().replaceAll('-', '').slice(0, 16);
    const functionName = `game_http_fail_outbox_${failureToken}`;
    const triggerName = `game_http_fail_outbox_${failureToken}`;

    try {
      await pool.query(
        `create function ${functionName}() returns trigger language plpgsql as $$
         begin
           if new.tenant_id = '${tenantId}'::uuid
              and new.correlation_id = '${correlationId}' then
             raise exception 'GAME_HTTP_INJECTED_OUTBOX_FAILURE';
           end if;
           return new;
         end
         $$`,
      );
      await pool.query(
        `create trigger ${triggerName}
           before insert on audit.outbox_events
           for each row execute function ${functionName}()`,
      );
      const failed = await app.inject({
        method: 'POST',
        url: `/user/api/v1/${tenantKey}/games`,
        headers,
        payload,
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on audit.outbox_events`);
      await pool.query(`drop function if exists ${functionName}()`);
    }

    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{
          audit: string;
          commands: string;
          games: string;
          outbox: string;
        }>(
          `select
             (select count(*) from games.games
               where tenant_id = $1 and title = $2)::text as games,
             (select count(*) from games.command_idempotency
               where tenant_id = $1 and idempotency_key = $3)::text as commands,
             (select count(*) from audit.audit_log
               where tenant_id = $1 and correlation_id = $4)::text as audit,
             (select count(*) from audit.outbox_events
               where tenant_id = $1 and correlation_id = $4)::text as outbox`,
          [tenantId, payload.title, idempotencyKey, correlationId],
        );
        return result.rows[0];
      }),
    ).resolves.toEqual({ games: '0', commands: '0', audit: '0', outbox: '0' });

    const retried = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers,
      payload,
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({ replayed: false });
  });

  it('enforces join revisions, retries, permission and actor-scoped operation readback', async () => {
    const game = await createGame('join');
    const playerToken = await token(playerAId);
    const missing = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${randomUUID()}/join`,
      headers: commandHeaders(playerToken),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'GAME_NOT_FOUND' });
    const stale = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(playerToken),
      payload: { expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'GAME_REVISION_CONFLICT' });
    const headers = commandHeaders(playerToken);
    const joined = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(joined.statusCode).toBe(200);
    const joinedBody = joined.json<{
      commandId: string;
      operation: { aggregateRevision: number };
    }>();
    const replay = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers,
      payload: { expectedRevision: 1 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ commandId: joinedBody.commandId, replayed: true });
    const alreadyJoined = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(playerToken),
    });
    expect(alreadyJoined.statusCode).toBe(409);
    expect(alreadyJoined.json()).toMatchObject({ code: 'GAME_ALREADY_JOINED' });
    const denied = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(await token(deniedId, [])),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'GAME_PERMISSION_REQUIRED' });
    const foreignOperation = await app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenantKey}/game-operations/${joinedBody.commandId}`,
      headers: { authorization: `Bearer ${await token(unrelatedId)}` },
    });
    expect(foreignOperation.statusCode).toBe(404);
    const operation = await app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenantKey}/game-operations/${joinedBody.commandId}`,
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(operation.statusCode).toBe(200);
    expect(operation.json()).toMatchObject({
      commandId: joinedBody.commandId,
      operation: { type: 'JOIN_GAME', status: 'SUCCEEDED', gameId: game.operation.gameId },
    });
    await expect(readState(game.operation.gameId)).resolves.toMatchObject({
      game: { revision: '2' },
      participants: { active: '2', distinct_users: '2' },
      reservations: { active: '0' },
    });
  });

  it('serializes two HTTP joins for the final free seat without overflow or duplicates', async () => {
    const game = await createGame('last-seat', 2);
    const results = await Promise.race([
      Promise.all(
        [playerAId, playerBId].map(async (userId) =>
          app.inject({
            method: 'POST',
            url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
            headers: commandHeaders(await token(userId)),
          }),
        ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GAME_HTTP_LAST_SEAT_TIMEOUT')), 5_000),
      ),
    ]);
    const first = results[0];
    const second = results[1];
    if (!first || !second) throw new Error('GAME_HTTP_LAST_SEAT_RESULT_MISSING');
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect([first, second].find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: 'GAME_FULL',
    });
    await expect(readState(game.operation.gameId)).resolves.toMatchObject({
      game: { capacity: 2, revision: '2' },
      participants: { active: '2', distinct_users: '2' },
      reservations: { active: '0' },
    });
  });

  it('serializes same-user concurrent joins without duplicate membership', async () => {
    const game = await createGame('same-user-concurrency', 4);
    const playerToken = await token(playerAId);
    const results = await Promise.race([
      Promise.all(
        [0, 1].map((index) =>
          app.inject({
            method: 'POST',
            url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
            headers: commandHeaders(playerToken, `same-user-${index}-${randomUUID()}`),
          }),
        ),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GAME_HTTP_SAME_USER_TIMEOUT')), 5_000),
      ),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: 'GAME_ALREADY_JOINED',
    });
    await expect(readState(game.operation.gameId)).resolves.toMatchObject({
      game: { revision: '2' },
      participants: { active: '2', distinct_users: '2' },
      reservations: { active: '0' },
    });
  });

  it('serializes join versus cancel into one durable order without post-cancel admission', async () => {
    const game = await createGame('join-cancel-race', 2);
    const playerToken = await token(playerAId);
    const ownerToken = await token(ownerId);
    const [join, cancel] = await Promise.race([
      Promise.all([
        app.inject({
          method: 'POST',
          url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
          headers: commandHeaders(playerToken),
        }),
        app.inject({
          method: 'POST',
          url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/cancel`,
          headers: commandHeaders(ownerToken),
          payload: { reasonCode: 'ORGANIZER_REQUEST' },
        }),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GAME_HTTP_JOIN_CANCEL_TIMEOUT')), 5_000),
      ),
    ]);

    expect(cancel.statusCode).toBe(202);
    expect([200, 409]).toContain(join.statusCode);
    if (join.statusCode === 409) {
      expect(join.json()).toMatchObject({ code: 'GAME_NOT_JOINABLE' });
    }
    const state = await readState(game.operation.gameId);
    expect(state).toMatchObject({
      game: { lifecycle_state: 'CANCELLED', revision: join.statusCode === 200 ? '3' : '2' },
      participants: {
        active: join.statusCode === 200 ? '2' : '1',
        distinct_users: join.statusCode === 200 ? '2' : '1',
      },
      reservations: { active: '0' },
    });
  });

  it('proves both serialized join-before-cancel and cancel-before-join orders', async () => {
    const ownerToken = await token(ownerId);
    const playerToken = await token(playerAId);
    const joinFirst = await createGame('join-before-cancel', 2);
    const joined = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${joinFirst.operation.gameId}/join`,
      headers: commandHeaders(playerToken),
    });
    expect(joined.statusCode).toBe(200);
    const cancelledAfterJoin = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${joinFirst.operation.gameId}/cancel`,
      headers: commandHeaders(ownerToken),
      payload: { reasonCode: 'ORGANIZER_REQUEST' },
    });
    expect(cancelledAfterJoin.statusCode).toBe(202);
    await expect(readState(joinFirst.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'CANCELLED', revision: '3' },
      participants: { active: '2', distinct_users: '2' },
    });

    const cancelFirst = await createGame('cancel-before-join', 2);
    const cancelledBeforeJoin = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${cancelFirst.operation.gameId}/cancel`,
      headers: commandHeaders(ownerToken),
      payload: { reasonCode: 'ORGANIZER_REQUEST' },
    });
    expect(cancelledBeforeJoin.statusCode).toBe(202);
    const rejectedJoin = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${cancelFirst.operation.gameId}/join`,
      headers: commandHeaders(playerToken),
    });
    expect(rejectedJoin.statusCode).toBe(409);
    expect(rejectedJoin.json()).toMatchObject({ code: 'GAME_NOT_JOINABLE' });
    await expect(readState(cancelFirst.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'CANCELLED', revision: '2' },
      participants: { active: '1', distinct_users: '1' },
    });
  });

  it('serializes waitlist promotion versus cancel and makes post-cancel promotion a no-op', async () => {
    const prepared = await prepareWaitlistPromotion('promotion-cancel-race');
    const ownerToken = await token(ownerId);

    const [promotion, cancel] = await Promise.race([
      Promise.all([
        roster.promoteWaitlist(prepared.command),
        app.inject({
          method: 'POST',
          url: `/user/api/v1/${tenantKey}/games/${prepared.gameId}/cancel`,
          headers: commandHeaders(ownerToken),
          payload: { reasonCode: 'ORGANIZER_REQUEST' },
        }),
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GAME_HTTP_PROMOTION_CANCEL_TIMEOUT')), 5_000),
      ),
    ]);

    expect(cancel.statusCode).toBe(202);
    expect(['applied', 'no_op']).toContain(promotion.outcome);
    const replay = await roster.promoteWaitlist(prepared.command);
    expect(replay).toMatchObject({ outcome: promotion.outcome, replayed: true });
    const state = await readState(prepared.gameId);
    expect(state).toMatchObject({
      game: { lifecycle_state: 'CANCELLED' },
      participants: { active: promotion.outcome === 'applied' ? '2' : '1' },
      reservations: { active: '0' },
      waitlist: {
        active: promotion.outcome === 'applied' ? '0' : '1',
        promoted: promotion.outcome === 'applied' ? '1' : '0',
      },
    });
  });

  it('proves both serialized promotion-before-cancel and cancel-before-promotion orders', async () => {
    const ownerToken = await token(ownerId);
    const promotionFirst = await prepareWaitlistPromotion('promotion-before-cancel');
    const promoted = await roster.promoteWaitlist(promotionFirst.command);
    expect(promoted).toMatchObject({ outcome: 'applied', replayed: false });
    const cancelledAfterPromotion = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${promotionFirst.gameId}/cancel`,
      headers: commandHeaders(ownerToken),
      payload: { reasonCode: 'ORGANIZER_REQUEST' },
    });
    expect(cancelledAfterPromotion.statusCode).toBe(202);
    await expect(roster.promoteWaitlist(promotionFirst.command)).resolves.toMatchObject({
      outcome: 'applied',
      replayed: true,
    });
    await expect(readState(promotionFirst.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'CANCELLED' },
      participants: { active: '2', distinct_users: '2' },
      waitlist: { active: '0', promoted: '1' },
    });

    const cancelFirst = await prepareWaitlistPromotion('cancel-before-promotion');
    const cancelledBeforePromotion = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${cancelFirst.gameId}/cancel`,
      headers: commandHeaders(ownerToken),
      payload: { reasonCode: 'ORGANIZER_REQUEST' },
    });
    expect(cancelledBeforePromotion.statusCode).toBe(202);
    const noOp = await roster.promoteWaitlist(cancelFirst.command);
    expect(noOp).toMatchObject({ outcome: 'no_op', replayed: false });
    await expect(roster.promoteWaitlist(cancelFirst.command)).resolves.toMatchObject({
      outcome: 'no_op',
      replayed: true,
    });
    await expect(readState(cancelFirst.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'CANCELLED' },
      participants: { active: '1', distinct_users: '1' },
      waitlist: { active: '1', promoted: '0' },
    });
  });

  it('rejects cancellation after start and from a finished terminal state', async () => {
    const ownerToken = await token(ownerId);
    const cancelPayload = { reasonCode: 'ORGANIZER_REQUEST' };
    const started = await createGame('cancel-after-start');
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `update games.games
            set starts_at = now() - interval '1 hour',
                ends_at = now() + interval '30 minutes',
                join_cutoff_at = now() - interval '90 minutes'
          where tenant_id = $1 and id = $2`,
        [tenantId, started.operation.gameId],
      );
    });
    const startedCancel = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${started.operation.gameId}/cancel`,
      headers: commandHeaders(ownerToken),
      payload: cancelPayload,
    });
    expect(startedCancel.statusCode).toBe(409);
    expect(startedCancel.json()).toMatchObject({ code: 'GAME_NOT_CANCELLABLE' });
    await expect(readState(started.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'SCHEDULED', revision: '1' },
      participants: { active: '1', distinct_users: '1' },
    });

    const finished = await createGame('cancel-finished');
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `update games.games
            set lifecycle_state = 'FINISHED',
                revision = revision + 1,
                started_at = starts_at,
                finished_at = ends_at,
                result_state = 'CONFIRMED'
          where tenant_id = $1 and id = $2`,
        [tenantId, finished.operation.gameId],
      );
    });
    const finishedCancel = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${finished.operation.gameId}/cancel`,
      headers: commandHeaders(ownerToken),
      payload: cancelPayload,
    });
    expect(finishedCancel.statusCode).toBe(409);
    expect(finishedCancel.json()).toMatchObject({ code: 'GAME_NOT_CANCELLABLE' });
    await expect(readState(finished.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'FINISHED', revision: '2' },
      participants: { active: '1', distinct_users: '1' },
    });
  });

  it('leaves and cancels with idempotent terminal state and owner-only authorization', async () => {
    const game = await createGame('leave-cancel', 4);
    const playerToken = await token(playerAId);
    const join = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(playerToken),
    });
    expect(join.statusCode).toBe(200);
    const leaveHeaders = commandHeaders(playerToken);
    const left = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/participants/me`,
      headers: leaveHeaders,
    });
    expect(left.statusCode).toBe(200);
    const leaveReplay = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/participants/me`,
      headers: leaveHeaders,
    });
    expect(leaveReplay.statusCode).toBe(200);
    expect(leaveReplay.json()).toMatchObject({ replayed: true });
    await expect(readState(game.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'SCHEDULED', revision: '3' },
      participants: { active: '1', distinct_users: '1' },
    });
    const repeatLeave = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/participants/me`,
      headers: commandHeaders(playerToken),
    });
    expect(repeatLeave.statusCode).toBe(409);
    const ownerLeave = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/participants/me`,
      headers: commandHeaders(await token(ownerId)),
    });
    expect(ownerLeave.statusCode).toBe(409);
    expect(ownerLeave.json()).toMatchObject({ code: 'GAME_ORGANIZER_MUST_CANCEL' });
    const joinedBeforeCancel = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(await token(playerBId)),
    });
    expect(joinedBeforeCancel.statusCode).toBe(200);
    const cancelPayload = { reasonCode: 'ORGANIZER_REQUEST', note: 'verification' };
    for (const accessToken of [
      await token(playerBId),
      await token(unrelatedId),
      await token(adminId, ['games.play'], ['admin']),
    ]) {
      const deniedCancel = await app.inject({
        method: 'POST',
        url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/cancel`,
        headers: commandHeaders(accessToken),
        payload: cancelPayload,
      });
      expect(deniedCancel.statusCode).toBe(409);
      expect(deniedCancel.json()).toMatchObject({ code: 'GAME_NOT_CANCELLABLE' });
    }
    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{ count: string; reasons: string[] }>(
          `select count(*)::text as count,
                  array_agg(reason order by actor_id)::text[] as reasons
             from audit.audit_log
            where tenant_id = $1 and resource_id = $2
              and action = 'GAME_CANCEL_REJECTED'
              and actor_id = any($3::uuid[])`,
          [tenantId, game.operation.gameId, [playerBId, unrelatedId, adminId]],
        );
        return result.rows[0];
      }),
    ).resolves.toEqual({
      count: '3',
      reasons: ['GAME_NOT_CANCELLABLE', 'GAME_NOT_CANCELLABLE', 'GAME_NOT_CANCELLABLE'],
    });
    await expect(readState(game.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'SCHEDULED', revision: '4' },
      participants: { active: '2', distinct_users: '2' },
    });
    const cancelHeaders = commandHeaders(await token(ownerId));
    const cancelled = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/cancel`,
      headers: cancelHeaders,
      payload: cancelPayload,
    });
    expect(cancelled.statusCode).toBe(202);
    const cancelReplay = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/cancel`,
      headers: cancelHeaders,
      payload: cancelPayload,
    });
    expect(cancelReplay.statusCode).toBe(202);
    expect(cancelReplay.json()).toMatchObject({ replayed: true });
    const cancellationEventId = await withTenantTransaction(pool, tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from audit.outbox_events
          where tenant_id = $1 and aggregate_id = $2 and event_type = 'game.cancelled.v1'
          order by occurred_at desc, id desc limit 1`,
        [tenantId, game.operation.gameId],
      );
      return result.rows[0]?.id;
    });
    if (!cancellationEventId) throw new Error('GAME_HTTP_CANCELLATION_EVENT_MISSING');
    await expect(
      management.projectCardEvent({
        tenantId,
        eventId: cancellationEventId,
        gameId: game.operation.gameId,
      }),
    ).resolves.toBe('applied');
    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{
          aggregate_revision: string;
          lifecycle_state: string;
          projection_revision: string;
        }>(
          `select aggregate_revision::text, projection_revision::text, lifecycle_state
             from games.card_projections where tenant_id = $1 and game_id = $2`,
          [tenantId, game.operation.gameId],
        );
        return result.rows[0];
      }),
    ).resolves.toEqual({
      aggregate_revision: '5',
      projection_revision: '5',
      lifecycle_state: 'CANCELLED',
    });
    const publicCancelledDetail = await app.inject({
      method: 'GET',
      url: `/public/api/v1/${tenantKey}/games/${game.operation.gameId}`,
    });
    expect(publicCancelledDetail.statusCode).toBe(200);
    expect(publicCancelledDetail.json()).toMatchObject({
      game: { id: game.operation.gameId, displayState: 'CANCELLED' },
    });
    const ownerHistory = await app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenantKey}/games?scope=HISTORY&limit=50`,
      headers: { authorization: `Bearer ${await token(ownerId)}` },
    });
    expect(ownerHistory.statusCode).toBe(200);
    expect(
      ownerHistory.json<{ items: Array<{ id: string; displayState: string }> }>().items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: game.operation.gameId, displayState: 'CANCELLED' }),
      ]),
    );
    const cancelledJoin = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/join`,
      headers: commandHeaders(await token(playerAId)),
    });
    expect(cancelledJoin.statusCode).toBe(409);
    expect(cancelledJoin.json()).toMatchObject({ code: 'GAME_NOT_JOINABLE' });
    const terminal = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games/${game.operation.gameId}/cancel`,
      headers: commandHeaders(await token(ownerId)),
      payload: cancelPayload,
    });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json()).toMatchObject({ code: 'GAME_NOT_CANCELLABLE' });
    await expect(readState(game.operation.gameId)).resolves.toMatchObject({
      game: { lifecycle_state: 'CANCELLED', revision: '5' },
      participants: { active: '2', distinct_users: '2' },
      reservations: { active: '0' },
      operations: { count: '2' },
      outbox: { count: '7' },
      audit: {
        count: '12',
        cancel_rejected: '4',
        cancelled_success: '1',
        leave_success: '1',
      },
    });
  });
});
