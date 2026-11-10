import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { isAutoConfirmDue } from '@phub/database';

import {
  runGameResultAutoConfirmBatch,
  type GameResultAutoConfirmPort,
} from './game-result-auto-confirm.js';

type MockPort = {
  readonly listDueSubmissions: Mock<GameResultAutoConfirmPort['listDueSubmissions']>;
  readonly confirmDueSubmission: Mock<GameResultAutoConfirmPort['confirmDueSubmission']>;
};

const TENANT = 'tenant-1';
const WINDOW = 12;
const SUBMITTED = '2026-11-09T10:00:00.000Z';

describe('isAutoConfirmDue', () => {
  it('waits for the whole window', () => {
    expect(
      isAutoConfirmDue({
        state: 'PENDING_CONFIRMATION',
        submittedAt: SUBMITTED,
        now: '2026-11-09T21:59:59.000Z',
        confirmationWindowHours: WINDOW,
      }),
    ).toBe(false);
  });

  it('confirms once the window has passed', () => {
    expect(
      isAutoConfirmDue({
        state: 'PENDING_CONFIRMATION',
        submittedAt: SUBMITTED,
        now: '2026-11-09T22:00:00.000Z',
        confirmationWindowHours: WINDOW,
      }),
    ).toBe(true);
  });

  it('never touches a disputed, confirmed or superseded submission', () => {
    for (const state of ['DISPUTED', 'CONFIRMED', 'SUPERSEDED'] as const) {
      expect(
        isAutoConfirmDue({
          state,
          submittedAt: SUBMITTED,
          now: '2026-11-20T00:00:00.000Z',
          confirmationWindowHours: WINDOW,
        }),
      ).toBe(false);
    }
  });

  it('rejects a window that is not a positive number of hours', () => {
    for (const confirmationWindowHours of [0, -1, 1.5, Number.NaN]) {
      expect(
        isAutoConfirmDue({
          state: 'PENDING_CONFIRMATION',
          submittedAt: SUBMITTED,
          now: '2026-11-20T00:00:00.000Z',
          confirmationWindowHours,
        }),
      ).toBe(false);
    }
  });
});

describe('runGameResultAutoConfirmBatch', () => {
  let port: MockPort;

  beforeEach(() => {
    port = {
      listDueSubmissions: vi.fn<GameResultAutoConfirmPort['listDueSubmissions']>(),
      confirmDueSubmission: vi.fn<GameResultAutoConfirmPort['confirmDueSubmission']>(),
    };
    port.listDueSubmissions.mockResolvedValue([]);
  });

  it('confirms every due submission in the scan', async () => {
    port.listDueSubmissions.mockResolvedValue([
      { gameId: 'game-1', submissionId: 'submission-1' },
      { gameId: 'game-2', submissionId: 'submission-2' },
    ]);
    port.confirmDueSubmission.mockResolvedValue({
      outcome: 'applied',
      commandId: 'command',
      gameId: 'game-1',
      submissionId: 'submission-1',
      resultId: 'result',
      revision: 2,
      resultState: 'CONFIRMED',
      committedAt: '2026-11-09T22:00:00.000Z',
      replayed: false,
    });

    const result = await runGameResultAutoConfirmBatch({
      port,
      tenantId: TENANT,
      confirmationWindowHours: WINDOW,
      batchSize: 20,
      correlationId: 'auto-confirm:tenant-1:1',
    });

    expect(result).toEqual({ confirmed: 2, skipped: 0, failed: 0 });
    expect(port.listDueSubmissions).toHaveBeenCalledWith({
      tenantId: TENANT,
      confirmationWindowHours: WINDOW,
      limit: 20,
    });
    expect(port.confirmDueSubmission).toHaveBeenCalledWith({
      tenantId: TENANT,
      gameId: 'game-1',
      submissionId: 'submission-1',
      confirmationWindowHours: WINDOW,
      correlationId: 'auto-confirm:tenant-1:1',
    });
  });

  it('counts a rejection as skipped, not as an error', async () => {
    port.listDueSubmissions.mockResolvedValue([{ gameId: 'game-1', submissionId: 'submission-1' }]);
    port.confirmDueSubmission.mockResolvedValue({
      outcome: 'rejected',
      code: 'GAME_RESULT_STATE_CONFLICT',
      replayed: false,
    });

    const result = await runGameResultAutoConfirmBatch({
      port,
      tenantId: TENANT,
      confirmationWindowHours: WINDOW,
      batchSize: 20,
      correlationId: 'auto-confirm:tenant-1:1',
    });

    expect(result).toEqual({ confirmed: 0, skipped: 1, failed: 0 });
  });

  it('keeps going after one submission fails and reports it', async () => {
    const onError = vi.fn();
    port.listDueSubmissions.mockResolvedValue([
      { gameId: 'game-1', submissionId: 'submission-1' },
      { gameId: 'game-2', submissionId: 'submission-2' },
    ]);
    const failure = new Error('deadlock');
    port.confirmDueSubmission.mockRejectedValueOnce(failure).mockResolvedValueOnce({
      outcome: 'applied',
      commandId: 'command',
      gameId: 'game-2',
      submissionId: 'submission-2',
      resultId: 'result',
      revision: 2,
      resultState: 'CONFIRMED',
      committedAt: '2026-11-09T22:00:00.000Z',
      replayed: false,
    });

    const result = await runGameResultAutoConfirmBatch({
      port,
      tenantId: TENANT,
      confirmationWindowHours: WINDOW,
      batchSize: 20,
      correlationId: 'auto-confirm:tenant-1:1',
      onError,
    });

    expect(result).toEqual({ confirmed: 1, skipped: 0, failed: 1 });
    expect(onError).toHaveBeenCalledWith({
      gameId: 'game-1',
      submissionId: 'submission-1',
      error: failure,
    });
  });

  it('does nothing when no submission is due', async () => {
    const result = await runGameResultAutoConfirmBatch({
      port,
      tenantId: TENANT,
      confirmationWindowHours: WINDOW,
      batchSize: 20,
      correlationId: 'auto-confirm:tenant-1:1',
    });

    expect(result).toEqual({ confirmed: 0, skipped: 0, failed: 0 });
    expect(port.confirmDueSubmission).not.toHaveBeenCalled();
  });

  it('is wired into the worker behind its own flag', async () => {
    const workerMain = await readFile(new URL('./main.ts', import.meta.url), 'utf8');

    expect(workerMain).toContain('GAME_RESULT_AUTO_CONFIRM_ENABLED');
    expect(workerMain).toContain('void runGameResultAutoConfirmCycle();');
    expect(workerMain).toContain('createGameResultAutoConfirmPort({');
  });
});
