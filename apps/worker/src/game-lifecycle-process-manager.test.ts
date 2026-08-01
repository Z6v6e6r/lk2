import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runGameLifecycleProcessManagerCycle } from './game-lifecycle-process-manager.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const startCommandId = '0ef0247c-cae5-4e38-b4bf-1caf19e66746';
const finishCommandId = '1ef0247c-cae5-4e38-b4bf-1caf19e66746';
const eventId = '7d04d95e-cfb9-40a1-a0a7-f8d03c5d385c';

function command(id: string, type: 'game.lifecycle.start.v1' | 'game.lifecycle.finish.v1') {
  return {
    id,
    gameId,
    commandType: type,
    expectedRevision: type === 'game.lifecycle.start.v1' ? 5 : 6,
    payload: { gameId },
    attempts: 1,
  } as const;
}

describe('Games lifecycle process manager', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('claims one command at a time so start is committed before finish', async () => {
    const claimScheduledCommands = vi
      .fn()
      .mockResolvedValueOnce([command(startCommandId, 'game.lifecycle.start.v1')])
      .mockResolvedValueOnce([command(finishCommandId, 'game.lifecycle.finish.v1')])
      .mockResolvedValueOnce([]);
    const executeLifecycleCommand = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'applied',
        gameId,
        lifecycleState: 'IN_PROGRESS',
        revision: 6,
        eventId,
      })
      .mockResolvedValueOnce({
        outcome: 'applied',
        gameId,
        lifecycleState: 'FINISHED',
        revision: 7,
        eventId,
      });

    await expect(
      runGameLifecycleProcessManagerCycle({
        repository: {
          claimScheduledCommands,
          executeLifecycleCommand,
          retryScheduledCommand: vi.fn(),
        },
        tenantId,
        workerId: 'games-process-manager-test',
        logger,
        batchSize: 10,
        now: () => new Date('2026-07-30T10:00:00.000Z'),
      }),
    ).resolves.toEqual({
      claimed: 2,
      applied: 2,
      alreadyApplied: 0,
      rescheduled: 0,
      retryScheduled: 0,
      attemptsExhausted: 0,
    });

    expect(claimScheduledCommands).toHaveBeenCalledTimes(3);
    expect(claimScheduledCommands).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 1,
        commandTypes: ['game.lifecycle.start.v1', 'game.lifecycle.finish.v1'],
      }),
    );
    expect(executeLifecycleCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ commandId: startCommandId }),
    );
    expect(executeLifecycleCommand).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ commandId: finishCommandId }),
    );
  });

  it('returns a failed claim to the bounded retry path', async () => {
    const retryScheduledCommand = vi.fn().mockResolvedValue('retry_scheduled');

    await expect(
      runGameLifecycleProcessManagerCycle({
        repository: {
          claimScheduledCommands: vi
            .fn()
            .mockResolvedValueOnce([command(startCommandId, 'game.lifecycle.start.v1')])
            .mockResolvedValueOnce([]),
          executeLifecycleCommand: vi.fn().mockRejectedValue(new Error('database unavailable')),
          retryScheduledCommand,
        },
        tenantId,
        workerId: 'games-process-manager-test',
        logger,
        batchSize: 10,
        now: () => new Date('2026-07-30T10:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ claimed: 1, retryScheduled: 1 });

    expect(retryScheduledCommand).toHaveBeenCalledWith({
      tenantId,
      workerId: 'games-process-manager-test',
      commandId: startCommandId,
      errorCode: 'GAME_LIFECYCLE_COMMAND_FAILED',
      availableAt: '2026-07-30T10:00:01.000Z',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: startCommandId }),
      'Games lifecycle command deferred for retry',
    );
  });
});
