import type {
  LevelEligibilityMode,
  LevelEligibilityPolicy,
  ParticipationActivityType,
} from '@phub/domain';
import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface CanonicalLevelView {
  readonly id: string;
  readonly sportCode: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number;
  readonly sortOrder: number;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly scaleVersion: number;
}

export interface LevelEligibilityPolicyView extends LevelEligibilityPolicy {
  readonly id: string;
  readonly sportCode: string;
  readonly activityType: ParticipationActivityType;
  readonly recheckWaitlistPromotion: boolean;
  readonly changeComment: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
}

export interface LevelEligibilityPolicyState {
  readonly sportCode: string;
  readonly levels: readonly CanonicalLevelView[];
  readonly policies: readonly LevelEligibilityPolicyView[];
}

export interface LevelEligibilityPolicyPublishInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly sportCode: string;
  readonly activityType: ParticipationActivityType;
  readonly expectedVersion: number;
  readonly mode: LevelEligibilityMode;
  readonly lowerToleranceSteps: number;
  readonly upperToleranceSteps: number;
  readonly missingActivityConstraintAction: LevelEligibilityPolicy['missingActivityConstraintAction'];
  readonly legacyTextConstraintAction: LevelEligibilityPolicy['legacyTextConstraintAction'];
  readonly recheckWaitlistPromotion: boolean;
  readonly changeComment: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export type LevelEligibilityPolicyPublishResult =
  | {
      readonly outcome: 'applied';
      readonly policy: LevelEligibilityPolicyView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'version_conflict'; readonly currentVersion: number }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'sport_not_found' }
  | { readonly outcome: 'activation_not_ready'; readonly missingGates: readonly string[] }
  | { readonly outcome: 'tolerance_out_of_range'; readonly maximumSteps: number };

export interface LevelEligibilityImpact {
  readonly activityType: ParticipationActivityType;
  readonly activitiesWithoutLevel: number;
  readonly activitiesWithInvalidRange: number;
  readonly legacyActivities: number;
  readonly playersWithoutLevel: number;
  readonly existingParticipantsOutsideRange: number;
  readonly supported: boolean;
}

export interface LevelEligibilityPolicyRepository {
  getState(tenantId: string, sportCode: string): Promise<LevelEligibilityPolicyState>;
  getVersion(
    tenantId: string,
    sportCode: string,
    activityType: ParticipationActivityType,
    version: number,
  ): Promise<LevelEligibilityPolicyView | undefined>;
  listHistory(
    tenantId: string,
    sportCode: string,
    activityType: ParticipationActivityType,
  ): Promise<readonly LevelEligibilityPolicyView[]>;
  publish(input: LevelEligibilityPolicyPublishInput): Promise<LevelEligibilityPolicyPublishResult>;
  getImpact(tenantId: string, sportCode: string): Promise<readonly LevelEligibilityImpact[]>;
}

interface PolicyRow extends QueryResultRow {
  readonly id: string;
  readonly sport_code: string;
  readonly activity_type: ParticipationActivityType;
  readonly mode: LevelEligibilityMode;
  readonly lower_tolerance_steps: number | string;
  readonly upper_tolerance_steps: number | string;
  readonly missing_activity_constraint_action: LevelEligibilityPolicy['missingActivityConstraintAction'];
  readonly legacy_text_constraint_action: LevelEligibilityPolicy['legacyTextConstraintAction'];
  readonly recheck_waitlist_promotion: boolean;
  readonly version: number | string;
  readonly change_comment: string | null;
  readonly updated_by: string | null;
  readonly created_at: string;
}

interface LevelRow extends QueryResultRow {
  readonly id: string;
  readonly sport_code: string;
  readonly code: string;
  readonly title: string;
  readonly rank: number | string;
  readonly sort_order: number | string;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly scale_version: number | string;
}

function numberValue(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('LEVEL_ELIGIBILITY_INTEGER_INVALID');
  return parsed;
}

