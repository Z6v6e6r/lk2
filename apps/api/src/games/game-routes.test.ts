import { loadConfig } from '@phub/config';
import type {
  CreateStoredGameInput,
  GameRepository,
  GameRosterRepository,
  GameRosterUserCommandInput,
} from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

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

async function accessToken(permissions: readonly string[] = ['games.play']): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
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
) {
  const app = await buildApp({
    config,
    logger: createLogger('games-api-test', 'silent'),
    pool: fakePool(),
    gameRosterRepository: repositoryValue,
    ...(managementRepositoryValue ? { gameCommandRepository: managementRepositoryValue } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Games management User API', () => {
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

  it('maps post-lookup temporal rejection while preserving idempotency conflict precedence', async () => {
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

  it('returns a processable 202 for a durable paid-seat reservation without inventing a URL', async () => {
    const reservationId = '238df6f5-fec4-44dd-ad8c-39e98ade8366';
    const app = await appWith(
      repository({
        join: vi.fn().mockResolvedValue(
          applied({
            viewerRelation: 'SEAT_RESERVED',
            omitParticipation: true,
            reservationId,
            expiresAt: '2026-08-01T10:15:00.000Z',
          }),
        ),
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'games-api-paid-command-0001',
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      operation: { status: 'PROCESSING', nextAction: { type: 'NONE' } },
    });
    expect(JSON.stringify(response.json())).not.toContain('http');
  });

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
