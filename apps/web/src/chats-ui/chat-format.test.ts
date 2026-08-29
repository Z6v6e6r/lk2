import { describe, expect, it } from 'vitest';

import {
  formatConversationTimestamp,
  formatMessageDay,
  safeGameHref,
  unreadLabel,
} from './chat-format.js';

describe('chat formatting', () => {
  const now = new Date('2026-08-29T15:40:00');

  it('formats today, yesterday, recent days, and older dates for ru-RU', () => {
    expect(formatConversationTimestamp('2026-08-29T11:32:00', now)).toBe('11:32');
    expect(formatConversationTimestamp('2026-08-28T11:32:00', now)).toBe('Вчера');
    expect(formatConversationTimestamp('2026-08-26T11:32:00', now)).toMatch(/ср/u);
    expect(formatConversationTimestamp('2026-07-26T11:32:00', now)).toMatch(/26 июл/u);
    expect(formatMessageDay('2026-08-29T11:32:00', now)).toBe('Сегодня');
  });

  it('caps unread labels without hiding the accessible source count', () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(1)).toBe('1');
    expect(unreadLabel(99)).toBe('99');
    expect(unreadLabel(100)).toBe('99+');
  });

  it('builds a game link only from a valid context UUID', () => {
    expect(safeGameHref('11111111-1111-4111-8111-111111111111')).toBe(
      '/games/11111111-1111-4111-8111-111111111111',
    );
    expect(safeGameHref('not-a-game')).toBeNull();
    expect(safeGameHref(undefined)).toBeNull();
  });
});
