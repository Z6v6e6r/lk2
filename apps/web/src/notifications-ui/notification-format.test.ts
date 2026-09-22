import { describe, expect, it } from 'vitest';

import type { ConversationSummary } from '../auth-gateway.js';
import type { NotificationItem } from './notification-format.js';
import {
  formatNotificationTime,
  groupNotifications,
  notificationCategory,
  notificationFilters,
  notificationGroupPresentation,
  notificationGroupsForFilter,
  pluralRu,
  safeNotificationDeepLink,
} from './notification-format.js';

function notification(overrides: Partial<NotificationItem> & { readonly id: string }) {
  return {
    category: 'MESSAGING',
    title: 'Новое сообщение',
    body: 'Откройте чат в ПадлХАБ, чтобы прочитать сообщение.',
    createdAt: '2026-09-20T10:00:00+03:00',
    ...overrides,
  } satisfies NotificationItem;
}

const conversationId = '22222222-2222-4222-8222-222222222222';

const conversation: ConversationSummary = {
  id: conversationId,
  kind: 'DIRECT',
  participant: { userId: '77777777-7777-4777-8777-777777777777', displayName: 'Мария Соколова' },
  unreadCount: 3,
  updatedAt: '2026-09-20T10:05:00+03:00',
  lastMessage: {
    sequence: 12,
    body: 'Кто идёт на выходных?',
    createdAt: '2026-09-20T10:05:00+03:00',
  },
};

