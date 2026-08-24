import { randomUUID } from 'node:crypto';

import {
  evaluateLevelEligibility,
  levelResultAllowsParticipation,
  type ActivityLevelConstraint,
  type EligibilityRuleResult,
  type LevelEligibilityContext,
  type LevelEligibilityPolicy,
  type ParticipationActivityType,
  type PlayerSportLevel,
} from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export const PARTICIPATION_COMMAND_ACTIONS = [
  'JOIN',
  'JOIN_WAITLIST',
  'PROMOTE_WAITLIST',
  'BOOK',
  'REGISTER',
  'ADMIN_ADD',
] as const;
export type ParticipationCommandAction = (typeof PARTICIPATION_COMMAND_ACTIONS)[number];

export const PARTICIPATION_PAYMENT_MODES = ['SPLIT', 'SUBSCRIPTION', 'ONE_TIME'] as const;
export type ParticipationPaymentMode = (typeof PARTICIPATION_PAYMENT_MODES)[number];

export type ParticipationCommandState =
  'AUTHORIZED' | 'REJECTED' | 'APPLIED' | 'FAILED' | 'EXPIRED';

export interface ParticipationCommandDecisionView {
  readonly decisionId: string;
  readonly status: 'ALLOWED' | 'WARNING' | 'DENIED';
  readonly ruleCode: 'LEVEL_RANGE';
  readonly outcome: EligibilityRuleResult['outcome'];
  readonly reasonCode: EligibilityRuleResult['reasonCode'];
  readonly wouldBlock?: boolean;
  readonly policyVersion: number;
  readonly levelScaleVersion: number | null;
  readonly constraintSource: string;
  readonly evaluatedAt: string;
}

export interface ParticipationCommandView {
  readonly outcome: 'command';
  readonly commandId: string;
  readonly state: ParticipationCommandState;
  readonly activityType: ParticipationActivityType;
  readonly activityId: string;
  readonly action: ParticipationCommandAction;
  readonly activitySourceRevision: number;
  readonly decision: ParticipationCommandDecisionView;
  readonly paymentSnapshotOperationId?: string;
  readonly authorizationExpiresAt?: string;
  readonly writerOperationId?: string;
  readonly errorCode?: string;
  readonly replayed: boolean;
}

export type AuthorizeParticipationCommandResult =
  | ParticipationCommandView
  | { readonly outcome: 'actor_not_found' }
  | { readonly outcome: 'activity_not_found' }
  | { readonly outcome: 'activity_revision_conflict'; readonly currentRevision: number }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'payment_operation_conflict' };

export type AcknowledgeParticipationCommandResult =
  | ParticipationCommandView
  | { readonly outcome: 'command_not_found' }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'writer_operation_conflict' };

export interface AuthorizeParticipationCommandInput {
  readonly tenantId: string;
  readonly principalKey: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly actorUserId: string;
  readonly activityType: ParticipationActivityType;
  readonly activityId: string;
  readonly action: ParticipationCommandAction;
  readonly expectedActivityRevision?: number;
  readonly payment?: {
    readonly operationId: string;
    readonly mode: ParticipationPaymentMode;
  };
  readonly correlationId: string;
  readonly authorizationTtlSeconds: number;
}

export interface AcknowledgeParticipationCommandInput {
  readonly tenantId: string;
  readonly principalKey: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly writerOperationId: string;
  readonly result:
    { readonly outcome: 'APPLIED' } | { readonly outcome: 'FAILED'; readonly errorCode: string };
  readonly correlationId: string;
}

export interface ParticipationCommandTelemetry {
  readonly commandId: string;
  readonly tenantId: string;
  readonly sportId: string;
  readonly activityType: ParticipationActivityType;
  readonly activityId: string;
  readonly action: ParticipationCommandAction;
  readonly mode: LevelEligibilityPolicy['mode'];
  readonly outcome: EligibilityRuleResult['outcome'];
  readonly reasonCode: EligibilityRuleResult['reasonCode'];
  readonly wouldBlock: boolean;
  readonly policyVersion: number;
  readonly levelScaleVersion: number | null;
  readonly constraintSource: string;
  readonly correlationId: string;
}

