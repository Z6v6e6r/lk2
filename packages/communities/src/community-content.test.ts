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

const comment = {
  id: '33333333-3333-4333-8333-333333333333',
  communityId: base.communityId,
  postId: post.id,
  authorUserId: base.actorUserId,
  status: 'PUBLISHED',
  body: 'Комментарий',
  revision: 1,
  createdAt: '2026-08-04T10:01:00.000Z',
  publishedAt: '2026-08-04T10:01:00.000Z',
  updatedAt: '2026-08-04T10:01:00.000Z',
  archivedAt: null,
  restoreUntil: null,
  retentionUntil: null,
} as const;

const reaction = {
  targetType: 'POST',
  targetId: post.id,
  reaction: 'LIKE',
  active: true,
  revision: 1,
  updatedAt: '2026-08-04T10:02:00.000Z',
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

  it('validates every mutation boundary and preserves repository failure outcomes', async () => {
    const repo = repository();
    repo.editPost.mockResolvedValue({
      outcome: 'edited',
      post: { ...post, revision: 2 },
      replayed: false,
    });
    repo.archivePost.mockResolvedValue({
      outcome: 'archived',
      post: { ...post, status: 'ARCHIVED', revision: 2 },
      replayed: false,
    });
    repo.restorePost.mockResolvedValue({ outcome: 'post_not_found' });
    repo.createComment.mockResolvedValue({ outcome: 'created', comment, replayed: false });
    repo.editComment.mockResolvedValue({
      outcome: 'edited',
      comment: { ...comment, revision: 2 },
      replayed: false,
    });
    repo.archiveComment.mockResolvedValue({
      outcome: 'archived',
      comment: { ...comment, status: 'ARCHIVED', revision: 2 },
      replayed: false,
    });
    repo.restoreComment.mockResolvedValue({ outcome: 'restore_expired' });
    repo.setReaction.mockResolvedValue({ outcome: 'changed', reaction, replayed: false });
    repo.removeReaction.mockResolvedValue({
      outcome: 'changed',
      reaction: { ...reaction, reaction: null, active: false, revision: 2 },
      replayed: false,
    });
    const content = createCommunityContentService(repo);

    await expect(
      content.editPost({ ...base, postId: post.id, body: 'Изменено', expectedRevision: 1 }),
    ).resolves.toMatchObject({ outcome: 'edited' });
    await expect(
      content.archivePost({ ...base, postId: post.id, expectedRevision: 1 }),
    ).resolves.toMatchObject({ outcome: 'archived' });
    await expect(
      content.restorePost({ ...base, postId: post.id, expectedRevision: 1 }),
    ).resolves.toEqual({ outcome: 'post_not_found' });
    await expect(
      content.createComment({ ...base, postId: post.id, body: comment.body }),
    ).resolves.toMatchObject({ outcome: 'created' });
    await expect(
      content.editComment({
        ...base,
        postId: post.id,
        commentId: comment.id,
        body: 'Исправлено',
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: 'edited' });
    await expect(
      content.archiveComment({
        ...base,
        postId: post.id,
        commentId: comment.id,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ outcome: 'archived' });
    await expect(
      content.restoreComment({
        ...base,
        postId: post.id,
        commentId: comment.id,
        expectedRevision: 1,
      }),
    ).resolves.toEqual({ outcome: 'restore_expired' });
    await expect(
      content.setReaction({ ...base, targetType: 'POST', targetId: post.id, reaction: 'LIKE' }),
    ).resolves.toMatchObject({ outcome: 'changed' });
    await expect(
      content.removeReaction({ ...base, targetType: 'POST', targetId: post.id }),
    ).resolves.toMatchObject({ outcome: 'changed', reaction: { active: false } });
  });

  it('rejects malformed command inputs and invalid repository states before they escape', async () => {
    const repo = repository();
    const content = createCommunityContentService(repo);
    await expect(
      content.archivePost({ ...base, postId: post.id, expectedRevision: 0 }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID'));
    await expect(
      content.editComment({
        ...base,
        postId: post.id,
        commentId: comment.id,
        body: ' ',
        expectedRevision: 1,
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID'));
    await expect(
      content.setReaction({
        ...base,
        targetType: 'POST',
        targetId: post.id,
        reaction: 'CLAP',
      } as never),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_COMMAND_INVALID'));

    repo.editPost.mockResolvedValue({
      outcome: 'edited',
      post: { ...post, status: 'DELETED' },
      replayed: false,
    });
    await expect(
      content.editPost({ ...base, postId: post.id, body: 'Изменено', expectedRevision: 1 }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID'));
    repo.createComment.mockResolvedValue({
      outcome: 'created',
      comment: { ...comment, body: '' },
      replayed: false,
    });
    await expect(
      content.createComment({ ...base, postId: post.id, body: comment.body }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID'));
    repo.setReaction.mockResolvedValue({
      outcome: 'changed',
      reaction: { ...reaction, reaction: null, active: true },
      replayed: false,
    });
    await expect(
      content.setReaction({ ...base, targetType: 'POST', targetId: post.id, reaction: 'LIKE' }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID'));
  });

  it('rejects inconsistent feed pages and returns repository visibility failures unchanged', async () => {
    const repo = repository();
    const content = createCommunityContentService(repo);
    await expect(
      content.listFeed({
        tenantId: base.tenantId,
        viewerUserId: base.actorUserId,
        communityId: base.communityId,
        limit: 0,
        correlationId: base.correlationId,
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_FEED_QUERY_INVALID'));
    await expect(
      content.listFeed({
        tenantId: base.tenantId,
        viewerUserId: base.actorUserId,
        communityId: base.communityId,
        limit: 20,
        cursor: 'not-a-valid-cursor',
        correlationId: base.correlationId,
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_FEED_CURSOR_INVALID'));

    repo.listFeed.mockResolvedValueOnce({ outcome: 'community_not_found' });
    await expect(
      content.listFeed({
        tenantId: base.tenantId,
        viewerUserId: base.actorUserId,
        communityId: base.communityId,
        limit: 20,
        correlationId: base.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'community_not_found' });
    repo.listFeed.mockResolvedValueOnce({
      outcome: 'found',
      items: [],
      watermark: '2026-08-04T11:00:00.000Z',
      hasMore: true,
    });
    await expect(
      content.listFeed({
        tenantId: base.tenantId,
        viewerUserId: base.actorUserId,
        communityId: base.communityId,
        limit: 20,
        correlationId: base.correlationId,
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_CONTENT_STATE_INVALID'));
  });

  it('keeps one watermark across comment pages and rejects cross-post cursors', async () => {
    const repo = repository();
    repo.listComments.mockResolvedValueOnce({
      outcome: 'found',
      items: [comment],
      watermark: '2026-08-04T11:00:00.000Z',
      hasMore: true,
    });
    const content = createCommunityContentService(repo);
    const first = await content.listComments({
      tenantId: base.tenantId,
      viewerUserId: base.actorUserId,
      communityId: base.communityId,
      postId: post.id,
      limit: 1,
      correlationId: base.correlationId,
    });
    expect(first).toMatchObject({ outcome: 'found' });
    if (first.outcome !== 'found' || !first.page.nextCursor) throw new Error('expected cursor');

    repo.listComments.mockResolvedValueOnce({
      outcome: 'found',
      items: [],
      watermark: '2026-08-04T11:00:00.000Z',
      hasMore: false,
    });
    await content.listComments({
      tenantId: base.tenantId,
      viewerUserId: base.actorUserId,
      communityId: base.communityId,
      postId: post.id,
      limit: 1,
      cursor: first.page.nextCursor,
      correlationId: base.correlationId,
    });
    expect(repo.listComments).toHaveBeenLastCalledWith(
      expect.objectContaining({
        watermark: '2026-08-04T11:00:00.000Z',
        after: { publishedAt: comment.publishedAt, id: comment.id },
      }),
    );

    const copied = Buffer.from(
      JSON.stringify({
        v: 1,
        communityId: base.communityId,
        postId: '44444444-4444-4444-8444-444444444444',
        watermark: '2026-08-04T11:00:00.000Z',
        publishedAt: comment.publishedAt,
        id: comment.id,
      }),
    ).toString('base64url');
    await expect(
      content.listComments({
        tenantId: base.tenantId,
        viewerUserId: base.actorUserId,
        communityId: base.communityId,
        postId: post.id,
        limit: 1,
        cursor: copied,
        correlationId: base.correlationId,
      }),
    ).rejects.toEqual(new CommunityContentError('COMMUNITY_COMMENT_CURSOR_INVALID'));
  });
});
