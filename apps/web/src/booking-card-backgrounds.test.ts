import { describe, expect, it } from 'vitest';

import {
  bookingCardBackground,
  type BookingCardBackgroundKind,
  type BookingCardBackgroundTone,
} from './booking-card-backgrounds.js';

describe('booking card backgrounds', () => {
  it.each<[BookingCardBackgroundKind, BookingCardBackgroundTone, string]>([
    ['GAME', 'game', 'game-lime-soft.webp'],
    ['COACH_GAME', 'coach-game', 'coach-purple.webp'],
    ['TOURNAMENT', 'tournament', 'tournament-coral.webp'],
    ['TRAINING', 'training', 'training-blue.webp'],
  ])('maps %s cards to the expected new background', (kind, tone, assetName) => {
    const background = bookingCardBackground(kind, `${kind}-card-id`);

    expect(background.tone).toBe(tone);
    expect(background.variantCount).toBe(1);
    expect(background.variant).toBe(0);
    expect(background.image).toContain(assetName);
  });

  it('keeps the chosen variant stable for the same card', () => {
    expect(bookingCardBackground('GAME', 'game-123')).toEqual(
      bookingCardBackground('GAME', 'game-123'),
    );
  });
});
