import { randomUUID } from 'node:crypto';

import {
  evaluateLevelEligibility,
  type EligibilityRuleOutcome,
  type LevelEligibilityContext,
  type LevelEligibilityMode,
  type LevelEligibilityPolicy,
  type LevelEligibilityReasonCode,
} from '@phub/domain';
import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

/**
 * Pre-dispatch level gate for activities whose final roster writer is an external owner
 * (CUP tournaments, Viva group trainings). The decision uses the same canonical rule, policy,
 * tolerance and player level projection (CUP-authoritative, otherwise self-declared/onboarding)
 * as native games, and is persisted in `eligibility.decisions` before any owner write.
 */
export type ExternalParticipationActivityType = 'TOURNAMENT' | 'TRAINING';

export interface ParticipationLevelRange {
  /** Canonical level codes (for example `C`, `B+`) from a server-side activity read. */
  readonly from: string;
  readonly to: string;
  /** Set by the source adapter when the declared selection cannot be one range (for example a gap). */
  readonly dataQuality?: 'INVALID';
}

export interface ParticipationLevelGateInput {
  readonly tenantId: string;
  readonly playerId: string;
  readonly sportCode: string;
  readonly activityType: ExternalParticipationActivityType;
  readonly activityId: string;
  readonly action: 'REGISTER' | 'BOOK';
  /** `null` means the activity declares no level restriction. */
  readonly levelRange: ParticipationLevelRange | null;
  readonly constraintSource: 'LEGACY_TOURNAMENT_SETTINGS' | 'VIVA_EXERCISE';
  readonly correlationId: string;
}

export interface ParticipationLevelGateDecision {
  readonly decisionId: string;
  readonly mode: LevelEligibilityMode;
  readonly outcome: EligibilityRuleOutcome;
  readonly reasonCode: LevelEligibilityReasonCode;
  readonly allowed: boolean;
  readonly policyVersion: number;
}

export interface ParticipationLevelGate {
  /** Cheap read used to skip external constraint reads while the policy is OFF. */
  mode(
    tenantId: string,
    sportCode: string,
    activityType: ExternalParticipationActivityType,
  ): Promise<LevelEligibilityMode>;
  decide(input: ParticipationLevelGateInput): Promise<ParticipationLevelGateDecision>;
}

interface GateFactsRow extends QueryResultRow {
  readonly mode: LevelEligibilityMode | null;
  readonly lower_tolerance_steps: number | null;
  readonly upper_tolerance_steps: number | null;
  readonly missing_activity_constraint_action:
    LevelEligibilityPolicy['missingActivityConstraintAction'] | null;
  readonly legacy_text_constraint_action:
    LevelEligibilityPolicy['legacyTextConstraintAction'] | null;
  readonly policy_version: number | null;
  readonly player_level_id: string | null;
  readonly player_rank: number | null;
  readonly player_level_source: string | null;
  readonly player_scale_version: number | null;
  readonly minimum_level_id: string | null;
  readonly maximum_level_id: string | null;
  readonly minimum_rank: number | null;
  readonly maximum_rank: number | null;
  readonly constraint_scale_version: number | null;
}

const OFF_POLICY: LevelEligibilityPolicy = {
  mode: 'OFF',
  lowerToleranceSteps: 0,
  upperToleranceSteps: 0,
  missingActivityConstraintAction: 'ALLOW',
  legacyTextConstraintAction: 'ALLOW',
  version: 0,
};

const PLAYER_LEVEL_SOURCES = new Set([
  'SELF_DECLARED',
  'ONBOARDING',
  'MANUAL',
  'CALCULATED',
  'VIVA',
  'MIGRATED',
]);

