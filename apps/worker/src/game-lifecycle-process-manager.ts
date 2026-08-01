import type {
  ClaimedGameScheduledCommand,
  GameRepository,
  GameLifecycleCommandType,
} from '@phub/database';
import type { Logger } from 'pino';

export const GAME_LIFECYCLE_COMMAND_TYPES: readonly GameLifecycleCommandType[] = [
  'game.lifecycle.start.v1',
  'game.lifecycle.finish.v1',
];

export interface GameLifecycleProcessManagerCycleResult {
  readonly claimed: number;
  readonly applied: number;
  readonly alreadyApplied: number;
  readonly rescheduled: number;
  readonly retryScheduled: number;
  readonly attemptsExhausted: number;
}

function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 6)));
}

function correlationId(command: ClaimedGameScheduledCommand): string {
  return `games-process-manager-${command.id}`;
}

export async function runGameLifecycleProcessManagerCycle(input: {
  readonly repository: Pick<
    GameRepository,
    'claimScheduledCommands' | 'executeLifecycleCommand' | 'retryScheduledCommand'
  >;
  readonly tenantId: string;
  readonly workerId: string;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly batchSize: number;
  readonly now?: () => Date;
}): Promise<GameLifecycleProcessManagerCycleResult> {
  const result = {
    claimed: 0,
    applied: 0,
    alreadyApplied: 0,
    rescheduled: 0,
    retryScheduled: 0,
    attemptsExhausted: 0,
  };
  const limit = Math.max(1, Math.min(input.batchSize, 100));

  while (result.claimed < limit) {
    const [command] = await input.repository.claimScheduledCommands({
      tenantId: input.tenantId,
      workerId: input.workerId,
      limit: 1,
      commandTypes: GAME_LIFECYCLE_COMMAND_TYPES,
    });
    if (!command) break;
    result.claimed += 1;

    try {
      const executed = await input.repository.executeLifecycleCommand({
        tenantId: input.tenantId,
        workerId: input.workerId,
        commandId: command.id,
        correlationId: correlationId(command),
        occurredAt: input.now?.() ?? new Date(),
      });
      switch (executed.outcome) {
        case 'applied':
          result.applied += 1;
          input.logger.info(
            {
              tenantId: input.tenantId,
              commandId: command.id,
              gameId: executed.gameId,
              lifecycleState: executed.lifecycleState,
              revision: executed.revision,
              eventId: executed.eventId,
            },
            'Games lifecycle command applied',
          );
          break;
        case 'already_applied':
          result.alreadyApplied += 1;
          break;
        case 'rescheduled':
          result.rescheduled += 1;
          input.logger.info(
            {
              tenantId: input.tenantId,
              commandId: command.id,
              gameId: executed.gameId,
              dueAt: executed.dueAt,
              expectedRevision: executed.expectedRevision,
            },
            'Games lifecycle command refreshed from canonical schedule',
          );
          break;
        case 'not_claimed':
          input.logger.warn(
            { tenantId: input.tenantId, commandId: command.id },
            'Games lifecycle command claim was lost before execution',
          );
          break;
      }
    } catch (error) {
      const availableAt = new Date(
        (input.now?.() ?? new Date()).getTime() + retryDelayMs(command.attempts),
      ).toISOString();
      const retry = await input.repository.retryScheduledCommand({
        tenantId: input.tenantId,
        workerId: input.workerId,
        commandId: command.id,
        errorCode: 'GAME_LIFECYCLE_COMMAND_FAILED',
        availableAt,
      });
      if (retry === 'retry_scheduled') {
        result.retryScheduled += 1;
        input.logger.warn(
          {
            error,
            tenantId: input.tenantId,
            commandId: command.id,
            gameId: command.gameId,
            attempts: command.attempts,
            availableAt,
          },
          'Games lifecycle command deferred for retry',
        );
      } else if (retry === 'attempts_exhausted') {
        result.attemptsExhausted += 1;
        input.logger.error(
          {
            error,
            tenantId: input.tenantId,
            commandId: command.id,
            gameId: command.gameId,
            attempts: command.attempts,
          },
          'Games lifecycle command attempts exhausted',
        );
      }
    }
  }

  return result;
}
