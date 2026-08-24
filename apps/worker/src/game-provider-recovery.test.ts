import { describe, expect, it, vi } from 'vitest';

import { createSyntheticGameProviderAdapter, type GameProviderOperationState } from '@phub/games';
import type { ClaimedGameProviderOperation, GameProviderOperationRepository } from '@phub/database';

import { runGameProviderRecoveryCycle } from './game-provider-recovery.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const operationId = '750209e0-6097-4bd2-8cba-6ac203829e41';

function memoryRepository(): GameProviderOperationRepository & {
  readonly state: () => GameProviderOperationState;
} {
  let state: GameProviderOperationState = 'READY';
  let submitAttempts = 0;
  let readBackAttempts = 0;
  const base = {
    operationId,
    tenantId,
    provider: 'SYNTHETIC' as const,
    action: 'JOIN_PAYMENT' as const,
    providerIdempotencyKey: `game-provider-${operationId}`,
    correlationId: 'provider-recovery-test-0001',
    expected: {
      tenantId,
      actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
      gameId: '95a76d36-d8a7-4ff5-a988-84f33c0fd05a',
      reservationId: '840f475e-686d-44fa-9729-bc073bce3c2c',
      paymentMode: 'SPLIT' as const,
    },
  };
  return {
    state: () => state,
    async claimSubmit() {
      await Promise.resolve();
      if (state !== 'READY') return undefined;
      state = 'SUBMITTING';
      submitAttempts += 1;
      return {
        ...base,
        leaseToken: 'submit-lease',
        attempt: submitAttempts,
        state,
        startedAt: new Date().toISOString(),
      } satisfies ClaimedGameProviderOperation;
    },
    async completeSubmit(input) {
      await Promise.resolve();
      if (state !== 'SUBMITTING' || input.leaseToken !== 'submit-lease') return 'stale';
      state =
        input.result.outcome === 'ACCEPTED'
          ? 'UNKNOWN'
          : input.result.outcome === 'REJECTED'
            ? 'REJECTED'
            : input.result.outcome === 'NOT_SENT'
              ? 'READY'
              : 'UNKNOWN';
      return 'applied';
    },
    async claimReadBack() {
      await Promise.resolve();
      if (state !== 'UNKNOWN') return undefined;
      state = 'RECONCILING';
      readBackAttempts += 1;
      return {
        ...base,
        leaseToken: 'readback-lease',
        attempt: readBackAttempts,
        state,
        startedAt: new Date().toISOString(),
      } satisfies ClaimedGameProviderOperation;
    },
    async completeReadBack(input) {
      await Promise.resolve();
      if (state !== 'RECONCILING' || input.leaseToken !== 'readback-lease') return 'stale';
      state =
        input.result.outcome === 'MATCHED_ACCEPTED'
          ? 'CONFIRMED'
          : input.result.outcome === 'MATCHED_REJECTED'
            ? 'REJECTED'
            : input.maxAttempts <= readBackAttempts
              ? 'MANUAL_REVIEW'
              : 'UNKNOWN';
      return 'applied';
    },
    recordCallback: vi.fn(),
    getForActor: vi.fn(),
  };
}

describe('game provider recovery worker', () => {
  it('converges timeout-after-accept through read-back in one bounded cycle', async () => {
    const repository = memoryRepository();
    const adapter = createSyntheticGameProviderAdapter({ submitBehavior: 'TIMEOUT_AFTER_ACCEPT' });
    const metrics: string[] = [];
    await expect(
      runGameProviderRecoveryCycle({
        tenantId,
        repository,
        adapter,
        onMetric: (metric) => metrics.push(`${metric.name}:${metric.outcome}`),
      }),
    ).resolves.toEqual({ submitted: true, reconciled: true });
    expect(repository.state()).toBe('CONFIRMED');
    expect(adapter.mutationCount()).toBe(1);
    expect(metrics).toContain('game_provider_timeout_after_submit_total:UNKNOWN');
    expect(metrics).toContain('game_provider_recovered_total:MATCHED_ACCEPTED');
  });

  it('stops unavailable read-back at the configured budget without another submit', async () => {
    const repository = memoryRepository();
    const adapter = createSyntheticGameProviderAdapter({
      submitBehavior: 'TIMEOUT_AFTER_ACCEPT',
      readBackBehavior: 'UNAVAILABLE',
    });
    await runGameProviderRecoveryCycle({
      tenantId,
      repository,
      adapter,
      maxReadBackAttempts: 1,
    });
    expect(repository.state()).toBe('MANUAL_REVIEW');
    expect(adapter.mutationCount()).toBe(1);
  });

  it('classifies an adapter throw after dispatch as unknown and reads back before any retry', async () => {
    const repository = memoryRepository();
    const adapter = {
      submit: vi.fn().mockRejectedValue(new Error('connection reset')),
      readBack: vi.fn().mockResolvedValue({ outcome: 'UNAVAILABLE', code: 'DOWN' }),
    };
    await runGameProviderRecoveryCycle({ tenantId, repository, adapter, maxReadBackAttempts: 2 });
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(adapter.readBack).toHaveBeenCalledTimes(1);
    expect(repository.state()).toBe('UNKNOWN');
  });
});
