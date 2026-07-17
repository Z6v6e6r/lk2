import { loadConfig } from '@phub/config';
import type { GameRosterRepository, GameRosterUserCommandInput } from '@phub/database';
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
const committedAt = '2026-08-01T10:00:00.000Z';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

type UserRosterRepository = Pick<
  GameRosterRepository,
  'join' | 'joinWaitlist' | 'leave' | 'leaveWaitlist' | 'getOperation'
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

async function appWith(repositoryValue: UserRosterRepository) {
  const app = await buildApp({
    config,
    logger: createLogger('games-api-test', 'silent'),
    pool: fakePool(),
    gameRosterRepository: repositoryValue,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
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
      payload: { expectedRevision: 1 },
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

    const injectedIdentity = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/games/${gameId}/join`,
      headers: { authorization, 'idempotency-key': 'games-api-join-command-0002' },
      payload: { playerId: '47b10c0e-2d9f-4775-96dc-2941adae4968' },
    });
    expect(injectedIdentity.statusCode).toBe(400);
    expect(injectedIdentity.json()).toMatchObject({ code: 'INVALID_REQUEST' });
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