function policyView(row: PolicyRow): LevelEligibilityPolicyView {
  return {
    id: row.id,
    sportCode: row.sport_code,
    activityType: row.activity_type,
    mode: row.mode,
    lowerToleranceSteps: numberValue(row.lower_tolerance_steps),
    upperToleranceSteps: numberValue(row.upper_tolerance_steps),
    missingActivityConstraintAction: row.missing_activity_constraint_action,
    legacyTextConstraintAction: row.legacy_text_constraint_action,
    recheckWaitlistPromotion: row.recheck_waitlist_promotion,
    version: numberValue(row.version),
    changeComment: row.change_comment,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function levelView(row: LevelRow): CanonicalLevelView {
  return {
    id: row.id,
    sportCode: row.sport_code,
    code: row.code,
    title: row.title,
    rank: numberValue(row.rank),
    sortOrder: numberValue(row.sort_order),
    aliases: row.aliases,
    active: row.active,
    scaleVersion: numberValue(row.scale_version),
  };
}

const POLICY_COLUMNS = `id, sport_code, activity_type, mode,
  lower_tolerance_steps, upper_tolerance_steps,
  missing_activity_constraint_action, legacy_text_constraint_action,
  recheck_waitlist_promotion, version, change_comment, updated_by,
  created_at::text as created_at`;

export function createLevelEligibilityPolicyRepository(
  pool: Pool,
): LevelEligibilityPolicyRepository {
  return {
    getState(tenantId, sportCode) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const [levels, policies] = await Promise.all([
          client.query<LevelRow>(
            `select id, sport_code, code, title, rank, sort_order, aliases, active, scale_version
               from eligibility.canonical_levels
              where tenant_id = $1 and sport_code = $2 and active
              order by scale_version desc, sort_order, id`,
            [tenantId, sportCode],
          ),
          client.query<PolicyRow>(
            `select ${POLICY_COLUMNS}
               from eligibility.level_policies
              where tenant_id = $1 and sport_code = $2 and active
              order by activity_type`,
            [tenantId, sportCode],
          ),
        ]);
        return {
          sportCode,
          levels: levels.rows.map(levelView),
          policies: policies.rows.map(policyView),
        };
      });
    },

    getVersion(tenantId, sportCode, activityType, version) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<PolicyRow>(
          client,
          `select ${POLICY_COLUMNS}
             from eligibility.level_policies
            where tenant_id = $1 and sport_code = $2 and activity_type = $3 and version = $4`,
          [tenantId, sportCode, activityType, version],
        );
        return row ? policyView(row) : undefined;
      });
    },

    listHistory(tenantId, sportCode, activityType) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<PolicyRow>(
          `select ${POLICY_COLUMNS}
             from eligibility.level_policies
            where tenant_id = $1 and sport_code = $2 and activity_type = $3
            order by version desc`,
          [tenantId, sportCode, activityType],
        );
        return result.rows.map(policyView);
      });
    },

    publish(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const replay = await queryOne<
          QueryResultRow & { readonly request_hash: string; readonly result_payload: unknown }
        >(
          client,
          `select request_hash, result_payload
             from eligibility.policy_commands
            where tenant_id = $1 and idempotency_key = $2
            for update`,
          [input.tenantId, input.idempotencyKey],
        );
        if (replay) {
          if (replay.request_hash !== input.requestHash) return { outcome: 'idempotency_conflict' };
          return {
            outcome: 'applied',
            policy: replay.result_payload as LevelEligibilityPolicyView,
            replayed: true,
          };
        }

        const levelCount = await queryOne<QueryResultRow & { readonly count: number | string }>(
          client,
          `select count(*)::integer as count
             from eligibility.canonical_levels
            where tenant_id = $1 and sport_code = $2 and active`,
          [input.tenantId, input.sportCode],
        );
        const activeLevelCount = numberValue(levelCount?.count ?? 0);
        if (activeLevelCount === 0) return { outcome: 'sport_not_found' };
        const maximumSteps = activeLevelCount - 1;
        if (input.lowerToleranceSteps > maximumSteps || input.upperToleranceSteps > maximumSteps) {
          return { outcome: 'tolerance_out_of_range', maximumSteps };
        }

        if (input.mode === 'BLOCK') {
          const readiness = await queryOne<
            QueryResultRow & {
              readonly writer_authoritative: boolean;
              readonly player_projection_ready: boolean;
              readonly client_recovery_ready: boolean;
              readonly payment_recovery_ready: boolean;
            }
          >(
            client,
            `select writer_authoritative, player_projection_ready,
                    client_recovery_ready, payment_recovery_ready
               from eligibility.activation_readiness
              where tenant_id = $1 and sport_code = $2 and activity_type = $3
              for update`,
            [input.tenantId, input.sportCode, input.activityType],
          );
          const gates = [
            ['writer_authoritative', readiness?.writer_authoritative],
            ['player_projection_ready', readiness?.player_projection_ready],
            ['client_recovery_ready', readiness?.client_recovery_ready],
            ['payment_recovery_ready', readiness?.payment_recovery_ready],
          ] as const;
          const missingGates = gates.filter(([, ready]) => !ready).map(([gate]) => gate);
          if (missingGates.length > 0) return { outcome: 'activation_not_ready', missingGates };
        }

        const current = await queryOne<PolicyRow>(
          client,
          `select ${POLICY_COLUMNS}
             from eligibility.level_policies
            where tenant_id = $1 and sport_code = $2 and activity_type = $3 and active
            for update`,
          [input.tenantId, input.sportCode, input.activityType],
        );
        const currentVersion = current ? numberValue(current.version) : 0;
        if (currentVersion !== input.expectedVersion) {
          return { outcome: 'version_conflict', currentVersion };
        }

        if (current) {
          await client.query(
            `update eligibility.level_policies
                set active = false
              where tenant_id = $1 and id = $2 and active`,
            [input.tenantId, current.id],
          );
        }
        const next = await queryOne<PolicyRow>(
          client,
          `insert into eligibility.level_policies (
             tenant_id, sport_code, activity_type, mode,
             lower_tolerance_steps, upper_tolerance_steps,
             missing_activity_constraint_action, legacy_text_constraint_action,
             recheck_waitlist_promotion, version, active, change_comment, updated_by
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12)
           returning ${POLICY_COLUMNS}`,
          [
            input.tenantId,
            input.sportCode,
            input.activityType,
            input.mode,
            input.lowerToleranceSteps,
            input.upperToleranceSteps,
            input.missingActivityConstraintAction,
            input.legacyTextConstraintAction,
            input.recheckWaitlistPromotion,
            currentVersion + 1,
            input.changeComment,
            input.actorUserId,
          ],
        );
        if (!next) throw new Error('LEVEL_ELIGIBILITY_POLICY_WRITE_LOST');
        const view = policyView(next);
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, old_value, new_value
           ) values ($1, $2, 'LEVEL_ELIGIBILITY_POLICY_PUBLISHED', 'LEVEL_POLICY', $3,
                     'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            next.id,
            input.idempotencyKey,
            JSON.stringify(current ? policyView(current) : null),
            JSON.stringify(view),
          ],
        );
        await client.query(
          `insert into eligibility.policy_commands (
             tenant_id, idempotency_key, request_hash, result_payload
           ) values ($1, $2, $3, $4::jsonb)`,
          [input.tenantId, input.idempotencyKey, input.requestHash, JSON.stringify(view)],
        );
        return { outcome: 'applied', policy: view, replayed: false };
      });
    },

    getImpact(tenantId, sportCode) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<
          QueryResultRow & {
            readonly activities_without_level: number | string;
            readonly activities_with_invalid_range: number | string;
            readonly legacy_activities: number | string;
            readonly players_without_level: number | string;
            readonly existing_participants_outside_range: number | string;
          }
        >(
          client,
          `select
             count(*) filter (where game.min_level_id is null and game.max_level_id is null)::integer
               as activities_without_level,
             count(*) filter (where (minimum.rank is null) <> (maximum.rank is null)
                                  or minimum.rank > maximum.rank)::integer
               as activities_with_invalid_range,
             count(*) filter (where game.min_level_id is null and
                                    (game.level_from is not null or game.level_to is not null))::integer
               as legacy_activities,
             (select count(*)::integer
                from identity.users person
               where person.tenant_id = $1 and not exists (
                 select 1 from eligibility.player_sport_levels player
                  where player.tenant_id = person.tenant_id
                    and player.player_id = person.id and player.sport_code = $2
               )) as players_without_level,
             (select count(*)::integer
                from games.participations participation
                join games.games joined_game
                  on joined_game.tenant_id = participation.tenant_id
                 and joined_game.id = participation.game_id
                join eligibility.player_sport_levels player
                  on player.tenant_id = participation.tenant_id
                 and player.player_id = participation.user_id
                 and player.sport_code = joined_game.sport_code
                join eligibility.canonical_levels player_level
                  on player_level.tenant_id = player.tenant_id
                 and player_level.sport_code = player.sport_code
                 and player_level.id = player.level_id
                join eligibility.canonical_levels joined_minimum
                  on joined_minimum.tenant_id = joined_game.tenant_id
                 and joined_minimum.sport_code = joined_game.sport_code
                 and joined_minimum.id = joined_game.min_level_id
                join eligibility.canonical_levels joined_maximum
                  on joined_maximum.tenant_id = joined_game.tenant_id
                 and joined_maximum.sport_code = joined_game.sport_code
                 and joined_maximum.id = joined_game.max_level_id
               where participation.tenant_id = $1 and participation.state = 'ACTIVE'
                 and joined_game.sport_code = $2
                 and (player_level.rank < joined_minimum.rank or player_level.rank > joined_maximum.rank)
             ) as existing_participants_outside_range
            from games.games game
            left join eligibility.canonical_levels minimum
              on minimum.tenant_id = game.tenant_id and minimum.sport_code = game.sport_code
             and minimum.id = game.min_level_id
            left join eligibility.canonical_levels maximum
              on maximum.tenant_id = game.tenant_id and maximum.sport_code = game.sport_code
             and maximum.id = game.max_level_id
           where game.tenant_id = $1 and game.sport_code = $2`,
          [tenantId, sportCode],
        );
        const game: LevelEligibilityImpact = {
          activityType: 'GAME',
          activitiesWithoutLevel: numberValue(row?.activities_without_level ?? 0),
          activitiesWithInvalidRange: numberValue(row?.activities_with_invalid_range ?? 0),
          legacyActivities: numberValue(row?.legacy_activities ?? 0),
          playersWithoutLevel: numberValue(row?.players_without_level ?? 0),
          existingParticipantsOutsideRange: numberValue(
            row?.existing_participants_outside_range ?? 0,
          ),
          supported: true,
        };
        const unsupported = (activityType: 'TOURNAMENT' | 'TRAINING'): LevelEligibilityImpact => ({
          activityType,
          activitiesWithoutLevel: 0,
          activitiesWithInvalidRange: 0,
          legacyActivities: 0,
          playersWithoutLevel: game.playersWithoutLevel,
          existingParticipantsOutsideRange: 0,
          supported: false,
        });
        return [game, unsupported('TOURNAMENT'), unsupported('TRAINING')];
      });
    },
  };
}
