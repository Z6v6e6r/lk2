import { describe, expect, it } from 'vitest';

import {
  assertGameProviderOperationTransition,
  createSyntheticGameProviderAdapter,
  createSyntheticGameProviderStore,
  readBackTransition,
  submitTransition,
  type GameProviderOperationIntent,
} from './provider-recovery.js';

const intent: GameProviderOperationIntent = {
  operationId: '750209e0-6097-4bd2-8cba-6ac203829e41',
  provider: 'SYNTHETIC',
  action: 'JOIN_PAYMENT',
  providerIdempotencyKey: 'game-provider-750209e0-6097-4bd2-8cba-6ac203829e41',
  correlationId: 'provider-recovery-test-0001',
  expected: {
    tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
    actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    gameId: '95a76d36-d8a7-4ff5-a988-84f33c0fd05a',
    reservationId: '840f475e-686d-44fa-9729-bc073bce3c2c',
    paymentMode: 'SPLIT',
  },
};
const adapterContext = { signal: AbortSignal.timeout(1_000), timeoutMs: 1_000 };

describe('game provider recovery state machine', () => {
  it('allows only explicit transitions and keeps terminal states monotonic', () => {
    expect(() => assertGameProviderOperationTransition('READY', 'SUBMITTING')).not.toThrow();
    expect(() => assertGameProviderOperationTransition('SUBMITTING', 'UNKNOWN')).not.toThrow();
    expect(() => assertGameProviderOperationTransition('UNKNOWN', 'RECONCILING')).not.toThrow();
    expect(() => assertGameProviderOperationTransition('CONFIRMED', 'UNKNOWN')).toThrow(
      'GAME_PROVIDER_OPERATION_TRANSITION_INVALID',
    );
    expect(() => assertGameProviderOperationTransition('UNKNOWN', 'READY')).toThrow();
  });

  it('never maps timeout-after-accept to failure or a blind retry', () => {
    expect(submitTransition({ outcome: 'UNKNOWN', code: 'TIMEOUT_AFTER_ACCEPT' })).toEqual({
      state: 'UNKNOWN',
      errorClass: 'AMBIGUOUS_EGRESS',
    });
  });

  it('bounds ambiguous and unavailable read-back in manual review', () => {
    expect(readBackTransition({ outcome: 'AMBIGUOUS', evidenceHash: 'a' }, 2, 3)).toEqual({
      state: 'UNKNOWN',
      errorClass: 'AMBIGUOUS_READBACK',
    });
    expect(readBackTransition({ outcome: 'UNAVAILABLE', code: 'DOWN' }, 3, 3)).toEqual({
      state: 'MANUAL_REVIEW',
      errorClass: 'RETRY_EXHAUSTED',
    });
  });
});

describe('synthetic game provider contract', () => {
  it('recovers timeout-after-accept by authoritative read-back without a duplicate mutation', async () => {
    const store = createSyntheticGameProviderStore();
    const adapter = createSyntheticGameProviderAdapter({
      submitBehavior: 'TIMEOUT_AFTER_ACCEPT',
      store,
    });
    await expect(adapter.submit(intent, adapterContext)).resolves.toMatchObject({
      outcome: 'UNKNOWN',
    });
    const restartedAdapter = createSyntheticGameProviderAdapter({
      submitBehavior: 'TIMEOUT_AFTER_ACCEPT',
      store,
    });
    await expect(restartedAdapter.readBack(intent, adapterContext)).resolves.toMatchObject({
      outcome: 'MATCHED_ACCEPTED',
      facts: { terminalStatus: 'PAID', actorRef: `synthetic:actor:${intent.expected.actorUserId}` },
    });
    await expect(restartedAdapter.submit(intent, adapterContext)).resolves.toMatchObject({
      outcome: 'ACCEPTED',
    });
    expect(restartedAdapter.mutationCount()).toBe(1);
  });

  it.each([
    ['REJECT', 'REJECTED'],
    ['TIMEOUT_BEFORE_ACCEPT', 'NOT_SENT'],
  ] as const)('classifies %s without an accepted mutation', async (submitBehavior, outcome) => {
    const adapter = createSyntheticGameProviderAdapter({ submitBehavior });
    await expect(adapter.submit(intent, adapterContext)).resolves.toMatchObject({ outcome });
    expect(adapter.mutationCount()).toBe(0);
  });

  it.each([
    ['AMBIGUOUS', 'AMBIGUOUS'],
    ['UNAVAILABLE', 'UNAVAILABLE'],
    ['MISMATCH', 'MISMATCH'],
    ['NOT_FOUND', 'NOT_FOUND'],
  ] as const)(
    'exposes %s read-back without manufacturing success',
    async (readBackBehavior, outcome) => {
      const adapter = createSyntheticGameProviderAdapter({
        submitBehavior: 'TIMEOUT_BEFORE_ACCEPT',
        readBackBehavior,
      });
      await expect(adapter.readBack(intent, adapterContext)).resolves.toMatchObject({ outcome });
    },
  );
});
