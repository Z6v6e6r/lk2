import { randomUUID } from 'node:crypto';

import {
  gameCardProjectionInputSchema,
  gameDomainEventSchema,
  type GameCardProjectionInput,
  type GameKind,
  type GameLifecycleState,
  type GamePlayerLevel,
  type GameResultSetInput,
  type GameVisibility,
} from '@phub/games';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type GamePaymentMode = 'ORGANIZER_PAYS' | 'SPLIT' | 'SUBSCRIPTION' | 'NO_PAYMENT';
export type GameCancellationReason =
  'ORGANIZER_REQUEST' | 'VENUE_UNAVAILABLE' | 'WEATHER' | 'SAFETY' | 'OTHER';

export interface StoredGame {
  readonly id: string;
  readonly tenantId: string;
  readonly revision: number;
  readonly organizerUserId: string;
  readonly title: string;
  readonly kind: GameKind;
  readonly visibility: GameVisibility;
  readonly lifecycleState: GameLifecycleState;
  readonly stationId: string;
  readonly courtId: string | null;
  readonly bookingId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly capacity: number;
  readonly waitlistEnabled: boolean;
  readonly joinCutoffAt: string | null;
  readonly paymentMode: GamePaymentMode;
  readonly levelFrom: GamePlayerLevel | null;
  readonly levelTo: GamePlayerLevel | null;
  readonly resultState:
    | 'NOT_AVAILABLE'
    | 'AWAITING_SUBMISSION'
    | 'PENDING_CONFIRMATION'
    | 'CONFIRMED'
    | 'DISPUTED'
    | 'VOID';
  readonly cardProjectionRevision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredGameCardProjection {
  readonly gameId: string;
  readonly aggregateRevision: number;
  readonly projectionRevision: number;
  readonly lifecycleState: 'SCHEDULED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';
  readonly visibility: GameVisibility;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly basePayload: GameCardProjectionInput;
  readonly projectedAt: string;
}

export interface StoredGameCardProjectionPage {
  readonly items: readonly StoredGameCardProjection[];
  readonly next?: { readonly startsAt: string; readonly gameId: string };
}

export interface GameRecommendationProjectionInputs {
  readonly candidates: readonly StoredGameCardProjection[];
  readonly history: readonly StoredGameCardProjection[];
}

export interface ClaimedGameScheduledCommand {
  readonly id: string;
  readonly gameId: string;
  readonly commandType:
    | 'game.provisioning.advance.v1'
    | 'game.reservation.expire.v1'
    | 'game.waitlist.promote.v1'
    | 'game.lifecycle.start.v1'
    | 'game.lifecycle.finish.v1'
    | 'game.integration.reconcile.v1';
  readonly expectedRevision: number | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempts: number;
}

export type GameLifecycleCommandType = 'game.lifecycle.start.v1' | 'game.lifecycle.finish.v1';

export type GameLifecycleCommandExecutionResult =
  | {
      readonly outcome: 'applied';
      readonly gameId: string;
      readonly lifecycleState: 'IN_PROGRESS' | 'FINISHED';
      readonly revision: number;
      readonly eventId: string;
    }
  | {
      readonly outcome: 'already_applied';
      readonly gameId: string;
    }
  | {
      readonly outcome: 'rescheduled';
      readonly gameId: string;
      readonly dueAt: string;
      readonly expectedRevision: number;
    }
  | { readonly outcome: 'not_claimed' };

export interface CreateStoredGameInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
  readonly title: string;
  readonly kind: GameKind;
  readonly visibility: GameVisibility;
  readonly stationId: string;
  readonly courtId?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
  readonly capacity: number;
  readonly waitlistEnabled: boolean;
  readonly joinCutoffAt?: string;
  readonly paymentMode: GamePaymentMode;
  readonly levelFrom?: GamePlayerLevel;
  readonly levelTo?: GamePlayerLevel;
}

export type CreateStoredGameResult =
  | {
      readonly outcome: 'applied';
      readonly gameId: string;
      readonly operationId: string;
      readonly revision: number;
      readonly committedAt: string;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' };

export interface CancelStoredGameInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
  readonly reasonCode: GameCancellationReason;
  readonly note?: string | null;
}

export type CancelStoredGameResult =
  | {
      readonly outcome: 'applied';
      readonly commandId: string;
      readonly gameId: string;
      readonly revision: number;
      readonly committedAt: string;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: 'GAME_NOT_FOUND' | 'GAME_NOT_CANCELLABLE' | 'GAME_PAYMENT_REQUIRED';
      readonly currentRevision?: number;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' };

export type GameManagementOperation =
  | {
      readonly commandType: 'game.create.v1';
      readonly result: Extract<CreateStoredGameResult, { readonly outcome: 'applied' }>;
    }
  | {
      readonly commandType: 'game.cancel.v1';
      readonly result: Extract<CancelStoredGameResult, { readonly outcome: 'applied' }>;
    };

type StoredCreateAppliedResult = Omit<
  Extract<CreateStoredGameResult, { readonly outcome: 'applied' }>,
  'replayed'
>;

export interface GameRepository {
  get(tenantId: string, gameId: string): Promise<StoredGame | undefined>;
  create(input: CreateStoredGameInput): Promise<CreateStoredGameResult>;
  cancel(input: CancelStoredGameInput): Promise<CancelStoredGameResult>;
  getManagementOperation(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly operationId: string;
  }): Promise<GameManagementOperation | undefined>;
  upsertCardProjection(input: {
    readonly tenantId: string;
    readonly projectionRevision: number;
    readonly snapshot: GameCardProjectionInput;
  }): Promise<'applied' | 'stale' | 'game_not_found'>;
  listPublicCardProjections(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly after?: { readonly startsAt: string; readonly gameId: string };
  }): Promise<StoredGameCardProjectionPage>;
  getCardProjection(
    tenantId: string,
    gameId: string,
  ): Promise<StoredGameCardProjection | undefined>;
  listViewerCardProjections(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly scope: 'UPCOMING' | 'HISTORY';
    readonly limit: number;
    readonly after?: { readonly startsAt: string; readonly gameId: string };
  }): Promise<StoredGameCardProjectionPage>;
  listRecommendationCardProjections(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly candidateLimit: number;
    readonly historyLimit: number;
  }): Promise<GameRecommendationProjectionInputs>;
  projectCardEvent(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly gameId: string;
  }): Promise<
    'applied' | 'duplicate' | 'stale' | 'game_not_found' | 'not_card_visible' | 'dependency_missing'
  >;
  claimScheduledCommands(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly limit: number;
    readonly commandTypes?: readonly ClaimedGameScheduledCommand['commandType'][];
  }): Promise<readonly ClaimedGameScheduledCommand[]>;
  executeLifecycleCommand(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly commandId: string;
    readonly correlationId: string;
    readonly occurredAt?: Date;
  }): Promise<GameLifecycleCommandExecutionResult>;
  completeScheduledCommand(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly commandId: string;
  }): Promise<boolean>;
  retryScheduledCommand(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly commandId: string;
    readonly errorCode: string;
    readonly availableAt: string;
  }): Promise<'retry_scheduled' | 'attempts_exhausted' | 'not_claimed'>;
}

