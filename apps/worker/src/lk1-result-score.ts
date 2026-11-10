import type { GameResultSetInput } from '@phub/games';

export interface Lk1Score {
  readonly scoreA: number;
  readonly scoreB: number;
}

/**
 * LK1 stores one score per game and has no notion of sets. A single LK2 set maps directly; a
 * multi-set result maps to sets won, which is the match score LK1 shows and rates. When sets are
 * level the total points keep the ordering LK1 would otherwise lose, so a 1:1 in sets with 12:10
 * points still reaches LK1 as an explicit score.
 */
export function lk1ScoreFromSets(sets: readonly GameResultSetInput[]): Lk1Score | undefined {
  const scored = sets.filter(
    (set) =>
      Number.isInteger(set.teamA) &&
      Number.isInteger(set.teamB) &&
      set.teamA >= 0 &&
      set.teamB >= 0,
  );
  if (scored.length === 0) return undefined;
  if (scored.length === 1) {
    return { scoreA: scored[0]!.teamA, scoreB: scored[0]!.teamB };
  }
  const setsWonA = scored.filter((set) => set.teamA > set.teamB).length;
  const setsWonB = scored.filter((set) => set.teamB > set.teamA).length;
  if (setsWonA !== setsWonB) return { scoreA: setsWonA, scoreB: setsWonB };
  return {
    scoreA: scored.reduce((total, set) => total + set.teamA, 0),
    scoreB: scored.reduce((total, set) => total + set.teamB, 0),
  };
}
