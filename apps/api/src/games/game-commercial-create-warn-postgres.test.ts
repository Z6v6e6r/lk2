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

import { createBookedOperationAdmissionTargetRepository } from '../../../../packages/database/src/booked-operation-admission-target-repository.js';
import {
  createGameCommercialCreateRuntime,
  type GameCommercialCreateOptions,
} from './game-create-commercial-runtime.js';
import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';

/**
 * Real-PostgreSQL acceptance evidence for the managed commercial CREATE WARN contour.
 *
 * The unit suites prove the orchestration with mocked writer/owner. This verifier proves the actual
 * schema effects of the composed HTTP boundary: the paid create is accepted as an unresolved
 * operation, the aggregate is a `PROVISIONING` draft, no booking/capacity/projection state is
 * written, and a same-key repeat returns the exact same game and operation.
 *
 * It runs only with an explicitly supplied, query-free loopback `*_verify` database, exactly like the
 * existing lifecycle verifier; supplying the URL means the database is disposable and owned by the
 * caller. No shared/staging database, no provider call and no migration is part of this test.
 */
const connectionString = process.env.GAME_COMMERCIAL_CREATE_TEST_DATABASE_URL;

export function assertDisposableCreateDatabase(url: string): void {
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
      'GAME_COMMERCIAL_CREATE_TEST_DATABASE_URL must use a query-free loopback *_verify database',
    );
  }
}

if (connectionString) assertDisposableCreateDatabase(connectionString);
const describePostgres = connectionString ? describe : describe.skip;

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: connectionString ?? 'postgresql://phub:test@localhost:5432/phub_verify',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  GAMES_READ_ENABLED: 'true',
  GAMES_COMMANDS_ENABLED: 'true',
  GAME_COMMERCIAL_CREATE_ENABLED: 'true',
});

