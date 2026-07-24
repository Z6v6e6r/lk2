import { Readable } from 'node:stream';

import { loadConfig } from '@phub/config';
import type { ProfileSummaryRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type { ProfilePhotoMediaStore } from './profile-photo-media-store.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const deliveryId = '33333333-3333-4333-8333-333333333333';
const objectKey = `profile-photos/${tenantId}/${userId}/${'a'.repeat(64)}.webp`;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('profile photo media route', () => {
  it('streams the current private WebP object through the stable PadlHub URL', async () => {
    const body = Buffer.from('RIFF-profile-webp');
    const repository = {
      getPhotoObjectKey: vi
        .fn<ProfileSummaryRepository['getPhotoObjectKey']>()
        .mockResolvedValue(objectKey),
      getPhotoDeliveryIds: vi.fn<ProfileSummaryRepository['getPhotoDeliveryIds']>(),
    };
    const read = vi.fn<ProfilePhotoMediaStore['read']>().mockResolvedValue({
      body: Readable.from(body),
      contentLength: body.byteLength,
      etag: '"avatar-v1"',
    });
    const store: ProfilePhotoMediaStore = {
      read,
    };
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-test', 'silent'),
      profilePhotoMediaRepository: repository,
      profilePhotoMediaStore: store,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/webp');
    expect(response.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=600',
    );
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.rawPayload).toEqual(body);
    expect(repository.getPhotoObjectKey).toHaveBeenCalledWith(tenantId, deliveryId);
    expect(read).toHaveBeenCalledWith(objectKey);
  });

  it('returns a stable not-found response when the profile has no local object', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-test', 'silent'),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi
          .fn<ProfileSummaryRepository['getPhotoObjectKey']>()
          .mockResolvedValue(undefined),
        getPhotoDeliveryIds: vi.fn<ProfileSummaryRepository['getPhotoDeliveryIds']>(),
      },
      profilePhotoMediaStore: { read: vi.fn<ProfilePhotoMediaStore['read']>() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_NOT_FOUND' });
  });
});
