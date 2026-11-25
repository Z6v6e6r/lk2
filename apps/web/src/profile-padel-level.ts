import type { PlayerLevelState, UserProfile } from '@phub/api-sdk';
import { padelGradeForScore } from '@phub/domain';

/** Selects only a verified PADEL projection for the signed-in player. */
export function confirmedPadelProfileLevel(
  state: PlayerLevelState,
  viewerId: string,
): NonNullable<UserProfile['level']> | null {
  const level = state?.currentLevel;
  const score = level?.numericValue;
  // MIGRATED and VIVA can describe historical provenance of a confirmed CUP delivery.
  if (
    state?.sportCode !== 'PADEL' ||
    state.projectionStatus !== 'PROJECTED' ||
    level?.playerId !== viewerId ||
    level.sportCode !== 'PADEL' ||
    !['MANUAL', 'CALCULATED', 'MIGRATED', 'VIVA'].includes(level.source) ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 1 ||
    score > 7 ||
    level.code !== padelGradeForScore(score)
  ) {
    return null;
  }
  return { label: level.code, value: score, assessmentRequired: false };
}
