import { createHash, randomUUID } from 'node:crypto';

import {
  readBackTransition,
  submitTransition,
  type GameProviderErrorClass,
  type GameProviderOperationAction,
  type GameProviderOperationIntent,
  type GameProviderOperationState,
  type GameProviderReadBackResult,
  type GameProviderSubmitResult,
} from '@phub/games';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface CreateGameProviderIntentInput {
  readonly tenantId: string;
  readonly sourceCommandId: string;
  readonly action: GameProviderOperationAction;
  readonly actorUserId: string;
  readonly gameId: string;
  readonly reservationId: string;
  readonly waitlistEntryId?: string;
  readonly eligibilityDecisionId: string;
  readonly paymentSnapshotOperationId: string;
  readonly paymentMode: 'SPLIT' | 'SUBSCRIPTION';
  readonly correlationId: string;
}

export interface ClaimedGameProviderOperation extends GameProviderOperationIntent {
  readonly tenantId: string;
  readonly leaseToken: string;
  readonly attempt: number;
  readonly state: 'SUBMITTING' | 'RECONCILING';
  readonly startedAt: string;
}

export interface GameProviderOperationView {
  readonly operationId: string;
  readonly sourceCommandId: string;
  readonly state: GameProviderOperationState;
  readonly action: GameProviderOperationAction;
  readonly submitAttempts: number;
  readonly readBackAttempts: number;
  readonly lastErrorClass?: GameProviderErrorClass;
  readonly updatedAt: string;
}

export interface GameProviderOperationRepository {
  claimSubmit(input: {
    readonly tenantId: string;
    readonly leaseSeconds: number;
    readonly maxAttempts: number;
  }): Promise<ClaimedGameProviderOperation | undefined>;
  completeSubmit(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly leaseToken: string;
    readonly startedAt: string;
    readonly result: GameProviderSubmitResult;
    readonly maxAttempts: number;
  }): Promise<'applied' | 'stale'>;
  claimReadBack(input: {
    readonly tenantId: string;
    readonly leaseSeconds: number;
    readonly maxAttempts: number;
  }): Promise<ClaimedGameProviderOperation | undefined>;
  completeReadBack(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly leaseToken: string;
    readonly startedAt: string;
    readonly result: GameProviderReadBackResult;
    readonly maxAttempts: number;
  }): Promise<'applied' | 'stale'>;
  recordCallback(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly dedupeKey: string;
    readonly evidenceHash: string;
    readonly result: Extract<
      GameProviderReadBackResult,
      { outcome: 'MATCHED_ACCEPTED' | 'MATCHED_REJECTED' | 'MISMATCH' | 'AMBIGUOUS' }
    >;
    readonly observedAt: string;
  }): Promise<'applied' | 'duplicate' | 'stale' | 'mismatch'>;
  getForActor(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly sourceCommandId: string;
  }): Promise<GameProviderOperationView | undefined>;
}

