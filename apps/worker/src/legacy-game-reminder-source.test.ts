import type { WorkerConfig } from '@phub/config';
import type { LegacyGameReminderCycleResult } from '@phub/database';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { begin, complete, fail, refresh } = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@phub/database', () => ({
  beginLegacyGameReminderSourceCycle: begin,
  completeLegacyGameReminderSourceCycle: complete,
  failLegacyGameReminderSourceCycle: fail,
}));
vi.mock('./notification-scenarios.js', () => ({
  refreshPreparingLegacyGameStartReminderTarget: refresh,
}));

import {
  legacyGameReminderErrorCode,
  runLegacyGameReminderSourceCycle,
} from './legacy-game-reminder-source.js';

const config = {
  LEGACY_GAME_REMINDERS_SOURCE_ENABLED: true,
  LEGACY_GAME_REMINDERS_TENANT_KEY: 'synthetic',
  LEGACY_GAME_REMINDERS_LOOKAHEAD_DAYS: 7,
  LEGACY_GAME_REMINDERS_LIMIT: 20,
  LEGACY_GAME_REMINDERS_MAX_SOURCE_AGE_MS: 600_000,
} as unknown as WorkerConfig;

describe('legacy game reminder source admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    begin.mockResolvedValue({
      tenantId: '22222222-2222-4222-8222-222222222222',
      generationId: '33333333-3333-4333-8333-333333333333',
      tracked: [{ gameId: '44444444-4444-4444-8444-444444444444', externalIds: ['raw'] }],
    });
    const completed = {
      tenantId: '22222222-2222-4222-8222-222222222222',
      generationId: '33333333-3333-4333-8333-333333333333',
      changedGameIds: ['44444444-4444-4444-8444-444444444444'],
      refreshGameIds: ['44444444-4444-4444-8444-444444444444'],
      unchanged: 0,
      missing: 0,
      skippedUnmapped: 139,
    };
    complete.mockImplementation(
      async (
        _pool: unknown,
        input: {
          readonly beforeFinalize: (
            client: PoolClient,
            result: LegacyGameReminderCycleResult,
          ) => Promise<void>;
        },
      ) => {
        await input.beforeFinalize({ query: vi.fn() } as unknown as PoolClient, completed);
        return completed;
      },
    );
  });

  it('does not expose database or provider error text in the operational code', () => {
    expect(legacyGameReminderErrorCode(new Error('connect ECONNREFUSED mongodb://private'))).toBe(
      'LEGACY_GAME_REMINDER_SOURCE_FAILED',
    );
    expect(legacyGameReminderErrorCode(new Error('LEGACY_GAMES_SOURCE_UNAVAILABLE'))).toBe(
      'LEGACY_GAMES_SOURCE_UNAVAILABLE',
    );
  });

  it('is inert while its dedicated capability is off', async () => {
    const readReminderWindow = vi.fn();
    const readByExternalIds = vi.fn();
    const result = await runLegacyGameReminderSourceCycle({
      pool: {} as never,
      config: { ...config, LEGACY_GAME_REMINDERS_SOURCE_ENABLED: false },
      source: { readReminderWindow, readByExternalIds },
      logger: { info: vi.fn() } as never,
    });
    expect(result.attempted).toBe(0);
    expect(readReminderWindow).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it('combines a complete window with exact tracked reads and refreshes only isolated targets', async () => {
    const snapshot = {
      externalId: 'canonical',
      externalAliases: ['raw'],
      externalVersion: 'a'.repeat(64),
      sourceUpdatedAt: '2026-11-01T11:00:00.000Z',
    };
    const readReminderWindow = vi.fn().mockResolvedValue([snapshot]);
    const readByExternalIds = vi.fn().mockResolvedValue([snapshot]);
    await expect(
      runLegacyGameReminderSourceCycle({
        pool: {} as never,
        config,
        source: { readReminderWindow, readByExternalIds },
        logger: { info: vi.fn() } as never,
        now: new Date('2026-11-01T12:00:00Z'),
      }),
    ).resolves.toMatchObject({ changed: 1, skippedUnmapped: 139, refreshed: 1 });
    expect(readByExternalIds).toHaveBeenCalledWith({ externalIds: ['raw'], limit: 20 });
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ snapshots: [snapshot] }),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    const refreshCall = refresh.mock.calls[0] as unknown as [
      { readonly query?: unknown },
      { readonly generationId?: unknown },
    ];
    expect(typeof refreshCall[0].query).toBe('function');
    expect(refreshCall[1].generationId).toBe('33333333-3333-4333-8333-333333333333');
    expect(fail).not.toHaveBeenCalled();
  });

  it('treats an exact tracked miss as authoritative over an earlier window row', async () => {
    const windowSnapshot = {
      externalId: 'canonical',
      externalAliases: ['raw'],
      externalVersion: 'a'.repeat(64),
      sourceUpdatedAt: '2026-11-01T11:00:00.000Z',
    };
    await runLegacyGameReminderSourceCycle({
      pool: {} as never,
      config,
      source: {
        readReminderWindow: vi.fn().mockResolvedValue([windowSnapshot]),
        readByExternalIds: vi.fn().mockResolvedValue([]),
      },
      logger: { info: vi.fn() } as never,
      now: new Date('2026-11-01T12:00:00Z'),
    });
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ snapshots: [] }),
    );
  });

  it('marks the committed generation unhealthy when a provider read fails', async () => {
    const readReminderWindow = vi
      .fn()
      .mockRejectedValue(new Error('LEGACY_GAMES_SOURCE_UNAVAILABLE'));
    await expect(
      runLegacyGameReminderSourceCycle({
        pool: {} as never,
        config,
        source: { readReminderWindow, readByExternalIds: vi.fn() },
        logger: { info: vi.fn() } as never,
      }),
    ).rejects.toThrow('LEGACY_GAMES_SOURCE_UNAVAILABLE');
    expect(fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: 'LEGACY_GAMES_SOURCE_UNAVAILABLE' }),
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps the generation unhealthy when an in-transaction context refresh fails', async () => {
    refresh.mockRejectedValueOnce(new Error('CONTEXT_REFRESH_FAILED'));
    await expect(
      runLegacyGameReminderSourceCycle({
        pool: {} as never,
        config,
        source: {
          readReminderWindow: vi.fn().mockResolvedValue([]),
          readByExternalIds: vi.fn().mockResolvedValue([]),
        },
        logger: { info: vi.fn() } as never,
      }),
    ).rejects.toThrow('CONTEXT_REFRESH_FAILED');
    expect(fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: 'CONTEXT_REFRESH_FAILED' }),
    );
  });
});
