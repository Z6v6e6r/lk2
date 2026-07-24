import { randomUUID } from 'node:crypto';

import {
  disputeGameResultInputSchema,
  gameDomainEventSchema,
  submitGameResultInputSchema,
  type DisputeGameResultInput,
  type GameResultSetInput,
  type GameResultState,
  type SubmitGameResultInput,
} from '@phub/games';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type GameResultCommandErrorCode =
  | 'GAME_NOT_FOUND'
  | 'GAME_RESULT_NOT_AVAILABLE'
  | 'GAME_RESULT_NOT_PARTICIPANT'
  | 'GAME_RESULT_INVALID_ROSTER'
  | 'GAME_RESULT_SUBMISSION_NOT_FOUND'
  | 'GAME_RESULT_REVIEW_FORBIDDEN'
  | 'GAME_RESULT_STATE_CONFLICT';

export interface GameResultCommandInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly gameId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly correlationId: string;
}

export interface SubmitGameResultCommandInput extends GameResultCommandInput {
  readonly result: SubmitGameResultInput;
}

export interface ReviewGameResultCommandInput extends GameResultCommandInput {
  readonly submissionId: string;
}

export interface DisputeGameResultCommandInput extends ReviewGameResultCommandInput {
  readonly dispute: DisputeGameResultInput;
}

export type GameResultCommandResult =
  | {
      readonly outcome: 'applied';
      readonly commandId: string;
      readonly gameId: string;
      readonly submissionId: string;
      readonly resultId?: string;
      readonly revision: number;
      readonly resultState: Extract<
        GameResultState,
        'PENDING_CONFIRMATION' | 'CONFIRMED' | 'DISPUTED'
      >;
      readonly committedAt: string;
      readonly replayed: boolean;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: GameResultCommandErrorCode;
      readonly currentRevision?: number;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' };

export interface GameResultRepository {
  submit(input: SubmitGameResultCommandInput): Promise<GameResultCommandResult>;
  confirm(input: ReviewGameResultCommandInput): Promise<GameResultCommandResult>;
  dispute(input: DisputeGameResultCommandInput): Promise<GameResultCommandResult>;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: string;
  readonly request_hash: string;
  readonly state: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  readonly result_payload: unknown;
  readonly error_code: string | null;
}

interface LockedGameRow extends QueryResultRow {
  readonly revision: string | number;
  readonly lifecycle_state: string;
  readonly result_state: GameResultState;
  readonly ends_at: Date | string;
  readonly database_now: Date | string;
}

interface SubmissionRow extends QueryResultRow {
  readonly id: string;
  readonly revision: number;
  readonly submitted_by_user_id: string;
  readonly state: 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'DISPUTED' | 'SUPERSEDED';
  readonly confirmation_quorum: number;
  readonly score_payload: unknown;
  readonly roster_snapshot: unknown;
}

interface RevisionRow extends QueryResultRow {
  readonly revision: string | number;
}

interface CountRow extends QueryResultRow {
  readonly count: number;
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

function rosterFromSnapshot(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const participantUserIds = (value as Record<string, unknown>).participantUserIds;
  return Array.isArray(participantUserIds) &&
    participantUserIds.every((item) => typeof item === 'string')
    ? participantUserIds
    : [];
}

async function lockIdempotency(
  client: PoolClient,
  input: GameResultCommandInput,
): Promise<CommandRow | undefined> {
  const principal = principalKey(input.actorUserId);
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `game-result:${input.tenantId}:${principal}:${input.idempotencyKey}`,
  ]);
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, state, result_payload, error_code
       from games.command_idempotency
      where tenant_id = $1 and principal_key = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, principal, input.idempotencyKey],
  );
}

