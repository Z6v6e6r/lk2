import { describe, expect, it, vi } from 'vitest';

import { runPaidJoinReconciliationCycle } from './paid-join-reconciler.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const gameId = '6418f90b-0fa6-4c04-a3da-57707e2f0ae2';
const userId = '47b10c0e-2d9f-4775-96dc-2941adae4968';
const reservationId = '238df6f5-fec4-44dd-ad8c-39e98ade8366';
const operationId = 'd39e4287-e65c-4e75-88e4-4447e4c91ddb';

const candidate = {
  operationId,
  gameId,
  actorUserId: userId,
  reservationId,
  providerBinding: {
    providerClientId: 'viva-client-1',
    providerMappingId: 'c8a4e3f0-94f4-4b91-9a5f-1a0a1d3b8f01',
    providerClientSubscriptionId: 'viva-subscription-1',
    providerExerciseId: 'viva-exercise-1',
    targetMappingId: 'f0d0c0de-3f6e-4a8f-b6d0-4d5a4f4f0a01',
    targetVersion: '7',
    startsAt: '2026-11-20T09:00:00.000Z',
    durationMinutes: 90,
    capacity: 4,
    admissible: true,
    requestSha256: 'sha256:' + 'a'.repeat(64),
    idempotencyKeySha256: 'sha256:' + 'b'.repeat(64),
  },
  managedJoin: null,
  actorContext: {
    tenantKey: 'iSkq6G',
    sessionId: '2d7f3f7e-6f3b-4f7f-9d5e-5f7b8f9a0b01',
    providerClientId: 'viva-client-1',
    providerMappingId: 'c8a4e3f0-94f4-4b91-9a5f-1a0a1d3b8f01',
    providerClientSubscriptionId: 'viva-subscription-1',
  },
  reconciliationAttempts: 0,
};

function repository(overrides: Record<string, unknown> = {}) {
  return {
    listPaidJoinReconciliationCandidates: vi.fn(async () => [candidate]),
    recordPaidJoinReconciliationAttempt: vi.fn(async () => undefined),
    getPaidJoinAttempt: vi.fn(async () => ({
      commandId: operationId,
      gameId,
      state: 'IN_PROGRESS' as const,
      result: null,
      errorCode: null,
      providerBinding: candidate.providerBinding,
      reservation: {
        id: reservationId,
        state: 'ACTIVE' as const,
        paymentState: 'PROCESSING' as const,
        expiresAt: '2026-11-20T08:15:00.000Z',
      },
      receipt: null,
      reconciliation: null,
    })),
    confirmPayment: vi.fn(),
    ...overrides,
  };
}

describe('paid JOIN background reconciliation', () => {
  it('records an unresolved attempt and never releases the seat', async () => {
    const repo = repository();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runPaidJoinReconciliationCycle({
      tenantId,
      repository: repo as never,
      owner: {
        execute: vi.fn(),
        read: vi.fn(async () => ({ status: 'PENDING' as const })),
      } as never,
      logger,
      maxAttempts: 5,
    });

    expect(result).toMatchObject({ candidates: 1, confirmed: 0, unresolved: 1 });
    expect(repo.recordPaidJoinReconciliationAttempt).toHaveBeenCalledWith({
      tenantId,
      operationId,
      attempts: 1,
      escalated: false,
    });
    expect(repo.confirmPayment).not.toHaveBeenCalled();
  });

  it('escalates a repeatedly unresolved attempt without mutating the reservation', async () => {
    const repo = repository({
      listPaidJoinReconciliationCandidates: vi.fn(async () => [
        { ...candidate, reconciliationAttempts: 4 },
      ]),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await runPaidJoinReconciliationCycle({
      tenantId,
      repository: repo as never,
      owner: {
        execute: vi.fn(),
        read: vi.fn(async () => ({ status: 'UNKNOWN' as const })),
      } as never,
      logger,
      maxAttempts: 5,
    });

    expect(result).toMatchObject({ candidates: 1, escalated: 1, unresolved: 0 });
    expect(repo.recordPaidJoinReconciliationAttempt).toHaveBeenCalledWith({
      tenantId,
      operationId,
      attempts: 5,
      escalated: true,
    });
    expect(repo.confirmPayment).not.toHaveBeenCalled();
  });
});
