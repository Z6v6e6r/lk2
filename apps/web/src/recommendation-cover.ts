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

export function recommendationCover(
  stationName: string,
  kind: keyof typeof covers,
  eventId: string,
  fallback: string,
): string {
  // Temporary presentation mapping until station cover settings expose media IDs.
  const station = stationName.trim().toLocaleLowerCase('ru-RU');
  if (station !== 'сколково' && station !== 'падел сколково') return fallback;
  const images = covers[kind];
  let hash = 0;
  for (const char of eventId) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return images[hash % images.length] ?? fallback;
}
