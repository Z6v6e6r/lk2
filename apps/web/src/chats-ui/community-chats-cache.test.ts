// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCommunityChatsCache,
  communityChatsCacheKey,
  readCommunityChatsCache,
  writeCommunityChatsCache,
} from './community-chats-cache.js';
import type { CommunityRow } from './community-chat-rows.js';

const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function community(id: string, title: string, unreadChatCount = 0): CommunityRow {
  return {
    id,
    title,
    logoUrl: null,
    isVerified: false,
    unreadChatCount,
    route: `/communities/${id}`,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('community directory cache', () => {
  it('round-trips the rows and the cursor of the last read', () => {
    writeCommunityChatsCache(userId, [community('1', 'Клуб на Соколе', 2)], 'cursor-1');

    expect(readCommunityChatsCache(userId)).toEqual({
      communities: [community('1', 'Клуб на Соколе', 2)],
      nextCursor: 'cursor-1',
    });
  });

  it('keeps the cache per user', () => {
    writeCommunityChatsCache(userId, [community('1', 'Клуб на Соколе')], null);

    expect(readCommunityChatsCache('another-user')).toBeNull();
  });

  it('treats a corrupted or foreign payload as absent', () => {
    window.sessionStorage.setItem(communityChatsCacheKey(userId), '{not json');
    expect(readCommunityChatsCache(userId)).toBeNull();

    window.sessionStorage.setItem(
      communityChatsCacheKey(userId),
      JSON.stringify({
        communities: [{ id: '1', title: 'Без остальных полей' }],
        nextCursor: null,
      }),
    );
    expect(readCommunityChatsCache(userId)).toBeNull();

    window.sessionStorage.setItem(
      communityChatsCacheKey(userId),
      JSON.stringify({ communities: [], nextCursor: 42 }),
    );
    expect(readCommunityChatsCache(userId)).toBeNull();
  });

  it('never caches more than one published directory page', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      community(`${index}`, `Сообщество ${index}`),
    );

    writeCommunityChatsCache(userId, rows, null);

    expect(readCommunityChatsCache(userId)?.communities).toHaveLength(50);
  });

  it('drops the whole copy when the payload cannot be trusted as a directory', () => {
    const oversized = Array.from({ length: 50 }, (_, index) =>
      community(`${index}`, 'я'.repeat(1_000)),
    );

    writeCommunityChatsCache(userId, oversized, null);

    expect(readCommunityChatsCache(userId)).toBeNull();
  });

  it('clears the copy for one user only', () => {
    writeCommunityChatsCache(userId, [community('1', 'Клуб на Соколе')], null);
    writeCommunityChatsCache('other-user', [community('2', 'Другой клуб')], null);

    clearCommunityChatsCache(userId);

    expect(readCommunityChatsCache(userId)).toBeNull();
    expect(readCommunityChatsCache('other-user')).not.toBeNull();
  });

  it('works without a storage at all', () => {
    expect(readCommunityChatsCache(userId, null)).toBeNull();
    expect(() =>
      writeCommunityChatsCache(userId, [community('1', 'Клуб')], null, null),
    ).not.toThrow();
    expect(() => clearCommunityChatsCache(userId, null)).not.toThrow();
  });
});
