import { describe, expect, it, vi } from 'vitest';

import {
  CommunityReadError,
  createCommunityReadService,
  type CommunityReadRecord,
} from './community-read.js';

const base: CommunityReadRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Padel Friends',
  description: 'Public description',
  logoUrl: null,
  isVerified: true,
  visibility: 'PUBLIC',
  joinPolicy: 'MODERATED',
  publishingPreset: 'STAFF_FEED',
  revision: 1,
  memberCount: 42,
  createdAt: '2026-08-03T10:00:00.000Z',
  updatedAt: '2026-08-03T10:00:00.000Z',
  sortCreatedAt: '2026-08-03 10:00:00+00',
};

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  viewerUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
};

describe('community read policy', () => {
  it('accepts the exact relative PadlHub logo route in discovery and detail responses', async () => {
    const stableLogoUrl =
      `/public/api/v1/media/community-logos/${input.tenantId}/${base.id}` as const;
    const stable = { ...base, logoUrl: stableLogoUrl };
    const service = createCommunityReadService({
      listDiscoverable: vi.fn().mockResolvedValue({ items: [stable], hasMore: false }),
      getDetail: vi.fn().mockResolvedValue(stable),
    });

    await expect(service.listDiscoverable({ ...input, limit: 20 })).resolves.toMatchObject({
      items: [{ logoUrl: stableLogoUrl }],
    });
    await expect(service.getDetail({ ...input, communityId: base.id })).resolves.toMatchObject({
      outcome: 'found',
      detail: { logoUrl: stableLogoUrl },
    });
  });

  it('returns full public fields but a strict minimal LISTED_PRIVATE card', async () => {
    const service = createCommunityReadService({
      listDiscoverable: vi.fn().mockResolvedValue({
        items: [
          base,
          { ...base, id: '22222222-2222-4222-8222-222222222222', visibility: 'LISTED_PRIVATE' },
        ],
        hasMore: false,
      }),
      getDetail: vi.fn(),
    });

    const page = await service.listDiscoverable({ ...input, query: '  FRIENDS ', limit: 20 });
    expect(page.items[0]).toMatchObject({ description: 'Public description', memberCount: 42 });
    expect(page.items[1]).toEqual({
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Padel Friends',
      logoUrl: null,
      isVerified: true,
      visibility: 'LISTED_PRIVATE',
      joinAction: 'REQUEST_TO_JOIN',
    });
    expect(page.items[1]).not.toHaveProperty('description');
    expect(page.items[1]).not.toHaveProperty('memberCount');
  });

  it('makes HIDDEN indistinguishable from missing unless the viewer is ACTIVE', async () => {
    const getDetail = vi
      .fn()
      .mockResolvedValueOnce({ ...base, visibility: 'HIDDEN' })
      .mockResolvedValueOnce({
        ...base,
        visibility: 'HIDDEN',
        viewerMembership: { status: 'ACTIVE', role: 'MEMBER', revision: 3, memberRank: 7 },
      });
    const service = createCommunityReadService({ listDiscoverable: vi.fn(), getDetail });

    await expect(service.getDetail({ ...input, communityId: base.id })).resolves.toEqual({
      outcome: 'not_found',
    });
    await expect(service.getDetail({ ...input, communityId: base.id })).resolves.toMatchObject({
      outcome: 'found',
      detail: {
        visibility: 'HIDDEN',
        publishingPreset: 'STAFF_FEED',
        viewerMembership: { status: 'ACTIVE', role: 'MEMBER', revision: 3, memberRank: 7 },
      },
    });
  });

  it('derives pending, rejoin and fail-closed actions from current membership state', async () => {
    const getDetail = vi
      .fn()
      .mockResolvedValueOnce({
        ...base,
        visibility: 'LISTED_PRIVATE',
        viewerMembership: { status: 'PENDING', role: 'MEMBER', revision: 1 },
      })
      .mockResolvedValueOnce({
        ...base,
        viewerMembership: { status: 'REMOVED', role: 'MEMBER', revision: 2 },
      })
      .mockResolvedValueOnce({
        ...base,
        viewerMembership: { status: 'BANNED', role: 'MEMBER', revision: 3 },
      });
    const service = createCommunityReadService({ listDiscoverable: vi.fn(), getDetail });

    await expect(service.getDetail({ ...input, communityId: base.id })).resolves.toMatchObject({
      detail: { joinAction: 'MEMBERSHIP_PENDING' },
    });
    await expect(service.getDetail({ ...input, communityId: base.id })).resolves.toMatchObject({
      detail: { joinAction: 'REQUEST_REJOIN' },
    });
    await expect(service.getDetail({ ...input, communityId: base.id })).resolves.toMatchObject({
      detail: { joinAction: 'UNAVAILABLE' },
    });
  });

  it('binds an opaque continuation cursor to the normalized query', async () => {
    const listDiscoverable = vi
      .fn()
      .mockResolvedValueOnce({ items: [base], hasMore: true })
      .mockResolvedValueOnce({ items: [], hasMore: false });
    const service = createCommunityReadService({ listDiscoverable, getDetail: vi.fn() });
    const first = await service.listDiscoverable({ ...input, query: 'Friends', limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const cursor = first.nextCursor;
    if (!cursor) throw new Error('expected continuation cursor');
    await expect(
      service.listDiscoverable({ ...input, query: 'Other', limit: 1, cursor }),
    ).rejects.toEqual(new CommunityReadError('COMMUNITY_DISCOVERY_CURSOR_INVALID'));
    await service.listDiscoverable({
      ...input,
      query: 'friends',
      limit: 1,
      cursor,
    });
    expect(listDiscoverable).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: 'friends',
        after: { createdAt: base.sortCreatedAt, id: base.id },
      }),
    );
  });
});
