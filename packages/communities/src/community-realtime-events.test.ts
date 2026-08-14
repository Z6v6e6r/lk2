import { describe, expect, it, vi } from 'vitest';

import { createCommunityEventRecoveryService } from './community-realtime-events.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  viewerUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  afterSequence: 4,
  limit: 50,
  correlationId: 'community-recovery-correlation',
} as const;

describe('community event recovery service', () => {
  it('returns a bounded identifier-only page', async () => {
    const listEvents = vi.fn().mockResolvedValue({
      outcome: 'found',
      page: {
        items: [
          {
            communityId: input.communityId,
            sequence: 5,
            eventType: 'community.post.edited.v1',
            targetType: 'POST',
            targetId: '22222222-2222-4222-8222-222222222222',
            targetRevision: 3,
            targetStatus: 'PUBLISHED',
            occurredAt: '2026-08-04T13:00:00.000Z',
          },
        ],
        afterSequence: 4,
        latestSequence: 5,
        retainedFromSequence: 1,
        nextAfterSequence: 5,
        hasMore: false,
      },
    });
    await expect(
      createCommunityEventRecoveryService({ listEvents }).listEvents(input),
    ).resolves.toMatchObject({
      outcome: 'found',
      page: { latestSequence: 5 },
    });
  });

  it('rejects unsafe numeric cursors before storage', async () => {
    const service = createCommunityEventRecoveryService({ listEvents: vi.fn() });
    await expect(
      service.listEvents({ ...input, afterSequence: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toMatchObject({
      code: 'COMMUNITY_EVENT_RECOVERY_QUERY_INVALID',
    });
  });
});
