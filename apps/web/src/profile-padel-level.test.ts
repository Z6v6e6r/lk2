import type { PlayerLevelState, PlayerSportLevel } from '@phub/api-sdk';
import { describe, expect, it } from 'vitest';

import { confirmedPadelProfileLevel } from './profile-padel-level.js';

const viewerId = 'synthetic-viewer';
const projectedLevel: PlayerSportLevel = {
  playerId: viewerId,
  sportCode: 'PADEL',
  levelId: 'fixture-level',
  code: 'B+',
  title: 'B+',
  rank: 60,
  source: 'CALCULATED',
  numericValue: 4.70001,
  scaleVersion: 1,
  updatedAt: '2026-11-25T00:00:00.000Z',
};
const state: PlayerLevelState = {
  sportCode: 'PADEL',
  scaleVersion: 1,
  levels: [],
  currentLevel: projectedLevel,
  projectionStatus: 'PROJECTED',
};

describe('web PADEL profile display', () => {
  it.each(['CALCULATED', 'MANUAL', 'MIGRATED', 'VIVA'] as const)(
    'keeps the confirmed CUP grade and exact score for %s provenance',
    (source) => {
      expect(
        confirmedPadelProfileLevel(
          { ...state, currentLevel: { ...projectedLevel, source } },
          viewerId,
        ),
      ).toEqual({ label: 'B+', value: 4.70001, assessmentRequired: false });
    },
  );

  it.each([
    { ...state, projectionStatus: 'PENDING' },
    { sportCode: 'PADEL', scaleVersion: 1, levels: [], currentLevel: projectedLevel },
    { ...state, currentLevel: null },
    { ...state, sportCode: 'TENNIS' },
    { ...state, currentLevel: { ...projectedLevel, sportCode: 'TENNIS' } },
    { ...state, currentLevel: { ...projectedLevel, playerId: 'another-player' } },
    { ...state, currentLevel: { ...projectedLevel, source: 'SELF_DECLARED' } },
    { ...state, currentLevel: { ...projectedLevel, code: 'D' } },
    { ...state, currentLevel: { ...projectedLevel, numericValue: null } },
    { ...state, currentLevel: { ...projectedLevel, numericValue: Number.NaN } },
    { ...state, currentLevel: { ...projectedLevel, numericValue: 8 } },
  ] satisfies PlayerLevelState[])('omits invalid or unconfirmed projections (%#)', (input) => {
    expect(confirmedPadelProfileLevel(input, viewerId)).toBeNull();
  });
});
