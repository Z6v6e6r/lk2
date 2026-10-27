import { loadConfig } from '@phub/config';
import type {
  CreateStoredGameInput,
  GameRepository,
  GameTestCourtRepository,
  GameRosterRepository,
  GameRosterUserCommandInput,
} from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJoinConditionsFixture } from './game-join-conditions.test-fixture.js';
import {
  commercialCreateDraftGameId,
  commercialCreateOperationId,
  type CommercialCreateOwnerPort,
  type CommercialCreateQuote,
} from './game-create-commercial.js';
import type { GameCommercialCreateOptions } from './game-create-commercial-runtime.js';
import { subscriptionRuntimeIdempotencyKeySha256 } from '../subscriptions/subscription-runtime-actor-delegation-issuer.js';
import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const commandId = 'd39e4287-e65c-4e75-88e4-4447e4c91ddb';
const invitationId = '95a76d36-d8a7-4ff5-a988-84f33c0fd05a';
const committedAt = '2026-08-01T10:00:00.000Z';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

type UserRosterRepository = Pick<
  GameRosterRepository,
  'join' | 'joinWaitlist' | 'leave' | 'leaveWaitlist' | 'getOperation'
>;
type UserManagementRepository = Pick<
  GameRepository,
  'create' | 'cancel' | 'getManagementOperation'
