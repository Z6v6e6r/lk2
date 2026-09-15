import { describe, expect, it } from 'vitest';

import { recommendationCover } from './recommendation-cover.js';

describe.each([
  ['Сколково', 'skolkovo'],
  ['Нагатинская Премиум', 'nagatinskaya-premium'],
])('%s recommendation covers', (station, folder) => {
  it.each([
    ['GAME', 'game'],
    ['COACH_GAME', 'coach-game'],
    ['TRAINING', 'training'],
    ['TOURNAMENT', 'tournament'],
  ] as const)('selects a stable %s cover for the station', (kind, file) => {
    const first = recommendationCover(station, kind, 'event-123', 'fallback.webp');
    expect(first).toMatch(new RegExp(`/${folder}/${file}-\\d\\.webp$`));
    expect(recommendationCover(station, kind, 'event-123', 'fallback.webp')).toBe(first);
    expect(recommendationCover('Питер', kind, 'event-123', 'fallback.webp')).toBe('fallback.webp');
  });
});

it.each(['GAME', 'COACH_GAME', 'TRAINING', 'TOURNAMENT'] as const)(
  'uses the supplied Nagatinskaya cover for %s without matching Premium',
  (kind) => {
    const cover = recommendationCover('  НАГАТИНСКАЯ  ', kind, 'event-123', 'fallback.webp');
    expect(cover).toMatch(/\/nagatinskaya\/default\.webp$/);
    expect(recommendationCover('Нагатинская Премиум', kind, 'event-123', 'fallback.webp')).not.toBe(
      cover,
    );
  },
);
