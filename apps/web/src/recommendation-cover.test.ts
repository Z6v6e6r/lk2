import { describe, expect, it } from 'vitest';

import { recommendationCover } from './recommendation-cover.js';

describe('Skolkovo recommendation covers', () => {
  it.each([
    ['GAME', 'game'],
    ['COACH_GAME', 'coach-game'],
    ['TRAINING', 'training'],
    ['TOURNAMENT', 'tournament'],
  ] as const)('selects a stable %s cover only for Skolkovo', (kind, file) => {
    const first = recommendationCover('Сколково', kind, 'event-123', 'fallback.webp');
    expect(first).toMatch(new RegExp(`/skolkovo/${file}-\\d\\.webp$`));
    expect(recommendationCover('Сколково', kind, 'event-123', 'fallback.webp')).toBe(first);
    expect(recommendationCover('Нагатинская Премиум', kind, 'event-123', 'fallback.webp')).toBe(
      'fallback.webp',
    );
    expect(recommendationCover('Питер', kind, 'event-123', 'fallback.webp')).toBe('fallback.webp');
  });
});
