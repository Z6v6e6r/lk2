import { describe, expect, it } from 'vitest';

import {
  createCommunityDirectoryService,
  paginateCommunityDirectoryItems,
  type CommunityDirectoryError,
  type CommunityDirectoryItem,
} from './index.js';

const items: readonly CommunityDirectoryItem[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Недавнее',
    logoUrl: null,
    isVerified: false,
    unreadChatCount: 0,
    pinned: false,
    sortAt: '2026-07-17T10:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Закреплённое',
    logoUrl: null,
    isVerified: true,
    unreadChatCount: 2,
    pinned: true,
    sortAt: '2026-07-01T10:00:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Более раннее',
    logoUrl: null,
    isVerified: false,
    unreadChatCount: 0,
    pinned: false,
    sortAt: '2026-07-16T10:00:00.000Z',
  },
];

describe('community directory service', () => {
  it('keeps pinned memberships first and continues with an opaque keyset cursor', async () => {
    const service = createCommunityDirectoryService({
      listMemberships: ({ limit, after }) =>
        Promise.resolve(paginateCommunityDirectoryItems(items, limit, after)),
    });

    const first = await service.listMemberships({
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      correlationId: 'community-page-test',
      limit: 2,
    });
    expect(first.items.map((item) => item.title)).toEqual(['Закреплённое', 'Недавнее']);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items[0]?.route).toBe('/communities/22222222-2222-4222-8222-222222222222');

    const second = await service.listMemberships({
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      correlationId: 'community-page-test',
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((item) => item.title)).toEqual(['Более раннее']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('rejects a malformed cursor without querying a different source', async () => {
    const service = createCommunityDirectoryService({
      listMemberships: ({ limit, after }) =>
        Promise.resolve(paginateCommunityDirectoryItems(items, limit, after)),
    });
    await expect(
      service.listMemberships({
        tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        correlationId: 'community-page-test',
        limit: 20,
        cursor: 'not-a-cursor-value',
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommunityDirectoryError>>({
        code: 'COMMUNITY_CURSOR_INVALID',
      }),
    );
  });
});
