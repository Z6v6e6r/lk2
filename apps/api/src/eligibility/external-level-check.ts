import type { LevelEligibilityReasonCode } from '@phub/domain';
import type {
  ExternalParticipationActivityType,
  ParticipationLevelGate,
  ParticipationLevelRange,
} from '@phub/database';

export interface ExternalLevelCheckActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
}

/** Stable public refusal; `code` is the canonical level reason code used by native games. */
export type ExternalLevelRefusal =
  | { readonly code: LevelEligibilityReasonCode; readonly status: 409 }
  | { readonly code: 'PARTICIPATION_LEVEL_UNAVAILABLE'; readonly status: 503 };

/** `dateHint` locates the activity in a date-paged provider feed (trainings). */
export type ExternalLevelCheck = (
  actor: ExternalLevelCheckActor,
  activityId: string,
  dateHint?: string,
) => Promise<ExternalLevelRefusal | null>;

const SPORT_CODE = 'PADEL';

/**
 * Evaluates the tenant level policy before an external owner (CUP/Viva) receives a registration.
 * - OFF: no constraint read and no decision row, so existing behavior is unchanged.
 * - Unknown constraint (provider read failed): SHADOW continues; WARN/BLOCK fail closed.
 * - Otherwise the decision is persisted first and only a FAIL outcome refuses the command.
 */
export function createExternalLevelCheck(options: {
  readonly gate: ParticipationLevelGate;
  readonly activityType: ExternalParticipationActivityType;
  readonly action: 'REGISTER' | 'BOOK';
  readonly constraintSource: 'LEGACY_TOURNAMENT_SETTINGS' | 'VIVA_EXERCISE';
  /** `null`: no restriction; `undefined`: restriction could not be read from the source. */
  readonly levelRange: (
    actor: ExternalLevelCheckActor,
    activityId: string,
    dateHint?: string,
  ) => Promise<ParticipationLevelRange | null | undefined>;
  readonly onDecision?: (event: {
    readonly activityType: ExternalParticipationActivityType;
    readonly mode: string;
    readonly outcome: string;
    readonly reasonCode: string;
  }) => void;
}): ExternalLevelCheck {
  const emit = (event: Parameters<NonNullable<typeof options.onDecision>>[0]) => {
    try {
      options.onDecision?.(event);
    } catch {
      // Telemetry never changes the decision.
    }
  };
  return async (actor, activityId, dateHint) => {
    const mode = await options.gate.mode(actor.tenantId, SPORT_CODE, options.activityType);
    if (mode === 'OFF') return null;
    let levelRange: ParticipationLevelRange | null | undefined;
    try {
      levelRange = await options.levelRange(actor, activityId, dateHint);
    } catch {
      levelRange = undefined;
    }
    if (levelRange === undefined) {
      emit({
        activityType: options.activityType,
        mode,
        outcome: mode === 'SHADOW' ? 'SKIP' : 'FAIL',
        reasonCode: 'ACTIVITY_LEVEL_UNAVAILABLE',
      });
      return mode === 'SHADOW' ? null : { code: 'PARTICIPATION_LEVEL_UNAVAILABLE', status: 503 };
    }
    let decision: Awaited<ReturnType<ParticipationLevelGate['decide']>>;
    try {
      decision = await options.gate.decide({
        tenantId: actor.tenantId,
        playerId: actor.userId,
        sportCode: SPORT_CODE,
        activityType: options.activityType,
        activityId,
        action: options.action,
        levelRange,
        constraintSource: options.constraintSource,
        correlationId: actor.correlationId,
      });
    } catch (error) {
      // SHADOW observes only; WARN/BLOCK keep failing closed on an unavailable decision store.
      if (mode !== 'SHADOW') throw error;
      emit({
        activityType: options.activityType,
        mode,
        outcome: 'SKIP',
        reasonCode: 'DECISION_UNAVAILABLE',
      });
      return null;
    }
    emit({
      activityType: options.activityType,
      mode: decision.mode,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
    });
    return decision.allowed ? null : { code: decision.reasonCode, status: 409 };
  };
}