export interface ParticipationCommandRepository {
  authorize(
    input: AuthorizeParticipationCommandInput,
  ): Promise<AuthorizeParticipationCommandResult>;
  acknowledge(
    input: AcknowledgeParticipationCommandInput,
  ): Promise<AcknowledgeParticipationCommandResult>;
  get(input: {
    readonly tenantId: string;
    readonly principalKey: string;
    readonly commandId: string;
  }): Promise<ParticipationCommandView | undefined>;
  expireAuthorizedBatch(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly correlationId: string;
  }): Promise<{ readonly expired: number }>;
}

interface StoredCommandRow extends QueryResultRow {
  readonly id: string;
  readonly request_hash: string;
  readonly state: ParticipationCommandState;
  readonly result_payload: unknown;
  readonly authorization_expires_at: Date | string | null;
  readonly acknowledgement_idempotency_key: string | null;
  readonly acknowledgement_request_hash: string | null;
  readonly writer_operation_id: string | null;
  readonly authorization_expired?: boolean;
}

interface ActivityProjectionRow extends QueryResultRow {
  readonly activity_id: string;
  readonly sport_code: string;
  readonly constraint_mode: 'NONE' | 'RANGE';
  readonly min_level_id: string | null;
  readonly max_level_id: string | null;
  readonly minimum_rank: number | string | null;
  readonly maximum_rank: number | string | null;
  readonly constraint_source: ActivityLevelConstraint['source'];
  readonly data_quality: ActivityLevelConstraint['dataQuality'];
  readonly scale_version: number | string | null;
  readonly source_revision: number | string;
}

interface PlayerLevelRow extends QueryResultRow {
  readonly player_id: string;
  readonly sport_code: string;
  readonly level_id: string;
  readonly rank: number | string;
  readonly source: PlayerSportLevel['source'];
  readonly scale_version: number | string;
}

interface PolicyRow extends QueryResultRow {
  readonly mode: LevelEligibilityPolicy['mode'];
  readonly lower_tolerance_steps: number | string;
  readonly upper_tolerance_steps: number | string;
  readonly missing_activity_constraint_action: LevelEligibilityPolicy['missingActivityConstraintAction'];
  readonly legacy_text_constraint_action: LevelEligibilityPolicy['legacyTextConstraintAction'];
  readonly version: number | string;
}

interface DecisionRow extends QueryResultRow {
  readonly evaluated_at: Date | string;
}

class PaymentOperationConflictError extends Error {
  constructor() {
    super('PARTICIPATION_PAYMENT_OPERATION_CONFLICT');
  }
}

class WriterOperationConflictError extends Error {
  constructor() {
    super('PARTICIPATION_WRITER_OPERATION_CONFLICT');
  }
}

function integer(value: number | string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function parseStoredView(value: unknown): ParticipationCommandView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PARTICIPATION_COMMAND_RESULT_INVALID');
  }
  return value as ParticipationCommandView;
}

function replay(row: StoredCommandRow): ParticipationCommandView {
  return { ...parseStoredView(row.result_payload), replayed: true };
}

function policy(row: PolicyRow | undefined): LevelEligibilityPolicy {
  if (!row) {
    return {
      mode: 'OFF',
      lowerToleranceSteps: 0,
      upperToleranceSteps: 0,
      missingActivityConstraintAction: 'ALLOW',
      legacyTextConstraintAction: 'ALLOW',
      version: 0,
    };
  }
  return {
    mode: row.mode,
    lowerToleranceSteps: integer(
      row.lower_tolerance_steps,
      'PARTICIPATION_POLICY_LOWER_TOLERANCE_INVALID',
    ),
    upperToleranceSteps: integer(
      row.upper_tolerance_steps,
      'PARTICIPATION_POLICY_UPPER_TOLERANCE_INVALID',
    ),
    missingActivityConstraintAction: row.missing_activity_constraint_action,
    legacyTextConstraintAction: row.legacy_text_constraint_action,
    version: integer(row.version, 'PARTICIPATION_POLICY_VERSION_INVALID'),
  };
}