interface GameRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly revision: string | number;
  readonly organizer_user_id: string;
  readonly title: string;
  readonly kind: GameKind;
  readonly visibility: GameVisibility;
  readonly lifecycle_state: GameLifecycleState;
  readonly station_id: string;
  readonly court_id: string | null;
  readonly booking_id: string | null;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
  readonly timezone: string;
  readonly capacity: number;
  readonly waitlist_enabled: boolean;
  readonly join_cutoff_at: Date | string | null;
  readonly payment_mode: GamePaymentMode;
  readonly level_from: GamePlayerLevel | null;
  readonly level_to: GamePlayerLevel | null;
  readonly result_state: StoredGame['resultState'];
  readonly card_projection_revision: string | number | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface IdempotencyRow extends QueryResultRow {
  readonly command_type: string;
  readonly request_hash: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly result_payload: unknown;
  readonly completed_at: Date | string | null;
}

interface CanonicalGameLevelRow extends QueryResultRow {
  readonly id: string;
  readonly code: GamePlayerLevel;
  readonly rank: number | string;
  readonly scale_version: number | string;
}

interface ProjectionRow extends QueryResultRow {
  readonly game_id: string;
  readonly aggregate_revision: string | number;
  readonly projection_revision: string | number;
  readonly lifecycle_state: StoredGameCardProjection['lifecycleState'];
  readonly visibility: GameVisibility;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
  readonly base_payload: unknown;
  readonly projected_at: Date | string;
}

interface RecommendationProjectionRow extends ProjectionRow {
  readonly input_kind: 'candidate' | 'history';
}

interface ProjectionSourceGameRow extends GameRow {
  readonly station_name: string;
  readonly station_short_address: string | null;
  readonly court_name: string | null;
}

interface ProjectionParticipantRow extends QueryResultRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly photo_url: string | null;
  readonly level_label: GamePlayerLevel | null;
  readonly level_value: number | string | null;
  readonly role: 'ORGANIZER' | 'PLAYER';
  readonly payment_state: 'NOT_REQUIRED' | 'PAID' | 'REFUND_PENDING' | 'REFUNDED';
}

interface ProjectionReservationRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly expires_at: Date | string;
  readonly payment_state: 'REQUIRES_ACTION' | 'PROCESSING' | 'PAID' | 'FAILED' | 'EXPIRED';
}

interface ProjectionWaitlistRow extends QueryResultRow {
  readonly user_id: string;
  readonly position: string | number;
}

interface ProjectionResultRow extends QueryResultRow {
  readonly id: string;
  readonly submitted_by_user_id: string;
  readonly submitted_at: Date | string;
  readonly confirmation_quorum: number;
  readonly score_payload: unknown;
  readonly roster_snapshot: unknown;
}

interface ProjectionReviewRow extends QueryResultRow {
  readonly reviewer_user_id: string;
  readonly decision: 'PENDING' | 'CONFIRMED' | 'DISPUTED';
}

interface ScheduledCommandRow extends QueryResultRow {
  readonly id: string;
  readonly game_id: string;
  readonly command_type: ClaimedGameScheduledCommand['commandType'];
  readonly expected_revision: string | number | null;
  readonly payload: unknown;
  readonly attempts: number;
}

interface ClaimedLifecycleCommandRow extends QueryResultRow {
  readonly id: string;
  readonly game_id: string;
  readonly command_type: GameLifecycleCommandType;
  readonly due_at: Date | string;
  readonly expected_revision: string | number | null;
}

interface LifecycleGameRow extends QueryResultRow {
  readonly id: string;
  readonly revision: string | number;
  readonly lifecycle_state: GameLifecycleState;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string;
}

interface AttemptsRow extends QueryResultRow {
  readonly attempts: number;
}

const GAME_COLUMNS = `
  id, tenant_id, revision, organizer_user_id, title, kind, visibility,
  lifecycle_state, station_id, court_id, booking_id, starts_at, ends_at,
  timezone, capacity, waitlist_enabled, join_cutoff_at, payment_mode,
  level_from, level_to, result_state, card_projection_revision, created_at, updated_at
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function positiveInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('GAME_REVISION_INVALID');
  return parsed;
}

function nullablePositiveInteger(value: string | number | null): number | null {
  return value === null ? null : positiveInteger(value);
}

function mapGame(row: GameRow): StoredGame {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    revision: positiveInteger(row.revision),
    organizerUserId: row.organizer_user_id,
    title: row.title,
    kind: row.kind,
    visibility: row.visibility,
    lifecycleState: row.lifecycle_state,
    stationId: row.station_id,
    courtId: row.court_id,
    bookingId: row.booking_id,
    startsAt: timestamp(row.starts_at),
    endsAt: timestamp(row.ends_at),
    timezone: row.timezone,
    capacity: row.capacity,
    waitlistEnabled: row.waitlist_enabled,
    joinCutoffAt: nullableTimestamp(row.join_cutoff_at),
    paymentMode: row.payment_mode,
    levelFrom: row.level_from,
    levelTo: row.level_to,
    resultState: row.result_state,
    cardProjectionRevision: nullablePositiveInteger(row.card_projection_revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapProjection(row: ProjectionRow): StoredGameCardProjection {
  return {
    gameId: row.game_id,
    aggregateRevision: positiveInteger(row.aggregate_revision),
    projectionRevision: positiveInteger(row.projection_revision),
    lifecycleState: row.lifecycle_state,
    visibility: row.visibility,
    startsAt: timestamp(row.starts_at),
    endsAt: timestamp(row.ends_at),
    basePayload: gameCardProjectionInputSchema.parse(row.base_payload),
    projectedAt: timestamp(row.projected_at),
  };
}

function scoreSets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).sets;
}

function resultRoster(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const participantUserIds = (value as Record<string, unknown>).participantUserIds;
  return Array.isArray(participantUserIds) &&
    participantUserIds.every((item) => typeof item === 'string')
    ? participantUserIds
    : [];
}

function storedCreateResult(
  value: unknown,
  fallbackCommittedAt?: string,
): StoredCreateAppliedResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.outcome !== 'applied' ||
    typeof candidate.gameId !== 'string' ||
    typeof candidate.operationId !== 'string' ||
    typeof candidate.revision !== 'number' ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision <= 0
  ) {
    return undefined;
  }
  const committedAt =
    typeof candidate.committedAt === 'string' && !Number.isNaN(Date.parse(candidate.committedAt))
      ? candidate.committedAt
      : fallbackCommittedAt;
  if (!committedAt || Number.isNaN(Date.parse(committedAt))) return undefined;
  return {
    outcome: 'applied',
    gameId: candidate.gameId,
    operationId: candidate.operationId,
    revision: candidate.revision,
    committedAt,
  };
}

async function existingCommand(
  client: PoolClient,
  input: Pick<CreateStoredGameInput, 'tenantId' | 'actorUserId' | 'idempotencyKey'>,
): Promise<IdempotencyRow | undefined> {
  return queryOne<IdempotencyRow>(
    client,
    `select command_type, request_hash, state, result_payload, completed_at
       from games.command_idempotency
      where tenant_id = $1 and principal_key = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, `user:${input.actorUserId}`, input.idempotencyKey],
  );
}

