import type { CommunityContentModerationService } from '@phub/communities';
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
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const mediaId = '77777777-7777-4777-8777-777777777777';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(permissions: readonly string[]) {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_ADMIN_AUDIENCE)
    .setSubject(actorUserId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function service(
  overrides: Partial<CommunityContentModerationService> = {},
): CommunityContentModerationService {
  return {
    listPending: vi.fn(),
    approvePost: vi.fn(),
    rejectPost: vi.fn(),
    hidePost: vi.fn(),
    restorePost: vi.fn(),
    hideComment: vi.fn(),
    restoreComment: vi.fn(),
    ...overrides,
  };
}

const approvedPost = {
  id: postId,
  communityId,
  authorUserId: '33333333-3333-4333-8333-333333333333',
  status: 'PUBLISHED' as const,
  body: 'Проверенный пост',
  revision: 2,
  createdAt: '2026-08-04T12:00:00.000Z',
  publishedAt: '2026-08-04T13:00:00.000Z',
  updatedAt: '2026-08-04T13:00:00.000Z',
  archivedAt: null,
  restoreUntil: null,
  retentionUntil: null,
};

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('community content moderation admin routes', () => {
  it('lists the bounded pending queue only for the CUP admin audience', async () => {
    const listPending = vi.fn().mockResolvedValue({ outcome: 'found', page: { items: [] } });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentModerationService: service({ listPending }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/admin/api/v1/local-padel/community-content/pending?communityId=${communityId}&limit=10`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(listPending).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId, communityId, limit: 10 }),
    );
  });

  it('approves with JWT actor, revision and retry-stable command context', async () => {
    const approvePost = vi
      .fn()
      .mockResolvedValue({ outcome: 'approved', post: approvedPost, replayed: false });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentModerationService: service({ approvePost }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/content/posts/${postId}/approve`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'content-moderation-route-0001',
      },
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotent-replayed']).toBe('false');
    expect(approvePost).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId,
        communityId,
        postId,
        expectedRevision: 1,
      }),
    );
    expect(approvePost.mock.calls[0]?.[0]).not.toHaveProperty('authorUserId');
  });

  it('issues a short-lived exact-version preview URL only to a moderation reader', async () => {
    const authorizeVariant = vi.fn().mockResolvedValue({
      outcome: 'found',
      objectKey: 'community-media/ready/image.webp',
      versionId: 'image-v3',
    });
    const createReadUrl = vi.fn().mockResolvedValue('https://media.test/signed-image');
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentModerationService: service(),
      communityMediaModerationAuthorizer: { authorizeVariant },
      communityMediaObjectStore: { createReadUrl } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/admin/api/v1/local-padel/communities/${communityId}/content/media/${mediaId}/variants/THUMBNAIL/url`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ url: 'https://media.test/signed-image' });
    expect(authorizeVariant).toHaveBeenCalledWith({
      tenantId,
      viewerUserId: actorUserId,
      communityId,
      mediaId,
      variant: 'THUMBNAIL',
    });
    expect(createReadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: 'community-media/ready/image.webp',
        versionId: 'image-v3',
      }),
    );
  });

  it('requires both the granular capability and a stable reason for hide', async () => {
    const hidePost = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentModerationService: service({ hidePost }),
    });
    apps.push(app);
    const noCapability = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/content/posts/${postId}/hide`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'content-moderation-route-0002',
      },
      payload: { expectedRevision: 2, reasonCode: 'POLICY_VIOLATION' },
    });
    expect(noCapability.statusCode).toBe(403);
    const invalidReason = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/content/posts/${postId}/hide`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'content-moderation-route-0003',
      },
      payload: { expectedRevision: 2, reasonCode: 'free text' },
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(hidePost).not.toHaveBeenCalled();
  });

  it('rejects pending content into HIDDEN with a mandatory reason', async () => {
    const rejectedPost = {
      ...approvedPost,
      status: 'HIDDEN' as const,
      publishedAt: null,
    };
    const rejectPost = vi
      .fn()
      .mockResolvedValue({ outcome: 'rejected', post: rejectedPost, replayed: false });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentModerationService: service({ rejectPost }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/content/posts/${postId}/reject`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'content-moderation-route-0004',
      },
      payload: { expectedRevision: 1, reasonCode: 'CONTENT_POLICY_VIOLATION' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'HIDDEN' });
    expect(rejectPost).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId,
        communityId,
        postId,
        expectedRevision: 1,
        reasonCode: 'CONTENT_POLICY_VIOLATION',
      }),
    );
  });

  it('replays a terminal media scan through the CUP-only idempotent operations path', async () => {
    const replayFailedScan = vi.fn().mockResolvedValue({
      outcome: 'replayed',
      targetId: mediaId,
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMediaOperationsRepository: {
        replayFailedScan,
        replayDeadGc: vi.fn(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/community-media/scans/${mediaId}/replay`,
      headers: {
        authorization: `Bearer ${await token(['communities.content.moderation.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'community-media-replay-0001',
      },
      payload: { reasonCode: 'DEPENDENCY_RECOVERED' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotent-replayed']).toBe('false');
    expect(response.json()).toMatchObject({ targetId: mediaId, operation: 'SCAN' });
    expect(replayFailedScan).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId,
        targetId: mediaId,
        reasonCode: 'DEPENDENCY_RECOVERED',
      }),
    );
  });
});