>;

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(
  permissions: readonly string[] = ['games.play'],
  tenants: readonly string[] = [tenantId],
): Promise<string> {
  return new SignJWT({
    tenants,
    roles: ['client'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function applied(
  overrides: Partial<
    Extract<Awaited<ReturnType<GameRosterRepository['join']>>, { outcome: 'applied' }>
  > & { readonly omitParticipation?: boolean } = {},
) {
  const { omitParticipation = false, ...resultOverrides } = overrides;
  return {
    outcome: 'applied' as const,
    commandId,
    gameId,
    revision: 2,
    viewerRelation: 'PARTICIPANT' as const,
    ...(omitParticipation ? {} : { participationId: '05d8cc21-9ab9-4ec2-a966-cb52ef13dd29' }),
    committedAt,
    replayed: false,
    ...resultOverrides,
  };
}

function repository(overrides: Partial<UserRosterRepository> = {}): UserRosterRepository {
  return {
    join: vi.fn().mockResolvedValue(applied()),
    joinWaitlist: vi.fn().mockResolvedValue(
      applied({
        viewerRelation: 'WAITLISTED',
        omitParticipation: true,
        waitlistEntryId: '7527d5e1-da33-464a-94c7-ace34a11e295',
        position: 1,
      }),
    ),
    leave: vi.fn().mockResolvedValue(applied({ viewerRelation: 'NONE', omitParticipation: true })),
    leaveWaitlist: vi
      .fn()
      .mockResolvedValue(applied({ viewerRelation: 'NONE', omitParticipation: true })),
    getOperation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function managementRepository(
  overrides: Partial<UserManagementRepository> = {},
): UserManagementRepository {
  return {
    create: vi.fn().mockResolvedValue({
      outcome: 'applied',
      gameId,
      operationId: commandId,
      revision: 1,
      committedAt,
      replayed: false,
    }),
    cancel: vi.fn().mockResolvedValue({
      outcome: 'applied',
      commandId,
      gameId,
      revision: 2,
      committedAt,
      replayed: false,
    }),
    getManagementOperation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function appWith(
  repositoryValue: UserRosterRepository,
  managementRepositoryValue?: UserManagementRepository,
  testCourtRepository?: GameTestCourtRepository,
  commercialCreate?: GameCommercialCreateOptions,
) {
  const app = await buildApp({
    config,
    logger: createLogger('games-api-test', 'silent'),
    pool: fakePool(),
    gameRosterRepository: repositoryValue,
    ...(testCourtRepository ? { gameTestCourtRepository: testCourtRepository } : {}),
    ...(managementRepositoryValue ? { gameCommandRepository: managementRepositoryValue } : {}),
    ...(commercialCreate ? { gameCommercialCreate: commercialCreate } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Games management User API', () => {
  it('returns an empty tester catalogue by default with no public cache', async () => {
    const app = await appWith(repository());
    const response = await app.inject({
      url: '/user/api/v1/local-padel/games/test-courts',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect((await app.inject('/user/api/v1/local-padel/games/test-courts')).statusCode).toBe(401);
  });

  it.each(['join', 'waitlist'])(
    'checks current stored test access before %s, including repository replays',
    async (endpoint) => {
      const roster = repository();
      const canJoin = vi.fn().mockResolvedValue(false);
      const app = await appWith(roster, undefined, {
        canJoin,
        hasAccess: vi.fn().mockResolvedValue(false),
        list: vi.fn().mockResolvedValue([]),
      });
      const response = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/games/${gameId}/${endpoint}`,
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'idempotency-key': 'test-court-replayed-0001',
          'x-correlation-id': '71587e84-6fbe-4419-84ef-f915909c64f1',
        },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      expect(canJoin).toHaveBeenCalledWith(tenantId, userId, gameId, {
        commandType: endpoint === 'join' ? 'game.join.v1' : 'game.waitlist.join.v1',
        correlationId: '71587e84-6fbe-4419-84ef-f915909c64f1',
      });
      expect(roster.join).not.toHaveBeenCalled();
      expect(roster.joinWaitlist).not.toHaveBeenCalled();
    },
  );
  it('creates only a free game and derives actor, tenant and cutoff at the API boundary', async () => {
    const create = vi.fn().mockResolvedValue({
      outcome: 'applied',
      gameId,
      operationId: commandId,
      revision: 1,
      committedAt,
      replayed: false,
    });
    const app = await appWith(repository(), managementRepository({ create }));
    const startsAt = '2027-08-15T15:00:00.000Z';
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-create-command-0001',
        'x-correlation-id': 'games-api-create-correlation-0001',
      },
      payload: {
        title: '  Игра для теста  ',
        kind: 'FRIENDLY',
        visibility: 'PUBLIC',
        stationId: '11111111-1111-4111-8111-111111111111',
        startsAt,
        endsAt: '2027-08-15T16:30:00.000Z',
        timezone: 'Europe/Moscow',
        capacity: 4,
        levelRange: { from: 'C', to: 'B' },
        paymentMode: 'NO_PAYMENT',
        waitlistEnabled: true,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      commandId,
      operation: { type: 'CREATE_GAME', status: 'SUCCEEDED', gameId },
      replayed: false,
    });
    const input = create.mock.calls[0]?.[0] as CreateStoredGameInput | undefined;
    expect(input).toMatchObject({
      tenantId,
      actorUserId: userId,
      title: 'Игра для теста',
      paymentMode: 'NO_PAYMENT',
      startsAt,
      joinCutoffAt: '2027-08-15T14:30:00.000Z',
      levelFrom: 'C',
      levelTo: 'B',
    });
    expect(input?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reaches durable replay for a past start and returns the original game', async () => {
    const create = vi.fn().mockResolvedValue({
      outcome: 'applied',
      gameId,
      operationId: commandId,
      revision: 1,
      committedAt,
      replayed: true,
    });
    const app = await appWith(repository(), managementRepository({ create }));
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-create-replay-past-0001',
      },
      payload: {
        title: 'Уже начавшаяся игра',
        kind: 'FRIENDLY',
        visibility: 'PUBLIC',
        stationId: '11111111-1111-4111-8111-111111111111',
        startsAt: '2026-01-15T15:00:00.000Z',
        endsAt: '2026-01-15T16:30:00.000Z',
        timezone: 'Europe/Moscow',
        capacity: 4,
        levelRange: null,
        paymentMode: 'NO_PAYMENT',
        waitlistEnabled: true,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { gameId },
      replayed: true,
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it('maps post-lookup create rejections without disclosing location ownership', async () => {
    const pastPayload = {
      title: 'Новая прошедшая игра',
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId: '11111111-1111-4111-8111-111111111111',
      startsAt: '2026-01-15T15:00:00.000Z',
      endsAt: '2026-01-15T16:30:00.000Z',
      timezone: 'Europe/Moscow',
      capacity: 4,
      levelRange: null,
      paymentMode: 'NO_PAYMENT',
      waitlistEnabled: true,
    } as const;
    const create = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'rejected', code: 'GAME_START_TIME_PASSED' })
      .mockResolvedValueOnce({ outcome: 'rejected', code: 'GAME_LOCATION_INVALID' })
      .mockResolvedValueOnce({ outcome: 'idempotency_conflict' });
    const app = await appWith(repository(), managementRepository({ create }));
    const authorization = `Bearer ${await accessToken()}`;

    const rejected = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: { authorization, 'idempotency-key': 'games-api-create-past-new-0001' },
      payload: pastPayload,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ code: 'GAME_START_TIME_PASSED' });

    const invalidLocation = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: { authorization, 'idempotency-key': 'games-api-create-location-invalid-0001' },
      payload: { ...pastPayload, title: 'Игра с неверной локацией' },
    });
    expect(invalidLocation.statusCode).toBe(400);
    expect(invalidLocation.json()).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Проверьте параметры и время игры.',
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: { authorization, 'idempotency-key': 'games-api-create-past-conflict-0001' },
      payload: { ...pastPayload, title: 'Изменённая прошедшая игра' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects paid or caller-extended create payloads before persistence', async () => {
    const create = vi.fn();
    const app = await appWith(repository(), managementRepository({ create }));
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': 'games-api-create-rejected-0001',
    };
    const basePayload = {
      title: 'Платная игра',
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      stationId: '11111111-1111-4111-8111-111111111111',
      startsAt: '2027-08-15T15:00:00.000Z',
      endsAt: '2027-08-15T16:30:00.000Z',
      timezone: 'Europe/Moscow',
      capacity: 4,
      levelRange: null,
      paymentMode: 'SPLIT',
      waitlistEnabled: true,
    };

    const paid = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers,
      payload: basePayload,
    });
    expect(paid.statusCode).toBe(409);
    expect(paid.json()).toMatchObject({ code: 'GAME_PAYMENT_REQUIRED' });

    const injected = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: { ...headers, 'idempotency-key': 'games-api-create-rejected-0002' },
      payload: { ...basePayload, paymentMode: 'NO_PAYMENT', organizerUserId: userId },
    });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(create).not.toHaveBeenCalled();
  });

  it('cancels through the authenticated organizer command and preserves stable rejection codes', async () => {
    const cancel = vi.fn().mockResolvedValue({
      outcome: 'applied',
      commandId,
      gameId,
      revision: 2,
      committedAt,
      replayed: false,
    });
    const app = await appWith(repository(), managementRepository({ cancel }));
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/cancel`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-cancel-command-0001',
      },
      payload: { reasonCode: 'ORGANIZER_REQUEST', note: 'Планы изменились' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { type: 'CANCEL_GAME', status: 'SUCCEEDED', gameId },
    });
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        gameId,
        reasonCode: 'ORGANIZER_REQUEST',
      }),
    );

    vi.mocked(cancel).mockResolvedValueOnce({
      outcome: 'rejected',
      code: 'GAME_NOT_CANCELLABLE',
      currentRevision: 2,
      replayed: false,
    });
    const rejected = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/cancel`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-cancel-command-0002',
      },
      payload: { reasonCode: 'ORGANIZER_REQUEST' },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: 'GAME_NOT_CANCELLABLE' });
  });

  it('reads back an actor-owned management operation through the documented endpoint', async () => {
    const getManagementOperation = vi.fn().mockResolvedValue({
      commandType: 'game.create.v1',
      result: {
        outcome: 'applied',
        gameId,
        operationId: commandId,
        revision: 1,
        committedAt,
        replayed: true,
      },
    });
    const app = await appWith(repository(), managementRepository({ getManagementOperation }));

    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/game-operations/${commandId}`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      commandId,
      operation: { type: 'CREATE_GAME', status: 'SUCCEEDED', gameId },
      replayed: true,
    });
    expect(getManagementOperation).toHaveBeenCalledWith({
      tenantId,
      actorUserId: userId,
      operationId: commandId,
    });
  });
});

describe('Games roster User API', () => {
  it('derives actor and tenant from JWT, validates the body and returns the durable result', async () => {
    const join = vi.fn().mockResolvedValue(applied());
    const app = await appWith(repository({ join }));
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-join-command-0001',
        'x-correlation-id': 'games-api-correlation-0001',
      },
      payload: { expectedRevision: 1, invitationId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      commandId,
      operation: {
        id: commandId,
        type: 'JOIN_GAME',
        status: 'SUCCEEDED',
        gameId,
        aggregateRevision: 2,
        createdAt: committedAt,
        updatedAt: committedAt,
        nextAction: { type: 'NONE' },
        error: null,
      },
      game: null,
      replayed: false,
    });
    const joinInput = join.mock.calls[0]?.[0] as unknown as GameRosterUserCommandInput | undefined;
    expect(joinInput).toMatchObject({
      tenantId,
      actorUserId: userId,
      gameId,
      idempotencyKey: 'games-api-join-command-0001',
      correlationId: 'games-api-correlation-0001',
      expectedRevision: 1,
      invitationId,
    });
    expect(joinInput?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects missing idempotency and caller-controlled roster fields before the repository', async () => {
    const join = vi.fn().mockResolvedValue(applied());
    const app = await appWith(repository({ join }));
    const authorization = `Bearer ${await accessToken()}`;

    const missingKey = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers: { authorization },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    for (const [index, payload] of [
      { playerId: '47b10c0e-2d9f-4775-96dc-2941adae4968' },
      { playerLevelId: '47b10c0e-2d9f-4775-96dc-2941adae4968' },
      { rank: 7 },
      { personalInvite: true },
      { skipLevelCheck: true },
    ].entries()) {
      const injectedField = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/games/${gameId}/join`,
        headers: { authorization, 'idempotency-key': `games-api-injection-${index}` },
        payload,
      });
      expect(injectedField.statusCode).toBe(400);
      expect(injectedField.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(join).not.toHaveBeenCalled();
  });

  it('requires the server-issued games.play permission', async () => {
    const join = vi.fn().mockResolvedValue(applied());
    const app = await appWith(repository({ join }));
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers: {
        authorization: `Bearer ${await accessToken([])}`,
        'idempotency-key': 'games-api-denied-command-0001',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'GAME_PERMISSION_REQUIRED' });
    expect(join).not.toHaveBeenCalled();
  });

  it('fails closed while the production Games repository is not injected', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('games-api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-disabled-command-0001',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'GAMES_RUNTIME_UNAVAILABLE' });
  });

  it('routes waitlist and leave commands to their explicit repository methods', async () => {
    const joinWaitlist = vi.fn().mockResolvedValue(
      applied({
        viewerRelation: 'WAITLISTED',
        omitParticipation: true,
        waitlistEntryId: '7527d5e1-da33-464a-94c7-ace34a11e295',
        position: 1,
      }),
    );
    const leave = vi
      .fn()
      .mockResolvedValue(applied({ viewerRelation: 'NONE', omitParticipation: true }));
    const leaveWaitlist = vi
      .fn()
      .mockResolvedValue(applied({ viewerRelation: 'NONE', omitParticipation: true }));
    const app = await appWith(repository({ joinWaitlist, leave, leaveWaitlist }));
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': 'games-api-roster-command-0001',
    };

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/games/${gameId}/waitlist`,
        headers,
        payload: { invitationId },
      }),
      app.inject({
        method: 'DELETE',
        url: `/user/api/v1/local-padel/games/${gameId}/participants/me`,
        headers: { ...headers, 'idempotency-key': 'games-api-roster-command-0002' },
      }),
      app.inject({
        method: 'DELETE',
        url: `/user/api/v1/local-padel/games/${gameId}/waitlist/me`,
        headers: { ...headers, 'idempotency-key': 'games-api-roster-command-0003' },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(
      responses.map((response) => response.json<{ operation: { type: string } }>().operation.type),
    ).toEqual(['JOIN_WAITLIST', 'LEAVE_GAME', 'LEAVE_WAITLIST']);
    expect(joinWaitlist).toHaveBeenCalledOnce();
    expect(joinWaitlist).toHaveBeenCalledWith(expect.objectContaining({ invitationId }));
    expect(leave).toHaveBeenCalledOnce();
    expect(leaveWaitlist).toHaveBeenCalledOnce();
  });

  it.each(['SPLIT', 'SUBSCRIPTION'])(
    'maps a fail-closed %s join to the stable public payment error',
    async () => {
      const join = vi.fn().mockResolvedValue({
        outcome: 'rejected',
        code: 'GAME_PAYMENT_REQUIRED',
        currentRevision: 7,
        replayed: false,
      });
      const app = await appWith(repository({ join }));
      const headers = {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-paid-command-0001',
      };
      const response = await app.inject({
        method: 'POST',
        url: `/user/api/v1/local-padel/games/${gameId}/join`,
        headers,
        payload: { expectedRevision: 7 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'GAME_PAYMENT_REQUIRED',
        message: 'Платёжный контур этой игры пока недоступен.',
      });
      expect(join).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }));
    },
  );

  it('maps stable domain and idempotency conflicts without leaking repository details', async () => {
    const full = await appWith(
      repository({
        join: vi.fn().mockResolvedValue({
          outcome: 'rejected',
          code: 'GAME_FULL',
          currentRevision: 7,
          replayed: false,
        }),
      }),
    );
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': 'games-api-full-command-0001',
    };
    const fullResponse = await full.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers,
    });
    expect(fullResponse.statusCode).toBe(409);
    expect(fullResponse.json()).toMatchObject({ code: 'GAME_FULL' });

    const conflict = await appWith(
      repository({ join: vi.fn().mockResolvedValue({ outcome: 'idempotency_conflict' }) }),
    );
    const conflictResponse = await conflict.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers,
    });
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('reads only the authenticated user durable operation', async () => {
    const getOperation = vi.fn().mockResolvedValue({
      commandId,
      commandType: 'game.join.v1',
      gameId,
      state: 'COMPLETED',
      committedAt,
      result: applied({ replayed: true }),
    });
    const app = await appWith(repository({ getOperation }));
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/game-operations/${commandId}`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      commandId,
      operation: { type: 'JOIN_GAME', status: 'SUCCEEDED' },
      replayed: true,
    });
    expect(getOperation).toHaveBeenCalledWith({
      tenantId,
      actorUserId: userId,
      operationId: commandId,
    });
  });
});

describe('paid JOIN reconciliation HTTP boundary', () => {
  it('scopes recovery to the authenticated actor and never invokes an owner for a foreign attempt', async () => {
    const getPaidJoinAttempt = vi.fn().mockResolvedValue(null);
    const read = vi.fn();
    const execute = vi.fn();
    const confirmPayment = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('join-reconcile-test', 'silent'),
      pool: fakePool(),
      gameRosterRepository: repository(),
      gameCommercialJoin: {
        repository: {
          beginPaidJoin: vi.fn(),
          getPaidJoinAttempt,
          failPaidJoinAttempt: vi.fn(),
          confirmPayment,
        },
        conditionsOwner: createJoinConditionsFixture().owner,
        owner: { read, execute },
      },
    });
    apps.push(app);
    const result = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/game-operations/${commandId}/reconcile`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': `join-reconcile:${commandId}`,
      },
    });
    expect(result.statusCode).toBe(404);
    expect(getPaidJoinAttempt).toHaveBeenCalledWith({
      tenantId,
      actorUserId: userId,
      operationId: commandId,
    });
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(confirmPayment).not.toHaveBeenCalled();
  });
  it('requires authenticated tenant permission and never accepts client receipt fields', async () => {
    const app = await appWith(repository());
    const url = `/user/api/v1/local-padel/game-operations/${commandId}/reconcile`;
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${await accessToken([])}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization: `Bearer ${await accessToken(['games.play'], [gameId])}` },
        })
      ).statusCode,
    ).toBe(403);
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': `join-reconcile:${commandId}`,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { receipt: { bookingId: 'untrusted' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'idempotency-key': 'different-command-key' },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('managed commercial CREATE HTTP boundary (WARN)', () => {
  const managedKey = 'games-api-commercial-create-0001';
  const managedKeySha256 = subscriptionRuntimeIdempotencyKeySha256(managedKey);
  const draftGameId = commercialCreateDraftGameId({
    tenantId,
    userId,
    idempotencyKeySha256: managedKeySha256,
  });
  const operationId = commercialCreateOperationId({
    tenantId,
    userId,
    idempotencyKeySha256: managedKeySha256,
  });
  const paidPayload = {
    title: 'Платная игра',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    stationId: '11111111-1111-4111-8111-111111111111',
    startsAt: '2027-08-15T15:00:00.000Z',
    endsAt: '2027-08-15T16:30:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 4,
    levelRange: null,
    paymentMode: 'SPLIT',
    waitlistEnabled: true,
  } as const;

  function advisoryQuote(overrides: Partial<CommercialCreateQuote> = {}): CommercialCreateQuote {
    return {
      basis: 'ADVISORY',
      decisionId: 'advisory:test-decision-0001',
      outcome: 'ALLOWED',
      price: null,
      reasonCodes: [],
      evaluatedAt: '2026-08-01T10:00:00.000Z',
      expiresAt: '2026-08-01T10:15:00.000Z',
      ...overrides,
    };
  }

  function advisoryOwner(overrides: Record<string, unknown> = {}): CommercialCreateOwnerPort & {
    quote: ReturnType<typeof vi.fn>;
    reserve: ReturnType<typeof vi.fn>;
  } {
    return {
      quote: vi.fn().mockResolvedValue(advisoryQuote()),
      reserve: vi
        .fn()
        .mockResolvedValue({ status: 'SKIPPED_ADVISORY', reason: 'GAME_COMMERCIAL_CREATE_WARN' }),
      ...overrides,
    };
  }

  function commercialCreateOptions(
    owner: CommercialCreateOwnerPort,
    create: ReturnType<typeof vi.fn>,
  ): GameCommercialCreateOptions {
    return { repository: { create } as never, owner };
  }

  function appliedCreate(
    overrides: Partial<{
      gameId: string;
      operationId: string;
      replayed: boolean;
    }> = {},
  ) {
    return {
      outcome: 'applied' as const,
      gameId: draftGameId,
      operationId,
      revision: 1,
      committedAt,
      replayed: false,
      ...overrides,
    };
  }

  it('creates a PROVISIONING draft through the advisory owner and reports UNKNOWN with reconciliation', async () => {
    const create = vi.fn().mockResolvedValue(appliedCreate());
    const owner = advisoryOwner();
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': managedKey,
      },
      payload: paidPayload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      commandId: operationId,
      operation: {
        id: operationId,
        type: 'CREATE_GAME',
        status: 'UNKNOWN',
        gameId: draftGameId,
        aggregateRevision: 1,
        error: null,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 5 },
        commercial: {
          attemptState: 'WARN_OBSERVED',
          reservation: null,
          receipt: null,
          price: null,
          quote: { basis: 'ADVISORY', outcome: 'ALLOWED' },
        },
      },
      game: null,
      replayed: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      tenantId,
      actorUserId: userId,
      idempotencyKey: managedKey,
      gameId: draftGameId,
      operationId,
      paymentMode: 'SPLIT',
    });
    // WARN must never look like a charge or a booking.
    expect(JSON.stringify(response.json())).not.toContain('SUCCEEDED');
    expect(owner.reserve).toHaveBeenCalledTimes(1);
  });

  it('replays the same operation for a repeated Idempotency-Key without a second owner request', async () => {
    const create = vi.fn().mockResolvedValue(appliedCreate({ replayed: true }));
    const owner = advisoryOwner();
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': managedKey,
      },
      payload: paidPayload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      commandId: operationId,
      operation: { status: 'UNKNOWN', gameId: draftGameId },
      replayed: true,
    });
    expect(owner.reserve).not.toHaveBeenCalled();
  });

  it('refuses a payment mode outside the managed contour with a managed code and no write', async () => {
    const create = vi.fn();
    const owner = advisoryOwner();
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': `${managedKey}-organizer-pays`,
      },
      payload: { ...paidPayload, paymentMode: 'ORGANIZER_PAYS' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'GAME_PAYMENT_MODE_MISMATCH' });
    expect(create).not.toHaveBeenCalled();
  });

  it('requires the exact authoritative price echo before any local write', async () => {
    const create = vi.fn().mockResolvedValue(appliedCreate());
    const owner = advisoryOwner({
      quote: vi.fn().mockResolvedValue(
        advisoryQuote({
          basis: 'OWNER',
          price: { amountMinor: 250000, currency: 'RUB', expiresAt: '2099-01-01T00:00:00.000Z' },
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      ),
    });
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );
    const headers = {
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': managedKey,
    };

    const missing = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers,
      payload: paidPayload,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(create).not.toHaveBeenCalled();

    const changed = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers,
      payload: { ...paidPayload, priceConsent: { amountMinor: 249999, currency: 'RUB' } },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(create).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers,
      payload: { ...paidPayload, priceConsent: { amountMinor: 250000, currency: 'RUB' } },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      operation: { status: 'UNKNOWN', commercial: { price: { consent: 'SETTLED' } } },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('validates managed-only create fields strictly', async () => {
    const create = vi.fn();
    const owner = advisoryOwner();
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );
    const headers = async (key: string) => ({
      authorization: `Bearer ${await accessToken()}`,
      'idempotency-key': key,
    });

    for (const [index, extra] of [
      { priceConsent: { amountMinor: 1.5, currency: 'RUB' } },
      { subscriptionInstanceId: 'not-a-uuid' },
      { organizerUserId: '55555555-5555-4555-8555-555555555555' },
      { gameId: '55555555-5555-4555-8555-555555555555' },
      { operationId: '55555555-5555-4555-8555-555555555555' },
      { tenantId: '55555555-5555-4555-8555-555555555555' },
    ].entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/games',
        headers: await headers(`games-api-commercial-create-invalid-${index}`),
        payload: { ...paidPayload, ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps an unresolved owner outcome UNKNOWN and never rewrites it as FAILED', async () => {
    const create = vi.fn().mockResolvedValue(appliedCreate());
    const owner = advisoryOwner({
      reserve: vi.fn().mockResolvedValue({ status: 'UNKNOWN' }),
    });
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': managedKey,
      },
      payload: paidPayload,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: {
        status: 'UNKNOWN',
        error: null,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION' },
        commercial: {
          attemptState: 'UNKNOWN',
          reason: 'GAME_RECONCILIATION_REQUIRED',
        },
      },
    });
  });

  it('reads back a still-provisioning create as UNKNOWN instead of a completed command', async () => {
    const getManagementOperation = vi.fn().mockResolvedValue({
      commandType: 'game.create.v1',
      state: 'PENDING',
      pending: {
        gameId: draftGameId,
        operationId,
        revision: 1,
        createdAt: committedAt,
        updatedAt: committedAt,
      },
    });
    const app = await appWith(repository(), managementRepository({ getManagementOperation }));
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/game-operations/${operationId}`,
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      commandId: operationId,
      operation: {
        type: 'CREATE_GAME',
        status: 'UNKNOWN',
        gameId: draftGameId,
        error: null,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION' },
      },
      replayed: true,
    });
    expect(getManagementOperation).toHaveBeenCalledWith({
      tenantId,
      actorUserId: userId,
      operationId,
    });
  });

  it('leaves the free-game create path unchanged when the managed contour is composed', async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ ...appliedCreate(), gameId, operationId: commandId });
    const owner = advisoryOwner();
    const app = await appWith(
      repository(),
      managementRepository({ create }),
      undefined,
      commercialCreateOptions(owner, create),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': `${managedKey}-free`,
      },
      payload: { ...paidPayload, paymentMode: 'NO_PAYMENT' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { type: 'CREATE_GAME', status: 'SUCCEEDED', gameId },
    });
    const write = create.mock.calls[0]![0] as CreateStoredGameInput;
    expect(write.gameId).toBeUndefined();
    expect(write.operationId).toBeUndefined();
    expect(write.paymentMode).toBe('NO_PAYMENT');
    expect(owner.quote).not.toHaveBeenCalled();
    expect(owner.reserve).not.toHaveBeenCalled();
  });

  it('keeps the old byte-identical refusal when the managed contour is not composed', async () => {
    const create = vi.fn();
    const app = await appWith(repository(), managementRepository({ create }));
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/games',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': `${managedKey}-off`,
      },
      payload: paidPayload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'GAME_PAYMENT_REQUIRED',
      message: 'В ранней beta можно создать только бесплатную игру.',
    });
    expect(create).not.toHaveBeenCalled();
  });
});
