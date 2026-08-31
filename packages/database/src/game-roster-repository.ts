import { randomUUID } from 'node:crypto';

import {
  GameDomainError,
  assertCanJoinGameFacts,
  assertCanJoinWaitlistFacts,
  assertCanLeaveGameFacts,
  assertCanLeaveWaitlistFacts,
  gameDomainEventSchema,
  type GameDomainErrorCode,
  type GameLifecycleState,
  type GameRosterCommandFacts,
  type GameViewerRelation,
} from '@phub/games';
import {
  evaluateLevelEligibility,
  type LevelEligibilityReasonCode,
  type LevelEligibilityPolicy,
  type LevelEligibilityContext,
} from '@phub/domain';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';
import type { GamePaymentMode } from './game-repository.js';

export type GameRosterCommandErrorCode =
  | GameDomainErrorCode
  | LevelEligibilityReasonCode
  | 'GAME_NOT_FOUND'
  | 'GAME_REVISION_CONFLICT'
  | 'GAME_NOT_CONFIRMABLE'
  | 'GAME_PAYMENT_EVIDENCE_CONFLICT'
  | 'GAME_PAYMENT_REQUIRED'
  | 'GAME_PAYMENT_MODE_MISMATCH'
  | 'GAME_PAYMENT_SNAPSHOT_MISSING'
  | 'GAME_RESERVATION_EXPIRED'
  | 'GAME_RESERVATION_NOT_FOUND';

export type GameRosterCommandResult =
  | {
      readonly outcome: 'applied';
      readonly commandId: string;
      readonly gameId: string;
      readonly revision: number;
      readonly viewerRelation: Exclude<GameViewerRelation, 'ANONYMOUS' | 'ORGANIZER'>;
      readonly participationId?: string;
      readonly reservationId?: string;
      readonly waitlistEntryId?: string;
      readonly position?: number;
      readonly expiresAt?: string;
      readonly committedAt: string;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: GameRosterCommandErrorCode;
      readonly currentRevision?: number;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' };

export type GameRosterProcessResult =
  | {
      readonly outcome: 'applied' | 'no_op';
      readonly commandId: string;
      readonly gameId: string;
      readonly revision: number;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'not_due';
      readonly availableAt: string;
    }
  | { readonly outcome: 'idempotency_conflict' };

export interface GameRosterUserCommandInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
  readonly expectedRevision?: number;
  readonly invitationId?: string;
}

export interface ConfirmGamePaymentInput extends GameRosterUserCommandInput {
  readonly reservationId: string;
  readonly evidence: {
    readonly provider: 'VIVA';
    readonly operationType: 'TRANSACTION' | 'SUBSCRIPTION_BOOKING';
    readonly operationId: string;
    readonly bookingId: string;
    readonly exerciseId?: string;
    readonly clientPhoneE164: string;
    readonly evidenceHash: string;
    readonly verifiedAt: string;
    readonly verifiedBy: 'LEGACY_NODE_RED';
    readonly amountMinor?: number;
    readonly currency?: string;
  };
}

export interface LevelEligibilityDecisionTelemetry {
  readonly decisionId: string;
  readonly tenantId: string;
  readonly sportId: string;
  readonly activityType: 'GAME';
  readonly activityId: string;
  readonly playerId: string;
  readonly action: 'JOIN' | 'JOIN_WAITLIST' | 'PROMOTE_WAITLIST';
  readonly ruleCode: 'LEVEL_RANGE';
  readonly mode: LevelEligibilityPolicy['mode'];
  readonly outcome: ReturnType<typeof evaluateLevelEligibility>['outcome'];
  readonly reasonCode: ReturnType<typeof evaluateLevelEligibility>['reasonCode'];
  readonly policyVersion: number;
  readonly levelScaleVersion: number | null;
  readonly constraintSource: string;
  readonly invitationId: string | null;
  readonly correlationId: string;
}

interface ProcessCommandInput {
  readonly tenantId: string;
  readonly gameId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface ExpireGameReservationInput extends ProcessCommandInput {
  readonly reservationId: string;
}

export interface PromoteGameWaitlistInput extends ProcessCommandInput {
  readonly waitlistEntryId: string;
}

export interface GameRosterRepository {
  join(input: GameRosterUserCommandInput): Promise<GameRosterCommandResult>;
  joinWaitlist(input: GameRosterUserCommandInput): Promise<GameRosterCommandResult>;
  confirmPayment(input: ConfirmGamePaymentInput): Promise<GameRosterCommandResult>;
  leave(input: GameRosterUserCommandInput): Promise<GameRosterCommandResult>;
  leaveWaitlist(input: GameRosterUserCommandInput): Promise<GameRosterCommandResult>;
  expireReservation(input: ExpireGameReservationInput): Promise<GameRosterProcessResult>;
  promoteWaitlist(input: PromoteGameWaitlistInput): Promise<GameRosterProcessResult>;
  getOperation(input: GameRosterOperationInput): Promise<GameRosterOperation | undefined>;
}

export interface GameRosterOperationInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly operationId: string;
}

export interface GameRosterOperation {
  readonly commandId: string;
  readonly commandType:
    'game.join.v1' | 'game.leave.v1' | 'game.waitlist.join.v1' | 'game.waitlist.leave.v1';
  readonly gameId: string | null;
  readonly state: 'COMPLETED' | 'FAILED';
  readonly committedAt: string;
  readonly result?: Extract<GameRosterCommandResult, { outcome: 'applied' }>;
  readonly errorCode?: GameRosterCommandErrorCode;
}

interface CommandRow extends QueryResultRow {
  readonly id: string;
  readonly command_type: string;
  readonly request_hash: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly result_payload: unknown;
  readonly error_code: string | null;
}

interface OperationRow extends CommandRow {
  readonly aggregate_id: string | null;
  readonly completed_at: Date | string;
}

interface LockedGameRow extends QueryResultRow {
  readonly id: string;
  readonly revision: string | number;
  readonly lifecycle_state: GameLifecycleState;
  readonly starts_at: Date | string;
  readonly join_cutoff_at: Date | string | null;
  readonly capacity: number;
  readonly waitlist_enabled: boolean;
  readonly payment_mode: GamePaymentMode;
  readonly sport_code: string;
  readonly level_from: string | null;
  readonly level_to: string | null;
  readonly min_level_id: string | null;
  readonly max_level_id: string | null;
  readonly database_now: Date | string;
}

interface RosterFactsRow extends QueryResultRow {
  readonly active_participant_count: number;
  readonly active_reservation_count: number;
  readonly participation_id: string | null;
  readonly participation_role: 'ORGANIZER' | 'PLAYER' | null;
  readonly reservation_id: string | null;
  readonly waitlist_entry_id: string | null;
  readonly waitlist_position: string | number | null;
}

interface IdentifierRow extends QueryResultRow {
  readonly id: string;
}

interface ReservationRow extends IdentifierRow {
  readonly expires_at: Date | string;
}

interface ConfirmableReservationRow extends ReservationRow {
  readonly user_id: string;
  readonly state: 'ACTIVE' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
  readonly payment_state: 'REQUIRES_ACTION' | 'PROCESSING' | 'PAID' | 'FAILED' | 'EXPIRED';
  readonly eligibility_decision_id: string | null;
  readonly payment_snapshot_exists: boolean;
}

interface PaymentEvidenceRow extends QueryResultRow {
  readonly id: string;
  readonly reservation_id: string;
  readonly provider: 'VIVA';
  readonly provider_operation_type: 'TRANSACTION' | 'SUBSCRIPTION_BOOKING';
  readonly provider_operation_id: string;
  readonly evidence_hash: string;
  readonly resolution: 'RECEIVED' | 'APPLIED' | 'REJECTED';
  readonly error_code: string | null;
  readonly participation_id: string | null;
  readonly aggregate_revision: string | number | null;
  readonly resolved_at: Date | string | null;
}

interface WaitlistRow extends IdentifierRow {
  readonly position: string | number;
}

interface RevisionRow extends QueryResultRow {
  readonly revision: string | number;
}