interface OperationRow extends QueryResultRow {
  readonly id: string;
  readonly source_command_id: string;
  readonly action: GameProviderOperationAction;
  readonly provider_idempotency_key: string;
  readonly correlation_id: string;
  readonly request_hash: string;
  readonly actor_user_id: string;
  readonly game_id: string;
  readonly reservation_id: string;
  readonly waitlist_entry_id: string | null;
  readonly eligibility_decision_id: string;
  readonly payment_snapshot_operation_id: string;
  readonly payment_mode: 'SPLIT' | 'SUBSCRIPTION';
  readonly provider_exercise_id: string | null;
  readonly expected_amount_minor: string | number | null;
  readonly expected_currency: string | null;
  readonly state: GameProviderOperationState;
  readonly submit_attempts: string | number;
  readonly readback_attempts: string | number;
  readonly lease_token: string | null;
  readonly last_error_class: GameProviderErrorClass | null;
  readonly local_aggregate_revision: string | number | null;
  readonly updated_at: Date | string;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function count(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('GAME_PROVIDER_ATTEMPT_INVALID');
  return result;
}

function expected(row: OperationRow) {
  return {
    tenantId: '',
    actorUserId: row.actor_user_id,
    gameId: row.game_id,
    reservationId: row.reservation_id,
    paymentMode: row.payment_mode,
    ...(row.provider_exercise_id ? { providerExerciseId: row.provider_exercise_id } : {}),
    ...(row.expected_amount_minor === null
      ? {}
      : {
          amountMinor: count(row.expected_amount_minor),
          currency: row.expected_currency!,
        }),
  } as const;
}

function claimed(
  row: OperationRow,
  tenantId: string,
  state: 'SUBMITTING' | 'RECONCILING',
): ClaimedGameProviderOperation {
  if (!row.lease_token) throw new Error('GAME_PROVIDER_LEASE_MISSING');
  return {
    operationId: row.id,
    tenantId,
    provider: 'SYNTHETIC',
    action: row.action,
    providerIdempotencyKey: row.provider_idempotency_key,
    correlationId: row.correlation_id,
    expected: { ...expected(row), tenantId },
    leaseToken: row.lease_token,
    attempt: state === 'SUBMITTING' ? count(row.submit_attempts) : count(row.readback_attempts),
    state,
    startedAt: iso(row.updated_at),
  };
}

export async function createGameProviderIntent(
  client: PoolClient,
  input: CreateGameProviderIntentInput,
): Promise<string> {
  const operationId = randomUUID();
  const providerIdempotencyKey = `game-provider-${operationId}`;
  const immutableFacts = {
    action: input.action,
    actorUserId: input.actorUserId,
    gameId: input.gameId,
    reservationId: input.reservationId,
    waitlistEntryId: input.waitlistEntryId ?? null,
    eligibilityDecisionId: input.eligibilityDecisionId,
    paymentSnapshotOperationId: input.paymentSnapshotOperationId,
    paymentMode: input.paymentMode,
  };
  const requestHash = createHash('sha256').update(JSON.stringify(immutableFacts)).digest('hex');
  const inserted = await queryOne<{ id: string } & QueryResultRow>(
    client,
    `insert into integration.game_provider_operations (
       tenant_id, id, source_command_id, action, provider, provider_contract_version,
       provider_idempotency_key, correlation_id, request_hash, actor_user_id, game_id,
       reservation_id, waitlist_entry_id, eligibility_decision_id,
       payment_snapshot_operation_id, payment_mode
     ) values ($1, $2, $3, $4, 'SYNTHETIC', 'synthetic-v1', $5, $6, $7, $8, $9,
               $10, $11, $12, $13, $14)
     on conflict (tenant_id, source_command_id, action) do nothing
     returning id`,
    [
      input.tenantId,
      operationId,
      input.sourceCommandId,
      input.action,
      providerIdempotencyKey,
      input.correlationId,
      requestHash,
      input.actorUserId,
      input.gameId,
      input.reservationId,
      input.waitlistEntryId ?? null,
      input.eligibilityDecisionId,
      input.paymentSnapshotOperationId,
      input.paymentMode,
    ],
  );
  const row: { readonly id: string; readonly request_hash: string } | undefined =
    (inserted ? { id: inserted.id, request_hash: requestHash } : undefined) ??
    (await queryOne<{ id: string; request_hash: string } & QueryResultRow>(
      client,
      `select id, request_hash from integration.game_provider_operations
        where tenant_id = $1 and source_command_id = $2 and action = $3 for update`,
      [input.tenantId, input.sourceCommandId, input.action],
    ));
  if (!row) throw new Error('GAME_PROVIDER_INTENT_WRITE_LOST');
  if (row.request_hash !== requestHash)
    throw new Error('GAME_PROVIDER_INTENT_IDEMPOTENCY_CONFLICT');
  if (!inserted) return row.id;
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id, new_value
     ) values ($1, $2, 'GAME_PROVIDER_INTENT_CREATED', 'GAME_PROVIDER_OPERATION', $3,
               'SUCCESS', $4, $5::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      row.id,
      input.correlationId,
      JSON.stringify({ action: input.action, state: 'READY', provider: 'SYNTHETIC' }),
    ],
  );
  return row.id;
}

async function expireLeases(
  client: PoolClient,
  tenantId: string,
  maxReadBackAttempts: number,
): Promise<void> {
  await client.query(
    `update integration.game_provider_operations
        set state = 'UNKNOWN', resolution = null, lease_token = null, lease_expires_at = null,
            last_error_class = 'AMBIGUOUS_EGRESS', next_attempt_at = now(),
            version = version + 1, updated_at = now()
      where tenant_id = $1 and state = 'SUBMITTING' and lease_expires_at <= now()`,
    [tenantId],
  );
  await client.query(
    `update integration.game_provider_operations
        set state = case when readback_attempts >= $2 then 'MANUAL_REVIEW' else 'UNKNOWN' end,
            resolution = case when readback_attempts >= $2 then 'UNKNOWN' else null end,
            lease_token = null, lease_expires_at = null,
            last_error_class = case when readback_attempts >= $2 then 'RETRY_EXHAUSTED' else 'READBACK_UNAVAILABLE' end,
            next_attempt_at = now(), terminal_at = case when readback_attempts >= $2 then now() else null end,
            version = version + 1, updated_at = now()
      where tenant_id = $1 and state = 'RECONCILING' and lease_expires_at <= now()`,
    [tenantId, maxReadBackAttempts],
  );
}