export function createParticipationLevelGate(pool: Pool): ParticipationLevelGate {
  return {
    mode(tenantId, sportCode, activityType) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<QueryResultRow & { readonly mode: LevelEligibilityMode }>(
          client,
          `select mode
             from eligibility.level_policies
            where tenant_id = $1 and sport_code = $2 and activity_type = $3 and active
            limit 1`,
          [tenantId, sportCode, activityType],
        );
        return row?.mode ?? 'OFF';
      });
    },

    decide(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const facts = await queryOne<GateFactsRow>(
          client,
          `select
             policy.mode,
             policy.lower_tolerance_steps,
             policy.upper_tolerance_steps,
             policy.missing_activity_constraint_action,
             policy.legacy_text_constraint_action,
             policy.version as policy_version,
             player.level_id as player_level_id,
             player_level.rank as player_rank,
             player.source as player_level_source,
             player.scale_version as player_scale_version,
             minimum.id as minimum_level_id,
             maximum.id as maximum_level_id,
             minimum.rank as minimum_rank,
             maximum.rank as maximum_rank,
             greatest(minimum.scale_version, maximum.scale_version) as constraint_scale_version
            from (values (1)) source(marker)
            left join lateral (
              select mode, lower_tolerance_steps, upper_tolerance_steps,
                     missing_activity_constraint_action, legacy_text_constraint_action, version
                from eligibility.level_policies
               where tenant_id = $1 and sport_code = $3 and activity_type = $4 and active
               limit 1
            ) policy on true
            left join eligibility.player_sport_levels player
              on player.tenant_id = $1 and player.player_id = $2 and player.sport_code = $3
            left join eligibility.canonical_levels player_level
              on player_level.tenant_id = player.tenant_id
             and player_level.sport_code = player.sport_code
             and player_level.id = player.level_id
            left join lateral (
              select id, rank, scale_version
                from eligibility.canonical_levels
               where tenant_id = $1 and sport_code = $3 and active and code = $5
               order by scale_version desc
               limit 1
            ) minimum on $5::text is not null
            left join lateral (
              select id, rank, scale_version
                from eligibility.canonical_levels
               where tenant_id = $1 and sport_code = $3 and active and code = $6
               order by scale_version desc
               limit 1
            ) maximum on $6::text is not null`,
          [
            input.tenantId,
            input.playerId,
            input.sportCode,
            input.activityType,
            input.levelRange?.from ?? null,
            input.levelRange?.to ?? null,
          ],
        );
        if (!facts) throw new Error('PARTICIPATION_LEVEL_FACTS_MISSING');

        const policy: LevelEligibilityPolicy = facts.mode
          ? {
              mode: facts.mode,
              lowerToleranceSteps: Number(facts.lower_tolerance_steps),
              upperToleranceSteps: Number(facts.upper_tolerance_steps),
              missingActivityConstraintAction: facts.missing_activity_constraint_action!,
              legacyTextConstraintAction: facts.legacy_text_constraint_action!,
              version: Number(facts.policy_version),
            }
          : OFF_POLICY;
        const complete =
          facts.minimum_level_id !== null &&
          facts.maximum_level_id !== null &&
          facts.minimum_rank !== null &&
          facts.maximum_rank !== null;
        const playerLevel: LevelEligibilityContext['playerLevel'] =
          facts.player_level_id &&
          facts.player_rank !== null &&
          facts.player_level_source &&
          PLAYER_LEVEL_SOURCES.has(facts.player_level_source)
            ? {
                playerId: input.playerId,
                sportId: input.sportCode,
                levelId: facts.player_level_id,
                rank: Number(facts.player_rank),
                source: facts.player_level_source as NonNullable<
                  LevelEligibilityContext['playerLevel']
                >['source'],
                scaleVersion: Number(facts.player_scale_version),
              }
            : null;
        const decision = evaluateLevelEligibility(
          {
            action: input.action,
            activityType: input.activityType,
            activityId: input.activityId,
            sportId: input.sportCode,
            playerId: input.playerId,
            playerLevel,
            activityLevelConstraint: input.levelRange
              ? {
                  mode: 'RANGE',
                  ...(facts.minimum_level_id ? { minLevelId: facts.minimum_level_id } : {}),
                  ...(facts.maximum_level_id ? { maxLevelId: facts.maximum_level_id } : {}),
                  ...(facts.minimum_rank === null ? {} : { minRank: Number(facts.minimum_rank) }),
                  ...(facts.maximum_rank === null ? {} : { maxRank: Number(facts.maximum_rank) }),
                  source: input.constraintSource,
                  dataQuality:
                    complete && input.levelRange.dataQuality !== 'INVALID' ? 'VALID' : 'INVALID',
                  ...(facts.constraint_scale_version === null
                    ? {}
                    : { scaleVersion: Number(facts.constraint_scale_version) }),
                }
              : { mode: 'NONE', source: input.constraintSource, dataQuality: 'VALID' },
          },
          policy,
        );
        const decisionId = randomUUID();
        await client.query(
          `insert into eligibility.decisions (
             tenant_id, id, player_id, activity_type, activity_id, action, status,
             rule_code, outcome, reason_code, policy_version, level_scale_version,
             constraint_source, invitation_id, details
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
          [
            input.tenantId,
            decisionId,
            input.playerId,
            input.activityType,
            input.activityId,
            input.action,
            decision.outcome === 'FAIL'
              ? 'DENIED'
              : decision.outcome === 'WARN'
                ? 'WARNING'
                : 'ALLOWED',
            decision.ruleCode,
            decision.outcome,
            decision.reasonCode,
            policy.version,
            facts.constraint_scale_version ?? facts.player_scale_version,
            input.constraintSource,
            null,
            JSON.stringify({
              ...decision.metadata,
              ...(input.levelRange
                ? { declaredFrom: input.levelRange.from, declaredTo: input.levelRange.to }
                : {}),
              correlationId: input.correlationId,
            }),
          ],
        );
        // No personal-invitation bypass here: such invitations are consumed only by a native
        // roster command, so an unspent pre-dispatch bypass would become reusable.
        return {
          decisionId,
          mode: policy.mode,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          allowed: decision.outcome !== 'FAIL',
          policyVersion: policy.version,
        };
      });
    },
  };
}