function replayCreate(
  row: IdempotencyRow | undefined,
  requestHash: string,
): CreateStoredGameResult | undefined {
  if (!row) return undefined;
  if (
    row.command_type !== 'game.create.v1' ||
    row.request_hash !== requestHash ||
    row.state !== 'COMPLETED'
  ) {
    return { outcome: 'idempotency_conflict' };
  }
  const stored = storedCreateResult(
    row.result_payload,
    row.completed_at == null ? undefined : timestamp(row.completed_at),
  );
  if (!stored) throw new Error('GAME_IDEMPOTENCY_RESULT_INVALID');
  return { ...stored, replayed: true };
}

function storedCancelResult(
  value: unknown,
): Exclude<CancelStoredGameResult, { outcome: 'idempotency_conflict' }> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome === 'rejected') {
    if (
      !['GAME_NOT_FOUND', 'GAME_NOT_CANCELLABLE', 'GAME_PAYMENT_REQUIRED'].includes(
        String(candidate.code),
      )
    ) {
      return undefined;
    }
    return {
      outcome: 'rejected',
      code: candidate.code as Extract<CancelStoredGameResult, { outcome: 'rejected' }>['code'],
      ...(typeof candidate.currentRevision === 'number'
        ? { currentRevision: candidate.currentRevision }
        : {}),
      replayed: true,
    };
  }
  if (
    candidate.outcome !== 'applied' ||
    typeof candidate.commandId !== 'string' ||
    typeof candidate.gameId !== 'string' ||
    typeof candidate.revision !== 'number' ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision <= 0 ||
    typeof candidate.committedAt !== 'string' ||
    Number.isNaN(Date.parse(candidate.committedAt))
  ) {
    return undefined;
  }
  return {
    outcome: 'applied',
    commandId: candidate.commandId,
    gameId: candidate.gameId,
    revision: candidate.revision,
    committedAt: candidate.committedAt,
    replayed: true,
  };
}

function replayCancel(
  row: IdempotencyRow | undefined,
  requestHash: string,
): CancelStoredGameResult | undefined {
  if (!row) return undefined;
  if (
    row.command_type !== 'game.cancel.v1' ||
    row.request_hash !== requestHash ||
    row.state !== 'COMPLETED'
  ) {
    return { outcome: 'idempotency_conflict' };
  }
  const stored = storedCancelResult(row.result_payload);
  if (!stored) throw new Error('GAME_IDEMPOTENCY_RESULT_INVALID');
  return stored;
}

async function insertOutboxEvent(client: PoolClient, rawEvent: unknown): Promise<void> {
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

function mapScheduledCommand(row: ScheduledCommandRow): ClaimedGameScheduledCommand {
  if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
    throw new Error('GAME_SCHEDULED_COMMAND_PAYLOAD_INVALID');
  }
  return {
    id: row.id,
    gameId: row.game_id,
    commandType: row.command_type,
    expectedRevision: nullablePositiveInteger(row.expected_revision),
    payload: row.payload as Readonly<Record<string, unknown>>,
    attempts: row.attempts,
  };
}

