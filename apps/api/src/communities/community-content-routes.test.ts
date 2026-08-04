import { CommunityContentError, type CommunityContentService } from '@phub/communities';
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
const postId = '22222222-2222-4222-8222-222222222222';
const mediaId = '33333333-3333-4333-8333-333333333333';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
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

const post = {
  id: postId,
  communityId,
  authorUserId: userId,
  status: 'PUBLISHED',
  body: 'Первый пост',
  revision: 1,
  createdAt: '2026-08-04T10:00:00.000Z',
  publishedAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  archivedAt: null,
  restoreUntil: null,
  retentionUntil: null,
} as const;

const commentId = '44444444-4444-4444-8444-444444444444';
const comment = {
  id: commentId,
  communityId,
  postId,
  authorUserId: userId,
  status: 'PUBLISHED',
  body: 'Комментарий',
  revision: 1,
  createdAt: '2026-08-04T10:00:00.000Z',
  publishedAt: '2026-08-04T10:00:00.000Z',
  updatedAt: '2026-08-04T10:00:00.000Z',
  archivedAt: null,
  restoreUntil: null,
  retentionUntil: null,
} as const;

function service(overrides: Partial<CommunityContentService> = {}): CommunityContentService {
  return {
    createPost: vi.fn(),
    editPost: vi.fn(),
    archivePost: vi.fn(),
    restorePost: vi.fn(),
    createComment: vi.fn(),
    editComment: vi.fn(),
    archiveComment: vi.fn(),
    restoreComment: vi.fn(),
    setReaction: vi.fn(),
    removeReaction: vi.fn(),
    listFeed: vi.fn(),
    listComments: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('community content routes', () => {
  it('creates a post for the JWT subject without accepting actor or status selectors', async () => {
    const createPost = vi.fn().mockResolvedValue({ outcome: 'created', post, replayed: false });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ createPost }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts`,
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'community-post-route-test-0001',
      },
      payload: { body: post.body, mediaIds: [mediaId] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['x-idempotent-replayed']).toBe('false');
    expect(createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        communityId,
        body: post.body,
        mediaIds: [mediaId],
      }),
    );
    expect(createPost.mock.calls[0]?.[0]).not.toHaveProperty('status');
    expect(createPost.mock.calls[0]?.[0]).not.toHaveProperty('role');
  });

  it('rejects oversized post and nested/forged comment fields at the boundary', async () => {
    const createPost = vi.fn();
    const createComment = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ createPost, createComment }),
    });
    apps.push(app);
    const authorization = `Bearer ${await token()}`;
    const oversized = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts`,
      headers: { authorization, 'idempotency-key': 'community-post-route-test-0002' },
      payload: { body: 'a'.repeat(10_001) },
    });
    expect(oversized.statusCode).toBe(400);

    const nested = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments`,
      headers: { authorization, 'idempotency-key': 'community-comment-route-test-0001' },
      payload: { body: 'Комментарий', parentCommentId: postId },
    });
    expect(nested.statusCode).toBe(400);
    const commentMedia = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments`,
      headers: { authorization, 'idempotency-key': 'community-comment-route-test-0002' },
      payload: { body: 'Комментарий', mediaIds: [mediaId] },
    });
    expect(commentMedia.statusCode).toBe(400);
    expect(createPost).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('passes only the opaque cursor to a bounded feed read', async () => {
    const listFeed = vi.fn().mockResolvedValue({
      outcome: 'found',
      page: { items: [post], watermark: '2026-08-04T11:00:00.000Z' },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ listFeed }),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/communities/${communityId}/feed?limit=10&cursor=opaque-feed-cursor`,
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(listFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        viewerUserId: userId,
        communityId,
        limit: 10,
        cursor: 'opaque-feed-cursor',
      }),
    );
  });

  it('sets only an accepted reaction and maps stale content to a stable conflict', async () => {
    const setReaction = vi.fn().mockResolvedValue({
      outcome: 'changed',
      replayed: false,
      reaction: {
        targetType: 'POST',
        targetId: postId,
        reaction: 'LIKE',
        active: true,
        revision: 1,
        updatedAt: '2026-08-04T10:00:00.000Z',
      },
    });
    const archivePost = vi.fn().mockResolvedValue({
      outcome: 'revision_conflict',
      currentRevision: 2,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ setReaction, archivePost }),
    });
    apps.push(app);
    const authorization = `Bearer ${await token()}`;
    const reaction = await app.inject({
      method: 'PUT',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/reaction`,
      headers: { authorization, 'idempotency-key': 'community-reaction-route-test-0001' },
      payload: { reaction: 'LIKE' },
    });
    expect(reaction.statusCode).toBe(200);
    expect(setReaction).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'POST', targetId: postId, reaction: 'LIKE' }),
    );

    const stale = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/archive`,
      headers: { authorization, 'idempotency-key': 'community-post-route-test-0003' },
      payload: { expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'COMMUNITY_CONTENT_REVISION_CONFLICT' });
  });

  it.each([
    ['idempotency_conflict', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['actor_not_active', 403, 'COMMUNITY_CONTENT_ACTOR_INELIGIBLE'],
    ['community_not_found', 404, 'COMMUNITY_NOT_FOUND'],
    ['membership_required', 403, 'COMMUNITY_ACTIVE_MEMBERSHIP_REQUIRED'],
    ['publishing_forbidden', 403, 'COMMUNITY_PUBLISHING_FORBIDDEN'],
    ['post_not_found', 404, 'COMMUNITY_POST_NOT_FOUND'],
    ['comment_not_found', 404, 'COMMUNITY_COMMENT_NOT_FOUND'],
    ['not_author', 403, 'COMMUNITY_CONTENT_AUTHOR_REQUIRED'],
    ['content_not_editable', 409, 'COMMUNITY_CONTENT_NOT_EDITABLE'],
    ['content_not_archived', 409, 'COMMUNITY_CONTENT_NOT_ARCHIVED'],
    ['restore_expired', 409, 'COMMUNITY_CONTENT_RESTORE_EXPIRED'],
    ['media_not_ready', 409, 'COMMUNITY_MEDIA_NOT_READY'],
    ['media_not_owned', 403, 'COMMUNITY_MEDIA_NOT_OWNED'],
    ['media_already_bound', 409, 'COMMUNITY_MEDIA_ALREADY_BOUND'],
    ['media_attachment_conflict', 409, 'COMMUNITY_MEDIA_ATTACHMENT_CONFLICT'],
  ] as const)('maps %s command failures to %s/%s', async (outcome, status, code) => {
    const createPost = vi.fn().mockResolvedValue({ outcome });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ createPost }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts`,
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': `community-failure-${outcome}`,
      },
      payload: { body: post.body },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
  });

  it('maps revision conflicts including the current revision', async () => {
    const editPost = vi
      .fn()
      .mockResolvedValue({ outcome: 'revision_conflict', currentRevision: 4 });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ editPost }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'PATCH',
      url: `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}`,
      headers: {
        authorization: `Bearer ${await token()}`,
        'idempotency-key': 'community-post-revision-conflict-0001',
      },
      payload: { body: 'Изменённый пост', expectedRevision: 3 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_CONTENT_REVISION_CONFLICT' });
  });

  it('covers successful post, comment and reaction mutations without trusting client identity', async () => {
    const changedPost = { ...post, body: 'Изменённый пост', revision: 2 };
    const changedComment = { ...comment, body: 'Изменённый комментарий', revision: 2 };
    const editPost = vi
      .fn()
      .mockResolvedValue({ outcome: 'edited', post: changedPost, replayed: true });
    const archivePost = vi.fn().mockResolvedValue({ outcome: 'archived', post, replayed: false });
    const restorePost = vi.fn().mockResolvedValue({ outcome: 'restored', post, replayed: false });
    const createComment = vi.fn().mockResolvedValue({
      outcome: 'created',
      comment,
      replayed: false,
    });
    const editComment = vi.fn().mockResolvedValue({
      outcome: 'edited',
      comment: changedComment,
      replayed: true,
    });
    const archiveComment = vi.fn().mockResolvedValue({
      outcome: 'archived',
      comment,
      replayed: false,
    });
    const restoreComment = vi.fn().mockResolvedValue({
      outcome: 'restored',
      comment,
      replayed: false,
    });
    const setReaction = vi
      .fn()
      .mockImplementation((input: { targetType: 'POST' | 'COMMENT'; targetId: string }) =>
        Promise.resolve({
          outcome: 'changed',
          replayed: false,
          reaction: {
            targetType: input.targetType,
            targetId: input.targetId,
            reaction: 'DISLIKE',
            active: true,
            revision: 1,
            updatedAt: post.updatedAt,
          },
        }),
      );
    const removeReaction = vi
      .fn()
      .mockImplementation((input: { targetType: 'POST' | 'COMMENT'; targetId: string }) =>
        Promise.resolve({
          outcome: 'changed',
          replayed: true,
          reaction: {
            targetType: input.targetType,
            targetId: input.targetId,
            reaction: null,
            active: false,
            revision: 2,
            updatedAt: post.updatedAt,
          },
        }),
      );
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({
        editPost,
        archivePost,
        restorePost,
        createComment,
        editComment,
        archiveComment,
        restoreComment,
        setReaction,
        removeReaction,
      }),
    });
    apps.push(app);
    const authorization = `Bearer ${await token()}`;
    let sequence = 0;
    const command = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      app.inject({
        method,
        url,
        headers: {
          authorization,
          'idempotency-key': `community-success-route-${String(++sequence).padStart(4, '0')}`,
        },
        ...(payload ? { payload } : {}),
      });

    const responses = await Promise.all([
      command('PATCH', `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}`, {
        body: changedPost.body,
        expectedRevision: 1,
      }),
      command(
        'POST',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/archive`,
        { expectedRevision: 1 },
      ),
      command(
        'POST',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/restore`,
        { expectedRevision: 1 },
      ),
      command(
        'POST',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments`,
        { body: comment.body },
      ),
      command(
        'PATCH',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments/${commentId}`,
        { body: changedComment.body, expectedRevision: 1 },
      ),
      command(
        'POST',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments/${commentId}/archive`,
        { expectedRevision: 1 },
      ),
      command(
        'POST',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments/${commentId}/restore`,
        { expectedRevision: 1 },
      ),
      command(
        'PUT',
        `/user/api/v1/local-padel/communities/${communityId}/comments/${commentId}/reaction`,
        {
          reaction: 'DISLIKE',
        },
      ),
      command(
        'DELETE',
        `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/reaction`,
      ),
      command(
        'DELETE',
        `/user/api/v1/local-padel/communities/${communityId}/comments/${commentId}/reaction`,
      ),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 201, 200, 200, 200, 200, 200, 200,
    ]);
    expect(editPost).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: userId }));
    expect(editComment).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: userId }));
    expect(setReaction).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'COMMENT' }));
    expect(removeReaction).toHaveBeenCalledTimes(2);
  });

  it('maps feed and comment read failures and accepts bounded comment cursors', async () => {
    const listFeed = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'community_not_found' })
      .mockResolvedValueOnce({ outcome: 'actor_not_active' });
    const listComments = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'community_not_found' })
      .mockResolvedValueOnce({ outcome: 'post_not_found' })
      .mockResolvedValueOnce({ outcome: 'actor_not_active' })
      .mockResolvedValueOnce({
        outcome: 'found',
        page: { items: [comment], watermark: post.updatedAt },
      });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ listFeed, listComments }),
    });
    apps.push(app);
    const authorization = `Bearer ${await token()}`;

    const feedUrl = `/user/api/v1/local-padel/communities/${communityId}/feed`;
    expect(
      (await app.inject({ method: 'GET', url: feedUrl, headers: { authorization } })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: feedUrl, headers: { authorization } })).statusCode,
    ).toBe(403);

    const commentsUrl = `/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/comments`;
    const statuses: number[] = [];
    for (const suffix of ['', '', '', '?limit=7&cursor=opaque-comment-cursor']) {
      statuses.push(
        (
          await app.inject({
            method: 'GET',
            url: `${commentsUrl}${suffix}`,
            headers: { authorization },
          })
        ).statusCode,
      );
    }
    expect(statuses).toEqual([404, 404, 403, 200]);
    expect(listComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 7, cursor: 'opaque-comment-cursor' }),
    );
  });

  it.each([
    'COMMUNITY_CONTENT_COMMAND_INVALID',
    'COMMUNITY_FEED_QUERY_INVALID',
    'COMMUNITY_FEED_CURSOR_INVALID',
    'COMMUNITY_COMMENT_CURSOR_INVALID',
  ] as const)('maps the known %s domain error to a stable bad request', async (code) => {
    const listFeed = vi.fn().mockRejectedValue(new CommunityContentError(code));
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ listFeed }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/communities/${communityId}/feed`,
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code });
  });

  it('hides unexpected content errors behind the availability contract', async () => {
    const listFeed = vi.fn().mockRejectedValue(new Error('database details must stay private'));
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityContentService: service({ listFeed }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/communities/${communityId}/feed`,
      headers: { authorization: `Bearer ${await token()}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_CONTENT_UNAVAILABLE' });
    expect(response.body).not.toContain('database details');
  });
});