interface ParticipantIdsRow extends QueryResultRow {
  readonly user_ids: readonly string[];
}

interface WaitlistPromotionRow extends QueryResultRow {
  readonly id: string;
}

interface ExpirableReservationRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly state: 'ACTIVE' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED';
  readonly expires_at: Date | string;
}

interface PromotableWaitlistRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly position: string | number;
  readonly state: 'ACTIVE' | 'PROMOTED' | 'LEFT' | 'EXPIRED';
  readonly personal_invitation_id: string | null;
}

interface EligibilityFactsRow extends QueryResultRow {
  readonly mode: LevelEligibilityPolicy['mode'] | null;
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
  readonly valid_invitation_id: string | null;
}

interface CapacityRow extends QueryResultRow {
  readonly active_participant_count: number;
  readonly active_reservation_count: number;
}

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function positiveInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('GAME_REVISION_INVALID');
  return parsed;
}

function principalKey(actorUserId: string): string {
  return `user:${actorUserId}`;
}

const USER_ROSTER_COMMAND_TYPES = [
  'game.join.v1',
  'game.leave.v1',
  'game.waitlist.join.v1',
  'game.waitlist.leave.v1',
] as const;

function isUserRosterCommandType(value: string): value is GameRosterOperation['commandType'] {
  return (USER_ROSTER_COMMAND_TYPES as readonly string[]).includes(value);
}

async function lockIdempotency(
  client: PoolClient,
  input: GameRosterUserCommandInput,
): Promise<CommandRow | undefined> {
  const principal = principalKey(input.actorUserId);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `game-command:${input.tenantId}:${principal}:${input.idempotencyKey}`,
  ]);
  return queryOne<CommandRow>(
    client,
    `select id, command_type, request_hash, state, result_payload, error_code
       from games.command_idempotency
      where tenant_id = $1 and principal_key = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, principal, input.idempotencyKey],
  );
}

function parseAppliedResult(
  value: unknown,
): Extract<GameRosterCommandResult, { outcome: 'applied' }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (
    result.outcome !== 'applied' ||
    typeof result.commandId !== 'string' ||
    typeof result.gameId !== 'string' ||
    typeof result.revision !== 'number' ||
    !Number.isSafeInteger(result.revision) ||
    typeof result.committedAt !== 'string' ||
    Number.isNaN(Date.parse(result.committedAt)) ||
    !['NONE', 'SEAT_RESERVED', 'PARTICIPANT', 'WAITLISTED'].includes(String(result.viewerRelation))
  ) {
    return undefined;
  }
  return {
    ...(result as Omit<Extract<GameRosterCommandResult, { outcome: 'applied' }>, 'replayed'>),
    replayed: true,
  };
}

function replayCommand(
  row: CommandRow | undefined,
  commandType: string,
  requestHash: string,
): GameRosterCommandResult | undefined {
  if (!row) return undefined;
  if (row.command_type !== commandType || row.request_hash !== requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  if (row.state === 'FAILED' && row.error_code) {
    return {
      outcome: 'rejected',
      code: row.error_code as GameRosterCommandErrorCode,
      replayed: true,
    };
  }
  if (row.state !== 'COMPLETED') return { outcome: 'idempotency_conflict' };
  const parsed = parseAppliedResult(row.result_payload);
  if (!parsed) throw new Error('GAME_IDEMPOTENCY_RESULT_INVALID');
  return parsed;
}

const PROCESS_PRINCIPAL = 'service:games-process-manager';

async function lockProcessIdempotency(
  client: PoolClient,
  input: ProcessCommandInput,
): Promise<CommandRow | undefined> {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `game-command:${input.tenantId}:${PROCESS_PRINCIPAL}:${input.idempotencyKey}`,
  ]);
  return queryOne<CommandRow>(
    client,
    `select id, command_type, request_hash, state, result_payload, error_code
       from games.command_idempotency
      where tenant_id = $1 and principal_key = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, PROCESS_PRINCIPAL, input.idempotencyKey],
  );
}

function parseProcessResult(value: unknown): GameRosterProcessResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (
    !['applied', 'no_op'].includes(String(result.outcome)) ||
    typeof result.commandId !== 'string' ||
    typeof result.gameId !== 'string' ||
    typeof result.revision !== 'number' ||
    !Number.isSafeInteger(result.revision)
  ) {
    return undefined;
  }
  return {
    outcome: result.outcome as 'applied' | 'no_op',
    commandId: result.commandId,
    gameId: result.gameId,
    revision: result.revision,
    replayed: true,
  };
}

