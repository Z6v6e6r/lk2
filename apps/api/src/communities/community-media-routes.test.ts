import type { CommunityMediaService } from '@phub/communities';
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
const communityId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

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
    permissions: ['communities.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

const mediaBase = {
  id: mediaId,
  communityId,
  uploaderUserId: userId,
  mediaType: 'IMAGE' as const,
  revision: 1,
  declaredContentType: 'image/png' as const,
  declaredByteSize: 1_024,
  declaredSha256: 'a'.repeat(64),
  createdAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
};

function service(overrides: Partial<CommunityMediaService> = {}): CommunityMediaService {
  return {
    issueUpload: vi.fn().mockResolvedValue({ outcome: 'actor_not_active' }),
    finalizeUpload: vi.fn().mockResolvedValue({ outcome: 'actor_not_active' }),
    getMedia: vi.fn().mockResolvedValue({ outcome: 'actor_not_active' }),
    ...overrides,
  };
}

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('community media routes', () => {
  it('issues a bounded upload from the JWT principal and ignores forged authority fields', async () => {
    const issueUpload = vi.fn<CommunityMediaService['issueUpload']>().mockResolvedValue({
      outcome: 'issued',
      replayed: false,
      media: {
        ...mediaBase,
        state: 'UPLOADING',
        upload: {
          method: 'PUT',
          url: 'https://storage.test/signed-upload',
          requiredHeaders: {
            'Content-Type': 'image/png',
          },
          expiresAt: '2026-08-04T10:15:00.000Z',
        },
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMediaService: service({ issueUpload }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/media/uploads`,
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'community-media-issue-route-0001',
      },
      payload: {
        mediaType: 'IMAGE',
        contentType: 'image/png',
        byteSize: 1_024,
        sha256: 'a'.repeat(64),
        actorUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        quotaOverride: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(issueUpload).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/media/uploads`,
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'community-media-issue-route-0002',
      },
      payload: {
        mediaType: 'IMAGE',
        contentType: 'image/png',
        byteSize: 1_024,
        sha256: 'a'.repeat(64),
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers['x-idempotent-replayed']).toBe('false');
    expect(issueUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        communityId,
        contentType: 'image/png',
        byteSize: 1_024,
      }),
    );
  });

  it('returns 202 for a new finalize and preserves expected revision', async () => {
    const finalizeUpload = vi.fn<CommunityMediaService['finalizeUpload']>().mockResolvedValue({
      outcome: 'finalized',
      replayed: false,
      media: {
        ...mediaBase,
        state: 'SCANNING',
        revision: 2,
        finalizedAt: '2026-08-04T10:01:00.000Z',
        updatedAt: '2026-08-04T10:01:00.000Z',
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMediaService: service({ finalizeUpload }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/media/${mediaId}/finalize`,
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'community-media-finalize-route-0001',
      },
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(202);
    expect(finalizeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId, expectedRevision: 1, actorUserId: userId }),
    );
  });

  it('authorizes a READY variant before redirecting to an exact-version short URL', async () => {
    const authorizeVariant = vi.fn().mockResolvedValue({
      outcome: 'found',
      objectKey: `community-media/ready/${tenantId}/${communityId}/${mediaId}/feed/hash.webp`,
      versionId: 'immutable-version-1',
    });
    const createReadUrl = vi.fn().mockResolvedValue('https://storage.test/signed-read');
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMediaDeliveryAuthorizer: { authorizeVariant },
      communityMediaObjectStore: {
        createUploadGrant: vi.fn(),
        statUploadedObject: vi.fn(),
        createReadUrl,
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/communities/${communityId}/media/${mediaId}/variants/FEED`,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('https://storage.test/signed-read');
    expect(authorizeVariant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        viewerUserId: userId,
        communityId,
        mediaId,
        variant: 'FEED',
      }),
    );
    expect(createReadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'immutable-version-1' }),
    );
  });
});
