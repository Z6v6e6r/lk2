import { describe, expect, it } from 'vitest';

import {
  evaluateLevelEligibility,
  levelResultAllowsParticipation,
  type LevelEligibilityContext,
  type LevelEligibilityPolicy,
} from './participation-eligibility.js';

const policy: LevelEligibilityPolicy = {
  mode: 'BLOCK',
  lowerToleranceSteps: 1,
  upperToleranceSteps: 2,
  missingActivityConstraintAction: 'WARN',
  legacyTextConstraintAction: 'WARN',
  version: 4,
};

function context(overrides: Partial<LevelEligibilityContext> = {}): LevelEligibilityContext {
  return {
    action: 'JOIN',
    activityType: 'GAME',
    activityId: 'game-1',
    sportId: 'padel',
    playerId: 'player-1',
    playerLevel: {
      playerId: 'player-1',
      sportId: 'padel',
      levelId: 'c-plus',
      rank: 4,
      source: 'CALCULATED',
      scaleVersion: 2,
    },
    activityLevelConstraint: {
      mode: 'RANGE',
      minLevelId: 'b',
      maxLevelId: 'b-plus',
      minRank: 5,
      maxRank: 6,
      source: 'CANONICAL',
      dataQuality: 'VALID',
      scaleVersion: 2,
    },
    ...overrides,
  };
}

describe('evaluateLevelEligibility', () => {
  it('uses inclusive canonical rank boundaries and asymmetric tolerance', () => {
    const lower = evaluateLevelEligibility(context(), policy);
    const upper = evaluateLevelEligibility(
      context({ playerLevel: { ...context().playerLevel!, rank: 8 } }),
      policy,
    );
    expect(lower.outcome).toBe('PASS');
    expect(lower.reasonCode).toBe('LEVEL_ALLOWED');
    expect(upper.outcome).toBe('PASS');
    expect(
      evaluateLevelEligibility(
        context({ playerLevel: { ...context().playerLevel!, rank: 3 } }),
        policy,
      ).reasonCode,
    ).toBe('LEVEL_NOT_ALLOWED');
  });

  it.each([
    ['OFF', 'SKIP'],
    ['SHADOW', 'PASS'],
    ['WARN', 'WARN'],
    ['BLOCK', 'FAIL'],
  ] as const)('applies %s rollout semantics', (mode, outcome) => {
    const actual = evaluateLevelEligibility(
      context({ playerLevel: { ...context().playerLevel!, rank: 1 } }),
      { ...policy, mode },
    );
    expect(actual.outcome).toBe(outcome);
    expect(levelResultAllowsParticipation(actual)).toBe(mode !== 'BLOCK');
  });

  it('keeps missing and unreadable player levels distinct', () => {
    expect(evaluateLevelEligibility(context({ playerLevel: null }), policy).reasonCode).toBe(
      'PLAYER_LEVEL_REQUIRED',
    );
    expect(
      evaluateLevelEligibility(context({ playerLevel: null, playerLevelUnknown: true }), policy)
        .reasonCode,
    ).toBe('PLAYER_LEVEL_UNKNOWN');
  });

  it('lets only a server-validated personal invitation bypass the level rule', () => {
    const actual = evaluateLevelEligibility(
      context({ playerLevel: null, validPersonalInvitationId: 'invite-1' }),
      policy,
    );
    expect(actual).toMatchObject({ outcome: 'BYPASS', reasonCode: 'PERSONAL_INVITE_BYPASS' });
    expect(evaluateLevelEligibility(context({ playerLevel: null }), policy).outcome).toBe('FAIL');
  });

  it('limits organizer bypass to creation actions', () => {
    expect(
      evaluateLevelEligibility(
        context({ action: 'CREATE_ACTIVITY', actorIsOrganizer: true, playerLevel: null }),
        policy,
      ).reasonCode,
    ).toBe('ORGANIZER_CREATION_BYPASS');
    expect(
      evaluateLevelEligibility(
        context({ action: 'JOIN', actorIsOrganizer: true, playerLevel: null }),
        policy,
      ).reasonCode,
    ).toBe('PLAYER_LEVEL_REQUIRED');
  });

  it('never hard-blocks a legacy text fallback', () => {
    const actual = evaluateLevelEligibility(
      context({
        activityLevelConstraint: {
          mode: 'RANGE',
          minRank: 5,
          maxRank: 6,
          source: 'LEGACY_TEXT_FALLBACK',
          dataQuality: 'LEGACY',
        },
      }),
      policy,
    );
    expect(actual).toMatchObject({ outcome: 'WARN', reasonCode: 'LEGACY_LEVEL_CONSTRAINT' });
  });

  it('fails closed for invalid policy, sport/scale mismatch and inverted range', () => {
    expect(
      evaluateLevelEligibility(context(), { ...policy, lowerToleranceSteps: -1 }).reasonCode,
    ).toBe('LEVEL_POLICY_MISCONFIGURED');
    expect(
      evaluateLevelEligibility(
        context({ playerLevel: { ...context().playerLevel!, sportId: 'tennis' } }),
        policy,
      ).reasonCode,
    ).toBe('LEVEL_SPORT_MISMATCH');
    expect(
      evaluateLevelEligibility(
        context({ playerLevel: { ...context().playerLevel!, scaleVersion: 3 } }),
        policy,
      ).reasonCode,
    ).toBe('LEVEL_SCALE_VERSION_MISMATCH');
    expect(
      evaluateLevelEligibility(
        context({
          activityLevelConstraint: {
            mode: 'RANGE',
            minRank: 7,
            maxRank: 2,
            source: 'CANONICAL',
            dataQuality: 'INVALID',
          },
        }),
        policy,
      ).reasonCode,
    ).toBe('ACTIVITY_LEVEL_INVALID');
  });
});