function constraint(row: ActivityProjectionRow): ActivityLevelConstraint {
  const scaleVersion =
    row.scale_version === null
      ? undefined
      : integer(row.scale_version, 'PARTICIPATION_ACTIVITY_SCALE_VERSION_INVALID');
  if (row.constraint_mode === 'NONE') {
    return {
      mode: 'NONE',
      source: row.constraint_source,
      dataQuality: row.data_quality,
      ...(scaleVersion === undefined ? {} : { scaleVersion }),
    };
  }
  const minRank =
    row.minimum_rank === null
      ? undefined
      : integer(row.minimum_rank, 'PARTICIPATION_ACTIVITY_MINIMUM_RANK_INVALID');
  const maxRank =
    row.maximum_rank === null
      ? undefined
      : integer(row.maximum_rank, 'PARTICIPATION_ACTIVITY_MAXIMUM_RANK_INVALID');
  return {
    mode: 'RANGE',
    source: row.constraint_source,
    dataQuality: row.data_quality,
    ...(row.min_level_id ? { minLevelId: row.min_level_id } : {}),
    ...(row.max_level_id ? { maxLevelId: row.max_level_id } : {}),
    ...(minRank === undefined ? {} : { minRank }),
    ...(maxRank === undefined ? {} : { maxRank }),
    ...(scaleVersion === undefined ? {} : { scaleVersion }),
  };
}

function playerLevel(row: PlayerLevelRow | undefined): PlayerSportLevel | undefined {
  if (!row) return undefined;
  return {
    playerId: row.player_id,
    sportId: row.sport_code,
    levelId: row.level_id,
    rank: integer(row.rank, 'PARTICIPATION_PLAYER_RANK_INVALID'),
    source: row.source,
    scaleVersion: integer(row.scale_version, 'PARTICIPATION_PLAYER_SCALE_VERSION_INVALID'),
  };
}

function decisionStatus(result: EligibilityRuleResult): ParticipationCommandDecisionView['status'] {
  if (result.outcome === 'FAIL') return 'DENIED';
  if (result.outcome === 'WARN') return 'WARNING';
  return 'ALLOWED';
}

async function appendAuditAndOutbox(
  client: Pick<PoolClient, 'query'>,
  input: {
    readonly tenantId: string;
    readonly commandId: string;
    readonly actorUserId?: string;
    readonly action: string;
    readonly result: string;
    readonly reason: string;
    readonly correlationId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id
     ) values ($1, $2, $3, 'PARTICIPATION_COMMAND', $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.actorUserId ?? null,
      input.action,
      input.commandId,
      input.result,
      input.reason,
      input.correlationId,
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      input.eventType,
      input.commandId,
      input.correlationId,
      JSON.stringify(input.payload),
    ],
  );
}

async function loadStoredCommand(
  client: PoolClient,
  input: { readonly tenantId: string; readonly principalKey: string; readonly commandId: string },
): Promise<StoredCommandRow | undefined> {
  return queryOne<StoredCommandRow>(
    client,
    `select id, request_hash, state, result_payload, authorization_expires_at,
            acknowledgement_idempotency_key, acknowledgement_request_hash, writer_operation_id
       from eligibility.participation_commands
      where tenant_id = $1 and principal_key = $2 and id = $3`,
    [input.tenantId, input.principalKey, input.commandId],
  );
}

