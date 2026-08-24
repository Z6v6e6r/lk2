export const PARTICIPATION_ACTIVITY_TYPES = ['GAME', 'TOURNAMENT', 'TRAINING'] as const;
export type ParticipationActivityType = (typeof PARTICIPATION_ACTIVITY_TYPES)[number];

export const LEVEL_ELIGIBILITY_MODES = ['OFF', 'SHADOW', 'WARN', 'BLOCK'] as const;
export type LevelEligibilityMode = (typeof LEVEL_ELIGIBILITY_MODES)[number];

export const ELIGIBILITY_RULE_OUTCOMES = ['PASS', 'SKIP', 'WARN', 'FAIL', 'BYPASS'] as const;
export type EligibilityRuleOutcome = (typeof ELIGIBILITY_RULE_OUTCOMES)[number];

export const LEVEL_ELIGIBILITY_REASON_CODES = [
  'LEVEL_RULE_DISABLED',
  'LEVEL_ALLOWED',
  'ACTIVITY_HAS_NO_LEVEL_RESTRICTION',
  'PLAYER_LEVEL_REQUIRED',
  'PLAYER_LEVEL_STALE',
  'PLAYER_LEVEL_UNKNOWN',
  'LEVEL_TOO_LOW',
  'LEVEL_TOO_HIGH',
  'LEVEL_NOT_ALLOWED',
  'LEVEL_SPORT_MISMATCH',
  'LEVEL_SCALE_VERSION_MISMATCH',
  'ACTIVITY_LEVEL_UNDEFINED',
  'ACTIVITY_LEVEL_INVALID',
  'LEVEL_POLICY_MISCONFIGURED',
  'POLICY_UNAVAILABLE',
  'PERSONAL_INVITE_BYPASS',
  'ORGANIZER_CREATION_BYPASS',
  'LEGACY_LEVEL_CONSTRAINT',
] as const;
export type LevelEligibilityReasonCode = (typeof LEVEL_ELIGIBILITY_REASON_CODES)[number];

export type ActivityLevelConstraintSource =
  | 'CANONICAL'
  | 'LEGACY_GAME_SETTINGS'
  | 'LEGACY_TOURNAMENT_SETTINGS'
  | 'VIVA_EXERCISE'
  | 'LEGACY_ACCESS_LEVELS'
  | 'LEGACY_TEXT_FALLBACK';

export interface ActivityLevelConstraint {
  readonly mode: 'NONE' | 'RANGE';
  readonly minLevelId?: string;
  readonly maxLevelId?: string;
  readonly minRank?: number;
  readonly maxRank?: number;
  readonly source: ActivityLevelConstraintSource;
  readonly dataQuality: 'VALID' | 'LEGACY' | 'MISSING' | 'INVALID';
  readonly scaleVersion?: number;
}

export interface PlayerSportLevel {
  readonly playerId: string;
  readonly sportId: string;
  readonly levelId: string;
  readonly rank: number;
  readonly source: 'SELF_DECLARED' | 'ONBOARDING' | 'MANUAL' | 'CALCULATED' | 'VIVA' | 'MIGRATED';
  readonly scaleVersion: number;
}

export interface LevelEligibilityPolicy {
  readonly mode: LevelEligibilityMode;
  readonly lowerToleranceSteps: number;
  readonly upperToleranceSteps: number;
  readonly missingActivityConstraintAction: 'ALLOW' | 'WARN' | 'BLOCK';
  readonly legacyTextConstraintAction: 'ALLOW' | 'WARN';
  readonly version: number;
}

export interface LevelEligibilityContext {
  readonly action:
    | 'CREATE_ACTIVITY'
    | 'CREATE_ACTIVITY_WITH_ORGANIZER_PARTICIPATION'
    | 'JOIN'
    | 'JOIN_WAITLIST'
    | 'PROMOTE_WAITLIST'
    | 'BOOK'
    | 'REGISTER'
    | 'ADMIN_ADD';
  readonly activityType: ParticipationActivityType;
  readonly activityId: string;
  readonly sportId: string;
  readonly playerId: string;
  readonly playerLevel?: PlayerSportLevel | null;
  readonly playerLevelStale?: boolean;
  readonly playerLevelUnknown?: boolean;
  readonly activityLevelConstraint: ActivityLevelConstraint;
  readonly validPersonalInvitationId?: string;
  readonly actorIsOrganizer?: boolean;
}