function replayProcessCommand(
  row: CommandRow | undefined,
  commandType: string,
  requestHash: string,
): GameRosterProcessResult | undefined {
  if (!row) return undefined;
  if (row.command_type !== commandType || row.request_hash !== requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  if (row.state !== 'COMPLETED') return { outcome: 'idempotency_conflict' };
  const parsed = parseProcessResult(row.result_payload);
  if (!parsed) throw new Error('GAME_PROCESS_IDEMPOTENCY_RESULT_INVALID');
  return parsed;
}

async function storeProcessResult(
  client: PoolClient,
  input: ProcessCommandInput,
  commandType: string,
  result: Extract<GameRosterProcessResult, { outcome: 'applied' | 'no_op' }>,
): Promise<void> {
  await client.query(
    `insert into games.command_idempotency (
       tenant_id, id, actor_user_id, principal_key, idempotency_key,
       command_type, request_hash, aggregate_id, state, result_payload, completed_at
     ) values ($1, $2, null, $3, $4, $5, $6, $7, 'COMPLETED', $8::jsonb, now())`,
    [
      input.tenantId,
      input.commandId,
      PROCESS_PRINCIPAL,
      input.idempotencyKey,
      commandType,
      input.requestHash,
      input.gameId,
      JSON.stringify({ ...result, replayed: undefined }),
    ],
  );
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, null, $2, 'GAME', $3, $4, $5, $6::jsonb)`,
    [
      input.tenantId,
      commandType.toUpperCase().replaceAll('.', '_'),
      input.gameId,
      result.outcome === 'applied' ? 'SUCCESS' : 'NO_OP',
      input.correlationId,
      JSON.stringify({ revision: result.revision }),
    ],
  );
}

async function lockGame(
  client: PoolClient,
  input: GameRosterUserCommandInput,
): Promise<LockedGameRow | undefined> {
  return queryOne<LockedGameRow>(
    client,
    `select id, revision, lifecycle_state, starts_at, join_cutoff_at,
            capacity, waitlist_enabled, payment_mode, sport_code, level_from, level_to,
            min_level_id, max_level_id, now()::text as database_now
       from games.games
      where tenant_id = $1 and id = $2
      for update`,
    [input.tenantId, input.gameId],
  );
}

async function lockProcessGame(
  client: PoolClient,
  input: ProcessCommandInput,
): Promise<LockedGameRow | undefined> {
  return queryOne<LockedGameRow>(
    client,
    `select id, revision, lifecycle_state, starts_at, join_cutoff_at,
            capacity, waitlist_enabled, payment_mode, sport_code, level_from, level_to,
            min_level_id, max_level_id, now()::text as database_now
       from games.games
      where tenant_id = $1 and id = $2
      for update`,
    [input.tenantId, input.gameId],
  );
}

async function loadCapacity(
  client: PoolClient,
  tenantId: string,
  gameId: string,
): Promise<CapacityRow> {
  const row = await queryOne<CapacityRow>(
    client,
    `select
       (select count(*)::integer from games.participations
         where tenant_id = $1 and game_id = $2 and state = 'ACTIVE') as active_participant_count,
       (select count(*)::integer from games.seat_reservations
         where tenant_id = $1 and game_id = $2 and state = 'ACTIVE' and expires_at > now())
         as active_reservation_count`,
    [tenantId, gameId],
  );
  if (!row) throw new Error('GAME_CAPACITY_FACTS_MISSING');
  return row;
}

async function loadRosterFacts(
  client: PoolClient,
  input: GameRosterUserCommandInput,
): Promise<RosterFactsRow> {
  const row = await queryOne<RosterFactsRow>(
    client,
    `select
       (select count(*)::integer
          from games.participations
         where tenant_id = $1 and game_id = $2 and state = 'ACTIVE') as active_participant_count,
       (select count(*)::integer
          from games.seat_reservations
         where tenant_id = $1 and game_id = $2 and state = 'ACTIVE' and expires_at > now())
         as active_reservation_count,
       participant.id as participation_id,
       participant.role as participation_role,
       reservation.id as reservation_id,
       waitlist.id as waitlist_entry_id,
       waitlist.position as waitlist_position
      from (values (1)) source(marker)
      left join lateral (
        select id, role
          from games.participations
         where tenant_id = $1 and game_id = $2 and user_id = $3 and state = 'ACTIVE'
         limit 1
      ) participant on true
      left join lateral (
        select id
          from games.seat_reservations
         where tenant_id = $1 and game_id = $2 and user_id = $3 and state = 'ACTIVE'
         limit 1
      ) reservation on true
      left join lateral (
        select id, position
          from games.waitlist_entries
         where tenant_id = $1 and game_id = $2 and user_id = $3 and state = 'ACTIVE'
         limit 1
      ) waitlist on true`,
    [input.tenantId, input.gameId, input.actorUserId],
  );
  if (!row) throw new Error('GAME_ROSTER_FACTS_MISSING');
  return row;
}

function viewerRelation(facts: RosterFactsRow): GameRosterCommandFacts['viewerRelation'] {
  if (facts.participation_role === 'ORGANIZER') return 'ORGANIZER';
  if (facts.participation_id) return 'PARTICIPANT';
  if (facts.reservation_id) return 'SEAT_RESERVED';
  if (facts.waitlist_entry_id) return 'WAITLISTED';
  return 'NONE';
}

function commandFacts(game: LockedGameRow, facts: RosterFactsRow): GameRosterCommandFacts {
  return {
    lifecycleState: game.lifecycle_state,
    startsAt: timestamp(game.starts_at),
    joinCutoffAt: game.join_cutoff_at === null ? null : timestamp(game.join_cutoff_at),
    capacity: game.capacity,
    activeParticipantCount: facts.active_participant_count,
    activeReservationCount: facts.active_reservation_count,
    waitlistEnabled: game.waitlist_enabled,
    viewerRelation: viewerRelation(facts),
  };
}

async function evaluateGameParticipationEligibility(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly playerId: string;
    readonly invitationId?: string;
    readonly action: 'JOIN' | 'JOIN_WAITLIST' | 'PROMOTE_WAITLIST';
    readonly correlationId: string;
  },
  game: LockedGameRow,
  onEligibilityDecision?: (event: LevelEligibilityDecisionTelemetry) => void,
): Promise<{
  readonly decisionId: string;
  readonly deniedCode?: LevelEligibilityReasonCode;
  readonly validatedInvitationId?: string;
}> {
  const facts = await queryOne<EligibilityFactsRow>(
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
       greatest(minimum.scale_version, maximum.scale_version) as constraint_scale_version,
       invitation.id as valid_invitation_id
      from (values (1)) source(marker)
      left join lateral (
        select mode, lower_tolerance_steps, upper_tolerance_steps,
               missing_activity_constraint_action, legacy_text_constraint_action, version
          from eligibility.level_policies
         where tenant_id = $1 and sport_code = $3 and activity_type = 'GAME' and active
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
         where tenant_id = $1 and sport_code = $3 and active
           and (($4::uuid is not null and id = $4::uuid) or ($4::uuid is null and code = $5))
         order by scale_version desc
         limit 1
      ) minimum on true
      left join lateral (
        select id, rank, scale_version
          from eligibility.canonical_levels
         where tenant_id = $1 and sport_code = $3 and active
           and (($6::uuid is not null and id = $6::uuid) or ($6::uuid is null and code = $7))
         order by scale_version desc
         limit 1
      ) maximum on true
      left join lateral (
        select id
          from eligibility.personal_invitations
         where tenant_id = $1
           and id = $8::uuid
           and activity_type = 'GAME'
           and activity_id = $9
           and invitation_type = 'PERSONAL'
           and recipient_player_id = $2
           and status = 'ACTIVE'
           and revoked_at is null
           and expires_at > now()
           and use_count < max_uses
         limit 1
         for update
      ) invitation on $8::uuid is not null`,
    [
      input.tenantId,
      input.playerId,
      game.sport_code,
      game.min_level_id,
      game.level_from,
      game.max_level_id,
      game.level_to,
      input.invitationId ?? null,
      input.gameId,
    ],
  );
  if (!facts) throw new Error('GAME_ELIGIBILITY_FACTS_MISSING');

  const policy: LevelEligibilityPolicy = facts.mode
    ? {
        mode: facts.mode,
        lowerToleranceSteps: Number(facts.lower_tolerance_steps),
        upperToleranceSteps: Number(facts.upper_tolerance_steps),
        missingActivityConstraintAction: facts.missing_activity_constraint_action!,
        legacyTextConstraintAction: facts.legacy_text_constraint_action!,
        version: Number(facts.policy_version),
      }
    : {
        mode: 'OFF',
        lowerToleranceSteps: 0,
        upperToleranceSteps: 0,
        missingActivityConstraintAction: 'ALLOW',
        legacyTextConstraintAction: 'ALLOW',
        version: 0,
      };
  const hasDeclaredRange =
    game.min_level_id !== null ||
    game.max_level_id !== null ||
    game.level_from !== null ||
    game.level_to !== null;
  const hasCompleteCanonicalRange =
    facts.minimum_level_id !== null &&
    facts.maximum_level_id !== null &&
    facts.minimum_rank !== null &&
    facts.maximum_rank !== null;
  const source = game.min_level_id && game.max_level_id ? 'CANONICAL' : 'LEGACY_GAME_SETTINGS';
  const decision = evaluateLevelEligibility(
    {
      action: input.action,
      activityType: 'GAME',
      activityId: input.gameId,
      sportId: game.sport_code,
      playerId: input.playerId,
      playerLevel:
        facts.player_level_id && facts.player_rank !== null && facts.player_level_source
          ? {
              playerId: input.playerId,
              sportId: game.sport_code,
              levelId: facts.player_level_id,
              rank: Number(facts.player_rank),
              source: facts.player_level_source as NonNullable<
                LevelEligibilityContext['playerLevel']
              >['source'],
              scaleVersion: Number(facts.player_scale_version),
            }
          : null,
      activityLevelConstraint: !hasDeclaredRange
        ? { mode: 'NONE', source, dataQuality: 'VALID' }
        : {
            mode: 'RANGE',
            ...(facts.minimum_level_id ? { minLevelId: facts.minimum_level_id } : {}),
            ...(facts.maximum_level_id ? { maxLevelId: facts.maximum_level_id } : {}),
            ...(facts.minimum_rank === null ? {} : { minRank: Number(facts.minimum_rank) }),
            ...(facts.maximum_rank === null ? {} : { maxRank: Number(facts.maximum_rank) }),
            source,
            dataQuality: hasCompleteCanonicalRange ? 'VALID' : 'INVALID',
            ...(facts.constraint_scale_version === null
              ? {}
              : { scaleVersion: Number(facts.constraint_scale_version) }),
          },
      ...(facts.valid_invitation_id
        ? { validPersonalInvitationId: facts.valid_invitation_id }
        : {}),
    },
    policy,
  );
  const decisionId = randomUUID();
  const usedInvitationId =
    decision.reasonCode === 'PERSONAL_INVITE_BYPASS' ? facts.valid_invitation_id : null;
  const status =
    decision.outcome === 'FAIL' ? 'DENIED' : decision.outcome === 'WARN' ? 'WARNING' : 'ALLOWED';
  await client.query(
    `insert into eligibility.decisions (
       tenant_id, id, player_id, activity_type, activity_id, action, status,
       rule_code, outcome, reason_code, policy_version, level_scale_version,
       constraint_source, invitation_id, details
     ) values ($1, $2, $3, 'GAME', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
    [
      input.tenantId,
      decisionId,
      input.playerId,
      input.gameId,
      input.action,
      status,
      decision.ruleCode,
      decision.outcome,
      decision.reasonCode,
      policy.version,
      facts.constraint_scale_version ?? facts.player_scale_version,
      source,
      usedInvitationId,
      JSON.stringify({ ...decision.metadata, correlationId: input.correlationId }),
    ],
  );
  try {
    onEligibilityDecision?.({
      decisionId,
      tenantId: input.tenantId,
      sportId: game.sport_code,
      activityType: 'GAME',
      activityId: input.gameId,
      playerId: input.playerId,
      action: input.action,
      ruleCode: decision.ruleCode,
      mode: policy.mode,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      policyVersion: policy.version,
      levelScaleVersion:
        facts.constraint_scale_version === null && facts.player_scale_version === null
          ? null
          : Number(facts.constraint_scale_version ?? facts.player_scale_version),
      constraintSource: source,
      invitationId: usedInvitationId,
      correlationId: input.correlationId,
    });
  } catch {
    // Telemetry must never change an eligibility decision or roster transaction.
  }
  return {
    decisionId,
    ...(decision.outcome === 'FAIL' ? { deniedCode: decision.reasonCode } : {}),
    ...(usedInvitationId ? { validatedInvitationId: usedInvitationId } : {}),
  };
}

async function persistPaymentEligibilitySnapshot(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly decisionId: string;
    readonly playerId: string;
    readonly gameId: string;
    readonly paymentMode: 'SPLIT' | 'SUBSCRIPTION';
  },
): Promise<void> {
  const result = await client.query(
    `insert into eligibility.payment_snapshots (
       tenant_id, operation_id, decision_id, player_id, activity_type, activity_id, snapshot
     )
     select $1, $2, decision.id, $4, 'GAME', $5,
            jsonb_build_object(
              'decisionId', decision.id,
              'status', decision.status,
              'ruleCode', decision.rule_code,
              'outcome', decision.outcome,
              'reasonCode', decision.reason_code,
              'policyVersion', decision.policy_version,
              'levelScaleVersion', decision.level_scale_version,
              'constraintSource', decision.constraint_source,
              'invitationId', decision.invitation_id,
              'details', decision.details,
              'evaluatedAt', decision.evaluated_at,
              'paymentMode', $6::text
            )
       from eligibility.decisions decision
      where decision.tenant_id = $1 and decision.id = $3
     on conflict (tenant_id, operation_id) do nothing`,
    [
      input.tenantId,
      input.operationId,
      input.decisionId,
      input.playerId,
      input.gameId,
      input.paymentMode,
    ],
  );
  if (result.rowCount !== 1) throw new Error('GAME_PAYMENT_ELIGIBILITY_SNAPSHOT_WRITE_LOST');
}

async function consumePersonalInvitation(
  client: PoolClient,
  tenantId: string,
  invitationId: string | undefined,
): Promise<void> {
  if (!invitationId) return;
  await client.query(
    `update eligibility.personal_invitations
        set use_count = use_count + 1,
            used_at = now(),
            status = case when use_count + 1 >= max_uses then 'USED' else status end,
            updated_at = now()
      where tenant_id = $1 and id = $2 and status = 'ACTIVE' and use_count < max_uses`,
    [tenantId, invitationId],
  );
}

async function storeCompleted(
  client: PoolClient,
  input: GameRosterUserCommandInput,
  commandType: string,
  commandId: string,
  result: Extract<GameRosterCommandResult, { outcome: 'applied' }>,
): Promise<void> {
  await client.query(
    `insert into games.command_idempotency (
       tenant_id, id, actor_user_id, principal_key, idempotency_key,
       command_type, request_hash, aggregate_id, state, result_payload, completed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', $9::jsonb, now())`,
    [
      input.tenantId,
      commandId,
      input.actorUserId,
      principalKey(input.actorUserId),
      input.idempotencyKey,
      commandType,
      input.requestHash,
      input.gameId,
      JSON.stringify({ ...result, replayed: undefined }),
    ],
  );
}