export function createParticipationCommandRepository(
  pool: Pool,
  options: { readonly onDecision?: (event: ParticipationCommandTelemetry) => void } = {},
): ParticipationCommandRepository {
  return {
    authorize(input) {
      let pendingTelemetry: ParticipationCommandTelemetry | undefined;
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `participation-command:${input.tenantId}:${input.principalKey}:${input.idempotencyKey}`,
        ]);
        const existing = await queryOne<StoredCommandRow>(
          client,
          `select id, request_hash, state, result_payload, authorization_expires_at,
                  acknowledgement_idempotency_key, acknowledgement_request_hash,
                  writer_operation_id
             from eligibility.participation_commands
            where tenant_id = $1 and principal_key = $2 and idempotency_key = $3
            for update`,
          [input.tenantId, input.principalKey, input.idempotencyKey],
        );
        if (existing) {
          return existing.request_hash === input.requestHash
            ? replay(existing)
            : { outcome: 'idempotency_conflict' as const };
        }

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `participation-activity:${input.tenantId}:${input.activityType}:${input.activityId}`,
        ]);
        const actor = await queryOne<{ readonly id: string } & QueryResultRow>(
          client,
          `select id from identity.users
            where tenant_id = $1 and id = $2 and status = 'ACTIVE'
            for update`,
          [input.tenantId, input.actorUserId],
        );
        if (!actor) return { outcome: 'actor_not_found' as const };

        const activity = await queryOne<ActivityProjectionRow>(
          client,
          `select projection.activity_id, projection.sport_code, projection.constraint_mode,
                  projection.min_level_id, projection.max_level_id,
                  minimum.rank as minimum_rank, maximum.rank as maximum_rank,
                  projection.constraint_source, projection.data_quality,
                  projection.scale_version, projection.source_revision
             from eligibility.activity_level_projections projection
             left join eligibility.canonical_levels minimum
               on minimum.tenant_id = projection.tenant_id
              and minimum.sport_code = projection.sport_code
              and minimum.id = projection.min_level_id
             left join eligibility.canonical_levels maximum
               on maximum.tenant_id = projection.tenant_id
              and maximum.sport_code = projection.sport_code
              and maximum.id = projection.max_level_id
            where projection.tenant_id = $1 and projection.activity_type = $2
              and projection.activity_id = $3
            for update of projection`,
          [input.tenantId, input.activityType, input.activityId],
        );
        if (!activity) return { outcome: 'activity_not_found' as const };
        const activityRevision = integer(
          activity.source_revision,
          'PARTICIPATION_ACTIVITY_REVISION_INVALID',
        );
        if (
          input.expectedActivityRevision !== undefined &&
          input.expectedActivityRevision !== activityRevision
        ) {
          return {
            outcome: 'activity_revision_conflict' as const,
            currentRevision: activityRevision,
          };
        }

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `player-level:${input.tenantId}:${input.actorUserId}:${activity.sport_code}`,
        ]);

        const [policyResult, playerResult] = await Promise.all([
          client.query<PolicyRow>(
            `select mode, lower_tolerance_steps, upper_tolerance_steps,
                    missing_activity_constraint_action, legacy_text_constraint_action, version
               from eligibility.level_policies
              where tenant_id = $1 and sport_code = $2 and activity_type = $3 and active`,
            [input.tenantId, activity.sport_code, input.activityType],
          ),
          client.query<PlayerLevelRow>(
            `select player.player_id, player.sport_code, player.level_id, level.rank,
                    player.source, player.scale_version
               from eligibility.player_sport_levels player
               join eligibility.canonical_levels level
                 on level.tenant_id = player.tenant_id
                and level.sport_code = player.sport_code and level.id = player.level_id
              where player.tenant_id = $1 and player.player_id = $2
                and player.sport_code = $3`,
            [input.tenantId, input.actorUserId, activity.sport_code],
          ),
        ]);
        const effectivePolicy = policy(policyResult.rows[0]);
        const activityConstraint = constraint(activity);
        const effectivePlayerLevel = playerLevel(playerResult.rows[0]);
        const context: LevelEligibilityContext = {
          action: input.action,
          activityType: input.activityType,
          activityId: input.activityId,
          sportId: activity.sport_code,
          playerId: input.actorUserId,
          playerLevel: effectivePlayerLevel ?? null,
          activityLevelConstraint: activityConstraint,
        };
        const eligibility = evaluateLevelEligibility(context, effectivePolicy);
        const commandId = randomUUID();
        const decisionId = randomUUID();
        const status = decisionStatus(eligibility);
        const savedDecision = await queryOne<DecisionRow>(
          client,
          `insert into eligibility.decisions (
             tenant_id, id, player_id, activity_type, activity_id, action, status,
             rule_code, outcome, reason_code, policy_version, level_scale_version,
             constraint_source, details
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
           returning evaluated_at`,
          [
            input.tenantId,
            decisionId,
            input.actorUserId,
            input.activityType,
            input.activityId,
            input.action,
            status,
            eligibility.ruleCode,
            eligibility.outcome,
            eligibility.reasonCode,
            effectivePolicy.version,
            activity.scale_version ?? effectivePlayerLevel?.scaleVersion ?? null,
            activity.constraint_source,
            JSON.stringify({
              ...eligibility.metadata,
              activitySourceRevision: activityRevision,
              correlationId: input.correlationId,
            }),
          ],
        );
        if (!savedDecision) throw new Error('PARTICIPATION_DECISION_WRITE_LOST');
        const decision: ParticipationCommandDecisionView = {
          decisionId,
          status,
          ruleCode: eligibility.ruleCode,
          outcome: eligibility.outcome,
          reasonCode: eligibility.reasonCode,
          wouldBlock: eligibility.metadata?.wouldBlock === true,
          policyVersion: effectivePolicy.version,
          levelScaleVersion:
            activity.scale_version === null && !effectivePlayerLevel
              ? null
              : integer(
                  activity.scale_version ?? effectivePlayerLevel!.scaleVersion,
                  'PARTICIPATION_DECISION_SCALE_VERSION_INVALID',
                ),
          constraintSource: activity.constraint_source,
          evaluatedAt: iso(savedDecision.evaluated_at),
        };

        const allowed = levelResultAllowsParticipation(eligibility);
        const expiry = allowed
          ? await queryOne<{ readonly expires_at: Date | string } & QueryResultRow>(
              client,
              'select now() + make_interval(secs => $1) as expires_at',
              [input.authorizationTtlSeconds],
            )
          : undefined;
        const authorizationExpiresAt = expiry ? iso(expiry.expires_at) : undefined;
        if (allowed && input.payment) {
          try {
            const snapshot = await client.query(
              `insert into eligibility.payment_snapshots (
                 tenant_id, operation_id, decision_id, player_id, activity_type, activity_id,
                 snapshot
               ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
               on conflict (tenant_id, operation_id) do nothing`,
              [
                input.tenantId,
                input.payment.operationId,
                decisionId,
                input.actorUserId,
                input.activityType,
                input.activityId,
                JSON.stringify({
                  ...decision,
                  activitySourceRevision: activityRevision,
                  paymentMode: input.payment.mode,
                }),
              ],
            );
            if ((snapshot.rowCount ?? 0) !== 1) {
              throw new PaymentOperationConflictError();
            }
          } catch (error) {
            if ((error as { readonly code?: string }).code === '23505') {
              throw new PaymentOperationConflictError();
            }
            throw error;
          }
        }

        const view: ParticipationCommandView = {
          outcome: 'command',
          commandId,
          state: allowed ? 'AUTHORIZED' : 'REJECTED',
          activityType: input.activityType,
          activityId: input.activityId,
          action: input.action,
          activitySourceRevision: activityRevision,
          decision,
          ...(input.payment && allowed
            ? { paymentSnapshotOperationId: input.payment.operationId }
            : {}),
          ...(authorizationExpiresAt ? { authorizationExpiresAt } : {}),
          ...(allowed ? {} : { errorCode: eligibility.reasonCode }),
          replayed: false,
        };
        await client.query(
          `insert into eligibility.participation_commands (
             tenant_id, id, principal_key, idempotency_key, request_hash, actor_user_id,
             activity_type, activity_id, action, activity_source_revision, decision_id,
             payment_snapshot_operation_id, state, error_code, result_payload,
             authorization_expires_at, completed_at
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15::jsonb, $16::timestamptz,
             case when $13 = 'REJECTED' then now() else null end
           )`,
          [
            input.tenantId,
            commandId,
            input.principalKey,
            input.idempotencyKey,
            input.requestHash,
            input.actorUserId,
            input.activityType,
            input.activityId,
            input.action,
            activityRevision,
            decisionId,
            input.payment && allowed ? input.payment.operationId : null,
            view.state,
            view.errorCode ?? null,
            JSON.stringify(view),
            authorizationExpiresAt ?? null,
          ],
        );
        await appendAuditAndOutbox(client, {
          tenantId: input.tenantId,
          commandId,
          actorUserId: input.actorUserId,
          action: 'PARTICIPATION_AUTHORIZE',
          result: view.state,
          reason: eligibility.reasonCode,
          correlationId: input.correlationId,
          eventType: allowed
            ? 'participation.command.authorized.v1'
            : 'participation.command.rejected.v1',
          payload: {
            commandId,
            activityType: input.activityType,
            activityId: input.activityId,
            action: input.action,
            state: view.state,
            reasonCode: eligibility.reasonCode,
            activitySourceRevision: activityRevision,
          },
        });
        pendingTelemetry = {
          commandId,
          tenantId: input.tenantId,
          sportId: activity.sport_code,
          activityType: input.activityType,
          activityId: input.activityId,
          action: input.action,
          mode: effectivePolicy.mode,
          outcome: eligibility.outcome,
          reasonCode: eligibility.reasonCode,
          wouldBlock: eligibility.metadata?.wouldBlock === true,
          policyVersion: effectivePolicy.version,
          levelScaleVersion: decision.levelScaleVersion,
          constraintSource: activity.constraint_source,
          correlationId: input.correlationId,
        };
        return view;
      })
        .catch((error: unknown) => {
          if (error instanceof PaymentOperationConflictError) {
            return { outcome: 'payment_operation_conflict' as const };
          }
          throw error;
        })
        .then((result) => {
          if (pendingTelemetry && result.outcome === 'command') {
            try {
              options.onDecision?.(pendingTelemetry);
            } catch {
              // Telemetry must never change a committed authorization decision.
            }
          }
          return result;
        });
    },

    acknowledge(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `participation-command-ack:${input.tenantId}:${input.commandId}`,
        ]);
        const row = await queryOne<StoredCommandRow & { readonly actor_user_id: string }>(
          client,
          `select id, actor_user_id, request_hash, state, result_payload,
                  authorization_expires_at, acknowledgement_idempotency_key,
                  acknowledgement_request_hash, writer_operation_id,
                  authorization_expires_at <= now() as authorization_expired
             from eligibility.participation_commands
            where tenant_id = $1 and principal_key = $2 and id = $3
            for update`,
          [input.tenantId, input.principalKey, input.commandId],
        );
        if (!row) return { outcome: 'command_not_found' as const };
        if (row.acknowledgement_idempotency_key !== null) {
          return row.acknowledgement_idempotency_key === input.idempotencyKey &&
            row.acknowledgement_request_hash === input.requestHash &&
            row.writer_operation_id === input.writerOperationId
            ? replay(row)
            : { outcome: 'idempotency_conflict' as const };
        }
        if (row.state !== 'AUTHORIZED') return replay(row);

        const current = parseStoredView(row.result_payload);
        const expired = row.authorization_expires_at === null || row.authorization_expired === true;
        const nextState: ParticipationCommandState = expired
          ? 'EXPIRED'
          : input.result.outcome === 'APPLIED'
            ? 'APPLIED'
            : 'FAILED';
        const errorCode = expired
          ? 'PARTICIPATION_AUTHORIZATION_EXPIRED'
          : input.result.outcome === 'FAILED'
            ? input.result.errorCode
            : undefined;
        const view: ParticipationCommandView = {
          ...current,
          state: nextState,
          writerOperationId: input.writerOperationId,
          ...(errorCode ? { errorCode } : {}),
          replayed: false,
        };
        try {
          await client.query(
            `update eligibility.participation_commands
              set state = $4, error_code = $5, result_payload = $6::jsonb,
                  acknowledgement_idempotency_key = $7,
                  acknowledgement_request_hash = $8, writer_operation_id = $9,
                  completed_at = now(), updated_at = now()
            where tenant_id = $1 and principal_key = $2 and id = $3`,
            [
              input.tenantId,
              input.principalKey,
              input.commandId,
              nextState,
              errorCode ?? null,
              JSON.stringify(view),
              input.idempotencyKey,
              input.requestHash,
              input.writerOperationId,
            ],
          );
        } catch (error) {
          if ((error as { readonly code?: string }).code === '23505') {
            throw new WriterOperationConflictError();
          }
          throw error;
        }
        await appendAuditAndOutbox(client, {
          tenantId: input.tenantId,
          commandId: input.commandId,
          actorUserId: row.actor_user_id,
          action: 'PARTICIPATION_ACKNOWLEDGE',
          result: nextState,
          reason: errorCode ?? 'PARTICIPATION_WRITER_APPLIED',
          correlationId: input.correlationId,
          eventType:
            nextState === 'APPLIED'
              ? 'participation.command.applied.v1'
              : nextState === 'FAILED'
                ? 'participation.command.failed.v1'
                : 'participation.command.expired.v1',
          payload: {
            commandId: input.commandId,
            state: nextState,
            activityType: current.activityType,
            activityId: current.activityId,
            writerOperationId: input.writerOperationId,
            ...(errorCode ? { errorCode } : {}),
          },
        });
        return view;
      }).catch((error: unknown) => {
        if (error instanceof WriterOperationConflictError) {
          return { outcome: 'writer_operation_conflict' as const };
        }
        throw error;
      });
    },

    get(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await loadStoredCommand(client, input);
        return row ? parseStoredView(row.result_payload) : undefined;
      });
    },

    expireAuthorizedBatch(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const due = await client.query<StoredCommandRow & { readonly actor_user_id: string }>(
          `select id, actor_user_id, request_hash, state, result_payload,
                  authorization_expires_at, acknowledgement_idempotency_key,
                  acknowledgement_request_hash, writer_operation_id
             from eligibility.participation_commands
            where tenant_id = $1 and state = 'AUTHORIZED'
              and authorization_expires_at <= now()
            order by authorization_expires_at, id
            for update skip locked
            limit $2`,
          [input.tenantId, input.limit],
        );
        for (const row of due.rows) {
          const current = parseStoredView(row.result_payload);
          const view: ParticipationCommandView = {
            ...current,
            state: 'EXPIRED',
            errorCode: 'PARTICIPATION_AUTHORIZATION_EXPIRED',
            replayed: false,
          };
          await client.query(
            `update eligibility.participation_commands
                set state = 'EXPIRED', error_code = 'PARTICIPATION_AUTHORIZATION_EXPIRED',
                    result_payload = $3::jsonb, completed_at = now(), updated_at = now()
              where tenant_id = $1 and id = $2 and state = 'AUTHORIZED'`,
            [input.tenantId, row.id, JSON.stringify(view)],
          );
          await appendAuditAndOutbox(client, {
            tenantId: input.tenantId,
            commandId: row.id,
            actorUserId: row.actor_user_id,
            action: 'PARTICIPATION_EXPIRE',
            result: 'EXPIRED',
            reason: 'PARTICIPATION_AUTHORIZATION_EXPIRED',
            correlationId: input.correlationId,
            eventType: 'participation.command.expired.v1',
            payload: {
              commandId: row.id,
              state: 'EXPIRED',
              activityType: current.activityType,
              activityId: current.activityId,
            },
          });
        }
        return { expired: due.rows.length };
      });
    },
  };
}
