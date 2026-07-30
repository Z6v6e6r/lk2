import coachPurple from './assets/booking-card-backgrounds/coach-purple.webp';
import gameLime from './assets/booking-card-backgrounds/game-lime-soft.webp';
import tournamentCoral from './assets/booking-card-backgrounds/tournament-coral.webp';
import trainingBlue from './assets/booking-card-backgrounds/training-blue.webp';

export type BookingCardBackgroundKind = 'GAME' | 'COACH_GAME' | 'TOURNAMENT' | 'TRAINING';
export type BookingCardBackgroundTone = 'game' | 'coach-game' | 'tournament' | 'training';

interface BookingCardBackgroundGroup {
  readonly images: readonly string[];
  readonly tone: BookingCardBackgroundTone;
}

export interface BookingCardBackground {
  readonly image: string;
  readonly tone: BookingCardBackgroundTone;
  readonly variant: number;
  readonly variantCount: number;
}

const backgroundGroups: Readonly<Record<BookingCardBackgroundKind, BookingCardBackgroundGroup>> = {
  GAME: {
    images: [gameLime],
    tone: 'game',
  },
  COACH_GAME: {
    images: [coachPurple],
    tone: 'coach-game',
  },
  TOURNAMENT: {
    images: [tournamentCoral],
    tone: 'tournament',
  },
  TRAINING: {
    images: [trainingBlue],
    tone: 'training',
  },
};

function stableHash(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Выбирает фон детерминированно внутри категории, чтобы оформление не менялось
 * при повторном рендере или обновлении страницы.
 */
export function bookingCardBackground(
  kind: BookingCardBackgroundKind,
  seed: string,
): BookingCardBackground {
  const group = backgroundGroups[kind];
  const variant = stableHash(seed) % group.images.length;

  return {
    image: group.images[variant]!,
    tone: group.tone,
    variant,
    variantCount: group.images.length,
  };
}