interface LockedGameRow extends QueryResultRow {
  readonly lifecycle_state: string;
  readonly revision: string | number;
  readonly database_now: Date | string;
}

async function lockOperationInAggregateOrder(
  client: PoolClient,
  tenantId: string,
  operationId: string,
): Promise<{ readonly row: OperationRow; readonly game: LockedGameRow } | undefined> {
  const reference = await queryOne<QueryResultRow & { game_id: string }>(
    client,
    `select game_id from integration.game_provider_operations where tenant_id = $1 and id = $2`,
    [tenantId, operationId],
  );
  if (!reference) return undefined;
  const game = await queryOne<LockedGameRow>(
    client,
    `select lifecycle_state, revision, now() as database_now from games.games
      where tenant_id = $1 and id = $2 for update`,
    [tenantId, reference.game_id],
  );
  if (!game) throw new Error('GAME_PROVIDER_GAME_MISSING');
  const row = await queryOne<OperationRow>(
    client,
    `select * from integration.game_provider_operations where tenant_id = $1 and id = $2 for update`,
    [tenantId, operationId],
  );
  return row ? { row, game } : undefined;
}

async function applyConfirmedLocalState(
  client: PoolClient,
  row: OperationRow,
  tenantId: string,
  game: LockedGameRow,
): Promise<string | undefined> {
  const reservation = await queryOne<
    QueryResultRow & {
      state: string;
      payment_state: string;
      expires_at: Date | string;
      eligibility_decision_id: string;
      participation_id: string | null;
      participation_decision_id: string | null;
      participation_payment_state: string | null;
    }
  >(
    client,
    `select reservation.state, reservation.payment_state, reservation.expires_at,
            reservation.eligibility_decision_id,
            (select id from games.participations participation
              where participation.tenant_id = reservation.tenant_id
                and participation.game_id = reservation.game_id
                and participation.user_id = reservation.user_id
                and participation.state = 'ACTIVE' limit 1) as participation_id,
            (select eligibility_decision_id from games.participations participation
              where participation.tenant_id = reservation.tenant_id
                and participation.game_id = reservation.game_id
                and participation.user_id = reservation.user_id
                and participation.state = 'ACTIVE' limit 1) as participation_decision_id,
            (select payment_state from games.participations participation
              where participation.tenant_id = reservation.tenant_id
                and participation.game_id = reservation.game_id
                and participation.user_id = reservation.user_id
                and participation.state = 'ACTIVE' limit 1) as participation_payment_state
       from games.seat_reservations reservation
      where reservation.tenant_id = $1 and reservation.game_id = $2
        and reservation.id = $3 and reservation.user_id = $4
        and exists (
          select 1 from eligibility.payment_snapshots snapshot
           where snapshot.tenant_id = reservation.tenant_id
             and snapshot.operation_id = $5
             and snapshot.decision_id = $6
             and reservation.eligibility_decision_id = $6
             and snapshot.player_id = reservation.user_id
             and snapshot.activity_id = reservation.game_id
        )
      for update`,
    [
      tenantId,
      row.game_id,
      row.reservation_id,
      row.actor_user_id,
      row.payment_snapshot_operation_id,
      row.eligibility_decision_id,
    ],
  );
  if (!reservation) return undefined;
  if (reservation.state === 'CONFIRMED' && reservation.participation_id) {
    return reservation.participation_decision_id === row.eligibility_decision_id &&
      reservation.participation_payment_state === 'PAID'
      ? String(game.revision)
      : undefined;
  }
  if (
    reservation.state !== 'ACTIVE' ||
    !['REQUIRES_ACTION', 'PROCESSING'].includes(reservation.payment_state) ||
    !['SCHEDULED', 'IN_PROGRESS'].includes(game.lifecycle_state) ||
    Date.parse(iso(reservation.expires_at)) <= Date.parse(iso(game.database_now))
  ) {
    return undefined;
  }
  const participation = await queryOne<QueryResultRow & { id: string }>(
    client,
    `insert into games.participations (
       tenant_id, game_id, user_id, role, state, payment_state, eligibility_decision_id
     ) values ($1, $2, $3, 'PLAYER', 'ACTIVE', 'PAID', $4)
     on conflict (tenant_id, game_id, user_id) where state = 'ACTIVE' do nothing
     returning id`,
    [tenantId, row.game_id, row.actor_user_id, reservation.eligibility_decision_id],
  );
  const participationId = participation?.id ?? reservation.participation_id;
  if (!participationId) throw new Error('GAME_PROVIDER_PARTICIPATION_WRITE_LOST');
  const updated = await client.query(
    `update games.seat_reservations
        set state = 'CONFIRMED', payment_state = 'PAID', terminal_at = now(), updated_at = now()
      where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
    [tenantId, row.game_id, row.reservation_id],
  );
  if (updated.rowCount !== 1) throw new Error('GAME_PROVIDER_RESERVATION_CONFIRM_WRITE_LOST');
  const revision = await queryOne<QueryResultRow & { revision: string | number }>(
    client,
    `update games.games set revision = revision + 1, updated_at = now()
      where tenant_id = $1 and id = $2 returning revision`,
    [tenantId, row.game_id],
  );
  if (!revision) throw new Error('GAME_PROVIDER_REVISION_WRITE_LOST');
  const eventId = randomUUID();
  await client.query(
    `insert into audit.outbox_events (
       id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
     ) values ($1, $2, 'game.participation.confirmed.v1', $3, $4, $5::jsonb, now())`,
    [
      eventId,
      tenantId,
      row.game_id,
      row.correlation_id,
      JSON.stringify({
        gameId: row.game_id,
        aggregateRevision: String(revision.revision),
        causationId: row.id,
        actorUserId: row.actor_user_id,
        userId: row.actor_user_id,
        participationId,
      }),
    ],
  );
  return String(revision.revision);
}

async function applyRejectedLocalState(
  client: PoolClient,
  row: OperationRow,
  tenantId: string,
): Promise<string | undefined> {
  const reservation = await queryOne<QueryResultRow & { state: string; user_id: string }>(
    client,
    `select state, user_id from games.seat_reservations
      where tenant_id = $1 and game_id = $2 and id = $3 and user_id = $4 for update`,
    [tenantId, row.game_id, row.reservation_id, row.actor_user_id],
  );
  if (!reservation || reservation.state !== 'ACTIVE') return undefined;
  const cancelled = await client.query(
    `update games.seat_reservations
        set state = 'CANCELLED', payment_state = 'FAILED', terminal_at = now(), updated_at = now()
      where tenant_id = $1 and game_id = $2 and id = $3 and state = 'ACTIVE'`,
    [tenantId, row.game_id, row.reservation_id],
  );
  if (cancelled.rowCount !== 1) throw new Error('GAME_PROVIDER_REJECTION_CANCEL_WRITE_LOST');
  const revision = await queryOne<QueryResultRow & { revision: string | number }>(
    client,
    `update games.games set revision = revision + 1, updated_at = now()
      where tenant_id = $1 and id = $2 returning revision`,
    [tenantId, row.game_id],
  );
  if (!revision) throw new Error('GAME_PROVIDER_REJECTION_REVISION_WRITE_LOST');
  await client.query(
    `insert into audit.outbox_events (
       id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
     ) values ($1, $2, 'game.participation.expired.v1', $3, $4, $5::jsonb, now())`,
    [
      randomUUID(),
      tenantId,
      row.game_id,
      row.correlation_id,
      JSON.stringify({
        gameId: row.game_id,
        aggregateRevision: String(revision.revision),
        causationId: row.id,
        actorUserId: row.actor_user_id,
        userId: reservation.user_id,
        reservationId: row.reservation_id,
        reasonCode: 'PAYMENT_FAILED',
      }),
    ],
  );
  const entry = await queryOne<QueryResultRow & { id: string }>(
    client,
    `select id from games.waitlist_entries
      where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
      order by position, created_at, id for update skip locked limit 1`,
    [tenantId, row.game_id],
  );
  if (entry) {
    await client.query(
      `insert into games.scheduled_commands (
         tenant_id, game_id, command_type, due_at, expected_revision, payload
       ) select $1, $2, 'game.waitlist.promote.v1', now(), $3, $4::jsonb
          where not exists (
            select 1 from games.scheduled_commands command
             where command.tenant_id = $1 and command.game_id = $2
               and command.command_type = 'game.waitlist.promote.v1'
               and command.payload->>'waitlistEntryId' = $5
               and (command.state in ('PENDING', 'PROCESSING')
                    or (command.state = 'FAILED' and command.attempts < 20))
          )`,
      [
        tenantId,
        row.game_id,
        Number(revision.revision),
        JSON.stringify({ waitlistEntryId: entry.id }),
        entry.id,
      ],
    );
  }
  return String(revision.revision);
}

async function terminalize(
  client: PoolClient,
  row: OperationRow,
  tenantId: string,
  next: ReturnType<typeof submitTransition> | ReturnType<typeof readBackTransition>,
  providerOperationId: string | undefined,
  game: LockedGameRow,
): Promise<void> {
  let localRevision: string | undefined;
  let effectiveNext = next;
  if (next.state === 'CONFIRMED') {
    localRevision = await applyConfirmedLocalState(client, row, tenantId, game);
    if (!localRevision) {
      effectiveNext = { state: 'MANUAL_REVIEW', errorClass: 'REFERENCE_MISMATCH' };
    }
  }
  if (next.state === 'REJECTED') {
    localRevision = await applyRejectedLocalState(client, row, tenantId);
    if (!localRevision) {
      effectiveNext = { state: 'MANUAL_REVIEW', errorClass: 'REFERENCE_MISMATCH' };
    }
  }
  const terminal = ['CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'].includes(effectiveNext.state);
  const resolution =
    effectiveNext.state === 'CONFIRMED'
      ? 'ACCEPTED'
      : effectiveNext.state === 'REJECTED'
        ? 'REJECTED'
        : effectiveNext.state === 'MANUAL_REVIEW'
          ? 'UNKNOWN'
          : null;
  const operationUpdate = await client.query(
    `update integration.game_provider_operations
        set state = $4, resolution = $5, provider_operation_id = coalesce($6, provider_operation_id),
            local_aggregate_revision = coalesce($7, local_aggregate_revision),
            lease_token = null, lease_expires_at = null, last_error_class = $8,
            next_attempt_at = case when $9 then next_attempt_at else now() +
              make_interval(secs => least(300, 5 * power(2, greatest(submit_attempts, readback_attempts) - 1))::int) end,
            terminal_at = case when $9 then now() else null end,
            version = version + 1, updated_at = now()
      where tenant_id = $1 and id = $2 and lease_token = $3`,
    [
      tenantId,
      row.id,
      row.lease_token,
      effectiveNext.state,
      resolution,
      providerOperationId ?? null,
      localRevision ?? null,
      effectiveNext.errorClass ?? null,
      terminal,
    ],
  );
  if (operationUpdate.rowCount !== 1) throw new Error('GAME_PROVIDER_TRANSITION_FENCE_LOST');
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id, new_value
     ) values ($1, $2, 'GAME_PROVIDER_STATE_TRANSITIONED', 'GAME_PROVIDER_OPERATION', $3,
               'SUCCESS', $4, $5::jsonb)`,
    [
      tenantId,
      row.actor_user_id,
      row.id,
      row.correlation_id,
      JSON.stringify({
        from: row.state,
        to: effectiveNext.state,
        errorClass: effectiveNext.errorClass ?? null,
      }),
    ],
  );
}

