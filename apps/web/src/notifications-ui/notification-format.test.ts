import { describe, expect, it } from 'vitest';

import {
  formatNotificationTime,
  notificationCategory,
  notificationFilters,
  safeNotificationDeepLink,
} from './notification-format.js';

describe('notification presentation mapping', () => {
  it('maps only observed categories and keeps unknown categories neutral', () => {
    expect(notificationCategory('GAME')).toMatchObject({ filter: 'GAME', categoryLabel: 'Игра' });
    expect(notificationCategory('ADMIN_MESSAGE')).toMatchObject({
      filter: 'SYSTEM',
      categoryLabel: 'Системное',
    });
    expect(notificationCategory('FUTURE_CATEGORY')).toMatchObject({
      filter: null,
      categoryLabel: 'Событие',
      tone: 'neutral',
    });
  });

  it('derives filter buttons from categories actually present on the loaded page', () => {
    const filters = notificationFilters([
      {
        id: '11111111-1111-4111-8111-111111111111',
        category: 'GAME',
        title: 'Игра',
        body: 'Событие игры',
        createdAt: '2026-08-29T10:00:00+03:00',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        category: 'FUTURE_CATEGORY',
        title: 'Будущее событие',
        body: 'Не теряется во Все',
        createdAt: '2026-08-29T10:00:00+03:00',
      },
    ]);
    expect(filters).toEqual([
      { value: 'ALL', label: 'Все' },
      { value: 'GAME', label: 'Игры' },
    ]);
  });

  it('keeps deep links internal and formats relative time', () => {
    expect(safeNotificationDeepLink('/games/123')).toBe('/games/123');
    expect(safeNotificationDeepLink('//evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('https://evil.example/path')).toBe('/notifications');
    expect(safeNotificationDeepLink('/games\\evil')).toBe('/notifications');
    expect(
      formatNotificationTime('2026-08-29T10:35:00+03:00', new Date('2026-08-29T10:40:00+03:00')),
    ).toBe('5 мин назад');
  });
});