async function storeRejected(
  client: PoolClient,
  input: GameRosterUserCommandInput,
  commandType: string,
  commandId: string,
  code: GameRosterCommandErrorCode,
  aggregateExists: boolean,
  currentRevision?: number,
): Promise<GameRosterCommandResult> {
  await client.query(
    `insert into games.command_idempotency (
       tenant_id, id, actor_user_id, principal_key, idempotency_key,
       command_type, request_hash, aggregate_id, state, error_code, completed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'FAILED', $9, now())`,
    [
      input.tenantId,
      commandId,
      input.actorUserId,
      principalKey(input.actorUserId),
      input.idempotencyKey,
      commandType,
      input.requestHash,
      aggregateExists ? input.gameId : null,
      code,
    ],
  );
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, reason, correlation_id, new_value
     ) values ($1, $2, $3, 'GAME', $4, 'REJECTED', $5, $6, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      commandType.toUpperCase().replaceAll('.', '_'),
      input.gameId,
      code,
      input.correlationId,
      JSON.stringify(currentRevision === undefined ? {} : { currentRevision }),
    ],
  );
  return {
    outcome: 'rejected',
    code,
    ...(currentRevision === undefined ? {} : { currentRevision }),
    replayed: false,
  };
}

async function appendEvent(client: PoolClient, rawEvent: unknown): Promise<void> {
  const event = gameDomainEventSchema.parse(rawEvent);
  await client.query(
    `insert into audit.outbox_events (
       id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
     ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      event.id,
      event.tenantId,
      event.type,
      event.aggregateId,
      event.correlationId,
      JSON.stringify(event.payload),
      event.occurredAt,
    ],
  );
}

async function bumpRevision(
  client: PoolClient,
  input: Pick<GameRosterUserCommandInput, 'tenantId' | 'gameId'>,
): Promise<number> {
  const row = await queryOne<RevisionRow>(
    client,
    `update games.games set revision = revision + 1, updated_at = now()
      where tenant_id = $1 and id = $2
      returning revision`,
    [input.tenantId, input.gameId],
  );
  if (!row) throw new Error('GAME_REVISION_WRITE_LOST');
  return positiveInteger(row.revision);
}

async function participantUserIds(
  client: PoolClient,
  input: Pick<GameRosterUserCommandInput, 'tenantId' | 'gameId'>,
): Promise<readonly string[]> {
  const row = await queryOne<ParticipantIdsRow>(
    client,
    `select coalesce(array_agg(user_id order by joined_at, id), '{}'::uuid[]) as user_ids
       from games.participations
      where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'`,
    [input.tenantId, input.gameId],
  );
  return row?.user_ids ?? [];
}

async function recordSuccess(
  client: PoolClient,
  input: GameRosterUserCommandInput,
  commandType: string,
  result: Extract<GameRosterCommandResult, { outcome: 'applied' }>,
): Promise<void> {
  await storeCompleted(client, input, commandType, result.commandId, result);
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, new_value
     ) values ($1, $2, $3, 'GAME', $4, 'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      commandType.toUpperCase().replaceAll('.', '_'),
      input.gameId,
      input.correlationId,
      JSON.stringify({
        revision: result.revision,
        viewerRelation: result.viewerRelation,
        ...(result.participationId ? { participationId: result.participationId } : {}),
        ...(result.reservationId ? { reservationId: result.reservationId } : {}),
        ...(result.waitlistEntryId ? { waitlistEntryId: result.waitlistEntryId } : {}),
      }),
    ],
  );
}

function eventBase(
  input: GameRosterUserCommandInput,
  commandId: string,
  revision: number,
  occurredAt: string,
) {
  return {
    id: randomUUID(),
    aggregateId: input.gameId,
    tenantId: input.tenantId,
    occurredAt,
    correlationId: input.correlationId,
    payload: {
      gameId: input.gameId,
      aggregateRevision: String(revision),
      causationId: commandId,
      actorUserId: input.actorUserId,
    },
  };
}

