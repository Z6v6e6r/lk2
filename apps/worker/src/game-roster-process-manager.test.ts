import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runGameRosterProcessManagerCycle } from './game-roster-process-manager.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const reservationId = '238df6f5-fec4-44dd-ad8c-39e98ade8366';
const waitlistEntryId = '7527d5e1-da33-464a-94c7-ace34a11e295';
const expireCommandId = '0ef0247c-cae5-4e38-b4bf-1caf19e66746';
const promoteCommandId = '1ef0247c-cae5-4e38-b4bf-1caf19e66746';

function command(
  id: string,
  commandType: 'game.reservation.expire.v1' | 'game.waitlist.promote.v1',
  payload: Record<string, unknown>,
  attempts = 1,
) {
  return { id, gameId, commandType, expectedRevision: 4, payload, attempts } as const;
}

describe('Games roster process manager', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims one roster command at a time and completes applied and no-op outcomes', async () => {
    const claimScheduledCommands = vi
      .fn()
      .mockResolvedValueOnce([
        command(expireCommandId, 'game.reservation.expire.v1', { reservationId }),
      ])
      .mockResolvedValueOnce([
        command(promoteCommandId, 'game.waitlist.promote.v1', { waitlistEntryId }),
      ])
      .mockResolvedValueOnce([]);
    const expireReservation = vi.fn().mockResolvedValue({
      outcome: 'applied',
      commandId: expireCommandId,
      gameId,
      revision: 5,
      replayed: false,
    });
    const promoteWaitlist = vi.fn().mockResolvedValue({
      outcome: 'no_op',
      commandId: promoteCommandId,
      gameId,
      revision: 5,
      replayed: false,
    });
    const completeScheduledCommand = vi.fn().mockResolvedValue(true);

    await expect(
      runGameRosterProcessManagerCycle({
        scheduledCommandRepository: {
          claimScheduledCommands,
          completeScheduledCommand,
          deferScheduledCommand: vi.fn(),
          failScheduledCommand: vi.fn(),
          retryScheduledCommand: vi.fn(),
        },
        rosterRepository: { expireReservation, promoteWaitlist },
        tenantId,
        workerId: 'games-roster-process-manager-test',
        logger,
        batchSize: 10,
      }),
    ).resolves.toEqual({
      claimed: 2,
      applied: 1,
      noOp: 1,
      notDue: 0,
      retryScheduled: 0,
      attemptsExhausted: 0,
      invalidPayload: 0,
      terminalFailed: 0,
    });

    expect(claimScheduledCommands).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 1,
        commandTypes: ['game.reservation.expire.v1', 'game.waitlist.promote.v1'],
      }),
    );
    expect(expireReservation).toHaveBeenCalledWith({
      tenantId,
      gameId,
      commandId: expireCommandId,
      reservationId,
      idempotencyKey: `game-scheduled-command-${expireCommandId}`,
      requestHash: createHash('sha256')
        .update(
          JSON.stringify({
            commandId: expireCommandId,
            commandType: 'game.reservation.expire.v1',
            gameId,
            targetId: reservationId,
          }),
        )
        .digest('hex'),
      correlationId: `games-roster-process-manager-${expireCommandId}`,
    });
    expect(promoteWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: promoteCommandId, waitlistEntryId }),
    );
    expect(completeScheduledCommand).toHaveBeenNthCalledWith(1, {
      tenantId,
      workerId: 'games-roster-process-manager-test',
      commandId: expireCommandId,
    });
  });

  it('defers not-due without consuming an attempt and terminally fails malformed payloads', async () => {
    const deferScheduledCommand = vi.fn().mockResolvedValue(true);
    const failScheduledCommand = vi.fn().mockResolvedValue(true);
    const expireReservation = vi.fn().mockResolvedValue({
      outcome: 'not_due',
      availableAt: '2026-08-01T10:15:00.000Z',
    });

    await expect(
      runGameRosterProcessManagerCycle({
        scheduledCommandRepository: {
          claimScheduledCommands: vi
            .fn()
            .mockResolvedValueOnce([
              command(expireCommandId, 'game.reservation.expire.v1', { reservationId }),
            ])
            .mockResolvedValueOnce([
              command(promoteCommandId, 'game.waitlist.promote.v1', { waitlistEntryId: 'bad' }),
            ])
            .mockResolvedValueOnce([]),
          completeScheduledCommand: vi.fn(),
          deferScheduledCommand,
          failScheduledCommand,
          retryScheduledCommand: vi.fn(),
        },
        rosterRepository: { expireReservation, promoteWaitlist: vi.fn() },
        tenantId,
        workerId: 'games-roster-process-manager-test',
        logger,
        batchSize: 10,
        now: () => new Date('2026-08-01T10:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      claimed: 2,
      notDue: 1,
      invalidPayload: 1,
      retryScheduled: 0,
      terminalFailed: 1,
    });

    expect(deferScheduledCommand).toHaveBeenCalledWith({
      tenantId,
      workerId: 'games-roster-process-manager-test',
      commandId: expireCommandId,
      errorCode: 'GAME_ROSTER_COMMAND_NOT_DUE',
      availableAt: '2026-08-01T10:15:00.000Z',
    });
    expect(failScheduledCommand).toHaveBeenCalledWith({
      tenantId,
      workerId: 'games-roster-process-manager-test',
      commandId: promoteCommandId,
      errorCode: 'GAME_ROSTER_COMMAND_PAYLOAD_INVALID',
    });
  });

  it('terminally fails an idempotency conflict without retrying', async () => {
    const failScheduledCommand = vi.fn().mockResolvedValue(true);
    const retryScheduledCommand = vi.fn();

    await expect(
      runGameRosterProcessManagerCycle({
        scheduledCommandRepository: {
          claimScheduledCommands: vi
            .fn()
            .mockResolvedValueOnce([
              command(expireCommandId, 'game.reservation.expire.v1', { reservationId }),
            ])
            .mockResolvedValueOnce([]),
          completeScheduledCommand: vi.fn(),
          deferScheduledCommand: vi.fn(),
          failScheduledCommand,
          retryScheduledCommand,
        },
        rosterRepository: {
          expireReservation: vi.fn().mockResolvedValue({ outcome: 'idempotency_conflict' }),
          promoteWaitlist: vi.fn(),
        },
        tenantId,
        workerId: 'games-roster-process-manager-test',
        logger,
        batchSize: 10,
      }),
    ).resolves.toMatchObject({ claimed: 1, terminalFailed: 1, retryScheduled: 0 });

    expect(failScheduledCommand).toHaveBeenCalledWith({
      tenantId,
      workerId: 'games-roster-process-manager-test',
      commandId: expireCommandId,
      errorCode: 'GAME_ROSTER_COMMAND_IDEMPOTENCY_CONFLICT',
    });
    expect(retryScheduledCommand).not.toHaveBeenCalled();
  });

  it('uses bounded retry when roster processing fails', async () => {
    const retryScheduledCommand = vi.fn().mockResolvedValue('attempts_exhausted');

    await expect(
      runGameRosterProcessManagerCycle({
        scheduledCommandRepository: {
          claimScheduledCommands: vi
            .fn()
            .mockResolvedValueOnce([
              command(expireCommandId, 'game.reservation.expire.v1', { reservationId }, 20),
            ])
            .mockResolvedValueOnce([]),
          completeScheduledCommand: vi.fn(),
          deferScheduledCommand: vi.fn(),
          failScheduledCommand: vi.fn(),
          retryScheduledCommand,
        },
        rosterRepository: {
          expireReservation: vi.fn().mockRejectedValue(new Error('database unavailable')),
          promoteWaitlist: vi.fn(),
        },
        tenantId,
        workerId: 'games-roster-process-manager-test',
        logger,
        batchSize: 10,
        now: () => new Date('2026-08-01T10:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ claimed: 1, attemptsExhausted: 1, retryScheduled: 0 });

    expect(retryScheduledCommand).toHaveBeenCalledWith({
      tenantId,
      workerId: 'games-roster-process-manager-test',
      commandId: expireCommandId,
      errorCode: 'GAME_ROSTER_COMMAND_FAILED',
      availableAt: '2026-08-01T10:01:00.000Z',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 20 }),
      'Games roster command attempts exhausted',
    );
    for (const call of [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]) {
      const fields: unknown = call[0];
      expect(fields).not.toHaveProperty('tenantId');
      expect(fields).not.toHaveProperty('gameId');
      expect(fields).not.toHaveProperty('userId');
    }
  });
});
