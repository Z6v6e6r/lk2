import { randomUUID } from 'node:crypto';

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
      const operations = await client.query<{ count: string }>(
        `select count(*)::text as count from games.operations where tenant_id = $1 and game_id = $2`,
        [tenantId, gameId],
      );
      const outbox = await client.query<{ count: string }>(
        `select count(*)::text as count from audit.outbox_events
            where tenant_id = $1 and aggregate_id = $2`,
        [tenantId, gameId],
      );
      const audit = await client.query<{ count: string }>(
        `select count(*)::text as count from audit.audit_log
            where tenant_id = $1 and resource_id = $2`,
        [tenantId, gameId],
      );
      return {
        game: game.rows[0],
        participants: participants.rows[0],
        reservations: reservations.rows[0],
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
    await expect(
      withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{ games: string; commands: string }>(
          `select
             (select count(*) from games.games where tenant_id = $1 and station_id = $2)::text as games,
             (select count(*) from games.command_idempotency
               where tenant_id = $1 and idempotency_key = any($3::text[]))::text as commands`,
          [
            tenantId,
            invalidStationId,
            [pastHeaders['idempotency-key'], invalidHeaders['idempotency-key']],
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

  it('enforces join revisions, retries, permission and actor-scoped operation readback', async () => {
    const game = await createGame('join');
    const playerToken = await token(playerAId);
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
      audit: { count: '8' },
    });
  });
});
