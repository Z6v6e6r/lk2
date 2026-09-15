import nagatinskayaCover from './assets/recommendation-cards/nagatinskaya/default.webp';
import np_game_1 from './assets/recommendation-cards/nagatinskaya-premium/game-1.webp';
import np_game_2 from './assets/recommendation-cards/nagatinskaya-premium/game-2.webp';
import np_game_3 from './assets/recommendation-cards/nagatinskaya-premium/game-3.webp';
import np_game_4 from './assets/recommendation-cards/nagatinskaya-premium/game-4.webp';
import np_game_5 from './assets/recommendation-cards/nagatinskaya-premium/game-5.webp';
import np_game_6 from './assets/recommendation-cards/nagatinskaya-premium/game-6.webp';
import np_training_1 from './assets/recommendation-cards/nagatinskaya-premium/training-1.webp';
import np_training_2 from './assets/recommendation-cards/nagatinskaya-premium/training-2.webp';
import np_tournament_1 from './assets/recommendation-cards/nagatinskaya-premium/tournament-1.webp';
import np_coach_game_1 from './assets/recommendation-cards/nagatinskaya-premium/coach-game-1.webp';
import game_1 from './assets/recommendation-cards/skolkovo/game-1.webp';
import game_2 from './assets/recommendation-cards/skolkovo/game-2.webp';
import game_3 from './assets/recommendation-cards/skolkovo/game-3.webp';
import training_1 from './assets/recommendation-cards/skolkovo/training-1.webp';
import training_2 from './assets/recommendation-cards/skolkovo/training-2.webp';
import training_3 from './assets/recommendation-cards/skolkovo/training-3.webp';
import game_4 from './assets/recommendation-cards/skolkovo/game-4.webp';
import tournament_1 from './assets/recommendation-cards/skolkovo/tournament-1.webp';
import coach_game_1 from './assets/recommendation-cards/skolkovo/coach-game-1.webp';
import coach_game_2 from './assets/recommendation-cards/skolkovo/coach-game-2.webp';

const covers = {
  GAME: [game_1, game_2, game_3, game_4],
  COACH_GAME: [coach_game_1, coach_game_2],
  TRAINING: [training_1, training_2, training_3],
  TOURNAMENT: [tournament_1],
} as const;

const nagatinskayaPremiumCovers = {
  GAME: [np_game_1, np_game_2, np_game_3, np_game_4, np_game_5, np_game_6],
  COACH_GAME: [np_coach_game_1],
  TRAINING: [np_training_1, np_training_2],
  TOURNAMENT: [np_tournament_1],
} as const;

export function recommendationCover(
  stationName: string,
  kind: keyof typeof covers,
  eventId: string,
  fallback: string,
): string {
  // Temporary presentation mapping until station cover settings expose media IDs.
  const station = stationName.trim().toLocaleLowerCase('ru-RU');
  if (station === 'нагатинская') return nagatinskayaCover;
  const stationCovers =
    station === 'нагатинская премиум'
      ? nagatinskayaPremiumCovers
      : station === 'сколково' || station === 'падел сколково'
        ? covers
        : undefined;
  if (!stationCovers) return fallback;
  const images = stationCovers[kind];
  let hash = 0;
  for (const char of eventId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return images[hash % images.length] ?? fallback;
}
