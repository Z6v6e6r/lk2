import { describe, expect, it, vi } from 'vitest';

import { waitForGameRevision } from './game-revision-readback.js';

describe('revision-aware Game readback', () => {
  it('waits beyond the former two-second polling window until the projection catches up', async () => {
    let now = 0;
    const load = vi
      .fn()
      .mockResolvedValueOnce({ revision: 3 })
      .mockResolvedValueOnce({ revision: 3 })
      .mockResolvedValueOnce({ revision: 3 })
      .mockResolvedValueOnce({ revision: 3 })
      .mockResolvedValueOnce({ revision: 4 });

    await expect(
      waitForGameRevision({
        load,
        minimumRevision: 4,
        timeoutMs: 30_000,
        now: () => now,
        delay: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual({ status: 'converged', game: { revision: 4 } });

    expect(now).toBeGreaterThan(2_000);
  });

  it('distinguishes a stale read model from a temporarily unavailable readback', async () => {
    let staleNow = 0;
    await expect(
      waitForGameRevision({
        load: () => Promise.resolve({ revision: 2 }),
        minimumRevision: 3,
        timeoutMs: 1_000,
        now: () => staleNow,
        delay: (milliseconds) => {
          staleNow += milliseconds;
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual({ status: 'updating', game: { revision: 2 } });

    let unavailableNow = 0;
    const error = new Error('read model unavailable');
    await expect(
      waitForGameRevision({
        load: () => Promise.reject(error),
        minimumRevision: 3,
        timeoutMs: 1_000,
        now: () => unavailableNow,
        delay: (milliseconds) => {
          unavailableNow += milliseconds;
          return Promise.resolve();
        },
      }),
    ).resolves.toEqual({ status: 'unavailable', error });
  });
});
