import { loadConfig } from '@phub/config';
import type { GameRepository, StoredGameCardProjection } from '@phub/database';
import type { GameCardProjectionInput } from '@phub/games';
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
const playerId = '47b10c0e-2d9f-4775-96dc-2941adae4968';
const stationId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const secondGameId = '2f674339-c562-4b10-8ec8-5b58d1701ee8';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

type CardReadRepository = Pick<
  GameRepository,
  'getCardProjection' | 'listPublicCardProjections' | 'listViewerCardProjections'
>;

function snapshot(overrides: Partial<GameCardProjectionInput> = {}): GameCardProjectionInput {
  return {
    id: gameId,
    tenantId,
    revision: 3,
    organizerUserId: userId,
    title: 'Игра в Сколково',
    kind: 'FRIENDLY',
    visibility: 'PUBLIC',
    lifecycleState: 'SCHEDULED',
    startsAt: '2026-08-01T18:00:00.000Z',
    endsAt: '2026-08-01T19:30:00.000Z',
    timezone: 'Europe/Moscow',
    station: { id: stationId, name: 'Падел Сколково', shortAddress: 'Новая, 1' },
    levelRange: { from: 'C', to: 'B' },
    capacity: 4,
    participants: [
      {
        userId,
        displayName: 'Алексей',
        avatarUrl: null,
        level: 'C',
        role: 'ORGANIZER',
        paymentState: 'NOT_REQUIRED',
      },
      {
        userId: playerId,
        displayName: 'Мария',
        avatarUrl: null,
        level: 'C+',
        role: 'PLAYER',
        paymentState: 'PAID',
      },
    ],
    seatReservations: [],
    waitlist: [],
    waitlistEnabled: true,
    joinCutoffAt: '2026-08-01T17:30:00.000Z',
    priceSummary: { amountMinor: 250_000, currency: 'RUB' },
    ...overrides,
  };
}

function projection(value: GameCardProjectionInput): StoredGameCardProjection {
  return {
    gameId: value.id,
    aggregateRevision: value.revision,
    projectionRevision: value.revision,
    lifecycleState: value.lifecycleState as StoredGameCardProjection['lifecycleState'],
    visibility: value.visibility,
    startsAt: value.startsAt,
    endsAt: value.endsAt,
    basePayload: value,
    projectedAt: '2026-07-17T20:00:00.000Z',
  };
}

const firstProjection = projection(snapshot());
const secondProjection = projection(
  snapshot({
    id: secondGameId,
    title: 'Вторая игра',
    startsAt: '2026-08-02T18:00:00.000Z',
    endsAt: '2026-08-02T19:30:00.000Z',
    joinCutoffAt: '2026-08-02T17:30:00.000Z',
  }),
);

function repository(overrides: Partial<CardReadRepository> = {}): CardReadRepository {
  return {
    getCardProjection: vi.fn().mockResolvedValue(firstProjection),
    listPublicCardProjections: vi.fn().mockImplementation((input: { after?: { gameId: string } }) =>
      Promise.resolve({
        items: input.after ? [secondProjection] : [firstProjection, secondProjection],
      }),
    ),
    listViewerCardProjections: vi.fn().mockResolvedValue({ items: [firstProjection] }),
    ...overrides,
  };
}

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['games.play'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

async function appWith(repositoryValue: CardReadRepository) {
  const app = await buildApp({
    config,
    logger: createLogger('games-read-api-test', 'silent'),
    pool: fakePool(),
    gameReadRepository: repositoryValue,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Games read APIs', () => {
  it('returns an anonymous public card without PadlHub user identifiers', async () => {
    const app = await appWith(repository());
    const response = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/games?limit=1&availability=JOINABLE',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('public');
    const body = response.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(body.items[0]).toMatchObject({
      id: gameId,
      surface: 'DISCOVER',
      viewerRelation: 'ANONYMOUS',
      allowedActions: ['OPEN_DETAILS', 'JOIN'],
      participants: [{ displayName: 'Алексей' }, { displayName: 'Мария' }],
    });
    expect(JSON.stringify(body)).not.toContain(userId);
    expect(JSON.stringify(body)).not.toContain(playerId);
  });

  it('binds an opaque cursor to the original filters', async () => {
    const app = await appWith(repository());
    const first = await app.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/games?limit=1',
    });
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const changedFilters = await app.inject({
      method: 'GET',
      url: `/public/api/v1/local-padel/games?limit=1&kind=RATING&cursor=${cursor}`,
    });

    expect(changedFilters.statusCode).toBe(400);
    expect(changedFilters.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('returns viewer-aware cards from the authenticated user projection', async () => {
    const listViewerCardProjections = vi.fn().mockResolvedValue({ items: [firstProjection] });
    const app = await appWith(repository({ listViewerCardProjections }));
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/games?scope=UPCOMING',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json<{
      items: { allowedActions: string[] }[];
      nextCursor: string | null;
    }>();
    expect(body).toMatchObject({
      items: [
        {
          id: gameId,
          surface: 'MY_UPCOMING',
          viewerRelation: 'ORGANIZER',
          conversation: null,
        },
      ],
      nextCursor: null,
    });
    expect(body.items[0]?.allowedActions).toEqual(
      expect.arrayContaining(['INVITE', 'EDIT', 'CANCEL', 'OPEN_CHAT']),
    );
    expect(listViewerCardProjections).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, viewerUserId: userId, scope: 'UPCOMING' }),
    );
  });

  it('fails closed for unconfigured reads and never exposes a private outsider detail', async () => {
    const closed = await buildApp({
      config,
      logger: createLogger('games-read-api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(closed);
    const closedResponse = await closed.inject({
      method: 'GET',
      url: '/public/api/v1/local-padel/games',
    });
    expect(closedResponse.statusCode).toBe(503);

    const outsider = '2f986b33-ae51-42af-8f4c-3a35e930fc93';
    const token = await new SignJWT({
      tenants: [tenantId],
      roles: ['client'],
      permissions: ['games.play'],
      sid: '55555555-5555-4555-8555-555555555555',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setSubject(outsider)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
    const app = await appWith(repository());
    const detail = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/games/${gameId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(404);
  });
});
