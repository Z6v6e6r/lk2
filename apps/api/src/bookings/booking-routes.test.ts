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
  preferredTimeWindows: [],
  useHistory: true,
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
        preferredTimeWindows: [],
        useHistory: false,
      },
    });
    expect(write.statusCode).toBe(200);
    expect(write.headers['x-idempotent-replayed']).toBe('false');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, userId, useHistory: false }),
    );
  });

  it('returns a versioned local recommendation page without scores or provider identifiers', async () => {
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
  });
});
