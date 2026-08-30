import type { ActivityHistoryRepository, ActivityHistorySyncState } from '@phub/database';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type { ActivityHistoryProjectionService } from './activity-history-routes.js';
import { MemoryBookingScreenReadJobStore } from './booking-screen-read-job-store.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const participantUserId = 'ac3bf6de-f860-4063-b8a1-ff085faf7ace';
const deliveryId = 'e56e59bc-5dc0-4dd4-b121-9e5e00fc52ea';
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  ACTIVITY_HISTORY_ENABLED: 'true',
});

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      if (text.includes('select 1 as ready')) return Promise.resolve({ rows: [{ ready: 1 }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function token() {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['profile.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function state(overrides: Partial<ActivityHistorySyncState> = {}): ActivityHistorySyncState {
  return {
    userId,
    coverageStatus: 'COMPLETE',
    freshness: 'FRESH',
    lastSuccessAt: '2026-07-21T10:00:00.000Z',
    staleAt: '2026-07-21T11:00:00.000Z',
    oldestSyncedAt: '2025-01-01T00:00:00.000Z',
    nextProviderCursor: null,
    sourceRevision: 'v1',
    lastErrorCode: null,
    updatedAt: '2026-07-21T10:00:00.000Z',
    ...overrides,
  };
}

function repository(syncState: ActivityHistorySyncState): ActivityHistoryRepository {
  return {
    resolveVivaExerciseGameAssociations: () => Promise.resolve([]),
    resolveSourceMapping: () =>
      Promise.resolve({
        mappingId: '22222222-2222-4222-8222-222222222222',
        internalId: '11111111-1111-4111-8111-111111111111',
      }),
    getSyncState: () => Promise.resolve(syncState),
    list: () =>
      Promise.resolve({
        items: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            userId,
            kind: 'TRAINING',
            status: 'COMPLETED',
            occurredAt: '2026-07-20T09:00:00.000Z',
            startsAt: '2026-07-20T09:00:00.000Z',
            endsAt: '2026-07-20T10:00:00.000Z',
            title: 'Групповая тренировка',
            venueName: 'Терехово',
            route: '/bookings/11111111-1111-4111-8111-111111111111',
            gameId: null,
            tournamentId: null,
            details: { trainerName: 'Иван Тренер' },
            sourceRevision: 'v1',
            syncedAt: '2026-07-21T10:00:00.000Z',
          },
        ],
      }),
    persistPage: () => Promise.resolve(syncState),
    recordSyncFailure: () => Promise.resolve(syncState),
  };
}

describe('activity history routes', () => {
  it('requires authentication before reporting history infrastructure availability', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/activity-history-read-jobs',
      payload: {},
    });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refreshes a stale projection through a browser-relayed history page', async () => {
    const stale = state({ freshness: 'STALE', coverageStatus: 'PARTIAL', nextProviderCursor: '1' });
    const project = vi.fn<ActivityHistoryProjectionService['project']>().mockResolvedValue();
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: repository(stale),
      activityHistoryProjector: { project },
      bookingScreenReadJobStore: new MemoryBookingScreenReadJobStore(),
    });
    const authorization = `Bearer ${await token()}`;
    const started = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/activity-history-read-jobs',
      headers: { authorization },
      payload: {},
    });
    const job = started.json<{
      jobId: string;
      commands: readonly { commandId: string; operation: string; page: number; size: number }[];
    }>();
    expect(started.statusCode).toBe(200);
    expect(job.commands).toEqual([
      expect.objectContaining({ operation: 'bookings.history.read', page: 0, size: 50 }),
    ]);
    const command = job.commands[0];
    if (!command) throw new Error('Expected history command');
    const submitted = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/activity-history-read-jobs/${job.jobId}/results/${command.commandId}`,
      headers: { authorization },
      payload: {
        payload: {
          content: [
            {
              id: 'private-booking-ref',
              isCancelled: false,
              exercise: {
                id: 'private-exercise-ref',
                direction: { id: 4588, name: 'Открытая игра' },
                type: { id: 1613, name: 'Открытая игра' },
                timeFrom: '2026-07-20T09:00:00.000Z',
                timeTo: '2026-07-20T10:00:00.000Z',
                studio: { name: 'Терехово' },
              },
            },
          ],
          totalPages: 1,
          totalElements: 1,
          last: true,
          numberOfElements: 1,
          size: 50,
          number: 0,
          empty: false,
        },
      },
    });
    expect(submitted.statusCode).toBe(202);
    const completed = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/activity-history-read-jobs/${job.jobId}/complete`,
      headers: { authorization },
      payload: {},
    });
    await app.close();

    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      screen: 'ACTIVITY_HISTORY',
      state: 'READY',
      completedCommands: 1,
      totalCommands: 1,
    });
    expect(project).toHaveBeenCalledTimes(1);
    const projectionInput = project.mock.calls[0]?.[0];
    expect(projectionInput).toMatchObject({
      tenantId,
      userId,
      reason: 'STALE',
      page: { page: 0 },
    });
    expect(projectionInput?.page.records).toHaveLength(1);
  });

  it('returns one provider-neutral local projection page', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: repository(state()),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/history?kind=TRAINING&status=COMPLETED&limit=20',
      headers: { authorization: `Bearer ${await token()}` },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      freshness: 'FRESH',
      coverage: 'COMPLETE',
      items: [
        {
          kind: 'TRAINING',
          status: 'COMPLETED',
          trainerName: 'Иван Тренер',
        },
      ],
    });
    expect(response.body).not.toMatch(/viva|provider|external/i);
  });

  it('replaces expired participant photos in persisted game history', async () => {
    const getPhotoDeliveryIds = vi.fn(() =>
      Promise.resolve(new Map([[participantUserId, deliveryId]])),
    );
    const base = repository(state());
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: {
        ...base,
        list: () =>
          Promise.resolve({
            items: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                userId,
                kind: 'GAME' as const,
                status: 'COMPLETED' as const,
                occurredAt: '2026-07-20T09:00:00.000Z',
                startsAt: '2026-07-20T09:00:00.000Z',
                endsAt: '2026-07-20T10:00:00.000Z',
                title: 'Игра',
                venueName: 'Терехово',
                route: '/games/11111111-1111-4111-8111-111111111111',
                gameId: '11111111-1111-4111-8111-111111111111',
                tournamentId: null,
                details: {
                  game: {
                    participants: [
                      {
                        userId: participantUserId,
                        displayName: 'Dmitriy Krikunov',
                        avatarUrl: 'http://127.0.0.1:9000/expired.webp?X-Amz-Date=old',
                      },
                    ],
                  },
                },
                sourceRevision: 'game:1',
                syncedAt: '2026-07-21T10:00:00.000Z',
              },
            ],
          }),
      },
      profilePhotoMediaRepository: {
        getPhotoObjectKey: () => Promise.resolve(undefined),
        getPhotoDeliveryIds,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/history?kind=GAME',
      headers: { authorization: `Bearer ${await token()}` },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`,
    );
    expect(response.body).not.toContain('X-Amz-');
    expect(getPhotoDeliveryIds).toHaveBeenCalledWith(tenantId, [participantUserId]);
  });

  it('refreshes an uncovered range once before returning persisted history', async () => {
    let current = state({
      coverageStatus: 'UNSYNCED',
      freshness: 'UNSYNCED',
      lastSuccessAt: null,
      staleAt: null,
      oldestSyncedAt: null,
      sourceRevision: null,
      updatedAt: null,
    });
    const base = repository(current);
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: {
        ...base,
        getSyncState: () => Promise.resolve(current),
      },
      activityHistoryRefresher: {
        refresh: () => {
          current = state();
          return Promise.resolve();
        },
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/history',
      headers: { authorization: `Bearer ${await token()}` },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ coverage: 'COMPLETE' });
  });

  it('does not turn an unsynchronized provider failure into an empty history', async () => {
    const unsynced = state({
      coverageStatus: 'UNSYNCED',
      freshness: 'UNSYNCED',
      lastSuccessAt: null,
      staleAt: null,
      oldestSyncedAt: null,
      sourceRevision: null,
      updatedAt: null,
    });
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: repository(unsynced),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/history',
      headers: { authorization: `Bearer ${await token()}` },
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'BOOKING_HISTORY_UNAVAILABLE' });
  });

  it('serves persisted local game history as partial when provider coverage is unsynchronized', async () => {
    const unsynced = state({
      coverageStatus: 'UNSYNCED',
      freshness: 'UNSYNCED',
      lastSuccessAt: null,
      staleAt: null,
      oldestSyncedAt: null,
      sourceRevision: null,
      updatedAt: null,
    });
    const base = repository(unsynced);
    const list = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            userId,
            kind: 'GAME' as const,
            status: 'COMPLETED' as const,
            occurredAt: '2026-07-20T10:00:00.000Z',
            startsAt: '2026-07-20T09:00:00.000Z',
            endsAt: '2026-07-20T10:00:00.000Z',
            title: 'Локальная игра',
            venueName: 'ПадлХАБ',
            route: '/games/11111111-1111-4111-8111-111111111111',
            gameId: '11111111-1111-4111-8111-111111111111',
            tournamentId: null,
            details: {
              resultId: '22222222-2222-4222-8222-222222222222',
              resultRevision: 1,
              sets: [{ setNumber: 1, teamAUserIds: [], teamBUserIds: [], teamA: 6, teamB: 4 }],
            },
            sourceRevision: 'game-result:v1',
            syncedAt: '2026-07-21T10:00:00.000Z',
          },
        ],
      }),
    );
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: {
        ...base,
        list,
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/history?status=COMPLETED&limit=20',
      headers: { authorization: `Bearer ${await token()}` },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({
      tenantId,
      userId,
      kind: 'GAME',
      status: 'COMPLETED',
      limit: 20,
    });
    expect(response.json()).toMatchObject({
      coverage: 'PARTIAL',
      freshness: 'STALE',
      generatedAt: '2026-07-21T10:00:00.000Z',
      items: [{ kind: 'GAME', title: 'Локальная игра', result: '6:4' }],
    });
  });

  it('keeps a continuation cursor when the requested filter is empty but coverage is partial', async () => {
    const partial = state({
      coverageStatus: 'PARTIAL',
      nextProviderCursor: '3',
    });
    const base = repository(partial);
    const app = await buildApp({
      config,
      logger: createLogger('activity-history-test', 'silent'),
      pool: fakePool(),
      activityHistoryRepository: {
        ...base,
        list: () => Promise.resolve({ items: [] }),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/history?kind=TRAINING',
      headers: { authorization: `Bearer ${await token()}` },
    });
    await app.close();
    const payload = response.json<{
      items: unknown[];
      coverage: string;
      nextCursor?: string;
    }>();

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({ items: [], coverage: 'PARTIAL' });
    expect(payload.nextCursor).toEqual(expect.any(String));
  });
});
