import { describe, expect, it } from 'vitest';

import {
  aggregateCommunityRating,
  COMMUNITY_RATING_DEFAULTS,
  CommunityRatingError,
  communityRatingDecay,
  communityRatingSetPoints,
  PHUB_COMMUNITY_RATING_VERSION,
  rankCommunityRating,
  type CommunityRatingSetFact,
} from './community-rating.js';

const NOW = '2026-09-29T12:00:00.000Z';
const DAY = 86_400_000;

function fact(overrides: Partial<CommunityRatingSetFact> = {}): CommunityRatingSetFact {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    gameId: '22222222-2222-4222-8222-222222222222',
    resultId: '33333333-3333-4333-8333-333333333333',
    setNumber: 1,
    kind: 'RATING',
    outcome: 'WON',
    scoreFor: 6,
    scoreAgainst: 4,
    occurredAt: NOW,
    ...overrides,
  };
}

describe('community rating formula', () => {
  it('pins the formula version the ledger stores with every fact', () => {
    expect(PHUB_COMMUNITY_RATING_VERSION).toBe('phub-community-rating-v1');
    expect(COMMUNITY_RATING_DEFAULTS).toMatchObject({
      halfLifeDays: 60,
      marginFactor: 0.5,
      minimumSets: 3,
      activityWindowDays: 90,
      kindWeights: { RATING: 1, FRIENDLY: 0.5, PRIVATE: 0, COACH_GAME: 0 },
    });
  });

  it('scores a decisive win above a narrow win and a loss below both', () => {
    const narrow = communityRatingSetPoints(fact({ scoreFor: 6, scoreAgainst: 5 }));
    const decisive = communityRatingSetPoints(fact({ scoreFor: 6, scoreAgainst: 0 }));
    const lost = communityRatingSetPoints(fact({ outcome: 'LOST' }));

    expect(narrow).toBeCloseTo(1.083333, 6);
    expect(decisive).toBeCloseTo(1.5, 6);
    expect(lost).toBe(0);
    expect(decisive).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThan(lost);
  });

  it('weights game kinds and ignores unrated ones', () => {
    const rating = communityRatingSetPoints(fact({ kind: 'RATING' }));
    const friendly = communityRatingSetPoints(fact({ kind: 'FRIENDLY' }));
    // Both sides are rounded to the ledger scale, so the ratio is exact only up to that scale.
    expect(Math.abs(rating - friendly * 2)).toBeLessThan(2e-6);
    expect(communityRatingSetPoints(fact({ kind: 'PRIVATE' }))).toBe(0);
    expect(communityRatingSetPoints(fact({ kind: 'COACH_GAME' }))).toBe(0);
  });

  it('rejects facts the canonical result projection could not produce', () => {
    const invalidFacts: readonly Partial<CommunityRatingSetFact>[] = [
      { scoreFor: 6, scoreAgainst: 6 },
      { scoreFor: 100 },
      { scoreFor: -1 },
      { scoreFor: 6.5 },
      { outcome: 'DRAW' as unknown as CommunityRatingSetFact['outcome'] },
      { kind: 'TOURNAMENT' as unknown as CommunityRatingSetFact['kind'] },
      { occurredAt: 'not-a-date' },
      { setNumber: 0 },
      { userId: '' },
    ];
    for (const overrides of invalidFacts) {
      expect(() => communityRatingSetPoints(fact(overrides))).toThrow(CommunityRatingError);
    }
  });

  it('halves a result weight after one half-life and never ages a future result', () => {
    const occurredAt = new Date(Date.parse(NOW) - 60 * DAY).toISOString();
    expect(communityRatingDecay(occurredAt, NOW)).toBeCloseTo(0.5, 10);
    expect(
      communityRatingDecay(new Date(Date.parse(NOW) - 30 * DAY).toISOString(), NOW),
    ).toBeCloseTo(0.5 ** 0.5, 10);
    expect(communityRatingDecay(NOW, NOW)).toBe(1);
    expect(communityRatingDecay(new Date(Date.parse(NOW) + DAY).toISOString(), NOW)).toBe(1);
  });

  it('aggregates a member lifetime score with recency applied at read time', () => {
    const aggregate = aggregateCommunityRating(
      [
        fact({ scoreFor: 6, scoreAgainst: 4, occurredAt: NOW }),
        fact({
          setNumber: 2,
          scoreFor: 6,
          scoreAgainst: 0,
          occurredAt: new Date(Date.parse(NOW) - 60 * DAY).toISOString(),
        }),
      ],
      { now: NOW },
    );

    // 1.166667 at full weight plus 1.5 halved.
    expect(aggregate.score).toBeCloseTo(1.166667 + 0.75, 6);
    expect(aggregate.sets).toBe(2);
    expect(aggregate.lastResultAt).toBe(NOW);
  });

  it('ignores unrated kinds and facts outside an explicit window', () => {
    const aggregate = aggregateCommunityRating(
      [
        fact({ kind: 'PRIVATE' }),
        fact({ kind: 'COACH_GAME' }),
        fact({ occurredAt: new Date(Date.parse(NOW) - 120 * DAY).toISOString() }),
        fact({ setNumber: 3, occurredAt: NOW }),
      ],
      { now: NOW, windowDays: 90 },
    );

    expect(aggregate.sets).toBe(1);
    expect(aggregate.lastResultAt).toBe(NOW);
  });

  it('returns an empty aggregate for a member without rated sets', () => {
    expect(aggregateCommunityRating([], { now: NOW })).toEqual({
      score: 0,
      sets: 0,
      lastResultAt: null,
    });
    expect(
      aggregateCommunityRating([fact({ kind: 'PRIVATE' })], { now: NOW }).lastResultAt,
    ).toBeNull();
  });

  it('places only members with enough recent activity and breaks ties deterministically', () => {
    const active = (userId: string, score: number, sets: number) => ({
      userId,
      aggregate: { score, sets, lastResultAt: NOW },
    });
    const standings = rankCommunityRating([
      active('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 10, 4),
      active('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 10, 4),
      active('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 12, 5),
      active('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 99, 2),
    ]);

    expect(standings.map((standing) => [standing.userId, standing.place])).toEqual([
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1],
      ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2],
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 3],
    ]);
  });

  it('rejects settings that would make a place unpredictable', () => {
    expect(() => communityRatingSetPoints(fact(), { halfLifeDays: 0 })).toThrow(
      CommunityRatingError,
    );
    expect(() => communityRatingSetPoints(fact(), { minimumSets: 0 })).toThrow(
      CommunityRatingError,
    );
    expect(() => aggregateCommunityRating([fact()], { now: NOW, windowDays: 0 })).toThrow(
      CommunityRatingError,
    );
    expect(() => communityRatingDecay('not-a-date', NOW)).toThrow(CommunityRatingError);
  });
});
