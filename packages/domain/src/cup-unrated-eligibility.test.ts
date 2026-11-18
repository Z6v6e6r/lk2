/**
 * QA scenario 2 — CUP caller with NO rating / NO player level.
 *
 * Real rule (verified): tournament (CUP) registration is gated pre-dispatch by
 * `participation-level-gate.ts`, which delegates to the canonical pure rule
 * `evaluateLevelEligibility()` in this package. A player without a rating arrives as
 * `playerLevel: null` (no projection row) or `playerLevelUnknown: true` (projection present but
 * the fact could not be resolved). Neither case throws and neither is a 500: each maps to a
 * documented reason code, and whether the caller is admitted depends on the configured policy mode.
 *
 * This test pins that documented contract per mode so an unrated CUP caller can never silently
 * acquire an eligibility benefit under an enforcing (BLOCK) policy — and so the permissive modes
 * are explicit decisions rather than an accident.
 */
import { describe, expect, it } from 'vitest';

import {
  ELIGIBILITY_RULE_OUTCOMES,
  evaluateLevelEligibility,
  LEVEL_ELIGIBILITY_MODES,
  LEVEL_ELIGIBILITY_REASON_CODES,
  levelResultAllowsParticipation,
  type ActivityLevelConstraint,
  type LevelEligibilityContext,
  type LevelEligibilityMode,
  type LevelEligibilityPolicy,
} from './participation-eligibility.js';

const SPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const RESTRICTED_RANGE: ActivityLevelConstraint = {
  mode: 'RANGE',
  minLevelId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  maxLevelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  minRank: 4,
  maxRank: 8,
  source: 'LEGACY_TOURNAMENT_SETTINGS',
  dataQuality: 'VALID',
  scaleVersion: 3,
};

function policy(mode: LevelEligibilityMode): LevelEligibilityPolicy {
  return {
    mode,
    lowerToleranceSteps: 0,
    upperToleranceSteps: 0,
    missingActivityConstraintAction: 'BLOCK',
    legacyTextConstraintAction: 'ALLOW',
    version: 7,
  };
}

/** A CUP REGISTER command issued by a player with no rating at all. */
function cupCallerWithoutRating(
  overrides: Partial<LevelEligibilityContext> = {},
): LevelEligibilityContext {
  return {
    action: 'REGISTER',
    activityType: 'TOURNAMENT',
    activityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    sportId: SPORT_ID,
    playerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    playerLevel: null,
    activityLevelConstraint: RESTRICTED_RANGE,
    ...overrides,
  };
}

describe('scenario 2: CUP caller without a rating gets a defined outcome, never a crash', () => {
  it('denies registration under an enforcing BLOCK policy with PLAYER_LEVEL_REQUIRED', () => {
    const result = evaluateLevelEligibility(cupCallerWithoutRating(), policy('BLOCK'));
    expect(result.outcome).toBe('FAIL');
    expect(result.reasonCode).toBe('PLAYER_LEVEL_REQUIRED');
    expect(result.publicMessageKey).toBe('eligibility.player_level_required');
    expect(levelResultAllowsParticipation(result)).toBe(false);
  });

  it('denies registration when the rating exists in no resolvable form (PLAYER_LEVEL_UNKNOWN)', () => {
    const result = evaluateLevelEligibility(
      cupCallerWithoutRating({ playerLevelUnknown: true }),
      policy('BLOCK'),
    );
    expect(result.outcome).toBe('FAIL');
    expect(result.reasonCode).toBe('PLAYER_LEVEL_UNKNOWN');
    expect(levelResultAllowsParticipation(result)).toBe(false);
  });

  it('records the unrated fact without denying while the policy is in SHADOW', () => {
    const result = evaluateLevelEligibility(cupCallerWithoutRating(), policy('SHADOW'));
    expect(result.outcome).toBe('PASS');
    // The reason code is still PLAYER_LEVEL_REQUIRED: the observation is not lost, only not enforced.
    expect(result.reasonCode).toBe('PLAYER_LEVEL_REQUIRED');
  });

  it('warns but does not deny while the policy is in WARN', () => {
    const result = evaluateLevelEligibility(cupCallerWithoutRating(), policy('WARN'));
    expect(result.outcome).toBe('WARN');
    expect(result.reasonCode).toBe('PLAYER_LEVEL_REQUIRED');
    expect(levelResultAllowsParticipation(result)).toBe(true);
  });

  it('returns SKIP under an OFF policy — an explicit, named bypass rather than a silent grant', () => {
    const result = evaluateLevelEligibility(cupCallerWithoutRating(), policy('OFF'));
    expect(result.outcome).toBe('SKIP');
    expect(result.reasonCode).toBe('LEVEL_RULE_DISABLED');
  });

  it.each(LEVEL_ELIGIBILITY_MODES)(
    'produces a documented outcome (no throw, no 500) for every mode: %s',
    (mode) => {
      for (const context of [
        cupCallerWithoutRating(),
        cupCallerWithoutRating({ playerLevelUnknown: true }),
      ]) {
        const result = evaluateLevelEligibility(context, policy(mode));
        expect(ELIGIBILITY_RULE_OUTCOMES).toContain(result.outcome);
        expect(LEVEL_ELIGIBILITY_REASON_CODES).toContain(result.reasonCode);
        expect(result.ruleCode).toBe('LEVEL_RANGE');
      }
    },
  );

  it('never admits an unrated caller to a restricted activity under BLOCK, whatever the entry action', () => {
    for (const action of ['REGISTER', 'BOOK', 'JOIN'] as const) {
      const result = evaluateLevelEligibility(cupCallerWithoutRating({ action }), policy('BLOCK'));
      expect(levelResultAllowsParticipation(result)).toBe(false);
      expect(result.outcome).toBe('FAIL');
    }
  });

  it('still admits an unrated caller when the tournament declares no level restriction', () => {
    const result = evaluateLevelEligibility(
      cupCallerWithoutRating({
        activityLevelConstraint: {
          mode: 'NONE',
          source: 'LEGACY_TOURNAMENT_SETTINGS',
          dataQuality: 'VALID',
        },
      }),
      policy('BLOCK'),
    );
    expect(result.outcome).toBe('PASS');
    expect(result.reasonCode).toBe('ACTIVITY_HAS_NO_LEVEL_RESTRICTION');
  });

  it('rejects a misconfigured policy instead of guessing (LEVEL_POLICY_MISCONFIGURED)', () => {
    const result = evaluateLevelEligibility(cupCallerWithoutRating(), {
      ...policy('BLOCK'),
      version: -1,
    });
    expect(result.outcome).toBe('FAIL');
    expect(result.reasonCode).toBe('LEVEL_POLICY_MISCONFIGURED');
    expect(levelResultAllowsParticipation(result)).toBe(false);
  });
});