function evidenceHash(
  result: GameProviderSubmitResult | GameProviderReadBackResult,
): string | undefined {
  return 'evidenceHash' in result ? result.evidenceHash : undefined;
}

function resultClass(result: GameProviderSubmitResult | GameProviderReadBackResult): string {
  return result.outcome.replace('MATCHED_', '');
}

function verifiedReadBackResult(
  row: OperationRow,
  tenantId: string,
  result: GameProviderReadBackResult,
): GameProviderReadBackResult {
  if (result.outcome !== 'MATCHED_ACCEPTED' && result.outcome !== 'MATCHED_REJECTED') return result;
  const facts = result.facts;
  const expectedTerminal = result.outcome === 'MATCHED_ACCEPTED' ? 'PAID' : 'REJECTED';
  const mismatch =
    facts.providerContractVersion !== 'synthetic-v1' || facts.terminalStatus !== expectedTerminal
      ? 'REFERENCE_MISMATCH'
      : facts.tenantRef !== `synthetic:tenant:${tenantId}`
        ? 'TENANT_MISMATCH'
        : facts.actorRef !== `synthetic:actor:${row.actor_user_id}`
          ? 'ACTOR_MISMATCH'
          : facts.gameRef !== `synthetic:game:${row.game_id}`
            ? 'GAME_MISMATCH'
            : facts.reservationRef !== `synthetic:reservation:${row.reservation_id}`
              ? 'REFERENCE_MISMATCH'
              : facts.paymentMode !== row.payment_mode ||
                  (row.expected_amount_minor !== null &&
                    (facts.amountMinor !== count(row.expected_amount_minor) ||
                      facts.currency !== row.expected_currency))
                ? 'PAYMENT_MISMATCH'
                : row.provider_exercise_id !== null &&
                    facts.providerExerciseRef !== `synthetic:exercise:${row.provider_exercise_id}`
                  ? 'REFERENCE_MISMATCH'
                  : undefined;
  return mismatch ? { outcome: 'MISMATCH', mismatch, evidenceHash: result.evidenceHash } : result;
}