export function createGameRepository(pool: Pool): GameRepository {
  return {
    get(tenantId, gameId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<GameRow>(
          client,
          `select ${GAME_COLUMNS}
             from games.games
            where tenant_id = $1
              and id = coalesce((
                select target_game_id
                  from integration.legacy_game_merge_redirects
                 where tenant_id = $1 and source_game_id = $2
              ), $2)`,
          [tenantId, gameId],
        );
        return row ? mapGame(row) : undefined;
      });
    },

    create(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const principalKey = `user:${input.actorUserId}`;
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `game-command:${input.tenantId}:${principalKey}:${input.idempotencyKey}`,
        ]);
        const replay = replayCreate(await existingCommand(client, input), input.requestHash);
        if (replay) return replay;

        const operationId = randomUUID();
        const commandId = operationId;
        const immediateSchedule = input.paymentMode === 'NO_PAYMENT';
        if (Boolean(input.levelFrom) !== Boolean(input.levelTo)) {
          throw new Error('GAME_CREATE_LEVEL_RANGE_INVALID');
        }
        let minimumLevelId: string | null = null;
        let maximumLevelId: string | null = null;
        if (input.levelFrom && input.levelTo) {
          const levels = await client.query<CanonicalGameLevelRow>(
            `select id, code, rank, scale_version
               from eligibility.canonical_levels
              where tenant_id = $1
                and sport_code = 'PADEL'
                and active
                and scale_version = (
                  select max(scale_version)
                    from eligibility.canonical_levels
                   where tenant_id = $1 and sport_code = 'PADEL' and active
                )
                and code = any($2::text[])
              order by rank, id`,
            [input.tenantId, [input.levelFrom, input.levelTo]],
          );
          const byCode = new Map(levels.rows.map((level) => [level.code, level]));
          const minimum = byCode.get(input.levelFrom);
          const maximum = byCode.get(input.levelTo);
          if (
            !minimum ||
            !maximum ||
            Number(minimum.scale_version) !== Number(maximum.scale_version) ||
            Number(minimum.rank) > Number(maximum.rank)
          ) {
            throw new Error('GAME_CREATE_LEVEL_RANGE_INVALID');
          }
          minimumLevelId = minimum.id;
          maximumLevelId = maximum.id;
        }
        const created = await queryOne<GameRow>(
          client,
          `insert into games.games (
             tenant_id, organizer_user_id, title, kind, visibility, lifecycle_state,
             station_id, court_id, starts_at, ends_at, timezone, capacity,
             waitlist_enabled, join_cutoff_at, payment_mode, level_from, level_to,
             sport_code, min_level_id, max_level_id
           ) values (
             $1, $2, $3, $4, $5, $19, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16, 'PADEL', $17, $18
           ) returning ${GAME_COLUMNS}`,
          [
            input.tenantId,
            input.actorUserId,
            input.title,
            input.kind,
            input.visibility,
            input.stationId,
            input.courtId ?? null,
            input.startsAt,
            input.endsAt,
            input.timezone,
            input.capacity,
            input.waitlistEnabled,
            input.joinCutoffAt ?? null,
            input.paymentMode,
            input.levelFrom ?? null,
            input.levelTo ?? null,
            minimumLevelId,
            maximumLevelId,
            immediateSchedule ? 'SCHEDULED' : 'PROVISIONING',
          ],
        );
        if (!created) throw new Error('GAME_CREATE_WRITE_LOST');
        const game = mapGame(created);

        await client.query(
          `insert into games.participations (
             tenant_id, game_id, user_id, role, state, payment_state
           ) values ($1, $2, $3, 'ORGANIZER', 'ACTIVE', $4)`,
          [input.tenantId, game.id, input.actorUserId, 'NOT_REQUIRED'],
        );
        await client.query(
          `insert into games.operations (
             tenant_id, id, game_id, kind, state, requested_by_user_id, completed_at
           ) values ($1, $2, $3, 'CREATE_GAME', $5, $4,
             case when $5 = 'SUCCEEDED' then now() else null end)`,
          [
            input.tenantId,
            operationId,
            game.id,
            input.actorUserId,
            immediateSchedule ? 'SUCCEEDED' : 'PENDING',
          ],
        );
        if (immediateSchedule) {
          await client.query(
            `insert into games.scheduled_commands (
               tenant_id, game_id, command_type, due_at, expected_revision, payload
             ) values
               ($1, $2, 'game.lifecycle.start.v1', $3, $5, $6::jsonb),
               ($1, $2, 'game.lifecycle.finish.v1', $4, $5, $6::jsonb)`,
            [
              input.tenantId,
              game.id,
              game.startsAt,
              game.endsAt,
              game.revision,
              JSON.stringify({ gameId: game.id, expectedRevision: String(game.revision) }),
            ],
          );
        } else {
          await client.query(
            `insert into games.scheduled_commands (
               tenant_id, game_id, command_type, due_at, expected_revision, payload
             ) values ($1, $2, 'game.provisioning.advance.v1', now(), $3, $4::jsonb)`,
            [input.tenantId, game.id, game.revision, JSON.stringify({ operationId })],
          );
        }

        const occurredAt = new Date().toISOString();
        const result = {
          outcome: 'applied' as const,
          gameId: game.id,
          operationId,
          revision: game.revision,
          committedAt: occurredAt,
        };
        await client.query(
          `insert into games.command_idempotency (
             tenant_id, id, actor_user_id, principal_key, idempotency_key,
             command_type, request_hash, aggregate_id, state, result_payload, completed_at
           ) values ($1, $2, $3, $4, $5, 'game.create.v1', $6, $7, 'COMPLETED', $8::jsonb, now())`,
          [
            input.tenantId,
            commandId,
            input.actorUserId,
            principalKey,
            input.idempotencyKey,
            input.requestHash,
            game.id,
            JSON.stringify(result),
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'GAME_CREATED', 'GAME', $3, 'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            game.id,
            input.correlationId,
            JSON.stringify({
              revision: game.revision,
              lifecycleState: game.lifecycleState,
              kind: game.kind,
              visibility: game.visibility,
              operationId,
              participationEligibility: {
                ruleCode: 'LEVEL_RANGE',
                outcome: 'BYPASS',
                reasonCode: 'ORGANIZER_CREATION_BYPASS',
              },
            }),
          ],
        );

        const eventBase = {
          aggregateId: game.id,
          tenantId: input.tenantId,
          occurredAt,
          correlationId: input.correlationId,
        };
        const payloadBase = {
          gameId: game.id,
          aggregateRevision: String(game.revision),
          causationId: commandId,
          actorUserId: input.actorUserId,
        };
        await insertOutboxEvent(client, {
          ...eventBase,
          id: randomUUID(),
          type: 'game.created.v1',
          payload: {
            ...payloadBase,
            organizerUserId: input.actorUserId,
            kind: input.kind,
            visibility: input.visibility,
          },
        });
        if (immediateSchedule) {
          await insertOutboxEvent(client, {
            ...eventBase,
            id: randomUUID(),
            type: 'game.scheduled.v1',
            payload: { ...payloadBase, organizerUserId: input.actorUserId },
          });
          if (input.visibility === 'PUBLIC') {
            await insertOutboxEvent(client, {
              ...eventBase,
              id: randomUUID(),
              type: 'game.published.v1',
              payload: { ...payloadBase, visibility: input.visibility },
            });
          }
        } else {
          await insertOutboxEvent(client, {
            ...eventBase,
            id: randomUUID(),
            type: 'game.provisioning.requested.v1',
            payload: { ...payloadBase, operationId },
          });
        }
        return { ...result, replayed: false };
      });
    },

    cancel(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const principalKey = `user:${input.actorUserId}`;
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `game-command:${input.tenantId}:${principalKey}:${input.idempotencyKey}`,
        ]);
        const replay = replayCancel(await existingCommand(client, input), input.requestHash);
        if (replay) return replay;

        const commandId = randomUUID();
        const gameRow = await queryOne<GameRow>(
          client,
          `select ${GAME_COLUMNS}
             from games.games
            where tenant_id = $1 and id = $2
            for update`,
          [input.tenantId, input.gameId],
        );
        const game = gameRow ? mapGame(gameRow) : undefined;
        const rejectionCode = !game
          ? ('GAME_NOT_FOUND' as const)
          : game.organizerUserId !== input.actorUserId ||
              !['PROVISIONING', 'SCHEDULED'].includes(game.lifecycleState)
            ? ('GAME_NOT_CANCELLABLE' as const)
            : game.paymentMode !== 'NO_PAYMENT'
              ? ('GAME_PAYMENT_REQUIRED' as const)
              : undefined;
        if (rejectionCode) {
          const rejected = {
            outcome: 'rejected' as const,
            code: rejectionCode,
            ...(game ? { currentRevision: game.revision } : {}),
          };
          await client.query(
            `insert into games.command_idempotency (
               tenant_id, id, actor_user_id, principal_key, idempotency_key,
               command_type, request_hash, aggregate_id, state, result_payload, completed_at
             ) values ($1, $2, $3, $4, $5, 'game.cancel.v1', $6, $7,
               'COMPLETED', $8::jsonb, now())`,
            [
              input.tenantId,
              commandId,
              input.actorUserId,
              principalKey,
              input.idempotencyKey,
              input.requestHash,
              game?.id ?? null,
              JSON.stringify(rejected),
            ],
          );
          return { ...rejected, replayed: false };
        }
        if (!game) throw new Error('GAME_CANCEL_STATE_INVALID');

        const committedAt = new Date().toISOString();
        const updated = await queryOne<{ revision: string | number } & QueryResultRow>(
          client,
          `update games.games set
             revision = revision + 1,
             lifecycle_state = 'CANCELLED',
             cancellation_reason_code = $4,
             cancelled_by_user_id = $3,
             cancelled_at = $5,
             updated_at = $5
           where tenant_id = $1 and id = $2
             and organizer_user_id = $3
             and lifecycle_state in ('PROVISIONING', 'SCHEDULED')
             and payment_mode = 'NO_PAYMENT'
           returning revision`,
          [input.tenantId, game.id, input.actorUserId, input.reasonCode, committedAt],
        );
        if (!updated) throw new Error('GAME_CANCEL_WRITE_LOST');
        const revision = positiveInteger(updated.revision);
        const participants = await client.query<{ user_id: string } & QueryResultRow>(
          `select user_id from games.participations
            where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
            order by user_id`,
          [input.tenantId, game.id],
        );
        const result = {
          outcome: 'applied' as const,
          commandId,
          gameId: game.id,
          revision,
          committedAt,
        };
        await client.query(
          `insert into games.operations (
             tenant_id, id, game_id, kind, state, requested_by_user_id, completed_at
           ) values ($1, $2, $3, 'CANCEL_GAME', 'SUCCEEDED', $4, $5)`,
          [input.tenantId, commandId, game.id, input.actorUserId, committedAt],
        );
        await client.query(
          `insert into games.command_idempotency (
             tenant_id, id, actor_user_id, principal_key, idempotency_key,
             command_type, request_hash, aggregate_id, state, result_payload, completed_at
           ) values ($1, $2, $3, $4, $5, 'game.cancel.v1', $6, $7,
             'COMPLETED', $8::jsonb, $9)`,
          [
            input.tenantId,
            commandId,
            input.actorUserId,
            principalKey,
            input.idempotencyKey,
            input.requestHash,
            game.id,
            JSON.stringify(result),
            committedAt,
          ],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, old_value, new_value
           ) values ($1, $2, 'GAME_CANCELLED', 'GAME', $3, 'SUCCESS', $4, $5::jsonb, $6::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            game.id,
            input.correlationId,
            JSON.stringify({ revision: game.revision, lifecycleState: game.lifecycleState }),
            JSON.stringify({
              revision,
              lifecycleState: 'CANCELLED',
              reasonCode: input.reasonCode,
              noteProvided: Boolean(input.note),
            }),
          ],
        );
        await insertOutboxEvent(client, {
          id: randomUUID(),
          type: 'game.cancelled.v1',
          aggregateId: game.id,
          tenantId: input.tenantId,
          occurredAt: committedAt,
          correlationId: input.correlationId,
          payload: {
            gameId: game.id,
            aggregateRevision: String(revision),
            causationId: commandId,
            actorUserId: input.actorUserId,
            participantUserIds: participants.rows.map((row) => row.user_id),
            reasonCode: input.reasonCode,
          },
        });
        return { ...result, replayed: false };
      });
    },

    getManagementOperation(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<IdempotencyRow>(
          client,
          `select command_type, request_hash, state, result_payload, completed_at
             from games.command_idempotency
            where tenant_id = $1 and id = $2 and actor_user_id = $3
              and command_type in ('game.create.v1', 'game.cancel.v1')
              and state = 'COMPLETED'`,
          [input.tenantId, input.operationId, input.actorUserId],
        );
        if (!row) return undefined;
        if (row.command_type === 'game.create.v1') {
          const stored = storedCreateResult(
            row.result_payload,
            row.completed_at == null ? undefined : timestamp(row.completed_at),
          );
          if (!stored) throw new Error('GAME_OPERATION_RESULT_INVALID');
          return {
            commandType: row.command_type,
            result: { ...stored, replayed: true },
          };
        }
        if (row.command_type === 'game.cancel.v1') {
          const stored = storedCancelResult(row.result_payload);
          if (!stored || stored.outcome !== 'applied') {
            throw new Error('GAME_OPERATION_RESULT_INVALID');
          }
          return { commandType: row.command_type, result: stored };
        }
        return undefined;
      });
    },

    upsertCardProjection(input) {
      const snapshot = gameCardProjectionInputSchema.parse(input.snapshot);
      if (snapshot.tenantId !== input.tenantId) {
        throw new Error('GAME_PROJECTION_TENANT_MISMATCH');
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const game = await queryOne<{ revision: string | number } & QueryResultRow>(
          client,
          `select revision
             from games.games
            where tenant_id = $1 and id = $2
              and not exists (
                select 1
                  from integration.legacy_game_merge_redirects redirect
                 where redirect.tenant_id = $1 and redirect.source_game_id = $2
              )
            for update`,
          [input.tenantId, snapshot.id],
        );
        if (!game) return 'game_not_found';
        if (positiveInteger(game.revision) !== snapshot.revision) return 'stale';
        const applied = await client.query(
          `insert into games.card_projections (
             tenant_id, game_id, aggregate_revision, projection_revision,
             lifecycle_state, visibility, starts_at, ends_at, base_payload
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           on conflict (tenant_id, game_id) do update set
             aggregate_revision = excluded.aggregate_revision,
             projection_revision = excluded.projection_revision,
             lifecycle_state = excluded.lifecycle_state,
             visibility = excluded.visibility,
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             base_payload = excluded.base_payload,
             projected_at = now()
           where games.card_projections.projection_revision < excluded.projection_revision`,
          [
            input.tenantId,
            snapshot.id,
            snapshot.revision,
            input.projectionRevision,
            snapshot.lifecycleState,
            snapshot.visibility,
            snapshot.startsAt,
            snapshot.endsAt,
            JSON.stringify(snapshot),
          ],
        );
        if (applied.rowCount === 0) return 'stale';
        await client.query(
          `update games.games
              set card_projection_revision = $3, updated_at = now()
            where tenant_id = $1 and id = $2`,
          [input.tenantId, snapshot.id, input.projectionRevision],
        );
        return 'applied';
      });
    },

    listPublicCardProjections(input) {
      const limit = Math.max(1, Math.min(input.limit, 100));
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<ProjectionRow>(
          `select game_id, aggregate_revision, projection_revision, lifecycle_state,
                  visibility, starts_at, ends_at, base_payload, projected_at
             from games.card_projections
            where tenant_id = $1
              and not exists (
                select 1
                 from integration.legacy_game_merge_redirects redirect
                 where redirect.tenant_id = $1
                   and redirect.source_game_id = games.card_projections.game_id
              )
              and lifecycle_state = 'SCHEDULED'
              and visibility = 'PUBLIC'
              and starts_at > now()
              and (
                $2::timestamptz is null
                or (starts_at, game_id) > ($2::timestamptz, $3::uuid)
              )
            order by starts_at, game_id
            limit $4`,
          [input.tenantId, input.after?.startsAt ?? null, input.after?.gameId ?? null, limit + 1],
        );
        const visible = result.rows.slice(0, limit).map(mapProjection);
        const last = visible.at(-1);
        return {
          items: visible,
          ...(result.rows.length > limit && last
            ? { next: { startsAt: last.startsAt, gameId: last.gameId } }
            : {}),
        };
      });
    },

    getCardProjection(tenantId, gameId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<ProjectionRow>(
          client,
          `select game_id, aggregate_revision, projection_revision, lifecycle_state,
                  visibility, starts_at, ends_at, base_payload, projected_at
             from games.card_projections
            where tenant_id = $1
              and game_id = coalesce((
                select target_game_id
                  from integration.legacy_game_merge_redirects
                 where tenant_id = $1 and source_game_id = $2
              ), $2)`,
          [tenantId, gameId],
        );
        return row ? mapProjection(row) : undefined;
      });
    },

    listViewerCardProjections(input) {
      const limit = Math.max(1, Math.min(input.limit, 100));
      const history = input.scope === 'HISTORY';
      const lifecyclePredicate = history
        ? "lifecycle_state in ('FINISHED', 'CANCELLED')"
        : "lifecycle_state in ('SCHEDULED', 'IN_PROGRESS')";
      const cursorPredicate = history
        ? 'or (starts_at, game_id) < ($3::timestamptz, $4::uuid)'
        : 'or (starts_at, game_id) > ($3::timestamptz, $4::uuid)';
      const order = history ? 'starts_at desc, game_id desc' : 'starts_at, game_id';
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<ProjectionRow>(
          `select game_id, aggregate_revision, projection_revision, lifecycle_state,
                  visibility, starts_at, ends_at, base_payload, projected_at
             from games.card_projections
            where tenant_id = $1
              and not exists (
                select 1
                 from integration.legacy_game_merge_redirects redirect
                 where redirect.tenant_id = $1
                   and redirect.source_game_id = games.card_projections.game_id
              )
              and ${lifecyclePredicate}
              and (
                base_payload ->> 'organizerUserId' = $2
                or base_payload @> jsonb_build_object(
                  'participants', jsonb_build_array(jsonb_build_object('userId', $2))
                )
                or exists (
                  select 1
                    from jsonb_array_elements(
                      coalesce(base_payload -> 'seatReservations', '[]'::jsonb)
                    ) as reservation
                   where reservation ->> 'userId' = $2
                     and (reservation ->> 'expiresAt')::timestamptz > now()
                )
                or base_payload @> jsonb_build_object(
                  'waitlist', jsonb_build_array(jsonb_build_object('userId', $2))
                )
              )
              and ($3::timestamptz is null ${cursorPredicate})
            order by ${order}
            limit $5`,
          [
            input.tenantId,
            input.viewerUserId,
            input.after?.startsAt ?? null,
            input.after?.gameId ?? null,
            limit + 1,
          ],
        );
        const visible = result.rows.slice(0, limit).map(mapProjection);
        const last = visible.at(-1);
        return {
          items: visible,
          ...(result.rows.length > limit && last
            ? { next: { startsAt: last.startsAt, gameId: last.gameId } }
            : {}),
        };
      });
    },

    listRecommendationCardProjections(input) {
      const candidateLimit = Math.max(1, Math.min(input.candidateLimit, 100));
      const historyLimit = Math.max(1, Math.min(input.historyLimit, 100));
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<RecommendationProjectionRow>(
          `with candidates as (
             select game_id, aggregate_revision, projection_revision, lifecycle_state,
                    visibility, starts_at, ends_at, base_payload, projected_at
               from games.card_projections
              where tenant_id = $1
                and not exists (
                  select 1
                    from integration.legacy_game_merge_redirects redirect
                   where redirect.tenant_id = $1
                     and redirect.source_game_id = games.card_projections.game_id
                )
                and lifecycle_state = 'SCHEDULED'
                and visibility = 'PUBLIC'
                and starts_at > now()
              order by starts_at, game_id
              limit $3
           ), history as (
             select game_id, aggregate_revision, projection_revision, lifecycle_state,
                    visibility, starts_at, ends_at, base_payload, projected_at
               from games.card_projections
              where tenant_id = $1
                and not exists (
                  select 1
                    from integration.legacy_game_merge_redirects redirect
                   where redirect.tenant_id = $1
                     and redirect.source_game_id = games.card_projections.game_id
                )
                and lifecycle_state in ('FINISHED', 'CANCELLED')
                and (
                  base_payload ->> 'organizerUserId' = $2
                  or base_payload @> jsonb_build_object(
                    'participants', jsonb_build_array(jsonb_build_object('userId', $2))
                  )
                )
              order by starts_at desc, game_id desc
              limit $4
           )
           select 'candidate'::text as input_kind, candidates.* from candidates
           union all
           select 'history'::text as input_kind, history.* from history`,
          [input.tenantId, input.viewerUserId, candidateLimit, historyLimit],
        );
        return {
          candidates: result.rows
            .filter((row) => row.input_kind === 'candidate')
            .map(mapProjection),
          history: result.rows.filter((row) => row.input_kind === 'history').map(mapProjection),
        };
      });
    },

    projectCardEvent(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const consumerName = 'games-card-projector-v1';
        const inbox = await client.query(
          `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
           values ($1, $2, $3)
           on conflict (consumer_name, event_id) do nothing
           returning event_id`,
          [consumerName, input.eventId, input.tenantId],
        );
        if (inbox.rowCount === 0) return 'duplicate';
        const finish = async <
          T extends Exclude<Awaited<ReturnType<GameRepository['projectCardEvent']>>, 'duplicate'>,
        >(
          outcome: T,
        ): Promise<T> => {
          await client.query(
            `update audit.inbox_events set processed_at = now()
              where consumer_name = $1 and event_id = $2`,
            [consumerName, input.eventId],
          );
          return outcome;
        };

        const source = await queryOne<ProjectionSourceGameRow>(
          client,
          `select g.*,
                  coalesce(nullif(lp.short_title, ''), nullif(lp.title, ''), 'Площадка') as station_name,
                  lp.address as station_short_address
             from games.games g
             left join locations.profiles lp
               on lp.tenant_id = g.tenant_id and lp.id = g.station_id
            where g.tenant_id = $1 and g.id = $2
              and not exists (
                select 1
                  from integration.legacy_game_merge_redirects redirect
                 where redirect.tenant_id = g.tenant_id
                   and redirect.source_game_id = g.id
              )
            for share of g`,
          [input.tenantId, input.gameId],
        );
        if (!source) return finish('game_not_found');
        const game = mapGame(source);
        if (game.lifecycleState === 'DRAFT' || game.lifecycleState === 'PROVISIONING') {
          return finish('not_card_visible');
        }

        // A PoolClient has one PostgreSQL connection. Keep dependency reads sequential so the
        // transaction never attempts overlapping client.query calls (deprecated by pg and not
        // actually parallel on the wire).
        const participants = await client.query<ProjectionParticipantRow>(
          `select p.user_id,
                    coalesce(nullif(btrim(summary.display_name), ''), 'Игрок') as display_name,
                    summary.photo_url, summary.level_label, summary.level_value,
                    p.role, p.payment_state
               from games.participations p
               left join profile.user_summaries summary
                 on summary.tenant_id = p.tenant_id and summary.user_id = p.user_id
              where p.tenant_id = $1 and p.game_id = $2 and p.state = 'ACTIVE'
              order by case p.role when 'ORGANIZER' then 0 else 1 end, p.joined_at, p.id`,
          [input.tenantId, input.gameId],
        );
        const reservations = await client.query<ProjectionReservationRow>(
          `select id, user_id, expires_at, payment_state
               from games.seat_reservations
              where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
              order by created_at, id`,
          [input.tenantId, input.gameId],
        );
        const waitlist = await client.query<ProjectionWaitlistRow>(
          `select user_id, position
               from games.waitlist_entries
              where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
              order by position, created_at, id`,
          [input.tenantId, input.gameId],
        );

        let result: GameCardProjectionInput['result'];
        if (game.resultState !== 'NOT_AVAILABLE') {
          if (game.resultState === 'AWAITING_SUBMISSION' || game.resultState === 'VOID') {
            result = {
              state: game.resultState,
              requiredConfirmationUserIds: [],
              confirmedByUserIds: [],
            };
          } else {
            const submission = await queryOne<ProjectionResultRow>(
              client,
              `select id, submitted_by_user_id, submitted_at, confirmation_quorum,
                      score_payload, roster_snapshot
                 from games.result_submissions
                where tenant_id = $1 and game_id = $2
                order by revision desc, id desc
                limit 1`,
              [input.tenantId, input.gameId],
            );
            if (!submission) return finish('dependency_missing');
            const reviews = await client.query<ProjectionReviewRow>(
              `select reviewer_user_id, decision
                 from games.result_submission_reviews
                where tenant_id = $1 and game_id = $2
                  and submission_id = (
                    select id from games.result_submissions
                     where tenant_id = $1 and game_id = $2
                     order by revision desc, id desc limit 1
                  )
                order by reviewer_user_id`,
              [input.tenantId, input.gameId],
            );
            const sets = scoreSets(submission.score_payload);
            if (!Array.isArray(sets)) return finish('dependency_missing');
            result = {
              state: game.resultState,
              submissionId: submission.id,
              submittedByUserId: submission.submitted_by_user_id,
              submittedAt: timestamp(submission.submitted_at),
              requiredConfirmationUserIds: resultRoster(submission.roster_snapshot).filter(
                (userId) => userId !== submission.submitted_by_user_id,
              ),
              confirmedByUserIds: reviews.rows
                .filter((row) => row.decision === 'CONFIRMED')
                .map((row) => row.reviewer_user_id),
              confirmationQuorum: submission.confirmation_quorum,
              sets: sets as GameResultSetInput[],
            };
          }
        }

        const snapshot = gameCardProjectionInputSchema.parse({
          id: game.id,
          tenantId: game.tenantId,
          revision: game.revision,
          organizerUserId: game.organizerUserId,
          title: game.title,
          kind: game.kind,
          visibility: game.visibility,
          lifecycleState: game.lifecycleState,
          startsAt: game.startsAt,
          endsAt: game.endsAt,
          timezone: game.timezone,
          station: {
            id: game.stationId,
            name: source.station_name,
            shortAddress: source.station_short_address,
          },
          court: game.courtId
            ? {
                id: game.courtId,
                name: source.court_name,
              }
            : null,
          levelRange:
            game.levelFrom === null && game.levelTo === null
              ? null
              : { from: game.levelFrom, to: game.levelTo },
          capacity: game.capacity,
          participants: participants.rows.map((participant) => ({
            userId: participant.user_id,
            displayName: participant.display_name,
            avatarUrl: participant.photo_url,
            level: participant.level_label,
            levelValue: participant.level_value === null ? null : Number(participant.level_value),
            role: participant.role,
            paymentState: participant.payment_state,
          })),
          seatReservations: reservations.rows.map((reservation) => ({
            id: reservation.id,
            userId: reservation.user_id,
            expiresAt: timestamp(reservation.expires_at),
            paymentState: reservation.payment_state,
          })),
          waitlist: waitlist.rows.map((entry) => ({
            userId: entry.user_id,
            position: positiveInteger(entry.position),
          })),
          waitlistEnabled: game.waitlistEnabled,
          joinCutoffAt: game.joinCutoffAt,
          priceSummary: null,
          ...(result ? { result } : {}),
        });
        const applied = await client.query(
          `insert into games.card_projections (
             tenant_id, game_id, aggregate_revision, projection_revision,
             lifecycle_state, visibility, starts_at, ends_at, base_payload
           ) values ($1, $2, $3, $3, $4, $5, $6, $7, $8::jsonb)
           on conflict (tenant_id, game_id) do update set
             aggregate_revision = excluded.aggregate_revision,
             projection_revision = excluded.projection_revision,
             lifecycle_state = excluded.lifecycle_state,
             visibility = excluded.visibility,
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             base_payload = excluded.base_payload,
             projected_at = now()
           where games.card_projections.projection_revision < excluded.projection_revision`,
          [
            input.tenantId,
            game.id,
            game.revision,
            game.lifecycleState,
            game.visibility,
            game.startsAt,
            game.endsAt,
            JSON.stringify(snapshot),
          ],
        );
        if (applied.rowCount === 0) return finish('stale');
        await client.query(
          `update games.games set card_projection_revision = $3, updated_at = now()
            where tenant_id = $1 and id = $2`,
          [input.tenantId, game.id, game.revision],
        );
        return finish('applied');
      });
    },

    claimScheduledCommands(input) {
      const limit = Math.max(1, Math.min(input.limit, 100));
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query(
          `update games.scheduled_commands
              set state = 'FAILED', available_at = now(),
                  locked_at = null, locked_by = null,
                  last_error_code = 'GAME_COMMAND_CLAIM_EXPIRED'
            where tenant_id = $1 and state = 'PROCESSING'
              and ($2::text[] is null or command_type = any($2::text[]))
              and locked_at < now() - interval '60 seconds'`,
          [input.tenantId, input.commandTypes ? [...input.commandTypes] : null],
        );
        const result = await client.query<ScheduledCommandRow>(
          `with due as (
             select tenant_id, id
               from games.scheduled_commands
              where tenant_id = $1
                and state in ('PENDING', 'FAILED')
                and ($4::text[] is null or command_type = any($4::text[]))
                and due_at <= now()
                and available_at <= now()
                and attempts < 20
              order by due_at, id
              for update skip locked
              limit $3
           )
           update games.scheduled_commands command set
             state = 'PROCESSING', attempts = command.attempts + 1,
             locked_at = now(), locked_by = $2, last_error_code = null
           from due
           where command.tenant_id = due.tenant_id and command.id = due.id
           returning command.id, command.game_id, command.command_type,
                     command.expected_revision, command.payload, command.attempts`,
          [
            input.tenantId,
            input.workerId,
            limit,
            input.commandTypes ? [...input.commandTypes] : null,
          ],
        );
        return result.rows.map(mapScheduledCommand);
      });
    },

    executeLifecycleCommand(input) {
      const occurredAt = input.occurredAt ?? new Date();
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const command = await queryOne<ClaimedLifecycleCommandRow>(
          client,
          `select id, game_id, command_type, due_at, expected_revision
             from games.scheduled_commands
            where tenant_id = $1 and id = $2
              and state = 'PROCESSING' and locked_by = $3
              and command_type in ('game.lifecycle.start.v1', 'game.lifecycle.finish.v1')
            for update`,
          [input.tenantId, input.commandId, input.workerId],
        );
        if (!command) return { outcome: 'not_claimed' };

        const game = await queryOne<LifecycleGameRow>(
          client,
          `select id, revision, lifecycle_state, starts_at, ends_at
             from games.games
            where tenant_id = $1 and id = $2
            for update`,
          [input.tenantId, command.game_id],
        );
        if (!game) throw new Error('GAME_LIFECYCLE_COMMAND_GAME_NOT_FOUND');

        const completeClaim = async (): Promise<void> => {
          const completed = await client.query(
            `update games.scheduled_commands
                set state = 'COMPLETED', completed_at = $4,
                    locked_at = null, locked_by = null, last_error_code = null
              where tenant_id = $1 and id = $2
                and state = 'PROCESSING' and locked_by = $3`,
            [input.tenantId, command.id, input.workerId, occurredAt.toISOString()],
          );
          if (completed.rowCount !== 1) {
            throw new Error('GAME_LIFECYCLE_COMMAND_COMPLETION_LOST');
          }
        };

        const alreadyApplied =
          command.command_type === 'game.lifecycle.start.v1'
            ? ['IN_PROGRESS', 'FINISHED', 'CANCELLED'].includes(game.lifecycle_state)
            : ['FINISHED', 'CANCELLED'].includes(game.lifecycle_state);
        if (alreadyApplied) {
          await completeClaim();
          return { outcome: 'already_applied', gameId: game.id };
        }

        const expectedSourceState =
          command.command_type === 'game.lifecycle.start.v1' ? 'SCHEDULED' : 'IN_PROGRESS';
        if (game.lifecycle_state !== expectedSourceState) {
          throw new Error('GAME_LIFECYCLE_COMMAND_NOT_READY');
        }

        const dueAt = timestamp(
          command.command_type === 'game.lifecycle.start.v1' ? game.starts_at : game.ends_at,
        );
        const revision = positiveInteger(game.revision);
        const storedExpectedRevision =
          command.expected_revision === null ? null : positiveInteger(command.expected_revision);
        if (
          timestamp(command.due_at) !== dueAt ||
          storedExpectedRevision !== revision ||
          Date.parse(dueAt) > occurredAt.getTime()
        ) {
          const rescheduled = await client.query(
            `update games.scheduled_commands
                set state = 'FAILED', due_at = $4,
                    available_at = greatest($4::timestamptz, $5::timestamptz),
                    expected_revision = $6::bigint,
                    payload = jsonb_build_object(
                      'gameId', game_id,
                      'expectedRevision', $6::bigint::text
                    ),
                    locked_at = null, locked_by = null,
                    last_error_code = 'GAME_COMMAND_RESCHEDULED'
              where tenant_id = $1 and id = $2
                and state = 'PROCESSING' and locked_by = $3`,
            [input.tenantId, command.id, input.workerId, dueAt, occurredAt.toISOString(), revision],
          );
          if (rescheduled.rowCount !== 1) {
            throw new Error('GAME_LIFECYCLE_COMMAND_RESCHEDULE_LOST');
          }
          return {
            outcome: 'rescheduled',
            gameId: game.id,
            dueAt,
            expectedRevision: revision,
          };
        }

        const lifecycleState =
          command.command_type === 'game.lifecycle.start.v1' ? 'IN_PROGRESS' : 'FINISHED';
        const updated = await queryOne<{ readonly revision: string | number } & QueryResultRow>(
          client,
          `update games.games
              set lifecycle_state = $4,
                  result_state = case
                    when $4 = 'FINISHED' and result_state = 'NOT_AVAILABLE'
                      then 'AWAITING_SUBMISSION'
                    else result_state
                  end,
                  started_at = coalesce(started_at, starts_at),
                  finished_at = case
                    when $4 = 'FINISHED' then coalesce(finished_at, ends_at)
                    else finished_at
                  end,
                  revision = revision + 1,
                  updated_at = $5
            where tenant_id = $1 and id = $2
              and revision = $3 and lifecycle_state = $6
            returning revision`,
          [
            input.tenantId,
            game.id,
            revision,
            lifecycleState,
            occurredAt.toISOString(),
            expectedSourceState,
          ],
        );
        if (!updated) throw new Error('GAME_LIFECYCLE_COMMAND_REVISION_CONFLICT');
        const nextRevision = positiveInteger(updated.revision);

        const participants = await client.query<{ readonly user_id: string } & QueryResultRow>(
          `select user_id
             from games.participations
            where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
            order by joined_at, id`,
          [input.tenantId, game.id],
        );
        const eventId = randomUUID();
        await insertOutboxEvent(client, {
          id: eventId,
          type:
            command.command_type === 'game.lifecycle.start.v1'
              ? 'game.started.v1'
              : 'game.finished.v1',
          aggregateId: game.id,
          tenantId: input.tenantId,
          occurredAt: occurredAt.toISOString(),
          correlationId: input.correlationId,
          payload: {
            gameId: game.id,
            aggregateRevision: String(nextRevision),
            causationId: command.id,
            actorUserId: null,
            participantUserIds: participants.rows.map((row) => row.user_id),
          },
        });
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id, result,
             reason, correlation_id, old_value, new_value, occurred_at
           ) values ($1, null, $2, 'GAME', $3, 'SUCCESS',
                     'SCHEDULED_COMMAND', $4, $5::jsonb, $6::jsonb, $7)`,
          [
            input.tenantId,
            lifecycleState === 'IN_PROGRESS' ? 'GAME_LIFECYCLE_STARTED' : 'GAME_LIFECYCLE_FINISHED',
            game.id,
            input.correlationId,
            JSON.stringify({ revision, lifecycleState: game.lifecycle_state }),
            JSON.stringify({ revision: nextRevision, lifecycleState }),
            occurredAt.toISOString(),
          ],
        );
        await completeClaim();
        return {
          outcome: 'applied',
          gameId: game.id,
          lifecycleState,
          revision: nextRevision,
          eventId,
        };
      });
    },

    completeScheduledCommand(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query(
          `update games.scheduled_commands
              set state = 'COMPLETED', completed_at = now(), locked_at = null, locked_by = null
            where tenant_id = $1 and id = $2 and state = 'PROCESSING' and locked_by = $3`,
          [input.tenantId, input.commandId, input.workerId],
        );
        return result.rowCount === 1;
      });
    },

    retryScheduledCommand(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const current = await queryOne<AttemptsRow>(
          client,
          `select attempts from games.scheduled_commands
            where tenant_id = $1 and id = $2 and state = 'PROCESSING' and locked_by = $3
            for update`,
          [input.tenantId, input.commandId, input.workerId],
        );
        if (!current) return 'not_claimed';
        const exhausted = current.attempts >= 20;
        await client.query(
          `update games.scheduled_commands set
             state = 'FAILED', available_at = $4, last_error_code = $5,
             locked_at = null, locked_by = null
           where tenant_id = $1 and id = $2 and state = 'PROCESSING' and locked_by = $3`,
          [input.tenantId, input.commandId, input.workerId, input.availableAt, input.errorCode],
        );
        return exhausted ? 'attempts_exhausted' : 'retry_scheduled';
      });
    },
  };
}
