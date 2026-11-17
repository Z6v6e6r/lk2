import type { GameRosterRepository } from '@phub/database';
import type { Logger } from 'pino';

import {
  reconcileCommercialJoinOperation,
  type CommercialJoinOwnerPort,
  type CommercialJoinRepositoryPort,
} from './game-commercial-join.js';

/**
 * Background reconciliation of paid JOIN attempts whose owner outcome is unresolved.
 *
 * It never dispatches the owner command again: it only reads the original operation by its
 * original operation id and applies a trusted receipt through the same reconciliation path the
 * API uses for GET readback. An unresolved attempt keeps its seat; a confirmed one is finalized
 * exactly once by the existing confirmation evidence key.
 */
export interface PaidJoinReconciliationCycleResult {
  readonly candidates: number;
  readonly confirmed: number;
  readonly unresolved: number;
  readonly escalated: number;
  readonly failed: number;
}

export async function runPaidJoinReconciliationCycle(input: {
  readonly tenantId: string;
  readonly repository: Pick<
    GameRosterRepository,
    | 'listPaidJoinReconciliationCandidates'
    | 'recordPaidJoinReconciliationAttempt'
    | 'getPaidJoinAttempt'
    | 'confirmPayment'
  >;
  readonly owner: CommercialJoinOwnerPort;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly limit?: number;
  readonly maxAttempts?: number;
  readonly now?: () => number;
}): Promise<PaidJoinReconciliationCycleResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 30, 100));
  const result = {
    candidates: 0,
    confirmed: 0,
    unresolved: 0,
    escalated: 0,
    failed: 0,
  };

  const candidates = await input.repository.listPaidJoinReconciliationCandidates({
    tenantId: input.tenantId,
    limit,
    maxAttempts,
  });
  result.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      const body = await reconcileCommercialJoinOperation(
        {
          tenantId: input.tenantId,
          tenantKey: candidate.actorContext.tenantKey,
          actorUserId: candidate.actorUserId,
          sessionId: candidate.actorContext.sessionId,
          operationId: candidate.operationId,
          correlationId: `join-reconcile-${candidate.operationId}`,
        },
        {
          repository: input.repository as unknown as CommercialJoinRepositoryPort,
          owner: input.owner,
          ...(input.now === undefined ? {} : { now: input.now }),
          onReconciliationFailure: (code) =>
            input.logger.warn(
              {
                tenantId: input.tenantId,
                operationId: candidate.operationId,
                gameId: candidate.gameId,
                code,
              },
              'Paid JOIN reconciliation remained unresolved',
            ),
        },
      );

      if (body?.operation.status === 'SUCCEEDED') {
        result.confirmed += 1;
        input.logger.info(
          {
            tenantId: input.tenantId,
            operationId: candidate.operationId,
            gameId: candidate.gameId,
          },
          'Paid JOIN reconciled from the original owner receipt',
        );
        continue;
      }

      const attempts = candidate.reconciliationAttempts + 1;
      const escalated = attempts >= maxAttempts;
      await input.repository.recordPaidJoinReconciliationAttempt({
        tenantId: input.tenantId,
        operationId: candidate.operationId,
        attempts,
        escalated,
      });
      if (escalated) {
        result.escalated += 1;
        input.logger.error(
          {
            tenantId: input.tenantId,
            operationId: candidate.operationId,
            gameId: candidate.gameId,
            attempts,
          },
          'Paid JOIN reconciliation requires operator review',
        );
      } else {
        result.unresolved += 1;
      }
    } catch (error) {
      result.failed += 1;
      input.logger.warn(
        {
          err: error,
          tenantId: input.tenantId,
          operationId: candidate.operationId,
          gameId: candidate.gameId,
        },
        'Paid JOIN reconciliation attempt failed',
      );
    }
  }

  return result;
}

/**
 * Starts the bounded API-side reconciliation loop. The loop is intentionally sequential and
 * unref'd so it cannot extend process shutdown; each cycle is limited and every attempt is
 * persisted before the next one starts.
 */
export function startPaidJoinReconciliation(input: {
  readonly tenantIds: () => Promise<readonly string[]>;
  readonly repository: Pick<
    GameRosterRepository,
    | 'listPaidJoinReconciliationCandidates'
    | 'recordPaidJoinReconciliationAttempt'
    | 'getPaidJoinAttempt'
    | 'confirmPayment'
  >;
  readonly owner: CommercialJoinOwnerPort;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly maxAttempts?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<void> => {
    if (stopped) return;
    try {
      const tenantIds = await input.tenantIds();
      for (const tenantId of tenantIds) {
        if (stopped) return;
        await runPaidJoinReconciliationCycle({
          tenantId,
          repository: input.repository,
          owner: input.owner,
          logger: input.logger,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
        });
      }
    } catch (error) {
      input.logger.warn({ err: error }, 'Paid JOIN reconciliation cycle failed');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void run(), input.intervalMs ?? 60_000);
        timer.unref?.();
      }
    }
  };

  void run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