function replayCommand(
  row: CommandRow | undefined,
  commandType: string,
  requestHash: string,
): GameResultCommandResult | undefined {
  if (!row) return undefined;
  if (row.command_type !== commandType || row.request_hash !== requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  if (row.state === 'FAILED' && row.error_code) {
    return {
      outcome: 'rejected',
      code: row.error_code as GameResultCommandErrorCode,
      replayed: true,
    };
  }
  if (row.state !== 'COMPLETED') return { outcome: 'idempotency_conflict' };
  const result = row.result_payload as Partial<
    Extract<GameResultCommandResult, { outcome: 'applied' }>
  > | null;
  if (
    !result ||
    result.outcome !== 'applied' ||
    typeof result.commandId !== 'string' ||
    typeof result.gameId !== 'string' ||
    typeof result.submissionId !== 'string' ||
    typeof result.revision !== 'number' ||
    typeof result.committedAt !== 'string' ||
    !['PENDING_CONFIRMATION', 'CONFIRMED', 'DISPUTED'].includes(String(result.resultState))
  ) {
    throw new Error('GAME_RESULT_IDEMPOTENCY_RESULT_INVALID');
  }
  return {
    ...result,
    outcome: 'applied',
    resultState: result.resultState as Extract<
      GameResultState,
      'PENDING_CONFIRMATION' | 'CONFIRMED' | 'DISPUTED'
    >,
    commandId: result.commandId,
    gameId: result.gameId,
    submissionId: result.submissionId,
    revision: result.revision,
    committedAt: result.committedAt,
    replayed: true,
  };
}

async function lockGame(
  client: PoolClient,
  input: GameResultCommandInput,
): Promise<LockedGameRow | undefined> {
  return queryOne<LockedGameRow>(
    client,
    `select revision, lifecycle_state, result_state, ends_at, now()::text as database_now
       from games.games
      where tenant_id = $1 and id = $2
      for update`,
    [input.tenantId, input.gameId],
  );
}

async function participantUserIds(
  client: PoolClient,
  input: Pick<GameResultCommandInput, 'tenantId' | 'gameId'>,
): Promise<readonly string[]> {
  const rows = await client.query<{ user_id: string }>(
    `select user_id
       from games.participations
      where tenant_id = $1 and game_id = $2 and state = 'ACTIVE'
      order by joined_at, id`,
    [input.tenantId, input.gameId],
  );
  return rows.rows.map((row) => row.user_id);
}

async function storeCompleted(
  client: PoolClient,
  input: GameResultCommandInput,
  commandType: string,
  result: Extract<GameResultCommandResult, { outcome: 'applied' }>,
): Promise<void> {
  await client.query(
    `insert into games.command_idempotency (
       tenant_id, id, actor_user_id, principal_key, idempotency_key,
       command_type, request_hash, aggregate_id, state, result_payload, completed_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', $9::jsonb, now())`,
    [
      input.tenantId,
      result.commandId,
      input.actorUserId,
      principalKey(input.actorUserId),
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
     ) values ($1, $2, $3, 'GAME_RESULT', $4, 'SUCCESS', $5, $6::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      commandType.toUpperCase().replaceAll('.', '_'),
      input.gameId,
      input.correlationId,
      JSON.stringify({
        submissionId: result.submissionId,
        ...(result.resultId ? { resultId: result.resultId } : {}),
        resultState: result.resultState,
        revision: result.revision,
      }),
    ],
  );
}

async function storeRejected(
  client: PoolClient,
  input: GameResultCommandInput,
  commandType: string,
  commandId: string,
  code: GameResultCommandErrorCode,
  aggregateExists: boolean,
  currentRevision?: number,
): Promise<GameResultCommandResult> {
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
     ) values ($1, $2, $3, 'GAME_RESULT', $4, 'REJECTED', $5, $6, $7::jsonb)`,
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

async function bumpRevision(
  client: PoolClient,
  input: Pick<GameResultCommandInput, 'tenantId' | 'gameId'>,
  resultState: Extract<GameResultState, 'PENDING_CONFIRMATION' | 'CONFIRMED' | 'DISPUTED'>,
): Promise<number> {
  const row = await queryOne<RevisionRow>(
    client,
    `update games.games
        set revision = revision + 1, result_state = $3, updated_at = now()
      where tenant_id = $1 and id = $2
      returning revision`,
    [input.tenantId, input.gameId, resultState],
  );
  if (!row) throw new Error('GAME_RESULT_REVISION_WRITE_LOST');
  return positiveInteger(row.revision);
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

function eventBase(
  input: GameResultCommandInput,
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

async function normalizeConfirmedResult(
  client: PoolClient,
  input: ReviewGameResultCommandInput,
  resultId: string,
  sets: readonly GameResultSetInput[],
): Promise<void> {
  for (const set of sets) {
    await client.query(
      `insert into games.result_sets (
         tenant_id, game_id, result_id, set_number, team_a_score, team_b_score
       ) values ($1, $2, $3, $4, $5, $6)`,
      [input.tenantId, input.gameId, resultId, set.setNumber, set.teamA, set.teamB],
    );
    const players = [
      ...set.teamAUserIds.map((userId, index) => ({ userId, team: 'A', slot: index + 1 })),
      ...set.teamBUserIds.map((userId, index) => ({ userId, team: 'B', slot: index + 1 })),
    ];
    for (const player of players) {
      await client.query(
        `insert into games.result_set_players (
           tenant_id, game_id, result_id, set_number, user_id, team, slot
         ) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.tenantId,
          input.gameId,
          resultId,
          set.setNumber,
          player.userId,
          player.team,
          player.slot,
        ],
      );
    }
  }
}

