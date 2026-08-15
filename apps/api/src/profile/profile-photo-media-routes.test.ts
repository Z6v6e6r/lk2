import { Readable } from 'node:stream';

import { loadConfig } from '@phub/config';
import {
  ProfilePhotoGrantStaleError,
  ProfilePhotoIdempotencyConflictError,
  type ProfileSummaryRepository,
} from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import sharp from 'sharp';
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
  PROFILE_PHOTO_CLIENT_SYNC_ENABLED: 'true',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'phub-media',
  S3_ACCESS_KEY: 'test-access-key',
  S3_SECRET_KEY: 'test-secret-key',
});

function fakePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }),
  } as unknown as Pool;
}

async function token(): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['profile.read'],
    sid: '44444444-4444-4444-8444-444444444444',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

async function profilePhotoGrant(
  sessionId = '44444444-4444-4444-8444-444444444444',
): Promise<string> {
  return new SignJWT({
    tenantId,
    sid: sessionId,
    scope: 'profile.photo.sync',
    issuedAtMs: Date.now(),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'phub-profile-photo-grant+jwt' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(`${config.JWT_AUDIENCE}:profile-photo-sync`)
    .setSubject(userId)
    .setJti('55555555-5555-4555-8555-555555555555')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('profile photo media route', () => {
  it('normalizes an authenticated client-assisted upload to WebP and returns its stable URL', async () => {
    const avatarUrl = `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`;
    const reserveClientAssistedPhoto = vi
      .fn<NonNullable<ProfileSummaryRepository['reserveClientAssistedPhoto']>>()
      .mockResolvedValue({ replayed: false });
    const finalizeClientAssistedPhoto = vi
      .fn<NonNullable<ProfileSummaryRepository['finalizeClientAssistedPhoto']>>()
      .mockResolvedValue({ avatarUrl, replayed: false });
    const stored: Buffer[] = [];
    const put = vi.fn((input: Parameters<NonNullable<ProfilePhotoMediaStore['put']>>[0]) => {
      stored.push(input.body);
      return Promise.resolve();
    });
    const store: ProfilePhotoMediaStore = {
      read: vi.fn(),
      put,
    };
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto,
        finalizeClientAssistedPhoto,
      },
      profilePhotoMediaStore: store,
    });
    apps.push(app);
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#7654d7' },
    })
      .png()
      .toBuffer();

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/png',
        'idempotency-key': 'profile-photo-client-sync-0001',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
      payload: png,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ avatarUrl, replayed: false });
    expect(stored).toHaveLength(1);
    await expect(sharp(stored[0]).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: config.PROFILE_PHOTO_MAX_DIMENSION,
      height: 683,
    });
    const saved = finalizeClientAssistedPhoto.mock.calls[0]?.[0];
    expect(saved?.tenantId).toBe(tenantId);
    expect(saved?.userId).toBe(userId);
    expect(saved?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(saved?.grantId).toBe('55555555-5555-4555-8555-555555555555');
  });

  it('returns an exact reservation replay without writing object storage again', async () => {
    const avatarUrl = `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`;
    const put = vi.fn();
    const finalizeClientAssistedPhoto = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-replay-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto: vi.fn().mockResolvedValue({ avatarUrl, replayed: true }),
        finalizeClientAssistedPhoto,
      },
      profilePhotoMediaStore: { read: vi.fn(), put },
    });
    apps.push(app);
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#7654d7' },
    })
      .png()
      .toBuffer();

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/png',
        'idempotency-key': 'profile-photo-client-sync-replay',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
      payload: png,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ avatarUrl, replayed: true });
    expect(put).not.toHaveBeenCalled();
    expect(finalizeClientAssistedPhoto).not.toHaveBeenCalled();
  });

  it('rejects a reservation conflict before writing object storage', async () => {
    const put = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-conflict-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto: vi
          .fn()
          .mockRejectedValue(new ProfilePhotoIdempotencyConflictError()),
        finalizeClientAssistedPhoto: vi.fn(),
      },
      profilePhotoMediaStore: { read: vi.fn(), put },
    });
    apps.push(app);
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#7654d7' },
    })
      .png()
      .toBuffer();

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/png',
        'idempotency-key': 'profile-photo-client-sync-conflict',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
      payload: png,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_IDEMPOTENCY_CONFLICT' });
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a stale reservation before writing object storage', async () => {
    const put = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-stale-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto: vi.fn().mockRejectedValue(new ProfilePhotoGrantStaleError()),
        finalizeClientAssistedPhoto: vi.fn(),
      },
      profilePhotoMediaStore: { read: vi.fn(), put },
    });
    apps.push(app);
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#7654d7' },
    })
      .png()
      .toBuffer();

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/png',
        'idempotency-key': 'profile-photo-client-sync-stale',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
      payload: png,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_GRANT_STALE' });
    expect(put).not.toHaveBeenCalled();
  });

  it('accepts an image body above the global 1 MiB default before bounded image validation', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-limit-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto: vi.fn(),
        finalizeClientAssistedPhoto: vi.fn(),
      },
      profilePhotoMediaStore: { read: vi.fn(), put: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/jpeg',
        'idempotency-key': 'profile-photo-client-sync-large-invalid',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
      payload: Buffer.alloc(1_200_000, 0x5a),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_INVALID' });
  });

  it('rejects an upload without the short-lived profile-photo grant', async () => {
    const put = vi.fn();
    const reserveClientAssistedPhoto = vi.fn();
    const finalizeClientAssistedPhoto = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-grant-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto,
        finalizeClientAssistedPhoto,
      },
      profilePhotoMediaStore: { read: vi.fn(), put },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/png',
        'idempotency-key': 'profile-photo-client-sync-no-grant',
      },
      payload: Buffer.from('not-used'),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_GRANT_REQUIRED' });
    expect(put).not.toHaveBeenCalled();
    expect(reserveClientAssistedPhoto).not.toHaveBeenCalled();
    expect(finalizeClientAssistedPhoto).not.toHaveBeenCalled();
  });

  it('keeps client-assisted writes disabled throughout the mixed-version rollout', async () => {
    const put = vi.fn();
    const reserveClientAssistedPhoto = vi.fn();
    const finalizeClientAssistedPhoto = vi.fn();
    const app = await buildApp({
      config: { ...config, PROFILE_PHOTO_CLIENT_SYNC_ENABLED: false },
      logger: createLogger('profile-photo-media-route-disabled-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        reserveClientAssistedPhoto,
        finalizeClientAssistedPhoto,
      },
      profilePhotoMediaStore: { read: vi.fn(), put },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'image/png',
        'idempotency-key': 'profile-photo-client-sync-disabled',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
      payload: Buffer.from('not-used'),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_SYNC_DISABLED' });
    expect(put).not.toHaveBeenCalled();
    expect(reserveClientAssistedPhoto).not.toHaveBeenCalled();
    expect(finalizeClientAssistedPhoto).not.toHaveBeenCalled();
  });

  it('removes an authoritative Viva-null photo with the same bound grant and idempotency key', async () => {
    let active = true;
    const removeClientAssistedPhoto = vi
      .fn<NonNullable<ProfileSummaryRepository['removeClientAssistedPhoto']>>()
      .mockImplementation(() => {
        active = false;
        return Promise.resolve({ removed: true, replayed: false });
      });
    const read = vi.fn<ProfilePhotoMediaStore['read']>();
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-delete-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi
          .fn()
          .mockImplementation(() => Promise.resolve(active ? objectKey : undefined)),
        getPhotoDeliveryIds: vi.fn(),
        removeClientAssistedPhoto,
      },
      profilePhotoMediaStore: { read },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'profile-photo-client-delete-0001',
        'x-profile-photo-grant': await profilePhotoGrant(),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ removed: true, replayed: false });
    expect(removeClientAssistedPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId,
        idempotencyKey: 'profile-photo-client-delete-0001',
        grantId: '55555555-5555-4555-8555-555555555555',
      }),
    );
    const oldDelivery = await app.inject({
      method: 'GET',
      url: `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`,
    });
    expect(oldDelivery.statusCode).toBe(404);
    expect(oldDelivery.json()).toMatchObject({ code: 'PROFILE_PHOTO_NOT_FOUND' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a photo command grant issued for another PadlHub session family', async () => {
    const removeClientAssistedPhoto = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('profile-photo-media-route-session-binding-test', 'silent'),
      pool: fakePool(),
      profilePhotoMediaRepository: {
        getPhotoObjectKey: vi.fn(),
        getPhotoDeliveryIds: vi.fn(),
        removeClientAssistedPhoto,
      },
      profilePhotoMediaStore: { read: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/user/api/v1/local-padel/profile/photo',
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'profile-photo-client-delete-wrong-session',
        'x-profile-photo-grant': await profilePhotoGrant('66666666-6666-4666-8666-666666666666'),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PROFILE_PHOTO_GRANT_REQUIRED' });
    expect(removeClientAssistedPhoto).not.toHaveBeenCalled();
  });

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