describe('notification presentation mapping', () => {
  it('maps only observed categories and keeps unknown categories neutral', () => {
    expect(notificationCategory('GAME')).toMatchObject({ filter: 'GAME', categoryLabel: 'Игра' });
    expect(notificationCategory('ADMIN_MESSAGE')).toMatchObject({
      filter: 'SYSTEM',
      categoryLabel: 'Системное',
      markerKind: 'brand',
    });
    expect(notificationCategory('FRIENDSHIP')).toMatchObject({
      filter: 'FRIENDSHIP',
      categoryLabel: 'Друзья',
    });
    expect(notificationCategory('FUTURE_CATEGORY')).toMatchObject({
      filter: null,
      categoryLabel: 'Событие',
      tone: 'neutral',
    });
  });

  it('derives filter buttons from categories actually present on the loaded page', () => {
    const filters = notificationFilters([
      notification({ id: '11111111-1111-4111-8111-111111111111', category: 'GAME', title: 'Игра' }),
      notification({
        id: '22222222-2222-4222-8222-222222222222',
        category: 'FUTURE_CATEGORY',
        title: 'Будущее событие',
      }),
    ]);
    expect(filters).toEqual([
      { value: 'ALL', label: 'Все' },
      { value: 'GAME', label: 'Игры' },
    ]);

    expect(
      notificationFilters([
        notification({
          id: '33333333-3333-4333-8333-333333333333',
          category: 'FRIENDSHIP',
          title: 'Заявка в друзья',
          body: 'Откройте ПадлХАБ, чтобы ответить.',
        }),
      ]),
    ).toEqual([
      { value: 'ALL', label: 'Все' },
      { value: 'FRIENDSHIP', label: 'Друзья' },
    ]);
  });

  it('keeps deep links internal and formats relative time', () => {
    expect(safeNotificationDeepLink('/games/123')).toBe('/games/123');
    expect(safeNotificationDeepLink('/games/123?tab=chat#message-1')).toBe(
      '/games/123?tab=chat#message-1',
    );
    expect(safeNotificationDeepLink('//evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('https://evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/games\\evil')).toBe('/notifications');
    expect(safeNotificationDeepLink('/\t/evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/\n/evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/\r/evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/%09/evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/%0a/evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/%0d/evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/%5c%5cevil.example/path')).toBe('/notifications');
    expect(
      formatNotificationTime('2026-08-29T10:35:00+03:00', new Date('2026-08-29T10:40:00+03:00')),
    ).toBe('5 мин назад');
  });

  it('pluralises Russian counts like the rest of the shell', () => {
    expect(pluralRu(1, 'сообщение', 'сообщения', 'сообщений')).toBe('сообщение');
    expect(pluralRu(3, 'сообщение', 'сообщения', 'сообщений')).toBe('сообщения');
    expect(pluralRu(11, 'сообщение', 'сообщения', 'сообщений')).toBe('сообщений');
    expect(pluralRu(21, 'сообщение', 'сообщения', 'сообщений')).toBe('сообщение');
  });
});

describe('notification grouping', () => {
  it('collapses every event that opens one chat into a single row', () => {
    const groups = groupNotifications([
      notification({
        id: '11111111-1111-4111-8111-111111111111',
        deepLink: `/chats/${conversationId}`,
        createdAt: '2026-09-20T10:00:00+03:00',
        readAt: '2026-09-20T10:01:00+03:00',
      }),
      notification({
        id: '22222222-2222-4222-8222-222222222222',
        deepLink: `/chats/${conversationId}`,
        createdAt: '2026-09-20T09:00:00+03:00',
      }),
      notification({
        id: '33333333-3333-4333-8333-333333333333',
        deepLink: '/profile',
        category: 'ADMIN_MESSAGE',
        createdAt: '2026-09-20T08:00:00+03:00',
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: `conversation:${conversationId}`,
      kind: 'conversation',
      sourceId: conversationId,
    });
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(groups[1]).toMatchObject({ kind: 'single' });
  });

  it('groups one game card and the bookings screen, and keeps unknown links apart', () => {
    const gameId = '44444444-4444-4444-8444-444444444444';
    const groups = groupNotifications([
      notification({
        id: '11111111-1111-4111-8111-111111111111',
        category: 'GAME',
        deepLink: `/games/${gameId}`,
      }),
      notification({
        id: '22222222-2222-4222-8222-222222222222',
        category: 'BOOKING',
        deepLink: '/bookings',
      }),
      notification({
        id: '33333333-3333-4333-8333-333333333333',
        category: 'BOOKING_REMINDER',
        deepLink: '/bookings',
      }),
      notification({
        id: '55555555-5555-4555-8555-555555555555',
        category: 'FUTURE_CATEGORY',
        deepLink: 'https://evil.example/path',
      }),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['game', 'bookings', 'single']);
    expect(groups[1]?.items).toHaveLength(2);
    expect(notificationGroupPresentation(groups[2]!, undefined).href).toBe('/notifications');
  });

  it('reads a grouped chat row from the conversation summary', () => {
    const groups = groupNotifications([
      notification({
        id: '11111111-1111-4111-8111-111111111111',
        deepLink: `/chats/${conversationId}`,
      }),
    ]);
    const presentation = notificationGroupPresentation(groups[0]!, conversation);

    expect(presentation).toMatchObject({
      kind: 'conversation',
      title: 'Мария Соколова',
      meta: '3 новых сообщения',
      preview: 'Кто идёт на выходных?',
      href: `/chats/${conversationId}`,
      badge: '3',
      unread: true,
    });
  });

  it('falls back to the category label when the conversation summary is missing', () => {
    const groups = groupNotifications([
      notification({
        id: '11111111-1111-4111-8111-111111111111',
        deepLink: `/chats/${conversationId}`,
      }),
    ]);
    const presentation = notificationGroupPresentation(groups[0]!, undefined);

    expect(presentation).toMatchObject({ title: 'Чат', meta: '1 новое сообщение', badge: '1' });
  });

  it('counts grouped events when the conversation itself has nothing unread', () => {
    const groups = groupNotifications([
      notification({
        id: '11111111-1111-4111-8111-111111111111',
        deepLink: `/chats/${conversationId}`,
      }),
    ]);
    const quietConversation: ConversationSummary = {
      id: conversation.id,
      kind: 'DIRECT',
      participant: conversation.participant,
      unreadCount: 0,
      updatedAt: conversation.updatedAt,
    };
    const presentation = notificationGroupPresentation(groups[0]!, quietConversation);

    expect(presentation).toMatchObject({
      meta: '1 новое сообщение',
      preview: 'Откройте чат в ПадлХАБ, чтобы прочитать сообщение.',
    });
  });

  it('keeps the filter working on grouped rows', () => {
    const groups = groupNotifications([
      notification({
        id: '11111111-1111-4111-8111-111111111111',
        deepLink: `/chats/${conversationId}`,
      }),
      notification({
        id: '22222222-2222-4222-8222-222222222222',
        category: 'ADMIN_MESSAGE',
        deepLink: '/profile',
      }),
    ]);

    expect(notificationGroupsForFilter(groups, 'MESSAGING')).toHaveLength(1);
    expect(notificationGroupsForFilter(groups, 'SYSTEM')).toHaveLength(1);
    expect(notificationGroupsForFilter(groups, 'FRIENDSHIP')).toHaveLength(0);
    expect(notificationGroupsForFilter(groups, 'ALL')).toHaveLength(2);
  });
});