function processEventBase(input: ProcessCommandInput, revision: number, occurredAt: string) {
  return {
    id: randomUUID(),
    aggregateId: input.gameId,
    tenantId: input.tenantId,
    occurredAt,
    correlationId: input.correlationId,
    payload: {
      gameId: input.gameId,
      aggregateRevision: String(revision),
      causationId: input.commandId,
      actorUserId: null,
    },
  };
}

async function prepareCommand(
  client: PoolClient,
  input: GameRosterUserCommandInput,
  commandType: string,
): Promise<
  | {
      readonly ready: true;
      readonly commandId: string;
      readonly game: LockedGameRow;
      readonly facts: RosterFactsRow;
    }
  | { readonly ready: false; readonly result: GameRosterCommandResult }
> {
  const replay = replayCommand(
    await lockIdempotency(client, input),
    commandType,
    input.requestHash,
  );
  if (replay) return { ready: false, result: replay };
  const commandId = randomUUID();
  const game = await lockGame(client, input);
  if (!game) {
    return {
      ready: false,
      result: await storeRejected(client, input, commandType, commandId, 'GAME_NOT_FOUND', false),
    };
  }
  const currentRevision = positiveInteger(game.revision);
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    return {
      ready: false,
      result: await storeRejected(
        client,
        input,
        commandType,
        commandId,
        'GAME_REVISION_CONFLICT',
        true,
        currentRevision,
      ),
    };
  }
  return { ready: true, commandId, game, facts: await loadRosterFacts(client, input) };
}

async function policyRejection(
  client: PoolClient,
  input: GameRosterUserCommandInput,
  commandType: string,
  commandId: string,
  game: LockedGameRow,
  policy: () => void,
): Promise<GameRosterCommandResult | undefined> {
  try {
    policy();
    return undefined;
  } catch (error) {
    if (!(error instanceof GameDomainError)) throw error;
    return storeRejected(
      client,
      input,
      commandType,
      commandId,
      error.code,
      true,
      positiveInteger(game.revision),
    );
  }
}

async function scheduleWaitlistPromotion(
  client: PoolClient,
  input: Pick<GameRosterUserCommandInput, 'tenantId' | 'gameId'>,
  revision: number,
): Promise<void> {
  const entry = await queryOne<WaitlistPromotionRow>(
    client,
    `select id
       from games.waitlist_entries
      where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
      order by position, created_at, id
      for update skip locked
      limit 1`,
    [input.tenantId, input.gameId],
  );
  if (!entry) return;
  await client.query(
    `insert into games.scheduled_commands (
       tenant_id, game_id, command_type, due_at, expected_revision, payload
     ) values ($1, $2, 'game.waitlist.promote.v1', now(), $3, $4::jsonb)`,
    [input.tenantId, input.gameId, revision, JSON.stringify({ waitlistEntryId: entry.id })],
  );
}

