import { describe, expect, it, vi } from 'vitest';

import { CommunityContentError, createCommunityContentService } from './community-content.js';

const base = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'community-content-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-content-correlation',
} as const;

const post = {
  id: '22222222-2222-4222-8222-222222222222',
  communityId: base.communityId,
  authorUserId: base.actorUserId,
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

function repository() {
  return {
    createPost: vi.fn().mockResolvedValue({ outcome: 'created', post, replayed: false }),
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
  };
}

describe('community content service', () => {
  it('accepts bounded non-empty post content', async () => {
    const repo = repository();
    await expect(
      createCommunityContentService(repo).createPost({ ...base, body: post.body }),
    ).resolves.toEqual({ outcome: 'created', post, replayed: false });
  });

  it('accepts at most ten unique READY media identifiers on posts', async () => {
    const repo = repository();
    const mediaIds = Array.from(
      { length: 10 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    await createCommunityContentService(repo).createPost({ ...base, body: post.body, mediaIds });
    expect(repo.createPost).toHaveBeenCalledWith(expect.objectContaining({ mediaIds }));

    await expect(
      createCommunityContentService(repo).createPost({
        ...base,
        body: post.body,
        mediaIds: [...mediaIds, mediaIds[0] as string],
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID'));
  });

  it.each(['', '   ', 'a'.repeat(10_001)])('rejects invalid post body %s', async (body) => {
    const repo = repository();
    await expect(createCommunityContentService(repo).createPost({ ...base, body })).rejects.toEqual(
      new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID'),
    );
    expect(repo.createPost).not.toHaveBeenCalled();
  });

  it('rejects a comment above 2,000 characters', async () => {
    const repo = repository();
    await expect(
      createCommunityContentService(repo).createComment({
        ...base,
        postId: post.id,
        body: 'a'.repeat(2_001),
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID'));
  });

  it('keeps one snapshot watermark across opaque feed pages', async () => {
    const repo = repository();
    repo.listFeed.mockResolvedValueOnce({
      outcome: 'found',
      items: [post],
      watermark: '2026-08-04T11:00:00.000Z',
      hasMore: true,
    });
    const service = createCommunityContentService(repo);
    const first = await service.listFeed({
      tenantId: base.tenantId,
      viewerUserId: base.actorUserId,
      communityId: base.communityId,
      limit: 1,
      correlationId: base.correlationId,
    });
    expect(first.outcome).toBe('found');
    if (first.outcome !== 'found') throw new Error('expected feed');
    expect(first.page.nextCursor).toBeTruthy();
    if (!first.page.nextCursor) throw new Error('expected next cursor');

    repo.listFeed.mockResolvedValueOnce({
      outcome: 'found',
      items: [],
      watermark: '2026-08-04T11:00:00.000Z',
      hasMore: false,
    });
    await service.listFeed({
      tenantId: base.tenantId,
      viewerUserId: base.actorUserId,
      communityId: base.communityId,
      limit: 1,
      cursor: first.page.nextCursor,
      correlationId: base.correlationId,
    });
    expect(repo.listFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        watermark: '2026-08-04T11:00:00.000Z',
        after: { publishedAt: post.publishedAt, id: post.id },
      }),
    );
  });

  it('rejects a cursor copied from another community', async () => {
    const repo = repository();
    const service = createCommunityContentService(repo);
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        communityId: '33333333-3333-4333-8333-333333333333',
        watermark: '2026-08-04T11:00:00.000Z',
        publishedAt: post.publishedAt,
        id: post.id,
      }),
    ).toString('base64url');
    await expect(
      service.listFeed({
        tenantId: base.tenantId,
        viewerUserId: base.actorUserId,
        communityId: base.communityId,
        limit: 20,
        cursor,
        correlationId: base.correlationId,
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_FEED_CURSOR_INVALID'));
  });
});