async function loadSubmission(
  client: PoolClient,
  input: ReviewGameResultCommandInput,
): Promise<SubmissionRow | undefined> {
  return queryOne<SubmissionRow>(
    client,
    `select id, revision, submitted_by_user_id, state, confirmation_quorum,
            score_payload, roster_snapshot
       from games.result_submissions
      where tenant_id = $1 and game_id = $2 and id = $3
      for update`,
    [input.tenantId, input.gameId, input.submissionId],
  );
}

export function createGameResultRepository(pool: Pool): GameResultRepository {
  return {
    submit(input) {
      const commandType = 'game.result.submit.v1';
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
        if (game.lifecycle_state !== 'FINISHED') {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_NOT_AVAILABLE',
            true,
            currentRevision,
          );
        }
        if (
          game.result_state === 'AWAITING_SUBMISSION' &&
          Date.parse(timestamp(game.database_now)) >=
            Date.parse(timestamp(game.ends_at)) + 48 * 60 * 60_000
        ) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_NOT_AVAILABLE',
            true,
            currentRevision,
          );
        }
        if (!['AWAITING_SUBMISSION', 'DISPUTED'].includes(game.result_state)) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_STATE_CONFLICT',
            true,
            currentRevision,
          );
        }
        const roster = await participantUserIds(client, input);
        if (!roster.includes(input.actorUserId)) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_NOT_PARTICIPANT',
            true,
            currentRevision,
          );
        }
        const parsed = submitGameResultInputSchema.safeParse(input.result);
        const submittedRoster = parsed.success
          ? [...parsed.data.sets[0]!.teamAUserIds, ...parsed.data.sets[0]!.teamBUserIds].sort()
          : [];
        const expectedRoster = [...roster].sort();
        if (
          !parsed.success ||
          roster.length !== 4 ||
          submittedRoster.some((userId, index) => userId !== expectedRoster[index])
        ) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_INVALID_ROSTER',
            true,
            currentRevision,
          );
        }
        if (game.result_state === 'DISPUTED') {
          await client.query(
            `update games.result_submissions
                set state = 'SUPERSEDED', terminal_at = now(), dispute_reason_code = null
              where tenant_id = $1 and game_id = $2 and state = 'DISPUTED'`,
            [input.tenantId, input.gameId],
          );
        }
        const submissionId = randomUUID();
        const revisionRow = await queryOne<{ revision: number }>(
          client,
          `select coalesce(max(revision), 0)::integer + 1 as revision
             from games.result_submissions
            where tenant_id = $1 and game_id = $2`,
          [input.tenantId, input.gameId],
        );
        const submissionRevision = revisionRow?.revision ?? 1;
        await client.query(
          `insert into games.result_submissions (
             tenant_id, game_id, id, revision, submitted_by_user_id, state,
             score_payload, roster_snapshot, confirmation_quorum
           ) values ($1, $2, $3, $4, $5, 'PENDING_CONFIRMATION', $6::jsonb, $7::jsonb, 1)`,
          [
            input.tenantId,
            input.gameId,
            submissionId,
            submissionRevision,
            input.actorUserId,
            JSON.stringify(parsed.data),
            JSON.stringify({ participantUserIds: roster }),
          ],
        );
        const revision = await bumpRevision(client, input, 'PENDING_CONFIRMATION');
        const committedAt = timestamp(game.database_now);
        const result: Extract<GameResultCommandResult, { outcome: 'applied' }> = {
          outcome: 'applied',
          commandId,
          gameId: input.gameId,
          submissionId,
          revision,
          resultState: 'PENDING_CONFIRMATION',
          committedAt,
          replayed: false,
        };
        await storeCompleted(client, input, commandType, result);
        await appendEvent(client, {
          ...eventBase(input, commandId, revision, committedAt),
          type: 'game.result.submitted.v1',
          payload: {
            ...eventBase(input, commandId, revision, committedAt).payload,
            submissionId,
            submittedByUserId: input.actorUserId,
            requiredConfirmationUserIds: roster.filter((userId) => userId !== input.actorUserId),
          },
        });
        return result;
      });
    },

    confirm(input) {
      const commandType = 'game.result.confirm.v1';
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
        const submission = await loadSubmission(client, input);
        if (!submission) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_SUBMISSION_NOT_FOUND',
            true,
            currentRevision,
          );
        }
        const roster = rosterFromSnapshot(submission.roster_snapshot);
        if (
          submission.state !== 'PENDING_CONFIRMATION' ||
          game.result_state !== 'PENDING_CONFIRMATION'
        ) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_STATE_CONFLICT',
            true,
            currentRevision,
          );
        }
        if (
          !roster.includes(input.actorUserId) ||
          submission.submitted_by_user_id === input.actorUserId
        ) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_REVIEW_FORBIDDEN',
            true,
            currentRevision,
          );
        }
        await client.query(
          `insert into games.result_submission_reviews (
             tenant_id, game_id, submission_id, reviewer_user_id, decision, decided_at
           ) values ($1, $2, $3, $4, 'CONFIRMED', now())`,
          [input.tenantId, input.gameId, input.submissionId, input.actorUserId],
        );
        const countRow = await queryOne<CountRow>(
          client,
          `select count(*)::integer as count
             from games.result_submission_reviews
            where tenant_id = $1 and submission_id = $2 and decision = 'CONFIRMED'`,
          [input.tenantId, input.submissionId],
        );
        if ((countRow?.count ?? 0) < submission.confirmation_quorum) {
          throw new Error('GAME_RESULT_CONFIRMATION_QUORUM_UNSUPPORTED');
        }
        const score = submitGameResultInputSchema.parse(submission.score_payload);
        const resultId = randomUUID();
        await client.query(
          `insert into games.results (
             tenant_id, game_id, id, submission_id, revision, state,
             score_payload, confirmed_by_user_id, confirmed_at
           ) values ($1, $2, $3, $4, $5, 'CONFIRMED', $6::jsonb, $7, now())`,
          [
            input.tenantId,
            input.gameId,
            resultId,
            input.submissionId,
            submission.revision,
            JSON.stringify(score),
            input.actorUserId,
          ],
        );
        await normalizeConfirmedResult(client, input, resultId, score.sets);
        await client.query(
          `update games.result_submissions
              set state = 'CONFIRMED', terminal_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3`,
          [input.tenantId, input.gameId, input.submissionId],
        );
        const revision = await bumpRevision(client, input, 'CONFIRMED');
        const committedAt = timestamp(game.database_now);
        const result: Extract<GameResultCommandResult, { outcome: 'applied' }> = {
          outcome: 'applied',
          commandId,
          gameId: input.gameId,
          submissionId: input.submissionId,
          resultId,
          revision,
          resultState: 'CONFIRMED',
          committedAt,
          replayed: false,
        };
        await storeCompleted(client, input, commandType, result);
        await appendEvent(client, {
          ...eventBase(input, commandId, revision, committedAt),
          type: 'game.result.confirmed.v1',
          payload: {
            ...eventBase(input, commandId, revision, committedAt).payload,
            resultId,
            participantUserIds: roster,
          },
        });
        return result;
      });
    },

    dispute(input) {
      const commandType = 'game.result.dispute.v1';
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
        const submission = await loadSubmission(client, input);
        if (!submission) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_SUBMISSION_NOT_FOUND',
            true,
            currentRevision,
          );
        }
        const roster = rosterFromSnapshot(submission.roster_snapshot);
        const dispute = disputeGameResultInputSchema.safeParse(input.dispute);
        if (
          !dispute.success ||
          submission.state !== 'PENDING_CONFIRMATION' ||
          game.result_state !== 'PENDING_CONFIRMATION'
        ) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_STATE_CONFLICT',
            true,
            currentRevision,
          );
        }
        if (
          !roster.includes(input.actorUserId) ||
          submission.submitted_by_user_id === input.actorUserId
        ) {
          return storeRejected(
            client,
            input,
            commandType,
            commandId,
            'GAME_RESULT_REVIEW_FORBIDDEN',
            true,
            currentRevision,
          );
        }
        await client.query(
          `insert into games.result_submission_reviews (
             tenant_id, game_id, submission_id, reviewer_user_id,
             decision, reason_code, note, decided_at
           ) values ($1, $2, $3, $4, 'DISPUTED', $5, $6, now())`,
          [
            input.tenantId,
            input.gameId,
            input.submissionId,
            input.actorUserId,
            dispute.data.reasonCode,
            dispute.data.note ?? null,
          ],
        );
        await client.query(
          `update games.result_submissions
              set state = 'DISPUTED', dispute_reason_code = $4, terminal_at = now()
            where tenant_id = $1 and game_id = $2 and id = $3`,
          [input.tenantId, input.gameId, input.submissionId, dispute.data.reasonCode],
        );
        const revision = await bumpRevision(client, input, 'DISPUTED');
        const committedAt = timestamp(game.database_now);
        const result: Extract<GameResultCommandResult, { outcome: 'applied' }> = {
          outcome: 'applied',
          commandId,
          gameId: input.gameId,
          submissionId: input.submissionId,
          revision,
          resultState: 'DISPUTED',
          committedAt,
          replayed: false,
        };
        await storeCompleted(client, input, commandType, result);
        await appendEvent(client, {
          ...eventBase(input, commandId, revision, committedAt),
          type: 'game.result.disputed.v1',
          payload: {
            ...eventBase(input, commandId, revision, committedAt).payload,
            submissionId: input.submissionId,
            disputedByUserId: input.actorUserId,
            participantUserIds: roster,
            reasonCode: dispute.data.reasonCode,
          },
        });
        return result;
      });
    },
  };
}
