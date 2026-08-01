import { loadConfig } from '@phub/config';
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
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const defaults = {
  favoriteStationIds: [],
  preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
  useHistory: true,
  recommendFriends: true,
  recommendationDisplay: 'CARDS',
  version: 0,
  updatedAt: null,
} as const;

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(permissions: readonly string[]): Promise<string> {
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('booking preferences and recommendations routes', () => {
  it('reads and idempotently updates owner booking preferences', async () => {
    const update = vi.fn().mockResolvedValue({
      outcome: 'applied',
      settings: { ...defaults, useHistory: false, version: 1, updatedAt: '2026-07-18T10:00:00Z' },
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('booking-routes-test', 'silent'),
      pool: fakePool(),
      bookingPreferencesRepository: {
        get: vi.fn().mockResolvedValue(defaults),
        getPlayerLevel: vi.fn().mockResolvedValue(null),
        getRecommendationProfile: vi
          .fn()
          .mockResolvedValue({ preferences: defaults, playerLevel: null }),
        update,
      },
    });
    apps.push(app);
    const token = await accessToken(['profile.read']);

    const read = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile/booking-preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(defaults);

    const write = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/profile/booking-preferences',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': 'booking-preferences-route-0001',
      },
      payload: {
        expectedVersion: 0,
        favoriteStationIds: [],
        preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
        useHistory: false,
        recommendFriends: false,
        recommendationDisplay: 'ROWS',
      },
    });
    expect(write.statusCode).toBe(200);
    expect(write.headers['x-idempotent-replayed']).toBe('false');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId,
        useHistory: false,
        recommendFriends: false,
        recommendationDisplay: 'ROWS',
      }),
    );
  });

  it('returns a versioned local recommendation page without scores or provider identifiers', async () => {
    const listFriends = vi.fn().mockResolvedValue({
      items: [
        {
          userId: '77777777-7777-4777-8777-777777777777',
          displayName: 'Друг игрока',
          avatarUrl: null,
          levelLabel: 'C+',
          addedAt: '2026-07-18T08:00:00.000Z',
          route: '/profile/77777777-7777-4777-8777-777777777777',
        },
      ],
    });
    const app = await buildApp({
      config,
      logger: createLogger('booking-routes-test', 'silent'),
      pool: fakePool(),
      bookingPreferencesRepository: {
        get: vi.fn().mockResolvedValue(defaults),
        getPlayerLevel: vi.fn().mockResolvedValue('C+'),
        getRecommendationProfile: vi
          .fn()
          .mockResolvedValue({ preferences: defaults, playerLevel: 'C+' }),
        update: vi.fn(),
      },
      profileFriendshipRepository: { list: listFriends } as never,
      gameReadRepository: {
        getCardProjection: vi.fn(),
        listPublicCardProjections: vi.fn(),
        listViewerCardProjections: vi.fn(),
        listRecommendationCardProjections: vi.fn().mockResolvedValue({
          candidates: [],
          history: [],
        }),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/recommendations/bookings?limit=6',
      headers: { authorization: `Bearer ${await accessToken(['games.play'])}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({ personalization: 'BASIC', items: [] });
    expect(JSON.stringify(response.json())).not.toMatch(/score|provider|externalId/i);
    expect(listFriends).toHaveBeenCalledWith(tenantId, userId, 500);

    const invalidCursor = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/recommendations/bookings?limit=12&cursor=not-a-valid-recommendation-cursor',
      headers: { authorization: `Bearer ${await accessToken(['games.play'])}` },
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({
      code: 'BOOKING_RECOMMENDATION_CURSOR_INVALID',
    });
  });

  it('loads tournaments from CUP and accepts only trainings from the Viva schedule', async () => {
    const trainingId = '50000000-0000-4000-8000-000000000001';
    const vivaTournamentId = '50000000-0000-4000-8000-000000000002';
    const cupTournamentId = '70000000-0000-4000-8000-000000000001';
    const vivaReadDate = vi.fn().mockResolvedValue([
      {
        id: trainingId,
        kind: 'TRAINING',
        title: 'Групповая тренировка',
        startsAt: '2099-07-29T15:00:00.000Z',
        endsAt: '2099-07-29T16:00:00.000Z',
        timezone: 'Europe/Moscow',
        station: {
          id: '60000000-0000-4000-8000-000000000001',
          name: 'Терехово',
          shortAddress: null,
        },
        levelRange: null,
        capacity: { total: 4, open: 3 },
        host: null,
        route: `/trainings?event=${trainingId}`,
      },
      {
        id: vivaTournamentId,
        kind: 'TOURNAMENT',
        title: 'Турнир из Viva',
        startsAt: '2099-07-29T17:00:00.000Z',
        endsAt: '2099-07-29T19:00:00.000Z',
        timezone: 'Europe/Moscow',
        station: {
          id: '60000000-0000-4000-8000-000000000001',
          name: 'Терехово',
          shortAddress: null,
        },
        levelRange: null,
        capacity: { total: 16, open: 4 },
        host: null,
        route: `/tournaments?event=${vivaTournamentId}`,
      },
    ]);
    const cupReadDate = vi.fn().mockResolvedValue([
      {
        id: cupTournamentId,
        title: 'Турнир из ЦУП',
        format: 'Американо',
        startsAt: '2099-07-29T17:00:00.000Z',
        endsAt: '2099-07-29T19:00:00.000Z',
        venue: 'Терехово',
        trainerName: 'Илья Соколов',
        levelRange: null,
        organizer: {
          displayName: 'Илья Соколов',
          avatarUrl: null,
        },
        capacity: {
          total: 16,
          registered: 12,
          open: 4,
          waitlist: 0,
        },
        status: 'REGISTRATION',
        route: `/tournaments?event=${cupTournamentId}`,
      },
    ]);
    const app = await buildApp({
      config,
      logger: createLogger('booking-routes-test', 'silent'),
      pool: fakePool(),
      authService: {
        issueVivaAccessToken: vi.fn().mockResolvedValue({ accessToken: 'delegated-user-token' }),
      } as never,
      bookingPreferencesRepository: {
        get: vi.fn().mockResolvedValue(defaults),
        getPlayerLevel: vi.fn().mockResolvedValue(null),
        getRecommendationProfile: vi
          .fn()
          .mockResolvedValue({ preferences: defaults, playerLevel: null }),
        update: vi.fn(),
      },
      gameReadRepository: {
        getCardProjection: vi.fn(),
        listPublicCardProjections: vi.fn(),
        listViewerCardProjections: vi.fn(),
        listRecommendationCardProjections: vi.fn().mockResolvedValue({
          candidates: [],
          history: [],
        }),
      },
      exerciseRecommendationSource: { readDate: vivaReadDate },
      tournamentSummarySource: { readDate: cupReadDate },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/recommendations/bookings?limit=6',
      headers: { authorization: `Bearer ${await accessToken(['games.play'])}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          kind: 'TRAINING',
          activity: { id: trainingId, title: 'Групповая тренировка' },
        },
        {
          kind: 'TOURNAMENT',
          activity: { id: cupTournamentId, title: 'Турнир из ЦУП' },
        },
      ],
    });
    expect(response.body).not.toContain(vivaTournamentId);
    expect(response.body).not.toContain('Турнир из Viva');
    expect(vivaReadDate).toHaveBeenCalledTimes(7);
    expect(cupReadDate).toHaveBeenCalledTimes(7);
  });

  it('returns PadlHub host media URLs and proxies the provider image', async () => {
    const activityId = '50000000-0000-4000-8000-000000000001';
    const sourceUrl = 'https://media.example/private-trainer-photo';
    const readDate = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: activityId,
          kind: 'TRAINING',
          title: 'Групповая тренировка',
          startsAt: '2099-07-29T15:00:00.000Z',
          endsAt: '2099-07-29T16:00:00.000Z',
          timezone: 'Europe/Moscow',
          station: {
            id: '60000000-0000-4000-8000-000000000001',
            name: 'Терехово',
            shortAddress: null,
          },
          levelRange: null,
          capacity: { total: 4, open: 3 },
          host: {
            displayName: 'Мария Орлова',
            avatarUrl: null,
            role: 'TRAINER',
          },
          route: `/trainings?event=${activityId}`,
        },
      ])
      .mockResolvedValue([]);
    const readAvatarSource = vi.fn().mockReturnValue(sourceUrl);
    const avatarMedia = {
      read: vi.fn().mockResolvedValue({
        body: Buffer.from('webp-host'),
        etag: '"host-etag"',
      }),
    };
    const app = await buildApp({
      config,
      logger: createLogger('booking-routes-test', 'silent'),
      pool: fakePool(),
      authService: {
        issueVivaAccessToken: vi.fn().mockResolvedValue({ accessToken: 'delegated-user-token' }),
      } as never,
      bookingPreferencesRepository: {
        get: vi.fn().mockResolvedValue(defaults),
        getPlayerLevel: vi.fn().mockResolvedValue(null),
        getRecommendationProfile: vi
          .fn()
          .mockResolvedValue({ preferences: defaults, playerLevel: null }),
        update: vi.fn(),
      },
      gameReadRepository: {
        getCardProjection: vi.fn(),
        listPublicCardProjections: vi.fn(),
        listViewerCardProjections: vi.fn(),
        listRecommendationCardProjections: vi.fn().mockResolvedValue({
          candidates: [],
          history: [],
        }),
      },
      exerciseRecommendationSource: { readDate, readAvatarSource },
      eventAvatarMedia: avatarMedia,
    });
    apps.push(app);

    const recommendations = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/recommendations/bookings?limit=6',
      headers: { authorization: `Bearer ${await accessToken(['games.play'])}` },
    });

    expect(recommendations.statusCode).toBe(200);
    expect(recommendations.json()).toMatchObject({
      items: [
        {
          kind: 'TRAINING',
          activity: {
            id: activityId,
            host: {
              displayName: 'Мария Орлова',
              avatarUrl: `/public/api/v1/local-padel/booking-activities/${activityId}/host-avatar`,
            },
          },
        },
      ],
    });
    expect(recommendations.body).not.toMatch(/media\.example|private-trainer-photo/);

    const avatar = await app.inject({
      method: 'GET',
      url: `/public/api/v1/local-padel/booking-activities/${activityId}/host-avatar`,
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers['content-type']).toBe('image/webp');
    expect(avatar.headers.etag).toBe('"host-etag"');
    expect(avatar.body).toBe('webp-host');
    expect(avatarMedia.read).toHaveBeenCalledWith({
      cacheKey: `booking-activity:${activityId}`,
      sourceUrl,
      tenantId,
    });
  });
});
