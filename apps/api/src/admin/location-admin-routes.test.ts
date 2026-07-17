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
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const locationId = '11111111-1111-4111-8111-111111111111';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const hours = (['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const).map((weekday) => ({
  weekday,
  closed: false,
  intervals: [{ opensAt: '07:00', closesAt: '23:00' }],
}));
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
  workingHours: hours,
  amenities: [],
  gallery: [
    {
      url: 'https://cdn.padlhub.test/nagatinskaya.webp',
      alt: '',
      isCover: true,
      sortOrder: 0,
    },
  ],
  publicationStatus: 'DRAFT',
  showOnHome: true,
  sortOrder: 10,
};
const location: LocationAdminView = {
  id: locationId,
  ...profile,
  version: 1,
  completeness: locationCompleteness(profile),
  createdAt: '2026-07-17T12:00:00.000Z',
  updatedAt: '2026-07-17T12:00:00.000Z',
  publishedAt: null,
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

async function token(permissions = ['locations.read', 'locations.manage']): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_ADMIN_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function repository() {
  const create = vi.fn().mockResolvedValue({ outcome: 'applied', location, replayed: false });
  return {
    value: {
      listAdmin: vi.fn().mockResolvedValue([location]),
      getAdmin: vi.fn().mockResolvedValue(location),
      listPublished: vi.fn().mockResolvedValue([]),
      getPublished: vi.fn().mockResolvedValue(undefined),
      create,
      update: vi.fn().mockResolvedValue({ outcome: 'applied', location, replayed: false }),
    } satisfies LocationRepository,
    create,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin location routes', () => {
  it('creates an audited idempotent draft through the CUP audience', async () => {
    const locationRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('location-admin-test', 'silent'),
      pool: fakePool(),
      locationRepository: locationRepository.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/locations',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'location-create-test-0001',
      },
      payload: profile,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: locationId, replayed: false });
    expect(locationRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        idempotencyKey: 'location-create-test-0001',
      }),
    );
  });

  it('keeps read and manage permissions separate', async () => {
    const locationRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('location-admin-test', 'silent'),
      pool: fakePool(),
      locationRepository: locationRepository.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/locations',
      headers: {
        authorization: `Bearer ${await token(['locations.read'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'location-create-denied-0001',
      },
      payload: profile,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'LOCATION_ADMIN_PERMISSION_REQUIRED' });
    expect(locationRepository.create).not.toHaveBeenCalled();
  });

  it('requires a separate permission before publishing', async () => {
    const locationRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('location-admin-test', 'silent'),
      pool: fakePool(),
      locationRepository: locationRepository.value,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/locations',
      headers: {
        authorization: `Bearer ${await token(['locations.read', 'locations.manage'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'location-publish-denied-0001',
      },
      payload: { ...profile, publicationStatus: 'PUBLISHED' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'LOCATION_ADMIN_PERMISSION_REQUIRED' });
    expect(locationRepository.create).not.toHaveBeenCalled();
  });
});
