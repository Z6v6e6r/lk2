import { loadConfig } from '@phub/config';
import type { LocationRepository } from '@phub/database';
import {
  locationCompleteness,
  type LocationAdminView,
  type LocationProfileInput,
} from '@phub/locations';
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
const locationId = '11111111-1111-4111-8111-111111111111';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const profile: LocationProfileInput = {
  slug: 'nagatinskaya',
  title: 'Хаб Нагатинская',
  shortTitle: 'Нагатинская',
  city: 'Москва',
  courtCount: 6,
  address: '1-й Нагатинский проезд, 2',
  latitude: 55.6801,
  longitude: 37.6319,
  timezone: 'Europe/Moscow',
  metroName: 'Нагатинская',
  metroDistanceMeters: 400,
  phoneE164: '+79990000000',
  workingHours: (['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const).map((weekday) => ({
    weekday,
    closed: false,
    intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
  })),
  amenities: [],
  gallery: [
    {
      url: 'https://cdn.padlhub.test/nagatinskaya.webp',
      alt: '',
      isCover: true,
      sortOrder: 0,
    },
  ],
  publicationStatus: 'PUBLISHED',
  showOnHome: true,
  sortOrder: 10,
};
const location: LocationAdminView = {
  id: locationId,
  ...profile,
  version: 2,
  completeness: locationCompleteness(profile),
  createdAt: '2026-07-17T12:00:00.000Z',
  updatedAt: '2026-07-17T12:00:00.000Z',
  publishedAt: '2026-07-17T12:00:00.000Z',
  archivedAt: null,
};

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(): Promise<string> {
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('user location routes', () => {
  it('returns only PadlHub identifiers and a computed detail view', async () => {
    const repository: LocationRepository = {
      listAdmin: vi.fn().mockResolvedValue([]),
      getAdmin: vi.fn().mockResolvedValue(undefined),
      listPublished: vi.fn().mockResolvedValue([location]),
      getPublished: vi.fn().mockResolvedValue(location),
      create: vi.fn(),
      update: vi.fn(),
    };
    const app = await buildApp({
      config,
      logger: createLogger('location-user-test', 'silent'),
      pool: fakePool(),
      locationRepository: repository,
    });
    apps.push(app);
    const headers = { authorization: `Bearer ${await token()}` };
    const list = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/locations',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: [{ id: locationId, title: 'Нагатинская' }] });

    const detail = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/locations/${locationId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: locationId, title: 'Хаб Нагатинская' });
    expect(detail.body).not.toContain('stationId');
  });
});
