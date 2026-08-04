import { describe, expect, it, vi } from 'vitest';

import {
  createCommunityContentModerationService,
  type CommunityContentModerationRepository,
} from './community-content-moderation.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const post = {
  id: '22222222-2222-4222-8222-222222222222',
  communityId,
  authorUserId: '33333333-3333-4333-8333-333333333333',
  status: 'PENDING_MODERATION' as const,
  body: 'Пост на проверку',
  revision: 1,
  createdAt: '2026-08-04T12:00:00.000Z',
  publishedAt: null,
  updatedAt: '2026-08-04T12:00:00.000Z',
  archivedAt: null,
  restoreUntil: null,
  retentionUntil: null,
};

function repository(
  overrides: Partial<CommunityContentModerationRepository> = {},
): CommunityContentModerationRepository {
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

describe('community content moderation service', () => {
  it('creates a scope-bound opaque cursor for the pending queue', async () => {
    const listPending = vi
      .fn()
      .mockResolvedValue({ outcome: 'found', items: [{ post }], hasMore: true });
    const service = createCommunityContentModerationService(repository({ listPending }));
    const result = await service.listPending({
      tenantId,
      actorUserId,
      communityId,
      limit: 1,
      correlationId: 'moderation-list-correlation',
    });
    expect(result).toMatchObject({ outcome: 'found', page: { items: [{ post }] } });
    if (result.outcome !== 'found') throw new Error('expected page');
    const cursor = result.page.nextCursor;
    expect(cursor).toBeTruthy();
    if (!cursor) throw new Error('expected cursor');
    await service.listPending({
      tenantId,
      actorUserId,
      communityId,
      limit: 1,
      cursor,
      correlationId: 'moderation-list-correlation',
    });
    expect(listPending).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { updatedAt: post.updatedAt, id: post.id } }),
    );
  });

  it('requires a stable reason code for reject, hide and restore commands', async () => {
    const rejectPost = vi.fn();
    const service = createCommunityContentModerationService(repository({ rejectPost }));
    await expect(
      service.rejectPost({
        tenantId,
        actorUserId,
        communityId,
        postId: post.id,
        expectedRevision: 1,
        reasonCode: 'free text',
        idempotencyKey: 'moderation-command-0001',
        requestHash: 'a'.repeat(64),
        correlationId: 'moderation-command-correlation',
      }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID' });
    expect(rejectPost).not.toHaveBeenCalled();
  });
});
