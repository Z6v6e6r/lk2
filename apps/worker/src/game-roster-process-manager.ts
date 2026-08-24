import { createHash } from 'node:crypto';

import type {
  ClaimedGameScheduledCommand,
  GameRepository,
  GameRosterRepository,
} from '@phub/database';
import type { Logger } from 'pino';

export const GAME_ROSTER_COMMAND_TYPES = [
  'game.reservation.expire.v1',
  'game.waitlist.promote.v1',
] as const;

export interface GameRosterProcessManagerCycleResult {
  readonly claimed: number;
  readonly applied: number;
  readonly noOp: number;
  readonly notDue: number;
  readonly retryScheduled: number;
  readonly attemptsExhausted: number;
  readonly invalidPayload: number;
  readonly terminalFailed: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 6)));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function correlationId(command: ClaimedGameScheduledCommand): string {
  return `games-roster-process-manager-${command.id}`;
}

function requestHash(command: ClaimedGameScheduledCommand, targetId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commandId: command.id,
        commandType: command.commandType,
        gameId: command.gameId,
        targetId,
      }),
    )
    .digest('hex');
}

function targetId(command: ClaimedGameScheduledCommand): string | undefined {
  if (!isUuid(command.gameId)) return undefined;
  if (command.commandType === 'game.reservation.expire.v1') {
    return isUuid(command.payload.reservationId) ? command.payload.reservationId : undefined;
  }
  if (command.commandType === 'game.waitlist.promote.v1') {
    return isUuid(command.payload.waitlistEntryId) ? command.payload.waitlistEntryId : undefined;
  }
  return undefined;
}

async function retryClaim(input: {
  readonly repository: Pick<GameRepository, 'retryScheduledCommand'>;
  readonly tenantId: string;
  readonly workerId: string;
  readonly command: ClaimedGameScheduledCommand;
  readonly errorCode: string;
  readonly availableAt: string;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
  readonly result: {
    retryScheduled: number;
    attemptsExhausted: number;
  };
}): Promise<void> {
  const retry = await input.repository.retryScheduledCommand({
    tenantId: input.tenantId,
    workerId: input.workerId,
    commandId: input.command.id,
    errorCode: input.errorCode,
    availableAt: input.availableAt,
  });
  if (retry === 'retry_scheduled') {
    input.result.retryScheduled += 1;
    input.logger.warn(
      {
        attempts: input.command.attempts,
        availableAt: input.availableAt,
        errorCode: input.errorCode,
      },
      'Games roster command deferred for retry',
    );
  } else if (retry === 'attempts_exhausted') {
    input.result.attemptsExhausted += 1;
    input.logger.error(
      {
        attempts: input.command.attempts,
        errorCode: input.errorCode,
      },
      'Games roster command attempts exhausted',
    );
  }
}

async function failClaim(input: {
  readonly repository: Pick<GameRepository, 'failScheduledCommand'>;
  readonly tenantId: string;
  readonly workerId: string;
  readonly command: ClaimedGameScheduledCommand;
  readonly errorCode: string;
  readonly logger: Pick<Logger, 'error'>;
  readonly result: { terminalFailed: number };
}): Promise<void> {
  const failed = await input.repository.failScheduledCommand({
    tenantId: input.tenantId,
    workerId: input.workerId,
    commandId: input.command.id,
    errorCode: input.errorCode,
  });
  if (!failed) return;
  input.result.terminalFailed += 1;
  input.logger.error(
    { attempts: input.command.attempts, errorCode: input.errorCode },
    'Games roster command failed terminally',
  );
}

