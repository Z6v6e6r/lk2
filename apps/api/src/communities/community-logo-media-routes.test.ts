import { Readable } from 'node:stream';

import { loadConfig } from '@phub/config';
import type { CommunityLogoMediaRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type { ProfilePhotoMediaStore } from '../profile/profile-photo-media-store.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const communityId = '22222222-2222-4222-8222-222222222222';
const objectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
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

describe('community logo media route', () => {
  it('streams the current private WebP object through a stable first-party URL', async () => {
    const body = Buffer.from('RIFF-community-webp');
    const getObjectKey = vi
      .fn<CommunityLogoMediaRepository['getObjectKey']>()
      .mockResolvedValue(objectKey);
    const read = vi.fn<ProfilePhotoMediaStore['read']>().mockResolvedValue({
      body: Readable.from(body),
      contentLength: body.byteLength,
      etag: '"community-v1"',
    });
    const repository: CommunityLogoMediaRepository = {
      getObjectKey,
    };
    const store: ProfilePhotoMediaStore = {
      read,
    };
    const app = await buildApp({
      config,
      logger: createLogger('community-logo-media-route-test', 'silent'),
      communityLogoMediaRepository: repository,
      profilePhotoMediaStore: store,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/public/api/v1/media/community-logos/${tenantId}/${communityId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/webp');
    expect(response.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=600',
    );
    expect(response.rawPayload).toEqual(body);
    expect(getObjectKey).toHaveBeenCalledWith(tenantId, communityId);
    expect(read).toHaveBeenCalledWith(objectKey);
  });

  it('returns not found when no local object is mapped', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('community-logo-media-route-test', 'silent'),
      communityLogoMediaRepository: { getObjectKey: vi.fn().mockResolvedValue(undefined) },
      profilePhotoMediaStore: { read: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/public/api/v1/media/community-logos/${tenantId}/${communityId}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_LOGO_NOT_FOUND' });
  });
});