export function createGameProviderOperationRepository(pool: Pool): GameProviderOperationRepository {
  return {
    claimSubmit(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await expireLeases(client, input.tenantId, 20);
        const leaseToken = randomUUID();
        const row = await queryOne<OperationRow>(
          client,
          `with candidate as (
             select id from integration.game_provider_operations
              where tenant_id = $1 and state = 'READY' and next_attempt_at <= now()
                and submit_attempts < $4
              order by next_attempt_at, id for update skip locked limit 1
           )
           update integration.game_provider_operations operation
              set state = 'SUBMITTING', submit_attempts = submit_attempts + 1,
                  lease_token = $2, lease_expires_at = now() + make_interval(secs => $3),
                  version = version + 1, updated_at = now()
             from candidate where operation.tenant_id = $1 and operation.id = candidate.id
           returning operation.*`,
          [input.tenantId, leaseToken, input.leaseSeconds, input.maxAttempts],
        );
        if (row) {
          await client.query(
            `insert into integration.game_provider_operation_attempts (
               tenant_id, operation_id, attempt_number, phase, event_type, result_class,
               request_hash, evidence_hash, error_class, started_at
             ) values ($1, $2, $3, 'SUBMIT', 'STARTED', null, $4, null, null, $5)`,
            [
              input.tenantId,
              row.id,
              count(row.submit_attempts),
              row.request_hash,
              iso(row.updated_at),
            ],
          );
        }
        return row ? claimed(row, input.tenantId, 'SUBMITTING') : undefined;
      });
    },
    completeSubmit(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const locked = await lockOperationInAggregateOrder(
          client,
          input.tenantId,
          input.operationId,
        );
        const row = locked?.row;
        if (!row || row.state !== 'SUBMITTING' || row.lease_token !== input.leaseToken)
          return 'stale';
        const transition = submitTransition(input.result);
        const exhausted = count(row.submit_attempts) >= input.maxAttempts;
        const next =
          transition.state === 'READY' && exhausted
            ? { state: 'MANUAL_REVIEW' as const, errorClass: 'RETRY_EXHAUSTED' as const }
            : transition;
        await client.query(
          `insert into integration.game_provider_operation_attempts (
             tenant_id, operation_id, attempt_number, phase, event_type, result_class, request_hash,
             evidence_hash, error_class, started_at
           ) values ($1, $2, $3, 'SUBMIT', 'FINISHED', $4, $5, $6, $7, $8)`,
          [
            input.tenantId,
            row.id,
            count(row.submit_attempts),
            resultClass(input.result),
            row.request_hash,
            evidenceHash(input.result) ?? null,
            next.errorClass ?? null,
            input.startedAt,
          ],
        );
        await terminalize(
          client,
          row,
          input.tenantId,
          next,
          'providerOperationId' in input.result ? input.result.providerOperationId : undefined,
          locked.game,
        );
        return 'applied';
      });
    },
    claimReadBack(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await expireLeases(client, input.tenantId, input.maxAttempts);
        const leaseToken = randomUUID();
        const row = await queryOne<OperationRow>(
          client,
          `with candidate as (
             select id from integration.game_provider_operations
              where tenant_id = $1 and state = 'UNKNOWN' and next_attempt_at <= now()
                and readback_attempts < $4
              order by next_attempt_at, id for update skip locked limit 1
           )
           update integration.game_provider_operations operation
              set state = 'RECONCILING', readback_attempts = readback_attempts + 1,
                  lease_token = $2, lease_expires_at = now() + make_interval(secs => $3),
                  version = version + 1, updated_at = now()
             from candidate where operation.tenant_id = $1 and operation.id = candidate.id
           returning operation.*`,
          [input.tenantId, leaseToken, input.leaseSeconds, input.maxAttempts],
        );
        if (row) {
          await client.query(
            `insert into integration.game_provider_operation_attempts (
               tenant_id, operation_id, attempt_number, phase, event_type, result_class,
               request_hash, evidence_hash, error_class, started_at
             ) values ($1, $2, $3, 'READBACK', 'STARTED', null, $4, null, null, $5)`,
            [
              input.tenantId,
              row.id,
              count(row.readback_attempts),
              row.request_hash,
              iso(row.updated_at),
            ],
          );
        }
        return row ? claimed(row, input.tenantId, 'RECONCILING') : undefined;
      });
    },
    completeReadBack(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const locked = await lockOperationInAggregateOrder(
          client,
          input.tenantId,
          input.operationId,
        );
        const row = locked?.row;
        if (!row || row.state !== 'RECONCILING' || row.lease_token !== input.leaseToken)
          return 'stale';
        const verifiedResult = verifiedReadBackResult(row, input.tenantId, input.result);
        const next = readBackTransition(
          verifiedResult,
          count(row.readback_attempts),
          input.maxAttempts,
        );
        await client.query(
          `insert into integration.game_provider_operation_attempts (
             tenant_id, operation_id, attempt_number, phase, event_type, result_class, request_hash,
             evidence_hash, error_class, started_at
           ) values ($1, $2, $3, 'READBACK', 'FINISHED', $4, $5, $6, $7, $8)`,
          [
            input.tenantId,
            row.id,
            count(row.readback_attempts),
            resultClass(verifiedResult),
            row.request_hash,
            evidenceHash(verifiedResult) ?? null,
            next.errorClass ?? null,
            input.startedAt,
          ],
        );
        await client.query(
          `insert into integration.game_provider_operation_observations (
             tenant_id, operation_id, provider, source, dedupe_key, normalized_result,
             match_result, evidence_hash, observed_at
           ) values ($1, $2, 'SYNTHETIC', 'READBACK', $3, $4, $5, $6, now())`,
          [
            input.tenantId,
            row.id,
            `readback:${row.id}:${count(row.readback_attempts)}`,
            resultClass(verifiedResult),
            verifiedResult.outcome === 'MISMATCH'
              ? verifiedResult.mismatch
              : verifiedResult.outcome.startsWith('MATCHED_')
                ? 'MATCHED'
                : 'NOT_APPLICABLE',
            evidenceHash(verifiedResult) ?? `unavailable:${row.id}:${count(row.readback_attempts)}`,
          ],
        );
        await terminalize(
          client,
          row,
          input.tenantId,
          next,
          'providerOperationId' in verifiedResult ? verifiedResult.providerOperationId : undefined,
          locked.game,
        );
        return 'applied';
      });
    },
    recordCallback(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const locked = await lockOperationInAggregateOrder(
          client,
          input.tenantId,
          input.operationId,
        );
        const row = locked?.row;
        if (!row) return 'mismatch';
        const verifiedResult = verifiedReadBackResult(row, input.tenantId, input.result);
        const inserted = await client.query(
          `insert into integration.game_provider_operation_observations (
             tenant_id, operation_id, provider, source, dedupe_key, normalized_result,
             match_result, evidence_hash, observed_at
           ) values ($1, $2, 'SYNTHETIC', 'CALLBACK', $3, $4, $5, $6, $7)
           on conflict (tenant_id, provider, dedupe_key) do nothing`,
          [
            input.tenantId,
            row.id,
            input.dedupeKey,
            resultClass(verifiedResult),
            verifiedResult.outcome === 'MISMATCH'
              ? verifiedResult.mismatch
              : verifiedResult.outcome.startsWith('MATCHED_')
                ? 'MATCHED'
                : 'NOT_APPLICABLE',
            input.evidenceHash,
            input.observedAt,
          ],
        );
        if (inserted.rowCount !== 1) {
          const existing = await queryOne<
            QueryResultRow & {
              operation_id: string;
              normalized_result: string;
              evidence_hash: string;
            }
          >(
            client,
            `select operation_id, normalized_result, evidence_hash
               from integration.game_provider_operation_observations
              where tenant_id = $1 and provider = 'SYNTHETIC' and dedupe_key = $2`,
            [input.tenantId, input.dedupeKey],
          );
          const exactDuplicate =
            existing?.operation_id === row.id &&
            existing.normalized_result === resultClass(verifiedResult) &&
            existing.evidence_hash === input.evidenceHash;
          if (exactDuplicate) return 'duplicate';
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id, result,
               correlation_id, new_value
             ) values ($1, $2, 'GAME_PROVIDER_CALLBACK_DEDUPE_COLLISION',
                       'GAME_PROVIDER_OPERATION', $3, 'FAILURE', $4, $5::jsonb)`,
            [
              input.tenantId,
              row.actor_user_id,
              row.id,
              row.correlation_id,
              JSON.stringify({ state: row.state, callbackResult: verifiedResult.outcome }),
            ],
          );
          if (!['CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'].includes(row.state)) {
            await client.query(
              `update integration.game_provider_operations
                  set state = 'MANUAL_REVIEW', resolution = 'UNKNOWN', terminal_at = now(),
                      lease_token = null, lease_expires_at = null,
                      last_error_class = 'REFERENCE_MISMATCH', version = version + 1, updated_at = now()
                where tenant_id = $1 and id = $2`,
              [input.tenantId, row.id],
            );
          }
          return 'mismatch';
        }
        const terminalAgreement =
          (row.state === 'CONFIRMED' && verifiedResult.outcome === 'MATCHED_ACCEPTED') ||
          (row.state === 'REJECTED' && verifiedResult.outcome === 'MATCHED_REJECTED');
        if (['CONFIRMED', 'REJECTED', 'MANUAL_REVIEW'].includes(row.state)) {
          if (!terminalAgreement) {
            await client.query(
              `insert into audit.audit_log (
                 tenant_id, actor_id, action, resource_type, resource_id, result,
                 correlation_id, new_value
               ) values ($1, $2, 'GAME_PROVIDER_TERMINAL_CONFLICT',
                         'GAME_PROVIDER_OPERATION', $3, 'FAILURE', $4, $5::jsonb)`,
              [
                input.tenantId,
                row.actor_user_id,
                row.id,
                row.correlation_id,
                JSON.stringify({ state: row.state, callback: verifiedResult.outcome }),
              ],
            );
            return 'mismatch';
          }
          return 'stale';
        }
        if (input.evidenceHash !== evidenceHash(verifiedResult)) return 'mismatch';
        if (row.state === 'READY') {
          await client.query(
            `update integration.game_provider_operations
                set state = 'MANUAL_REVIEW', resolution = 'UNKNOWN', terminal_at = now(),
                    lease_token = null, lease_expires_at = null,
                    last_error_class = 'REFERENCE_MISMATCH', version = version + 1, updated_at = now()
              where tenant_id = $1 and id = $2`,
            [input.tenantId, row.id],
          );
          return 'mismatch';
        }
        if (row.state !== 'UNKNOWN') return 'stale';
        if (verifiedResult.outcome === 'MISMATCH' || verifiedResult.outcome === 'AMBIGUOUS') {
          await client.query(
            `update integration.game_provider_operations
                set state = 'UNKNOWN', resolution = null, lease_token = null, lease_expires_at = null,
                    last_error_class = $3, next_attempt_at = now(), version = version + 1, updated_at = now()
              where tenant_id = $1 and id = $2`,
            [
              input.tenantId,
              row.id,
              verifiedResult.outcome === 'MISMATCH'
                ? verifiedResult.mismatch
                : 'AMBIGUOUS_READBACK',
            ],
          );
          return 'mismatch';
        }
        const next = readBackTransition(verifiedResult, 0, 1);
        const callbackLease = randomUUID();
        await client.query(
          `update integration.game_provider_operations
              set state = 'RECONCILING', lease_token = $3,
                  lease_expires_at = now() + interval '30 seconds', updated_at = now()
            where tenant_id = $1 and id = $2 and state = 'UNKNOWN'`,
          [input.tenantId, row.id, callbackLease],
        );
        const leasedRow = { ...row, state: 'RECONCILING' as const, lease_token: callbackLease };
        await terminalize(
          client,
          leasedRow,
          input.tenantId,
          next,
          'providerOperationId' in verifiedResult ? verifiedResult.providerOperationId : undefined,
          locked.game,
        );
        return 'applied';
      });
    },
    getForActor(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<OperationRow>(
          client,
          `select * from integration.game_provider_operations
            where tenant_id = $1 and actor_user_id = $2 and source_command_id = $3`,
          [input.tenantId, input.actorUserId, input.sourceCommandId],
        );
        return row
          ? {
              operationId: row.id,
              sourceCommandId: row.source_command_id,
              state: row.state,
              action: row.action,
              submitAttempts: count(row.submit_attempts),
              readBackAttempts: count(row.readback_attempts),
              ...(row.last_error_class ? { lastErrorClass: row.last_error_class } : {}),
              updatedAt: iso(row.updated_at),
            }
          : undefined;
      });
    },
  };
}