export async function runGameRosterProcessManagerCycle(input: {
  readonly scheduledCommandRepository: Pick<
    GameRepository,
    | 'claimScheduledCommands'
    | 'completeScheduledCommand'
    | 'deferScheduledCommand'
    | 'failScheduledCommand'
    | 'retryScheduledCommand'
  >;
  readonly rosterRepository: Pick<GameRosterRepository, 'expireReservation' | 'promoteWaitlist'>;
  readonly tenantId: string;
  readonly workerId: string;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly batchSize: number;
  readonly now?: () => Date;
}): Promise<GameRosterProcessManagerCycleResult> {
  const result = {
    claimed: 0,
    applied: 0,
    noOp: 0,
    notDue: 0,
    retryScheduled: 0,
    attemptsExhausted: 0,
    invalidPayload: 0,
    terminalFailed: 0,
  };
  const limit = Math.max(1, Math.min(input.batchSize, 100));

  while (result.claimed < limit) {
    const [command] = await input.scheduledCommandRepository.claimScheduledCommands({
      tenantId: input.tenantId,
      workerId: input.workerId,
      limit: 1,
      commandTypes: GAME_ROSTER_COMMAND_TYPES,
    });
    if (!command) break;
    result.claimed += 1;

    const commandTargetId = targetId(command);
    if (!commandTargetId) {
      result.invalidPayload += 1;
      await failClaim({
        repository: input.scheduledCommandRepository,
        tenantId: input.tenantId,
        workerId: input.workerId,
        command,
        errorCode: 'GAME_ROSTER_COMMAND_PAYLOAD_INVALID',
        logger: input.logger,
        result,
      });
      continue;
    }

    try {
      const processInput = {
        tenantId: input.tenantId,
        gameId: command.gameId,
        commandId: command.id,
        idempotencyKey: `game-scheduled-command-${command.id}`,
        requestHash: requestHash(command, commandTargetId),
        correlationId: correlationId(command),
      };
      const executed =
        command.commandType === 'game.reservation.expire.v1'
          ? await input.rosterRepository.expireReservation({
              ...processInput,
              reservationId: commandTargetId,
            })
          : await input.rosterRepository.promoteWaitlist({
              ...processInput,
              waitlistEntryId: commandTargetId,
            });

      if (executed.outcome === 'not_due') {
        result.notDue += 1;
        const deferred = await input.scheduledCommandRepository.deferScheduledCommand({
          tenantId: input.tenantId,
          workerId: input.workerId,
          commandId: command.id,
          errorCode: 'GAME_ROSTER_COMMAND_NOT_DUE',
          availableAt: executed.availableAt,
        });
        if (!deferred) {
          input.logger.warn(
            { errorCode: 'GAME_ROSTER_COMMAND_NOT_DUE' },
            'Games roster command claim was lost before deferral',
          );
        }
        continue;
      }
      if (executed.outcome === 'idempotency_conflict') {
        await failClaim({
          repository: input.scheduledCommandRepository,
          tenantId: input.tenantId,
          workerId: input.workerId,
          command,
          errorCode: 'GAME_ROSTER_COMMAND_IDEMPOTENCY_CONFLICT',
          logger: input.logger,
          result,
        });
        continue;
      }

      const completed = await input.scheduledCommandRepository.completeScheduledCommand({
        tenantId: input.tenantId,
        workerId: input.workerId,
        commandId: command.id,
      });
      if (!completed) {
        input.logger.warn({}, 'Games roster command claim was lost before completion');
        continue;
      }
      if (executed.outcome === 'applied') result.applied += 1;
      else result.noOp += 1;
      input.logger.info(
        {
          revision: executed.revision,
          outcome: executed.outcome,
        },
        'Games roster command completed',
      );
    } catch {
      const availableAt = new Date(
        (input.now?.() ?? new Date()).getTime() + retryDelayMs(command.attempts),
      ).toISOString();
      await retryClaim({
        repository: input.scheduledCommandRepository,
        tenantId: input.tenantId,
        workerId: input.workerId,
        command,
        errorCode: 'GAME_ROSTER_COMMAND_FAILED',
        availableAt,
        logger: input.logger,
        result,
      });
    }
  }

  return result;
}
