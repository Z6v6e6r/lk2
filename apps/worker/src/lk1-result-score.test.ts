import { describe, expect, it } from 'vitest';

import { lk1ScoreFromSets } from './lk1-result-score.js';

function teams() {
  return {
    teamAUserIds: [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ] as [string, string],
    teamBUserIds: [
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
    ] as [string, string],
  };
}

describe('LK1 score from LK2 sets', () => {
  it('passes a single set through unchanged', () => {
    expect(lk1ScoreFromSets([{ setNumber: 1, ...teams(), teamA: 6, teamB: 4 }])).toEqual({
      scoreA: 6,
      scoreB: 4,
    });
  });

  it('maps a multi-set result to sets won, which is the score LK1 shows', () => {
    expect(
      lk1ScoreFromSets([
        { setNumber: 1, ...teams(), teamA: 6, teamB: 4 },
        { setNumber: 2, ...teams(), teamA: 7, teamB: 6 },
      ]),
    ).toEqual({ scoreA: 2, scoreB: 0 });
  });

  it('keeps the point difference when sets are level', () => {
    expect(
      lk1ScoreFromSets([
        { setNumber: 1, ...teams(), teamA: 6, teamB: 4 },
        { setNumber: 2, ...teams(), teamA: 3, teamB: 6 },
      ]),
    ).toEqual({ scoreA: 9, scoreB: 10 });
  });

  it('reports no score when there is nothing to publish', () => {
    expect(lk1ScoreFromSets([])).toBeUndefined();
    expect(
      lk1ScoreFromSets([{ setNumber: 1, ...teams(), teamA: Number.NaN, teamB: 4 }]),
    ).toBeUndefined();
    expect(lk1ScoreFromSets([{ setNumber: 1, ...teams(), teamA: -1, teamB: 4 }])).toBeUndefined();
  });
});
