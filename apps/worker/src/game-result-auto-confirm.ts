import type { GameResultCommandResult, GameResultRepository } from '@phub/database';
import type { Pool, QueryResultRow } from 'pg';

export interface DueGameResultSubmission {
  readonly gameId: string;
  readonly submissionId: string;
}

export interface GameResultAutoConfirmPort {
  listDueSubmissions(input: {
    readonly tenantId: string;
    readonly confirmationWindowHours: number;
    readonly limit: number;
  }): Promise<readonly DueGameResultSubmission[]>;
  confirmDueSubmission(input: {
    readonly tenantId: string;
    readonly gameId: string;
    readonly submissionId: string;
    readonly confirmationWindowHours: number;
    readonly correlationId: string;
  }): Promise<GameResultCommandResult>;
}

export interface GameResultAutoConfirmBatchResult {
  readonly confirmed: number;
  readonly skipped: number;
  readonly failed: number;
}

/**
 * Confirms submissions nobody answered inside their window. One submission's failure must not stop
 * the batch: the rest still move, and the failed one is simply retried by the next cycle because the
 * command is idempotent per submission revision.
 */
export async function runGameResultAutoConfirmBatch(options: {
  readonly port: GameResultAutoConfirmPort;
  readonly tenantId: string;
  readonly confirmationWindowHours: number;
  readonly batchSize: number;
  readonly correlationId: string;
  readonly onError?: (input: {
    readonly gameId: string;
    readonly submissionId: string;
    readonly error: unknown;
  }) => void;
}): Promise<GameResultAutoConfirmBatchResult> {
  const due = await options.port.listDueSubmissions({
    tenantId: options.tenantId,
    confirmationWindowHours: options.confirmationWindowHours,
    limit: options.batchSize,
  });
  let confirmed = 0;
  let skipped = 0;
  let failed = 0;
  for (const submission of due) {
    try {
      const result = await options.port.confirmDueSubmission({
        tenantId: options.tenantId,
        gameId: submission.gameId,
        submissionId: submission.submissionId,
        confirmationWindowHours: options.confirmationWindowHours,
        correlationId: options.correlationId,
      });
      if (result.outcome === 'applied') confirmed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      options.onError?.({
        gameId: submission.gameId,
        submissionId: submission.submissionId,
        error,
      });
    }
  }
  return { confirmed, skipped, failed };
}

interface DueRow extends QueryResultRow {
  readonly game_id: string;
  readonly submission_id: string;
}

const DUE_SQL = `
  select s.game_id, s.id as submission_id
    from games.result_submissions s
    join games.games g
      on g.tenant_id = s.tenant_id and g.id = s.game_id
   where s.tenant_id = $1
     and s.state = 'PENDING_CONFIRMATION'
     and g.result_state = 'PENDING_CONFIRMATION'
     and s.submitted_at <= now() - make_interval(hours => $2::integer)
   order by s.submitted_at, s.id
   limit $3
`;

/**
 * The worker already holds the result repository, so the port only adds the due-submission scan: the
 * confirmation itself runs through the same transactional command as a participant confirmation.
 */
export function createGameResultAutoConfirmPort(input: {
  readonly pool: Pool;
  readonly repository: Pick<GameResultRepository, 'autoConfirm'>;
}): GameResultAutoConfirmPort {
  return {
    async listDueSubmissions({ tenantId, confirmationWindowHours, limit }) {
      const { rows } = await input.pool.query<DueRow>(DUE_SQL, [
        tenantId,
        confirmationWindowHours,
        limit,
      ]);
      return rows.map((row) => ({ gameId: row.game_id, submissionId: row.submission_id }));
    },
    confirmDueSubmission({
      tenantId,
      gameId,
      submissionId,
      confirmationWindowHours,
      correlationId,
    }) {
      return input.repository.autoConfirm({
        tenantId,
        gameId,
        submissionId,
        confirmationWindowHours,
        correlationId,
      });
    },
  };
}
