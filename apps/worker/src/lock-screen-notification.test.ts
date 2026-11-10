import { describe, expect, it } from 'vitest';

import {
  LOCK_SCREEN_FALLBACK_BODY,
  LOCK_SCREEN_TYPE_TEXT,
  lockScreenTitle,
  lockScreenTypeText,
} from './lock-screen-notification.js';

describe('lock-screen copy', () => {
  it('uses the template headline that is safe to show on a locked device', () => {
    expect(
      lockScreenTitle({
        titleTemplate: 'Напоминание о записи',
        renderedTitle: 'Напоминание о записи',
      }),
    ).toBe('Напоминание о записи');
  });

  it('drops a headline that interpolates event data', () => {
    expect(
      lockScreenTitle({
        titleTemplate: 'Игра {{locationName}}',
        renderedTitle: 'Игра на Селигерской',
      }),
    ).toBeUndefined();
  });

  it('collapses control characters and rejects empty or oversized headlines', () => {
    expect(lockScreenTitle({ titleTemplate: 'Заголовок', renderedTitle: '  Две\nстроки  ' })).toBe(
      'Две строки',
    );
    expect(lockScreenTitle({ titleTemplate: 'Заголовок', renderedTitle: '   ' })).toBeUndefined();
    expect(
      lockScreenTitle({ titleTemplate: 'Заголовок', renderedTitle: 'a'.repeat(121) }),
    ).toBeUndefined();
    expect(lockScreenTitle({ titleTemplate: null, renderedTitle: 'Заголовок' })).toBeUndefined();
  });

  it.each([
    ['BOOKING', 'Не пропусти занятие'],
    ['GAME', 'Не пропусти игру'],
    ['MESSAGING', 'Новое сообщение в чате'],
    ['FRIENDSHIP', 'Новая заявка в друзья'],
    ['ADMIN_MESSAGE', 'Оповещение ПадлХАБ'],
  ])('shows the %s type line', (category, expected) => {
    expect(lockScreenTypeText(category)).toBe(expected);
  });

  it('falls back to the generic line for a missing or unknown category', () => {
    expect(lockScreenTypeText(null)).toBe(LOCK_SCREEN_FALLBACK_BODY);
    expect(lockScreenTypeText(undefined)).toBe(LOCK_SCREEN_FALLBACK_BODY);
    expect(lockScreenTypeText('UNKNOWN_FUTURE_CATEGORY')).toBe(LOCK_SCREEN_FALLBACK_BODY);
  });

  it('keeps every type line short and free of placeholders', () => {
    for (const text of Object.values(LOCK_SCREEN_TYPE_TEXT)) {
      expect(text).not.toContain('{{');
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(80);
    }
  });
});