export function createGameRosterRepository(
  pool: Pool,
  options: {
    readonly onEligibilityDecision?: (event: LevelEligibilityDecisionTelemetry) => void;
  } = {},
): GameRosterRepository {
  return {
    join(input) {
      const commandType = 'game.join.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const prepared = await prepareCommand(client, input, commandType);
        if (!prepared.ready) return prepared.result;
        const now = timestamp(prepared.game.database_now);
        const rejected = await policyRejection(
          client,
          input,
          commandType,
          prepared.commandId,
          prepared.game,
          () => assertCanJoinGameFacts(commandFacts(prepared.game, prepared.facts), now),
        );
        if (rejected) return rejected;

        const eligibility = await evaluateGameParticipationEligibility(
          client,
          {
            tenantId: input.tenantId,
            gameId: input.gameId,
            playerId: input.actorUserId,
            ...(input.invitationId ? { invitationId: input.invitationId } : {}),
            action: 'JOIN',
            correlationId: input.correlationId,
          },
          prepared.game,
          options.onEligibilityDecision,
        );
        if (eligibility.deniedCode) {
          return storeRejected(
            client,
            input,
            commandType,
            prepared.commandId,
            eligibility.deniedCode,
            true,
            positiveInteger(prepared.game.revision),
          );
        }

        if (
          prepared.game.payment_mode === 'SPLIT' ||
          prepared.game.payment_mode === 'SUBSCRIPTION'
        ) {
          const reservation = await queryOne<ReservationRow>(
            client,
            `insert into games.seat_reservations (
               tenant_id, game_id, user_id, state, payment_state, expires_at,
               eligibility_decision_id
             ) values ($1, $2, $3, 'ACTIVE', $4, now() + interval '15 minutes', $5)
             returning id, expires_at::text as expires_at`,
            [
              input.tenantId,
              input.gameId,
              input.actorUserId,
              prepared.game.payment_mode === 'SPLIT' ? 'REQUIRES_ACTION' : 'PROCESSING',
              eligibility.decisionId ?? null,
            ],
          );
          if (!reservation) throw new Error('GAME_RESERVATION_WRITE_LOST');
          await persistPaymentEligibilitySnapshot(client, {
            tenantId: input.tenantId,
            operationId: prepared.commandId,
            decisionId: eligibility.decisionId,
            playerId: input.actorUserId,
            gameId: input.gameId,
            paymentMode: prepared.game.payment_mode,
          });
          const revision = await bumpRevision(client, input);
          const expiresAt = timestamp(reservation.expires_at);
          const result = {
            outcome: 'applied' as const,
            commandId: prepared.commandId,
            gameId: input.gameId,
            revision,
            viewerRelation: 'SEAT_RESERVED' as const,
            reservationId: reservation.id,
            expiresAt,
            committedAt: now,
            replayed: false,
          };
          await client.query(
            `insert into games.scheduled_commands (
               tenant_id, game_id, command_type, due_at, expected_revision, payload
             ) values ($1, $2, 'game.reservation.expire.v1', $3, $4, $5::jsonb)`,
            [
              input.tenantId,
              input.gameId,
              expiresAt,
              revision,
              JSON.stringify({ reservationId: reservation.id }),
            ],
          );
          await appendEvent(client, {
            ...eventBase(input, prepared.commandId, revision, now),
            type: 'game.participation.reserved.v1',
            payload: {
              ...eventBase(input, prepared.commandId, revision, now).payload,
              userId: input.actorUserId,
              reservationId: reservation.id,
              expiresAt,
            },
          });
          await consumePersonalInvitation(
            client,
            input.tenantId,
            eligibility.validatedInvitationId,
          );
          await recordSuccess(client, input, commandType, result);
          return result;
        }

        const participation = await queryOne<IdentifierRow>(
          client,
          `insert into games.participations (
             tenant_id, game_id, user_id, role, state, payment_state, eligibility_decision_id
           ) values ($1, $2, $3, 'PLAYER', 'ACTIVE', 'NOT_REQUIRED', $4)
           returning id`,
          [input.tenantId, input.gameId, input.actorUserId, eligibility.decisionId ?? null],
        );
        if (!participation) throw new Error('GAME_PARTICIPATION_WRITE_LOST');
        const revision = await bumpRevision(client, input);
        const result = {
          outcome: 'applied' as const,
          commandId: prepared.commandId,
          gameId: input.gameId,
          revision,
          viewerRelation: 'PARTICIPANT' as const,
          participationId: participation.id,
          committedAt: now,
          replayed: false,
        };
        const base = eventBase(input, prepared.commandId, revision, now);
        await appendEvent(client, {
          ...base,
          type: 'game.participation.confirmed.v1',
          payload: {
            ...base.payload,
            userId: input.actorUserId,
            participationId: participation.id,
          },
        });
        const users = await participantUserIds(client, input);
        if (users.length === prepared.game.capacity) {
          await appendEvent(client, {
            ...eventBase(input, prepared.commandId, revision, now),
            type: 'game.roster.completed.v1',
            payload: {
              ...eventBase(input, prepared.commandId, revision, now).payload,
              participantUserIds: users,
            },
          });
        }
        await consumePersonalInvitation(client, input.tenantId, eligibility.validatedInvitationId);
        await recordSuccess(client, input, commandType, result);
        return result;
      });
    },

    confirmPayment(input) {
      const commandType = 'game.payment.confirm.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const replay = replayCommand(
          await lockIdempotency(client, input),
          commandType,
          input.requestHash,
        );
        if (replay) return replay;
        const commandId = randomUUID();
        const game = await lockGame(client, input);
        if (!game) {
          return storeRejected(client, input, commandType, commandId, 'GAME_NOT_FOUND', false);
        }
        const currentRevision = positiveInteger(game.revision);
        const reservation = await queryOne<ConfirmableReservationRow>(
          client,
          `select id, user_id, state, payment_state, expires_at::text as expires_at,
                  eligibility_decision_id,
                  exists (
                    select 1
                      from eligibility.payment_snapshots snapshot
                     where snapshot.tenant_id = games.seat_reservations.tenant_id
                       and snapshot.decision_id = games.seat_reservations.eligibility_decision_id
                       and snapshot.player_id = games.seat_reservations.user_id
                       and snapshot.activity_type = 'GAME'
                       and snapshot.activity_id = games.seat_reservations.game_id
                  ) as payment_snapshot_exists
             from games.seat_reservations
            where tenant_id = $1 and game_id = $2 and id = $3 and user_id = $4
            for update`,
          [input.tenantId, input.gameId, input.reservationId, input.actorUserId],
        );
        if (!reservation) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESERVATION_NOT_FOUND',
            true,
            currentRevision,
          );
        }
        if (!reservation.eligibility_decision_id || !reservation.payment_snapshot_exists) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_PAYMENT_SNAPSHOT_MISSING',
            true,
            currentRevision,
          );
        }

        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `game-payment-evidence:${input.tenantId}:${input.evidence.provider}:${input.evidence.operationType}:${input.evidence.operationId}`,
        ]);

        const existingEvidence = await client.query<PaymentEvidenceRow>(
          `select id, reservation_id, provider, provider_operation_type,
                  provider_operation_id, evidence_hash, resolution, error_code,
                  participation_id, aggregate_revision, resolved_at
             from games.payment_confirmation_evidence
            where tenant_id = $1
              and (
                reservation_id = $2
                or (provider = $3 and provider_operation_type = $4 and provider_operation_id = $5)
              )
            for update`,
          [
            input.tenantId,
            input.reservationId,
            input.evidence.provider,
            input.evidence.operationType,
            input.evidence.operationId,
          ],
        );
        const exactEvidence = existingEvidence.rows.find(
          (row) =>
            row.reservation_id === input.reservationId &&
            row.provider === input.evidence.provider &&
            row.provider_operation_type === input.evidence.operationType &&
            row.provider_operation_id === input.evidence.operationId &&
            row.evidence_hash === input.evidence.evidenceHash,
        );
        if (existingEvidence.rows.length > 0 && !exactEvidence) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_PAYMENT_EVIDENCE_CONFLICT',
            true,
            currentRevision,
          );
        }
        if (exactEvidence?.resolution === 'APPLIED') {
          if (
            !exactEvidence.participation_id ||
            exactEvidence.aggregate_revision === null ||
            exactEvidence.resolved_at === null
          ) {
            throw new Error('GAME_PAYMENT_EVIDENCE_RESULT_INVALID');
          }
          const result = {
            outcome: 'applied' as const,
            commandId,
            gameId: input.gameId,
            revision: positiveInteger(exactEvidence.aggregate_revision),
            viewerRelation: 'PARTICIPANT' as const,
            participationId: exactEvidence.participation_id,
            reservationId: input.reservationId,
            committedAt: timestamp(exactEvidence.resolved_at),
            replayed: false,
          };
          await recordSuccess(client, input, commandType, result);
          return result;
        }
        if (exactEvidence?.resolution === 'REJECTED') {
          if (!exactEvidence.error_code) throw new Error('GAME_PAYMENT_EVIDENCE_RESULT_INVALID');
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            exactEvidence.error_code as GameRosterCommandErrorCode,
            true,
            currentRevision,
          );
        }
        if (exactEvidence) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_PAYMENT_EVIDENCE_CONFLICT',
            true,
            currentRevision,
          );
        }

        const evidence = await queryOne<IdentifierRow>(
          client,
          `insert into games.payment_confirmation_evidence (
             tenant_id, game_id, reservation_id, user_id, eligibility_decision_id,
             provider, provider_operation_type, provider_operation_id, payment_mode,
             provider_booking_id, provider_exercise_id, client_phone_e164, amount_minor, currency,
             evidence_hash, verified_at, verified_by
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
           )
           returning id`,
          [
            input.tenantId,
            input.gameId,
            input.reservationId,
            input.actorUserId,
            reservation.eligibility_decision_id,
            input.evidence.provider,
            input.evidence.operationType,
            input.evidence.operationId,
            game.payment_mode,
            input.evidence.bookingId,
            input.evidence.exerciseId ?? null,
            input.evidence.clientPhoneE164,
            input.evidence.amountMinor ?? null,
            input.evidence.currency ?? null,
            input.evidence.evidenceHash,
            input.evidence.verifiedAt,
            input.evidence.verifiedBy,
          ],
        );
        if (!evidence) throw new Error('GAME_PAYMENT_EVIDENCE_WRITE_LOST');
        const rejectEvidence = async (
          code: GameRosterCommandErrorCode,
        ): Promise<GameRosterCommandResult> => {
          const rejectedEvidence = await client.query(
            `update games.payment_confirmation_evidence
                set resolution = 'REJECTED', error_code = $3,
                    aggregate_revision = $4, resolved_at = now()
              where tenant_id = $1 and id = $2 and resolution = 'RECEIVED'`,
            [input.tenantId, evidence.id, code, currentRevision],
          );
          if (rejectedEvidence.rowCount !== 1) {
            throw new Error('GAME_PAYMENT_EVIDENCE_REJECT_LOST');
          }
          return storeRejected(client, input, commandType, commandId, code, true, currentRevision);
        };

        if (!['SCHEDULED', 'IN_PROGRESS'].includes(game.lifecycle_state)) {
          return rejectEvidence('GAME_NOT_CONFIRMABLE');
        }
        if (reservation.state !== 'ACTIVE') {
          return rejectEvidence('GAME_RESERVATION_NOT_FOUND');
        }
        const now = timestamp(game.database_now);
        if (Date.parse(timestamp(reservation.expires_at)) <= Date.parse(now)) {
          return rejectEvidence('GAME_RESERVATION_EXPIRED');
        }
        const operationTypeAllowed =
          (game.payment_mode === 'SPLIT' &&
            ['TRANSACTION', 'SUBSCRIPTION_BOOKING'].includes(input.evidence.operationType)) ||
          (game.payment_mode === 'SUBSCRIPTION' &&
            input.evidence.operationType === 'SUBSCRIPTION_BOOKING');
        if (!operationTypeAllowed) {
          return rejectEvidence('GAME_PAYMENT_MODE_MISMATCH');
        }
        if (!['REQUIRES_ACTION', 'PROCESSING'].includes(reservation.payment_state)) {
          return rejectEvidence('GAME_NOT_CONFIRMABLE');
        }

        const participation = await queryOne<IdentifierRow>(
          client,
          `insert into games.participations (
             tenant_id, game_id, user_id, role, state, payment_state, eligibility_decision_id
           ) values ($1, $2, $3, 'PLAYER', 'ACTIVE', 'PAID', $4)
           returning id`,
          [input.tenantId, input.gameId, input.actorUserId, reservation.eligibility_decision_id],
        );
        if (!participation) throw new Error('GAME_PARTICIPATION_WRITE_LOST');
        const reservationUpdate = await client.query(
          `update games.seat_reservations
              set state = 'CONFIRMED', payment_state = 'PAID', terminal_at = now(), updated_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
          [input.tenantId, input.gameId, input.reservationId],
        );
        if (reservationUpdate.rowCount !== 1)
          throw new Error('GAME_RESERVATION_CONFIRM_WRITE_LOST');
        const revision = await bumpRevision(client, input);
        const appliedEvidence = await client.query(
          `update games.payment_confirmation_evidence
              set resolution = 'APPLIED', participation_id = $3,
                  aggregate_revision = $4, resolved_at = now()
            where tenant_id = $1 and id = $2 and resolution = 'RECEIVED'`,
          [input.tenantId, evidence.id, participation.id, revision],
        );
        if (appliedEvidence.rowCount !== 1) throw new Error('GAME_PAYMENT_EVIDENCE_APPLY_LOST');
        const result = {
          outcome: 'applied' as const,
          commandId,
          gameId: input.gameId,
          revision,
          viewerRelation: 'PARTICIPANT' as const,
          participationId: participation.id,
          reservationId: reservation.id,
          committedAt: now,
          replayed: false,
        };
        const base = eventBase(input, commandId, revision, now);
        await appendEvent(client, {
          ...base,
          type: 'game.participation.confirmed.v1',
          payload: {
            ...base.payload,
            userId: input.actorUserId,
            participationId: participation.id,
          },
        });
        await recordSuccess(client, input, commandType, result);
        return result;
      });
    },

    joinWaitlist(input) {
      const commandType = 'game.waitlist.join.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const prepared = await prepareCommand(client, input, commandType);
        if (!prepared.ready) return prepared.result;
        const now = timestamp(prepared.game.database_now);
        const rejected = await policyRejection(
          client,
          input,
          commandType,
          prepared.commandId,
          prepared.game,
          () => assertCanJoinWaitlistFacts(commandFacts(prepared.game, prepared.facts), now),
        );
        if (rejected) return rejected;
        const eligibility = await evaluateGameParticipationEligibility(
          client,
          {
            tenantId: input.tenantId,
            gameId: input.gameId,
            playerId: input.actorUserId,
            ...(input.invitationId ? { invitationId: input.invitationId } : {}),
            action: 'JOIN_WAITLIST',
            correlationId: input.correlationId,
          },
          prepared.game,
          options.onEligibilityDecision,
        );
        if (eligibility.deniedCode) {
          return storeRejected(
            client,
            input,
            commandType,
            prepared.commandId,
            eligibility.deniedCode,
            true,
            positiveInteger(prepared.game.revision),
          );
        }
        const entry = await queryOne<WaitlistRow>(
          client,
          `insert into games.waitlist_entries (
             tenant_id, game_id, user_id, position, eligibility_decision_id, personal_invitation_id
           )
           select $1, $2, $3, coalesce(max(position), 0) + 1, $4, $5
             from games.waitlist_entries
            where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
           returning id, position`,
          [
            input.tenantId,
            input.gameId,
            input.actorUserId,
            eligibility.decisionId ?? null,
            eligibility.validatedInvitationId ?? null,
          ],
        );
        if (!entry) throw new Error('GAME_WAITLIST_WRITE_LOST');
        const revision = await bumpRevision(client, input);
        const position = positiveInteger(entry.position);
        const result = {
          outcome: 'applied' as const,
          commandId: prepared.commandId,
          gameId: input.gameId,
          revision,
          viewerRelation: 'WAITLISTED' as const,
          waitlistEntryId: entry.id,
          position,
          committedAt: now,
          replayed: false,
        };
        const base = eventBase(input, prepared.commandId, revision, now);
        await appendEvent(client, {
          ...base,
          type: 'game.waitlist.joined.v1',
          payload: {
            ...base.payload,
            userId: input.actorUserId,
            waitlistEntryId: entry.id,
            position,
          },
        });
        await recordSuccess(client, input, commandType, result);
        return result;
      });
    },

    leave(input) {
      const commandType = 'game.leave.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const prepared = await prepareCommand(client, input, commandType);
        if (!prepared.ready) return prepared.result;
        const now = timestamp(prepared.game.database_now);
        if (prepared.game.payment_mode !== 'NO_PAYMENT') {
          return storeRejected(
            client,
            input,
            commandType,
            prepared.commandId,
            'GAME_PAYMENT_REQUIRED',
            true,
            positiveInteger(prepared.game.revision),
          );
        }
        const rejected = await policyRejection(
          client,
          input,
          commandType,
          prepared.commandId,
          prepared.game,
          () => assertCanLeaveGameFacts(commandFacts(prepared.game, prepared.facts), now),
        );
        if (rejected) return rejected;
        if (!prepared.facts.participation_id) throw new Error('GAME_PARTICIPATION_FACT_MISSING');
        await client.query(
          `update games.participations
              set state = 'LEFT', left_at = now(), updated_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
          [input.tenantId, input.gameId, prepared.facts.participation_id],
        );
        const revision = await bumpRevision(client, input);
        const result = {
          outcome: 'applied' as const,
          commandId: prepared.commandId,
          gameId: input.gameId,
          revision,
          viewerRelation: 'NONE' as const,
          participationId: prepared.facts.participation_id,
          committedAt: now,
          replayed: false,
        };
        const base = eventBase(input, prepared.commandId, revision, now);
        await appendEvent(client, {
          ...base,
          type: 'game.participation.left.v1',
          payload: {
            ...base.payload,
            userId: input.actorUserId,
            participationId: prepared.facts.participation_id,
          },
        });
        if (
          prepared.facts.active_participant_count + prepared.facts.active_reservation_count >=
          prepared.game.capacity
        ) {
          const users = await participantUserIds(client, input);
          await appendEvent(client, {
            ...eventBase(input, prepared.commandId, revision, now),
            type: 'game.roster.reopened.v1',
            payload: {
              ...eventBase(input, prepared.commandId, revision, now).payload,
              participantUserIds: users,
            },
          });
          await scheduleWaitlistPromotion(client, input, revision);
        }
        await recordSuccess(client, input, commandType, result);
        return result;
      });
    },

    leaveWaitlist(input) {
      const commandType = 'game.waitlist.leave.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const prepared = await prepareCommand(client, input, commandType);
        if (!prepared.ready) return prepared.result;
        const now = timestamp(prepared.game.database_now);
        const rejected = await policyRejection(
          client,
          input,
          commandType,
          prepared.commandId,
          prepared.game,
          () => assertCanLeaveWaitlistFacts(commandFacts(prepared.game, prepared.facts), now),
        );
        if (rejected) return rejected;
        if (!prepared.facts.waitlist_entry_id || prepared.facts.waitlist_position === null) {
          throw new Error('GAME_WAITLIST_FACT_MISSING');
        }
        await client.query(
          `update games.waitlist_entries
              set state = 'LEFT', terminal_at = now(), updated_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
          [input.tenantId, input.gameId, prepared.facts.waitlist_entry_id],
        );
        const revision = await bumpRevision(client, input);
        const position = positiveInteger(prepared.facts.waitlist_position);
        const result = {
          outcome: 'applied' as const,
          commandId: prepared.commandId,
          gameId: input.gameId,
          revision,
          viewerRelation: 'NONE' as const,
          waitlistEntryId: prepared.facts.waitlist_entry_id,
          position,
          committedAt: now,
          replayed: false,
        };
        const base = eventBase(input, prepared.commandId, revision, now);
        await appendEvent(client, {
          ...base,
          type: 'game.waitlist.left.v1',
          payload: {
            ...base.payload,
            userId: input.actorUserId,
            waitlistEntryId: prepared.facts.waitlist_entry_id,
            position,
          },
        });
        await recordSuccess(client, input, commandType, result);
        return result;
      });
    },

    expireReservation(input) {
      const commandType = 'game.reservation.expire.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const replay = replayProcessCommand(
          await lockProcessIdempotency(client, input),
          commandType,
          input.requestHash,
        );
        if (replay) return replay;
        const game = await lockProcessGame(client, input);
        if (!game) throw new Error('GAME_NOT_FOUND');
        const reservation = await queryOne<ExpirableReservationRow>(
          client,
          `select id, user_id, state, expires_at::text as expires_at
             from games.seat_reservations
            where tenant_id = $1 and game_id = $2 and id = $3
            for update`,
          [input.tenantId, input.gameId, input.reservationId],
        );
        const currentRevision = positiveInteger(game.revision);
        if (!reservation || reservation.state !== 'ACTIVE') {
          const result = {
            outcome: 'no_op' as const,
            commandId: input.commandId,
            gameId: input.gameId,
            revision: currentRevision,
            replayed: false,
          };
          await storeProcessResult(client, input, commandType, result);
          return result;
        }
        const expiresAt = timestamp(reservation.expires_at);
        const now = timestamp(game.database_now);
        if (Date.parse(expiresAt) > Date.parse(now)) {
          return { outcome: 'not_due' as const, availableAt: expiresAt };
        }
        const before = await loadCapacity(client, input.tenantId, input.gameId);
        await client.query(
          `update games.seat_reservations
              set state = 'EXPIRED', payment_state = 'EXPIRED', terminal_at = now(), updated_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
          [input.tenantId, input.gameId, input.reservationId],
        );
        const revision = await bumpRevision(client, input);
        const base = processEventBase(input, revision, now);
        await appendEvent(client, {
          ...base,
          type: 'game.participation.expired.v1',
          payload: {
            ...base.payload,
            userId: reservation.user_id,
            reservationId: reservation.id,
            reasonCode: 'RESERVATION_EXPIRED',
          },
        });
        if (
          before.active_participant_count + before.active_reservation_count + 1 >=
          game.capacity
        ) {
          const users = await participantUserIds(client, input);
          const reopened = processEventBase(input, revision, now);
          await appendEvent(client, {
            ...reopened,
            type: 'game.roster.reopened.v1',
            payload: { ...reopened.payload, participantUserIds: users },
          });
          await scheduleWaitlistPromotion(client, input, revision);
        }
        const result = {
          outcome: 'applied' as const,
          commandId: input.commandId,
          gameId: input.gameId,
          revision,
          replayed: false,
        };
        await storeProcessResult(client, input, commandType, result);
        return result;
      });
    },

    promoteWaitlist(input) {
      const commandType = 'game.waitlist.promote.v1';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const replay = replayProcessCommand(
          await lockProcessIdempotency(client, input),
          commandType,
          input.requestHash,
        );
        if (replay) return replay;
        const game = await lockProcessGame(client, input);
        if (!game) throw new Error('GAME_NOT_FOUND');
        const currentRevision = positiveInteger(game.revision);
        if (game.payment_mode !== 'NO_PAYMENT') {
          const result = {
            outcome: 'no_op' as const,
            commandId: input.commandId,
            gameId: input.gameId,
            revision: currentRevision,
            replayed: false,
          };
          await storeProcessResult(client, input, commandType, result);
          return result;
        }
        const capacity = await loadCapacity(client, input.tenantId, input.gameId);
        const entry = await queryOne<PromotableWaitlistRow>(
          client,
          `select id, user_id, position, state, personal_invitation_id
             from games.waitlist_entries
            where tenant_id = $1 and game_id = $2 and id = $3
              and position = (
                select min(position) from games.waitlist_entries
                 where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
              )
            for update`,
          [input.tenantId, input.gameId, input.waitlistEntryId],
        );
        if (
          game.lifecycle_state !== 'SCHEDULED' ||
          capacity.active_participant_count + capacity.active_reservation_count >= game.capacity ||
          !entry ||
          entry.state !== 'ACTIVE'
        ) {
          const result = {
            outcome: 'no_op' as const,
            commandId: input.commandId,
            gameId: input.gameId,
            revision: currentRevision,
            replayed: false,
          };
          await storeProcessResult(client, input, commandType, result);
          return result;
        }

        const eligibility = await evaluateGameParticipationEligibility(
          client,
          {
            tenantId: input.tenantId,
            gameId: input.gameId,
            playerId: entry.user_id,
            ...(entry.personal_invitation_id ? { invitationId: entry.personal_invitation_id } : {}),
            action: 'PROMOTE_WAITLIST',
            correlationId: input.correlationId,
          },
          game,
          options.onEligibilityDecision,
        );
        if (eligibility.deniedCode) {
          await client.query(
            `update games.waitlist_entries
                set state = 'EXPIRED', terminal_at = now(), updated_at = now(),
                    eligibility_decision_id = $4
              where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
            [input.tenantId, input.gameId, entry.id, eligibility.decisionId ?? null],
          );
          const revision = await bumpRevision(client, input);
          await scheduleWaitlistPromotion(client, input, revision);
          const result = {
            outcome: 'applied' as const,
            commandId: input.commandId,
            gameId: input.gameId,
            revision,
            replayed: false,
          };
          await storeProcessResult(client, input, commandType, result);
          return result;
        }

        await client.query(
          `update games.waitlist_entries
              set state = 'PROMOTED', terminal_at = now(), updated_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
          [input.tenantId, input.gameId, entry.id],
        );
        const now = timestamp(game.database_now);
        const participation = await queryOne<IdentifierRow>(
          client,
          `insert into games.participations (
             tenant_id, game_id, user_id, role, state, payment_state, eligibility_decision_id
           ) values ($1, $2, $3, 'PLAYER', 'ACTIVE', 'NOT_REQUIRED', $4)
           returning id`,
          [input.tenantId, input.gameId, entry.user_id, eligibility.decisionId ?? null],
        );
        if (!participation) throw new Error('GAME_PROMOTION_PARTICIPATION_WRITE_LOST');
        const targetRelation = 'PARTICIPANT' as const;
        const targetId = participation.id;
        const revision = await bumpRevision(client, input);
        const promoted = processEventBase(input, revision, now);
        await appendEvent(client, {
          ...promoted,
          type: 'game.waitlist.promoted.v1',
          payload: {
            ...promoted.payload,
            userId: entry.user_id,
            waitlistEntryId: entry.id,
            position: positiveInteger(entry.position),
            targetRelation,
            targetId,
          },
        });
        await consumePersonalInvitation(client, input.tenantId, eligibility.validatedInvitationId);
        const participationEvent = processEventBase(input, revision, now);
        await appendEvent(client, {
          ...participationEvent,
          type: 'game.participation.confirmed.v1',
          payload: {
            ...participationEvent.payload,
            userId: entry.user_id,
            participationId: targetId,
          },
        });
        const users = await participantUserIds(client, input);
        if (users.length === game.capacity) {
          const completed = processEventBase(input, revision, now);
          await appendEvent(client, {
            ...completed,
            type: 'game.roster.completed.v1',
            payload: { ...completed.payload, participantUserIds: users },
          });
        }
        const result = {
          outcome: 'applied' as const,
          commandId: input.commandId,
          gameId: input.gameId,
          revision,
          replayed: false,
        };
        await storeProcessResult(client, input, commandType, result);
        return result;
      });
    },

    getOperation(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<OperationRow>(
          client,
          `select id, command_type, request_hash, state, result_payload, error_code,
                  aggregate_id, completed_at::text as completed_at
             from games.command_idempotency
            where tenant_id = $1 and id = $2 and actor_user_id = $3
              and command_type = any($4::text[])
              and state in ('COMPLETED', 'FAILED')`,
          [input.tenantId, input.operationId, input.actorUserId, USER_ROSTER_COMMAND_TYPES],
        );
        if (!row || !isUserRosterCommandType(row.command_type)) return undefined;
        const committedAt = timestamp(row.completed_at);
        if (row.state === 'FAILED') {
          if (!row.error_code) throw new Error('GAME_OPERATION_ERROR_MISSING');
          return {
            commandId: row.id,
            commandType: row.command_type,
            gameId: row.aggregate_id,
            state: 'FAILED',
            committedAt,
            errorCode: row.error_code as GameRosterCommandErrorCode,
          };
        }
        const result = parseAppliedResult(row.result_payload);
        if (!result) throw new Error('GAME_OPERATION_RESULT_INVALID');
        return {
          commandId: row.id,
          commandType: row.command_type,
          gameId: row.aggregate_id,
          state: 'COMPLETED',
          committedAt,
          result,
        };
      });
    },
  };
}
