import type { GiftCertificateMediaRepository } from '@phub/database';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type { GiftCertificateMediaStore } from './gift-certificate-media-store.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
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
  GIFT_CERTIFICATE_MEDIA_ENABLED: 'true',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'padlhub-media',
  S3_ACCESS_KEY: 'padlhub',
  S3_SECRET_KEY: 'test-secret',
});

function fakePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }),
  } as unknown as Pool;
}

async function token(): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions: ['gift_certificates.catalog.manage'],
    sid: '44444444-4444-4444-8444-444444444444',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_ADMIN_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('gift certificate media routes', () => {
  it('normalizes an admin upload to WebP before persisting its ready metadata', async () => {
    const storedBodies: Buffer[] = [];
    const store: GiftCertificateMediaStore = {
      putPreparedImage: vi.fn<GiftCertificateMediaStore['putPreparedImage']>((input) => {
        storedBodies.push(input.body);
        return Promise.resolve();
      }),
      createReadUrl: vi.fn<GiftCertificateMediaStore['createReadUrl']>(),
    };
    const saveReady = vi.fn<GiftCertificateMediaRepository['saveReady']>((input) =>
      Promise.resolve({
        outcome: 'applied' as const,
        asset: {
          id: assetId,
          status: 'READY' as const,
          mediaUrl: `/public/api/v1/local-padel/gift-certificate-media/${assetId}`,
          contentType: 'image/webp' as const,
          bytes: input.bytes,
          width: input.width,
          height: input.height,
          sha256: input.sha256,
          createdAt: '2026-07-19T10:00:00.000Z',
        },
        replayed: false,
      }),
    );
    const repository = {
      saveReady,
      getReady: vi.fn<GiftCertificateMediaRepository['getReady']>(),
    } satisfies GiftCertificateMediaRepository;
    const app = await buildApp({
      config,
      logger: createLogger('gift-media-route-test', 'silent'),
      pool: fakePool(),
      giftCertificateMediaRepository: repository,
      giftCertificateMediaStore: store,
    });
    apps.push(app);
    const png = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: '#1d6b45' },
    })
      .png()
      .toBuffer();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/gift-certificate-media',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'cup-admin',
        'content-type': 'image/png',
        'idempotency-key': 'gift-media-upload-0001',
      },
      payload: png,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: assetId, contentType: 'image/webp' });
    expect(storedBodies).toHaveLength(1);
    expect(await sharp(storedBodies[0]).metadata()).toMatchObject({
      format: 'webp',
      width: 1600,
      height: 800,
    });
    expect(saveReady).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId: userId, width: 1600, height: 800 }),
    );
  });

  it('reports storage outages as unavailable instead of invalid user media', async () => {
    const store: GiftCertificateMediaStore = {
      putPreparedImage: vi
        .fn<GiftCertificateMediaStore['putPreparedImage']>()
        .mockRejectedValue(new Error('storage offline')),
      createReadUrl: vi.fn<GiftCertificateMediaStore['createReadUrl']>(),
    };
    const repository = {
      saveReady: vi.fn<GiftCertificateMediaRepository['saveReady']>(),
      getReady: vi.fn<GiftCertificateMediaRepository['getReady']>(),
    } satisfies GiftCertificateMediaRepository;
    const app = await buildApp({
      config,
      logger: createLogger('gift-media-route-test', 'silent'),
      pool: fakePool(),
      giftCertificateMediaRepository: repository,
      giftCertificateMediaStore: store,
    });
    apps.push(app);
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#1d6b45' },
    })
      .png()
      .toBuffer();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/gift-certificate-media',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'cup-admin',
        'content-type': 'image/png',
        'idempotency-key': 'gift-media-upload-0002',
      },
      payload: png,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'GIFT_CERTIFICATE_MEDIA_STORAGE_UNAVAILABLE',
    });
    expect(repository.saveReady).not.toHaveBeenCalled();
  });

  it('allows public certificate artwork to render in CUP and sale surfaces', async () => {
    const asset = {
      id: assetId,
      status: 'READY' as const,
      mediaUrl: `/public/api/v1/local-padel/gift-certificate-media/${assetId}`,
      contentType: 'image/webp' as const,
      bytes: 1200,
      width: 1600,
      height: 800,
      sha256: 'a'.repeat(64),
      createdAt: '2026-07-19T10:00:00.000Z',
    };
    const repository = {
      saveReady: vi.fn<GiftCertificateMediaRepository['saveReady']>(),
      getReady: vi
        .fn<GiftCertificateMediaRepository['getReady']>()
        .mockResolvedValue({ asset, objectKey: 'gift-certificate-media/test.webp' }),
    } satisfies GiftCertificateMediaRepository;
    const store: GiftCertificateMediaStore = {
      putPreparedImage: vi.fn<GiftCertificateMediaStore['putPreparedImage']>(),
      createReadUrl: vi
        .fn<GiftCertificateMediaStore['createReadUrl']>()
        .mockResolvedValue('http://localhost:9000/padlhub-media/signed.webp'),
    };
    const app = await buildApp({
      config,
      logger: createLogger('gift-media-route-test', 'silent'),
      pool: fakePool(),
      giftCertificateMediaRepository: repository,
      giftCertificateMediaStore: store,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/public/api/v1/local-padel/gift-certificate-media/${assetId}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers.location).toBe('http://localhost:9000/padlhub-media/signed.webp');
  });
});