export interface EligibilityRuleResult {
  readonly ruleCode: 'LEVEL_RANGE';
  readonly outcome: EligibilityRuleOutcome;
  readonly reasonCode: LevelEligibilityReasonCode;
  readonly publicMessageKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function result(
  outcome: EligibilityRuleOutcome,
  reasonCode: LevelEligibilityReasonCode,
  metadata?: Readonly<Record<string, unknown>>,
): EligibilityRuleResult {
  return {
    ruleCode: 'LEVEL_RANGE',
    outcome,
    reasonCode,
    publicMessageKey: `eligibility.${reasonCode.toLowerCase()}`,
    ...(metadata ? { metadata } : {}),
  };
}

function nonMatchingOutcome(mode: LevelEligibilityMode): EligibilityRuleOutcome {
  if (mode === 'SHADOW') return 'PASS';
  if (mode === 'WARN') return 'WARN';
  return 'FAIL';
}

function nonMatchingResult(
  mode: LevelEligibilityMode,
  reasonCode: LevelEligibilityReasonCode,
  metadata?: Readonly<Record<string, unknown>>,
): EligibilityRuleResult {
  return result(nonMatchingOutcome(mode), reasonCode, {
    ...(metadata ?? {}),
    ...(mode === 'SHADOW' ? { wouldBlock: true } : {}),
  });
}

function missingConstraint(policy: LevelEligibilityPolicy): EligibilityRuleResult {
  if (policy.missingActivityConstraintAction === 'ALLOW') {
    return result('PASS', 'ACTIVITY_LEVEL_UNDEFINED');
  }
  if (policy.missingActivityConstraintAction === 'WARN') {
    return result('WARN', 'ACTIVITY_LEVEL_UNDEFINED');
  }
  return nonMatchingResult(policy.mode, 'ACTIVITY_LEVEL_UNDEFINED');
}

export function evaluateLevelEligibility(
  context: LevelEligibilityContext,
  policy: LevelEligibilityPolicy,
): EligibilityRuleResult {
  if (
    !Number.isSafeInteger(policy.version) ||
    policy.version < 0 ||
    !Number.isSafeInteger(policy.lowerToleranceSteps) ||
    policy.lowerToleranceSteps < 0 ||
    !Number.isSafeInteger(policy.upperToleranceSteps) ||
    policy.upperToleranceSteps < 0
  ) {
    return result('FAIL', 'LEVEL_POLICY_MISCONFIGURED');
  }
  if (policy.mode === 'OFF') return result('SKIP', 'LEVEL_RULE_DISABLED');
  if (context.activityLevelConstraint.mode === 'NONE') {
    return result('PASS', 'ACTIVITY_HAS_NO_LEVEL_RESTRICTION');
  }
  if (context.validPersonalInvitationId) {
    return result('BYPASS', 'PERSONAL_INVITE_BYPASS', {
      invitationId: context.validPersonalInvitationId,
    });
  }
  if (
    context.actorIsOrganizer &&
    (context.action === 'CREATE_ACTIVITY' ||
      context.action === 'CREATE_ACTIVITY_WITH_ORGANIZER_PARTICIPATION')
  ) {
    return result('BYPASS', 'ORGANIZER_CREATION_BYPASS');
  }
  if (context.playerLevelStale) {
    return nonMatchingResult(policy.mode, 'PLAYER_LEVEL_STALE');
  }
  if (context.playerLevelUnknown) {
    return nonMatchingResult(policy.mode, 'PLAYER_LEVEL_UNKNOWN');
  }
  if (!context.playerLevel) {
    return nonMatchingResult(policy.mode, 'PLAYER_LEVEL_REQUIRED');
  }
  if (context.playerLevel.sportId !== context.sportId) {
    return nonMatchingResult(policy.mode, 'LEVEL_SPORT_MISMATCH');
  }

  const constraint = context.activityLevelConstraint;
  if (
    constraint.dataQuality === 'MISSING' ||
    constraint.minRank === undefined ||
    constraint.maxRank === undefined
  ) {
    return missingConstraint(policy);
  }
  if (
    constraint.dataQuality === 'INVALID' ||
    !Number.isSafeInteger(constraint.minRank) ||
    !Number.isSafeInteger(constraint.maxRank) ||
    constraint.minRank > constraint.maxRank
  ) {
    return nonMatchingResult(policy.mode, 'ACTIVITY_LEVEL_INVALID');
  }
  if (
    constraint.scaleVersion !== undefined &&
    context.playerLevel.scaleVersion !== constraint.scaleVersion
  ) {
    return nonMatchingResult(policy.mode, 'LEVEL_SCALE_VERSION_MISMATCH', {
      playerScaleVersion: context.playerLevel.scaleVersion,
      constraintScaleVersion: constraint.scaleVersion,
    });
  }
  if (constraint.source === 'LEGACY_TEXT_FALLBACK') {
    return result(
      policy.legacyTextConstraintAction === 'WARN' ? 'WARN' : 'PASS',
      'LEGACY_LEVEL_CONSTRAINT',
    );
  }

  const effectiveMinRank = constraint.minRank - policy.lowerToleranceSteps;
  const effectiveMaxRank = constraint.maxRank + policy.upperToleranceSteps;
  const metadata = {
    configuredMinRank: constraint.minRank,
    configuredMaxRank: constraint.maxRank,
    effectiveMinRank,
    effectiveMaxRank,
    playerRank: context.playerLevel.rank,
    constraintSource: constraint.source,
  };
  if (
    context.playerLevel.rank >= effectiveMinRank &&
    context.playerLevel.rank <= effectiveMaxRank
  ) {
    return result('PASS', 'LEVEL_ALLOWED', metadata);
  }
  return nonMatchingResult(
    policy.mode,
    context.playerLevel.rank < effectiveMinRank ? 'LEVEL_TOO_LOW' : 'LEVEL_TOO_HIGH',
    metadata,
  );
}

export function levelResultAllowsParticipation(resultValue: EligibilityRuleResult): boolean {
  return resultValue.outcome !== 'FAIL';
}