describePostgres('managed commercial CREATE through HTTP and PostgreSQL', () => {
  const pool = new Pool({ connectionString, max: 8 });
  const management = createGameRepository(pool);
  const roster = createGameRosterRepository(pool);
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const ownerId = randomUUID();
  const otherTenantUserId = randomUUID();
  const stationId = randomUUID();
  const tenantKey = `create-warn-${tenantId.slice(0, 8)}`;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function token(
    userId: string,
    permissions: readonly string[] = ['games.play'],
  ): Promise<string> {
    return new SignJWT({
      tenants: [tenantId],
      permissions,
      roles: ['client'],
      sid: randomUUID(),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setSubject(userId)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  }

  function paidPayload(label: string) {
    return {
      title: `Managed create ${label} ${randomUUID()}`,
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId,
      startsAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 25 * 60 * 60_000).toISOString(),
      timezone: 'Europe/Moscow',
      capacity: 4,
      levelRange: null,
      paymentMode: 'SPLIT',
      waitlistEnabled: true,
    } as const;
  }

  async function createPaidGame(key: string, payload: object, userId = ownerId) {
    return app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenantKey}/games`,
      headers: {
        authorization: `Bearer ${await token(userId)}`,
        'idempotency-key': key,
        'x-correlation-id': randomUUID(),
      },
      payload,
    });
  }

  async function readCreateState(gameId: string) {
    return withTenantTransaction(pool, tenantId, async (client) => {
      const game = await client.query<{
        lifecycle_state: string;
        revision: string;
        payment_mode: string;
      }>(
        `select lifecycle_state, revision::text, payment_mode
           from games.games where tenant_id = $1 and id = $2`,
        [tenantId, gameId],
      );
      const operation = await client.query<{
        kind: string;
        state: string;
        completed: string;
      }>(
        `select kind, state, (completed_at is null)::text as completed
           from games.operations where tenant_id = $1 and game_id = $2`,
        [tenantId, gameId],
      );
      const commands = await client.query<{ command_type: string; count: string }>(
        `select command_type, count(*)::text as count
           from games.scheduled_commands where tenant_id = $1 and game_id = $2
          group by command_type`,
        [tenantId, gameId],
      );
      const counts = await client.query<{
        idempotency: string;
        participations: string;
        reservations: string;
        projections: string;
      }>(
        `select
           (select count(*) from games.command_idempotency
             where tenant_id = $1 and aggregate_id = $2)::text as idempotency,
           (select count(*) from games.participations
             where tenant_id = $1 and game_id = $2 and role = 'ORGANIZER'
               and state = 'ACTIVE' and payment_state = 'NOT_REQUIRED')::text
             as participations,
           (select count(*) from games.seat_reservations
             where tenant_id = $1 and game_id = $2)::text as reservations,
           (select count(*) from games.card_projections
             where tenant_id = $1 and game_id = $2)::text as projections`,
        [tenantId, gameId],
      );
      const events = await client.query<{ event_type: string }>(
        `select event_type from audit.outbox_events where tenant_id = $1 and aggregate_id = $2`,
        [tenantId, gameId],
      );
      return {
        game: game.rows[0],
        operation: operation.rows[0],
        commands: commands.rows,
        counts: counts.rows[0],
        eventTypes: events.rows.map((row) => row.event_type).sort(),
      };
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'Managed commercial CREATE verification')`,
      [tenantId, tenantKey],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         select $1, user_id, 'ACTIVE' from unnest($2::uuid[]) users(user_id)`,
        [tenantId, [ownerId, otherTenantUserId]],
      );
      await client.query(
        `insert into locations.profiles (
           tenant_id, id, slug, title, publication_status, created_by, updated_by, published_at
         ) values ($1, $2, $3, 'Managed create station', 'PUBLISHED', $4, $4, now())`,
        [tenantId, stationId, `create-warn-${stationId}`, ownerId],
      );
    });
    const commercialCreate: GameCommercialCreateOptions | undefined =
      createGameCommercialCreateRuntime({ config, repository: management });
    if (!commercialCreate) throw new Error('GAME_COMMERCIAL_CREATE_RUNTIME_NOT_COMPOSED');
    app = await buildApp({
      config,
      logger: createLogger('game-commercial-create-pg-test', 'silent'),
      pool,
      gameCommandRepository: management,
      gameReadRepository: management,
      gameRosterRepository: roster,
      gameCommercialCreate: commercialCreate,
    });
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it('creates a PROVISIONING draft with a PENDING operation and no booking, projection or publish', async () => {
    const key = `create-warn-${randomUUID()}`;
    const payload = paidPayload('happy');
    const response = await createPaidGame(key, payload);
    expect(response.statusCode).toBe(202);
    const body = response.json<{
      commandId: string;
      operation: {
        id: string;
        type: string;
        status: string;
        gameId: string;
        aggregateRevision: number;
        nextAction: { type: string };
        error: unknown;
        commercial: {
          attemptState: string;
          quote: { basis: string } | null;
          reservation: unknown;
          receipt: unknown;
          price: unknown;
        };
      };
      replayed: boolean;
    }>();
    expect(body).toMatchObject({
      operation: {
        type: 'CREATE_GAME',
        status: 'UNKNOWN',
        aggregateRevision: 1,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION' },
        error: null,
        commercial: {
          attemptState: 'WARN_OBSERVED',
          quote: { basis: 'ADVISORY' },
          reservation: null,
          receipt: null,
          price: null,
        },
      },
      replayed: false,
    });
    expect(body.commandId).toBe(body.operation.id);
    expect(body.operation.gameId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const state = await readCreateState(body.operation.gameId);
    // The paid create is a commercial draft in PROVISIONING, never a published/scheduled game.
    expect(state.game).toEqual({
      lifecycle_state: 'PROVISIONING',
      revision: '1',
      payment_mode: 'SPLIT',
    });
    expect(state.operation).toEqual({ kind: 'CREATE_GAME', state: 'PENDING', completed: 'true' });
    expect(state.commands).toEqual([{ command_type: 'game.provisioning.advance.v1', count: '1' }]);
    expect(state.counts).toEqual({
      idempotency: '1',
      participations: '1',
      reservations: '0',
      projections: '0',
    });
    expect(state.eventTypes).toEqual(['game.created.v1', 'game.provisioning.requested.v1']);

    // Readback stays unresolved: never FAILED/SUCCEEDED without a trusted receipt.
    const readback = await app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenantKey}/game-operations/${body.operation.id}`,
      headers: { authorization: `Bearer ${await token(ownerId)}` },
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toMatchObject({
      commandId: body.operation.id,
      operation: {
        type: 'CREATE_GAME',
        status: 'UNKNOWN',
        gameId: body.operation.gameId,
        error: null,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION' },
        commercial: { attemptState: 'UNKNOWN', reason: 'GAME_RECONCILIATION_REQUIRED' },
      },
      replayed: true,
    });

    // The actor-scoped operation read never exposes another member's draft.
    const foreignReadback = await app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenantKey}/game-operations/${body.operation.id}`,
      headers: { authorization: `Bearer ${await token(otherTenantUserId)}` },
    });
    expect(foreignReadback.statusCode).toBe(404);
  });

  it('replays the same key and body without a second game or operation, and refuses a changed body', async () => {
    const key = `create-warn-${randomUUID()}`;
    const payload = paidPayload('replay');
    const created = await createPaidGame(key, payload);
    expect(created.statusCode).toBe(202);
    const createdBody = created.json<{ commandId: string; operation: { gameId: string } }>();

    const replay = await createPaidGame(key, payload);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({
      commandId: createdBody.commandId,
      operation: { gameId: createdBody.operation.gameId, status: 'UNKNOWN' },
      replayed: true,
    });
    const state = await readCreateState(createdBody.operation.gameId);
    expect(state.counts).toMatchObject({ idempotency: '1', participations: '1' });

    const changed = await createPaidGame(key, { ...payload, title: `${payload.title} changed` });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'GAME_COMMERCIAL_ATTEMPT_CONFLICT' });
    const afterChanged = await readCreateState(createdBody.operation.gameId);
    expect(afterChanged.counts).toMatchObject({ idempotency: '1' });
  });

  it('resolves the draft target only for its own organizer and revision', async () => {
    const created = await createPaidGame(`create-warn-${randomUUID()}`, paidPayload('draft'));
    expect(created.statusCode).toBe(202);
    const gameId = created.json<{ operation: { gameId: string } }>().operation.gameId;
    const targets = createBookedOperationAdmissionTargetRepository(pool);

    await expect(
      targets.resolveCreateDraft({
        tenantId,
        targetId: gameId,
        expectedRevision: 1,
        actorUserId: ownerId,
      }),
    ).resolves.toMatchObject({
      draftGameId: gameId,
      expectedRevision: 1,
      capacity: 4,
      paymentMode: 'SPLIT',
      admissible: true,
    });
    await expect(
      targets.resolveCreateDraft({
        tenantId,
        targetId: gameId,
        expectedRevision: 1,
        actorUserId: otherTenantUserId,
      }),
    ).resolves.toBeNull();
    await expect(
      targets.resolveCreateDraft({
        tenantId: foreignTenantId,
        targetId: gameId,
        expectedRevision: 1,
        actorUserId: ownerId,
      }),
    ).resolves.toBeNull();
    await expect(
      targets.resolveCreateDraft({
        tenantId,
        targetId: gameId,
        expectedRevision: 2,
        actorUserId: ownerId,
      }),
    ).resolves.toBeNull();
  });
});
