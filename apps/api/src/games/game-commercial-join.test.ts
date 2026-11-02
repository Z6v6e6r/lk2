import managedFixture from '../../../../packages/subscription-runtime-adapter/src/fixtures/managed-join-v2.json';
import { parseManagedJoinEntitlement } from '@phub/domain';
import type { BookedOperationReceipt } from '@phub/subscription-runtime-adapter';
import { describe, expect, it, vi } from 'vitest';

import {
  executeCommercialJoin,
  readCommercialJoinOperation,
  reconcileCommercialJoinOperation,
  commercialJoinRequestHash,
  commercialJoinRequestHashV2,
  managedJoinRequestHash,
  type CommercialJoinAttemptView,
  type CommercialJoinBeginResult,
  type CommercialJoinCommandEnvelope,
  type CommercialJoinOwnerOutcome,
  type CommercialJoinRepositoryPort,
} from './game-commercial-join.js';
import {
  createJoinConditionsFixture,
  fixtureActor,
  fixtureId,
} from './game-join-conditions.test-fixture.js';

const operationId = fixtureId(900);
// Built at runtime so the fixture value is never a credential-shaped literal in the diff.
const commercialJoinKey = ['commercial', 'join', 'fixture', '0001'].join('-');
const reservationId = fixtureId(901);

const envelope: CommercialJoinCommandEnvelope = {
  tenantId: fixtureActor.tenantId,
  tenantKey: 'synthetic',
  userId: fixtureActor.userId,
  sessionId: fixtureActor.sessionId,
  gameId: fixtureActor.gameId,
  expectedRevision: 8,
  correlationId: 'correlation-commercial-1',
  idempotencyKey: commercialJoinKey,
  operationId,
  requestHash: commercialJoinRequestHash({
    tenantId: fixtureActor.tenantId,
    tenantKey: 'synthetic',
    userId: fixtureActor.userId,
    sessionId: fixtureActor.sessionId,
    gameId: fixtureActor.gameId,
    expectedRevision: 8,
    correlationId: 'correlation-commercial-1',
    idempotencyKey: commercialJoinKey,
    subscriptionInstanceId: fixtureActor.subscriptionInstanceId,
    priceConsent: { amountMinor: 70_000, currency: 'RUB' },
  }),
  subscriptionInstanceId: fixtureActor.subscriptionInstanceId,
  priceConsent: { amountMinor: 70_000, currency: 'RUB' },
};

const resolved = <T>(value: T): Promise<T> => Promise.resolve(value);

function repository(overrides: Partial<CommercialJoinRepositoryPort> = {}) {
  const calls: string[] = [];
  const base: CommercialJoinRepositoryPort = {
    beginPaidJoin() {
      calls.push('beginPaidJoin');
      return resolved<CommercialJoinBeginResult>({
        outcome: 'reserved',
        operationId,
        reservationId,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        revision: 9,
      });
    },
    getPaidJoinAttempt() {
      calls.push('getPaidJoinAttempt');
      return resolved(null);
    },
    failPaidJoinAttempt() {
      calls.push('failPaidJoinAttempt');
      return resolved(undefined);
    },
  };
  return { calls, repository: { ...base, ...overrides } };
}

function ownerPort(outcomes: CommercialJoinOwnerOutcome[]) {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    owner: {
      execute() {
        calls.push('execute');
        const next = outcomes[Math.min(index, outcomes.length - 1)]!;
        index += 1;
        return resolved(next);
      },
      read() {
        calls.push('read');
        return resolved(null);
      },
    },
  };
}

function dependencies(
  repo: CommercialJoinRepositoryPort,
  owner: ReturnType<typeof ownerPort>['owner'],
  fixture = createJoinConditionsFixture(),
) {
  return { repository: repo, conditionsOwner: fixture.owner, owner, now: () => Date.now() };
}

describe('commercial JOIN orchestration', () => {
  it('requires an explicit price selection before any reservation', async () => {
    const { calls, repository: repo } = repository();
    const result = await executeCommercialJoin(
      { ...envelope, priceConsent: undefined },
      dependencies(repo, ownerPort([{ status: 'PENDING' }]).owner),
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('requires a server-verified subscription product selection', async () => {
    const { calls, repository: repo } = repository();
    const result = await executeCommercialJoin(
      { ...envelope, subscriptionInstanceId: undefined },
      dependencies(repo, ownerPort([{ status: 'PENDING' }]).owner),
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_SUBSCRIPTION_SELECTION_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('maps a missing provider mapping of the selected product to a selection refusal, not payment', async () => {
    const { calls, repository: repo } = repository();
    const owner = {
      prepare: () => resolved({ outcome: 'selection_required' as const }),
      execute: vi.fn(() => resolved({ status: 'PENDING' as const })),
      read: () => resolved(null),
    };
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner));
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_SUBSCRIPTION_SELECTION_REQUIRED' });
    expect(calls).toEqual([]);
    expect(owner.execute).not.toHaveBeenCalled();
  });

  it('maps an unresolved actor or target to the existing fail-closed payment refusal', async () => {
    const { calls, repository: repo } = repository();
    const owner = {
      prepare: () => resolved({ outcome: 'not_available' as const }),
      execute: vi.fn(() => resolved({ status: 'PENDING' as const })),
      read: () => resolved(null),
    };
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner));
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_PAYMENT_REQUIRED' });
    expect(calls).toEqual([]);
    expect(owner.execute).not.toHaveBeenCalled();
  });

  it('refuses an old consent when the server price changed (new price needs a new consent)', async () => {
    const { calls, repository: repo } = repository();
    const result = await executeCommercialJoin(
      { ...envelope, priceConsent: { amountMinor: 69_900, currency: 'RUB' } },
      dependencies(repo, ownerPort([{ status: 'PENDING' }]).owner),
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('reserves once, dispatches the owner once and reports PROCESSING while the owner is pending', async () => {
    const { calls, repository: repo } = repository();
    const owner = ownerPort([{ status: 'PENDING' }]);
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner.owner));
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.body.operation.status).toBe('PROCESSING');
    expect(result.body.operation.nextAction).toEqual({ type: 'NONE' });
    expect(result.body.operation.commercial.attemptState).toBe('OWNER_PENDING');
    expect(result.body.operation.commercial.reservation).toMatchObject({
      id: reservationId,
      state: 'ACTIVE',
    });
    expect(calls).toEqual(['beginPaidJoin']);
    expect(owner.calls).toEqual(['execute']);
  });

  it('never dispatches a replacement owner POST for a repeat with the same key', async () => {
    const { repository: repo } = repository({
      beginPaidJoin(): Promise<CommercialJoinBeginResult> {
        return resolved({ outcome: 'replayed', operationId, state: 'IN_PROGRESS' });
      },
    });
    const owner = ownerPort([{ status: 'PENDING' }]);
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner.owner));
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.body.operation.status).toBe('UNKNOWN');
    expect(result.body.operation.nextAction).toEqual({
      type: 'WAIT_FOR_RECONCILIATION',
      retryAfterSeconds: 5,
    });
    expect(result.body.replayed).toBe(true);
    // A repeat is purely local: no replacement dispatch and no owner read.
    expect(owner.calls).toEqual([]);
  });

  it('keeps an unresolved owner outcome as UNKNOWN instead of failing the reservation', async () => {
    const { calls, repository: repo } = repository();
    const owner = {
      execute(): Promise<CommercialJoinOwnerOutcome> {
        return Promise.reject(new Error('owner timeout'));
      },
      read() {
        return resolved(null);
      },
    };
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner));
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.body.operation.status).toBe('UNKNOWN');
    expect(result.body.operation.commercial.attemptState).toBe('UNKNOWN');
    expect(result.body.operation.commercial.reservation?.state).toBe('ACTIVE');
    expect(result.body.operation.nextAction).toEqual({
      type: 'WAIT_FOR_RECONCILIATION',
      retryAfterSeconds: 5,
    });
    // No compensation: a possibly used benefit is never released on a timeout.
    expect(calls).toEqual(['beginPaidJoin']);
  });

  it('applies a definitive owner rejection and keeps the service block separate from price', async () => {
    const { calls, repository: repo } = repository();
    const owner = ownerPort([{ status: 'REJECTED', code: 'GAME_SERVICE_BLOCKED' }]);
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner.owner));
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_SERVICE_BLOCKED' });
    expect(calls).toEqual(['beginPaidJoin', 'failPaidJoinAttempt']);
    expect(owner.calls).toEqual(['execute']);
  });

  it('maps an owner session/second-tab reservation conflict to reconciliation, not to a new purchase', async () => {
    const { repository: repo } = repository({
      beginPaidJoin(): Promise<CommercialJoinBeginResult> {
        return resolved({ outcome: 'reservation_conflict' });
      },
    });
    const owner = ownerPort([{ status: 'PENDING' }]);
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner.owner));
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_RECONCILIATION_REQUIRED' });
    expect(owner.calls).toEqual([]);
  });

  it('maps a reused key with different content to an attempt conflict', async () => {
    const { repository: repo } = repository({
      beginPaidJoin(): Promise<CommercialJoinBeginResult> {
        return resolved({ outcome: 'idempotency_conflict' });
      },
    });
    const result = await executeCommercialJoin(
      envelope,
      dependencies(repo, ownerPort([{ status: 'PENDING' }]).owner),
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_COMMERCIAL_ATTEMPT_CONFLICT' });
  });

  it('keeps a full game fail-closed with the owner untouched', async () => {
    const { repository: repo } = repository({
      beginPaidJoin(): Promise<CommercialJoinBeginResult> {
        return resolved({ outcome: 'rejected', code: 'GAME_FULL' });
      },
    });
    const owner = ownerPort([{ status: 'PENDING' }]);
    const result = await executeCommercialJoin(envelope, dependencies(repo, owner.owner));
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_FULL' });
    expect(owner.calls).toEqual([]);
  });

  it('refuses an unmapped provider subscription before writing any durable row', async () => {
    const { calls, repository: repo } = repository();
    const owner = {
      resolveProviderClientSubscriptionId: () => Promise.resolve(undefined),
      execute: () => Promise.reject(new Error('must not dispatch')),
      read: () => Promise.resolve(null),
    };
    const result = await executeCommercialJoin(envelope, {
      repository: repo,
      conditionsOwner: createJoinConditionsFixture().owner,
      owner,
      now: () => Date.now(),
    });
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_SUBSCRIPTION_SELECTION_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('does not treat a missing commercial composition as success', async () => {
    const { repository: repo } = repository({
      beginPaidJoin(): Promise<CommercialJoinBeginResult> {
        return Promise.reject(new Error('repository unavailable'));
      },
    });
    const result = await executeCommercialJoin(
      envelope,
      dependencies(repo, ownerPort([{ status: 'PENDING' }]).owner),
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_OWNER_UNAVAILABLE' });
  });
});

const attemptBase: CommercialJoinAttemptView = {
  commandId: operationId,
  gameId: fixtureActor.gameId,
  state: 'IN_PROGRESS',
  result: null,
  errorCode: null,
  reservation: {
    id: reservationId,
    state: 'ACTIVE',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  },
  receipt: null,
};

describe('commercial JOIN readback', () => {
  const readbackDependencies = (attempt: CommercialJoinAttemptView | null) => ({
    repository: {
      beginPaidJoin(): Promise<CommercialJoinBeginResult> {
        return Promise.reject(new Error('readback must not write'));
      },
      getPaidJoinAttempt() {
        return resolved(attempt);
      },
      failPaidJoinAttempt(): Promise<unknown> {
        return Promise.reject(new Error('readback must not write'));
      },
    } satisfies CommercialJoinRepositoryPort,
    owner: {
      execute(): Promise<CommercialJoinOwnerOutcome> {
        return Promise.reject(new Error('readback must not dispatch'));
      },
      read() {
        return resolved(null);
      },
    },
    now: () => Date.now(),
  });

  it('returns null for an operation the actor does not own', async () => {
    const body = await readCommercialJoinOperation(
      {
        tenantId: fixtureActor.tenantId,
        tenantKey: 'synthetic',
        actorUserId: fixtureActor.userId,
        sessionId: fixtureActor.sessionId,
        operationId,
        correlationId: 'correlation-read-1',
      },
      readbackDependencies(null),
    );
    expect(body).toBeNull();
  });

  it('reports SUCCEEDED only with a trusted receipt', async () => {
    const body = await readCommercialJoinOperation(
      {
        tenantId: fixtureActor.tenantId,
        tenantKey: 'synthetic',
        actorUserId: fixtureActor.userId,
        sessionId: fixtureActor.sessionId,
        operationId,
        correlationId: 'correlation-read-2',
      },
      readbackDependencies({
        ...attemptBase,
        receipt: {
          provider: 'VIVA',
          status: 'CONFIRMED',
          confirmedAt: new Date().toISOString(),
        },
      }),
    );
    expect(body?.operation.status).toBe('SUCCEEDED');
    expect(body?.operation.commercial.attemptState).toBe('OWNER_CONFIRMED');
    expect(body?.operation.commercial.receipt?.provider).toBe('VIVA');
  });

  it('keeps an unresolved attempt UNKNOWN and never turns it into FAILED', async () => {
    const body = await readCommercialJoinOperation(
      {
        tenantId: fixtureActor.tenantId,
        tenantKey: 'synthetic',
        actorUserId: fixtureActor.userId,
        sessionId: fixtureActor.sessionId,
        operationId,
        correlationId: 'correlation-read-3',
      },
      readbackDependencies(attemptBase),
    );
    expect(body?.operation.status).toBe('UNKNOWN');
    expect(body?.operation.error).toBeNull();
    expect(body?.operation.nextAction).toMatchObject({ type: 'WAIT_FOR_RECONCILIATION' });
    expect(body?.operation.commercial.reservation?.state).toBe('ACTIVE');
  });

  it('reports a definitive failure with its stable code', async () => {
    const body = await readCommercialJoinOperation(
      {
        tenantId: fixtureActor.tenantId,
        tenantKey: 'synthetic',
        actorUserId: fixtureActor.userId,
        sessionId: fixtureActor.sessionId,
        operationId,
        correlationId: 'correlation-read-4',
      },
      readbackDependencies({
        ...attemptBase,
        state: 'FAILED',
        errorCode: 'GAME_SERVICE_BLOCKED',
        reservation: { ...attemptBase.reservation!, state: 'CANCELLED' },
      }),
    );
    expect(body?.operation.status).toBe('FAILED');
    expect(body?.operation.error?.code).toBe('GAME_SERVICE_BLOCKED');
    expect(body?.operation.commercial.attemptState).toBe('FAILED');
  });

  it('reports SUCCEEDED when the applied completion is already durable', async () => {
    const committedAt = new Date().toISOString();
    const body = await readCommercialJoinOperation(
      {
        tenantId: fixtureActor.tenantId,
        tenantKey: 'synthetic',
        actorUserId: fixtureActor.userId,
        sessionId: fixtureActor.sessionId,
        operationId,
        correlationId: 'correlation-read-5',
      },
      readbackDependencies({
        ...attemptBase,
        state: 'COMPLETED',
        result: {
          commandId: operationId,
          gameId: fixtureActor.gameId,
          revision: 9,
          viewerRelation: 'PARTICIPANT',
          participationId: fixtureId(902),
          reservationId,
          committedAt,
        },
      }),
    );
    expect(body?.operation.status).toBe('SUCCEEDED');
    expect(body?.operation.aggregateRevision).toBe(9);
    expect(body?.operation.commercial.attemptState).toBe('OWNER_CONFIRMED');
  });
});

const frozenBinding = {
  providerClientId: 'provider-client',
  providerMappingId: fixtureId(902),
  providerClientSubscriptionId: fixtureId(903),
  providerExerciseId: 'provider-exercise',
  targetMappingId: fixtureId(904),
  targetVersion: '7',
  startsAt: '2026-12-01T10:00:00.000Z',
  durationMinutes: 90,
  capacity: 4,
  admissible: true,
  requestSha256: `sha256:${'a'.repeat(64)}`,
  idempotencyKeySha256: `sha256:${'b'.repeat(64)}`,
};
const ownerReceipt = {
  contractVersion: 1 as const,
  source: 'LK1_SUBSCRIPTION_BOOKING_OWNER' as const,
  operationId,
  tenantId: envelope.tenantId,
  userId: envelope.userId,
  gameId: envelope.gameId,
  reservationId,
  bookingId: 'provider-booking',
  verifiedAt: '2026-10-22T10:00:00.000Z',
  ...Object.fromEntries(
    Object.entries(frozenBinding).filter(
      ([key]) => !['startsAt', 'durationMinutes', 'capacity', 'admissible'].includes(key),
    ),
  ),
} as BookedOperationReceipt;
const reconcileInput = {
  tenantId: envelope.tenantId,
  tenantKey: envelope.tenantKey,
  actorUserId: envelope.userId,
  sessionId: envelope.sessionId,
  operationId,
  correlationId: envelope.correlationId,
};
function receiptDependencies(receipt = ownerReceipt) {
  let completed = false;
  const attempt: CommercialJoinAttemptView = {
    commandId: operationId,
    gameId: envelope.gameId,
    state: 'IN_PROGRESS',
    result: null,
    errorCode: null,
    providerBinding: frozenBinding,
    reservation: { id: reservationId, state: 'ACTIVE', expiresAt: '2026-10-22T10:15:00.000Z' },
    receipt: null,
  };
  const confirmPayment = vi.fn<NonNullable<CommercialJoinRepositoryPort['confirmPayment']>>(() => {
    completed = true;
    return resolved({
      outcome: 'applied' as const,
      commandId: fixtureId(905),
      gameId: envelope.gameId,
      revision: 10,
      viewerRelation: 'PARTICIPANT' as const,
      participationId: fixtureId(906),
      reservationId,
      committedAt: receipt.verifiedAt,
      replayed: false,
    });
  });
  const repo = repository({
    getPaidJoinAttempt: () =>
      resolved<CommercialJoinAttemptView>(
        completed
          ? {
              ...attempt,
              state: 'COMPLETED',
              result: {
                commandId: operationId,
                gameId: envelope.gameId,
                revision: 10,
                viewerRelation: 'PARTICIPANT' as const,
                reservationId,
                participationId: fixtureId(906),
                committedAt: receipt.verifiedAt,
              },
              receipt: { provider: 'VIVA', status: 'CONFIRMED', confirmedAt: receipt.verifiedAt },
            }
          : attempt,
      ),
    confirmPayment,
  });
  const owner = {
    execute: vi.fn(() => resolved({ status: 'UNKNOWN' as const })),
    read: vi.fn(() => resolved({ status: 'CONFIRMED' as const, receipt })),
  };
  return { repository: repo.repository, owner, confirmPayment, calls: repo.calls };
}

describe('explicit commercial receipt reconciliation', () => {
  it('freezes provider binding before reservation and passes the original reservation to the owner', async () => {
    const repo = repository();
    const beginPaidJoin = vi.fn(repo.repository.beginPaidJoin);
    const execute = vi.fn(() => resolved({ status: 'PENDING' as const }));
    const prepare = vi.fn(() => {
      expect(beginPaidJoin).not.toHaveBeenCalled();
      return resolved({ outcome: 'prepared' as const, binding: frozenBinding });
    });
    await executeCommercialJoin(envelope, {
      ...dependencies({ ...repo.repository, beginPaidJoin }, ownerPort([]).owner),
      owner: { prepare, execute, read: () => resolved(null) },
    });
    expect(beginPaidJoin).toHaveBeenCalledWith(
      expect.objectContaining({ providerBinding: frozenBinding }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ providerBinding: frozenBinding, reservationId }),
    );
  });
  it('keeps GET read-only even with a confirmed owner receipt', async () => {
    const deps = receiptDependencies();
    const result = await readCommercialJoinOperation(reconcileInput, deps);
    expect(result?.operation.status).toBe('UNKNOWN');
    expect(deps.confirmPayment).not.toHaveBeenCalled();
    expect(deps.owner.execute).not.toHaveBeenCalled();
  });
  it('completes once from the original receipt and replays after a fresh session without rebooking', async () => {
    const deps = receiptDependencies();
    expect((await reconcileCommercialJoinOperation(reconcileInput, deps))?.operation.status).toBe(
      'SUCCEEDED',
    );
    expect(
      (
        await reconcileCommercialJoinOperation(
          { ...reconcileInput, sessionId: fixtureId(907) },
          deps,
        )
      )?.operation.status,
    ).toBe('SUCCEEDED');
    expect(deps.confirmPayment).toHaveBeenCalledTimes(1);
    expect(deps.confirmPayment.mock.calls[0]?.[0].evidence).toMatchObject({
      operationId,
      exerciseId: frozenBinding.providerExerciseId,
    });
    expect(deps.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paidJoinBinding: frozenBinding,
        reservationId,
      }),
    );
    expect(deps.owner.execute).not.toHaveBeenCalled();
    expect(deps.calls).not.toContain('failPaidJoinAttempt');
  });
  it('keeps a transient confirmation failure retryable and emits a redacted failure code', async () => {
    const deps = receiptDependencies();
    deps.confirmPayment.mockRejectedValueOnce(new Error('synthetic temporary projection failure'));
    const metric = vi.fn();
    expect(
      (
        await reconcileCommercialJoinOperation(reconcileInput, {
          ...deps,
          onReconciliationFailure: metric,
        })
      )?.operation.status,
    ).toBe('UNKNOWN');
    expect(metric).toHaveBeenCalledWith('GAME_CONFIRMATION_UNAVAILABLE');
    expect((await reconcileCommercialJoinOperation(reconcileInput, deps))?.operation.status).toBe(
      'SUCCEEDED',
    );
    expect(deps.owner.execute).not.toHaveBeenCalled();
  });
  it('returns the confirmed revision even while the attempt projection still lags', async () => {
    // Regression: the legacy trusted-receipt branch of the readback answered SUCCEEDED with
    // `aggregateRevision: null` while the paid-join attempt projection was not yet COMPLETED.
    // The web client then stayed in CONFIRMED_UPDATING forever. The reconcile command must return
    // the revision of the applied confirmation directly.
    const laggingAttempt: CommercialJoinAttemptView = {
      commandId: operationId,
      gameId: envelope.gameId,
      state: 'IN_PROGRESS',
      result: null,
      errorCode: null,
      providerBinding: frozenBinding,
      reservation: { id: reservationId, state: 'ACTIVE', expiresAt: '2026-10-22T10:15:00.000Z' },
      receipt: { provider: 'VIVA', status: 'CONFIRMED', confirmedAt: ownerReceipt.verifiedAt },
    };
    const confirmPayment = vi.fn<NonNullable<CommercialJoinRepositoryPort['confirmPayment']>>(() =>
      resolved({
        outcome: 'applied' as const,
        commandId: fixtureId(905),
        gameId: envelope.gameId,
        revision: 11,
        viewerRelation: 'PARTICIPANT' as const,
        participationId: fixtureId(906),
        reservationId,
        committedAt: ownerReceipt.verifiedAt,
        replayed: false,
      }),
    );
    const repo = repository({
      getPaidJoinAttempt: () => resolved(laggingAttempt),
      confirmPayment,
    });
    const result = await reconcileCommercialJoinOperation(reconcileInput, {
      repository: repo.repository,
      owner: {
        execute: vi.fn(() => resolved({ status: 'UNKNOWN' as const })),
        read: vi.fn(() => resolved({ status: 'CONFIRMED' as const, receipt: ownerReceipt })),
      },
    });
    expect(result?.operation.status).toBe('SUCCEEDED');
    expect(result?.operation.aggregateRevision).toBe(11);
    expect(result?.operation.commercial.attemptState).toBe('OWNER_CONFIRMED');
  });
  it.each([
    'operationId',
    'tenantId',
    'userId',
    'gameId',
    'reservationId',
    'providerClientId',
    'providerMappingId',
    'providerClientSubscriptionId',
    'providerExerciseId',
    'targetMappingId',
    'targetVersion',
    'requestSha256',
    'idempotencyKeySha256',
  ] as const)(
    'refuses a mismatched receipt %s without settlement, release or redispatch',
    async (key) => {
      const deps = receiptDependencies({ ...ownerReceipt, [key]: 'wrong' });
      expect((await reconcileCommercialJoinOperation(reconcileInput, deps))?.operation.status).toBe(
        'UNKNOWN',
      );
      expect(deps.confirmPayment).not.toHaveBeenCalled();
      expect(deps.owner.execute).not.toHaveBeenCalled();
      expect(deps.calls).not.toContain('failPaidJoinAttempt');
    },
  );
});

describe('commercial JOIN policy/usage binding refs (B2)', () => {
  const bindingRefs = {
    policyRef: { policyVersion: 3, policyDigest: `sha256:${'a'.repeat(64)}` },
    decisionId: '11111111-1111-4111-8111-111111111111',
    usageRef: { usageRef: 'usage:abc-1', reservationUnits: 1 },
  };

  it('refuses bound dispatch over the legacy owner before any durable write', async () => {
    const { calls, repository: repo } = repository();
    const owner = ownerPort([{ status: 'PENDING' }]);
    for (const refs of [bindingRefs, { policyRef: bindingRefs.policyRef }]) {
      const result = await executeCommercialJoin(
        { ...envelope, bindingRefs: refs },
        dependencies(repo, owner.owner),
      );
      expect(result).toMatchObject({ kind: 'failed', code: 'GAME_RECONCILIATION_REQUIRED' });
    }
    expect(calls).toEqual([]);
    expect(owner.calls).toEqual([]);
  });

  it.each(['IN_PROGRESS', 'COMPLETED'] as const)(
    'keeps a bound %s attempt unresolved despite a legacy local or owner receipt',
    async (state) => {
      const deps = receiptDependencies();
      const originalRead = deps.repository.getPaidJoinAttempt;
      deps.repository.getPaidJoinAttempt = async (input) => {
        const attempt = await originalRead(input);
        return (
          attempt && {
            ...attempt,
            bindingRefs,
            state,
            receipt: {
              provider: 'VIVA' as const,
              status: 'CONFIRMED' as const,
              confirmedAt: ownerReceipt.verifiedAt,
            },
            result: {
              commandId: operationId,
              gameId: envelope.gameId,
              revision: 10,
              viewerRelation: 'PARTICIPANT' as const,
              reservationId,
              committedAt: ownerReceipt.verifiedAt,
            },
          }
        );
      };
      for (const read of [readCommercialJoinOperation, reconcileCommercialJoinOperation]) {
        const result = await read(reconcileInput, deps);
        expect(result?.operation).toMatchObject({
          status: 'UNKNOWN',
          commercial: { attemptState: 'UNKNOWN', reason: 'GAME_RECONCILIATION_REQUIRED' },
        });
        expect(result?.operation.id).toBe(operationId);
        expect(JSON.stringify(result)).not.toContain(bindingRefs.usageRef.usageRef);
      }
      expect(deps.confirmPayment).not.toHaveBeenCalled();
      expect(deps.owner.read).not.toHaveBeenCalled();
      expect(deps.owner.execute).not.toHaveBeenCalled();
      expect(deps.calls).not.toContain('failPaidJoinAttempt');
    },
  );

  it('rejects a malformed binding before any durable write or owner call', async () => {
    const { calls, repository: repo } = repository();
    const owner = ownerPort([{ status: 'PENDING' }]);

    await expect(
      executeCommercialJoin(
        {
          ...envelope,
          bindingRefs: {
            policyRef: { policyVersion: 0, policyDigest: `sha256:${'a'.repeat(64)}` },
          },
        },
        dependencies(repo, owner.owner),
      ),
    ).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_REF_INVALID' });
    expect(calls).toEqual([]);
    expect(owner.calls).toEqual([]);
  });
});

describe('commercial JOIN request fingerprint v2 (B2)', () => {
  const digestA = `sha256:${'a'.repeat(64)}`;
  const digestB = `sha256:${'b'.repeat(64)}`;
  const decisionIdA = '11111111-1111-4111-8111-111111111111';
  const decisionIdB = '22222222-2222-4222-8222-222222222222';
  const bindingRefs = {
    policyRef: { policyVersion: 3, policyDigest: digestA },
    decisionId: decisionIdA,
    usageRef: { usageRef: 'usage:abc-1', reservationUnits: 1 },
  };
  const boundEnvelope = { ...envelope, bindingRefs };
  const reserved: CommercialJoinBeginResult = {
    outcome: 'reserved',
    operationId,
    reservationId,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    revision: 9,
  };
  type BeginInput = Parameters<CommercialJoinRepositoryPort['beginPaidJoin']>[0];

  it('is deterministic and covers every binding field', () => {
    const hash = commercialJoinRequestHashV2(boundEnvelope);
    expect(commercialJoinRequestHashV2({ ...envelope, bindingRefs })).toBe(hash);
    // A v2 hash can never collide with the legacy v1 fingerprint of the same client request.
    expect(hash).not.toBe(envelope.requestHash);
    const variants = [
      { ...bindingRefs, policyRef: { policyVersion: 4, policyDigest: digestA } },
      { ...bindingRefs, policyRef: { policyVersion: 3, policyDigest: digestB } },
      { ...bindingRefs, decisionId: decisionIdB },
      { ...bindingRefs, usageRef: { usageRef: 'usage:other' } },
      { ...bindingRefs, usageRef: { usageRef: 'usage:abc-1', reservationUnits: 2 } },
    ];
    for (const variant of variants) {
      expect(commercialJoinRequestHashV2({ ...envelope, bindingRefs: variant })).not.toBe(hash);
    }
    expect(() =>
      commercialJoinRequestHashV2({
        ...envelope,
        bindingRefs: { policyRef: { policyVersion: 0, policyDigest: digestA } },
      }),
    ).toThrow();
  });

  it('keeps the legacy v1 fingerprint for an unbound operation', async () => {
    const captured: BeginInput[] = [];
    const { repository: repo } = repository({
      beginPaidJoin(input) {
        captured.push(input);
        return resolved(reserved);
      },
    });

    await executeCommercialJoin(
      envelope,
      dependencies(repo, ownerPort([{ status: 'PENDING' }]).owner),
    );

    expect(captured[0]?.requestHash).toBe(envelope.requestHash);
    expect(captured[0]?.bindingRefs).toBeUndefined();
  });

  it('refuses both same-key bound retries without dispatching over the legacy wire', async () => {
    const repo = repository();
    const owner = ownerPort([{ status: 'PENDING' }]);
    for (const policyRef of [bindingRefs.policyRef, { policyVersion: 4, policyDigest: digestB }]) {
      await expect(
        executeCommercialJoin(
          { ...boundEnvelope, bindingRefs: { ...bindingRefs, policyRef } },
          dependencies(repo.repository, owner.owner),
        ),
      ).resolves.toMatchObject({ kind: 'failed', code: 'GAME_RECONCILIATION_REQUIRED' });
    }
    expect(repo.calls).toEqual([]);
    expect(owner.calls).toEqual([]);
  });
});

describe('managed JOIN v2 expectation acquisition', () => {
  const binding = {
    ...managedFixture.confirmed.receipt,
    startsAt: '2099-09-21T04:00:00.000Z',
    durationMinutes: 90,
    capacity: 4,
    admissible: true,
  };
  const managedJoin = {
    contractVersion: 2 as const,
    requestFingerprint: envelope.requestHash,
    entitlement: parseManagedJoinEntitlement(managedFixture.preflight.response.entitlement),
  };
  function freeFixture() {
    const fixture = createJoinConditionsFixture(0);
    fixture.setQuotes({
      quotes: [
        {
          subscriptionId: fixtureId(6),
          selectionKey: JSON.stringify([
            'EXISTING_GAME',
            'pay_synthetic_existing_game',
            '2099-09-21T07:00:00+03:00',
            90,
          ]),
          status: 'AVAILABLE',
          basePriceMinor: 300000,
          amountMinor: 0,
          freeMinutes: 90,
          paidMinutes: 0,
          reasonCode: null,
          evaluatedAt: Date.now(),
          expiresAt: Date.now() + 30000,
        },
      ],
    });
    return fixture;
  }
  it.each(['managed', 'legacy'] as const)(
    'free %s selection preflights before seat and freezes only managed refs',
    async (mode) => {
      const order: string[] = [];
      const begin = vi.fn<CommercialJoinRepositoryPort['beginPaidJoin']>(() => {
        order.push('reserve');
        return resolved({
          outcome: 'reserved' as const,
          operationId,
          reservationId,
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          revision: 9,
        });
      });
      const repo = repository({ beginPaidJoin: begin }).repository;
      const prepareManaged = vi.fn(() => {
        order.push('preflight');
        return resolved({
          outcome: 'prepared' as const,
          binding,
          ...(mode === 'managed' ? { managedJoin } : {}),
        });
      });
      const execute = vi.fn(() => {
        order.push('admit');
        return resolved({ status: 'PENDING' as const });
      });
      const result = await executeCommercialJoin(
        { ...envelope, priceConsent: { amountMinor: 0, currency: 'RUB' } },
        {
          ...dependencies(repo, { execute, read: () => resolved(null) }, freeFixture()),
          owner: { prepareManaged, execute, read: () => resolved(null) },
        },
      );
      expect(result.kind).toBe('accepted');
      expect(order).toEqual(['preflight', 'reserve', 'admit']);
      expect(begin.mock.calls[0]?.[0]).toMatchObject({
        requestHash:
          mode === 'managed' ? managedJoinRequestHash(managedJoin) : envelope.requestHash,
      });
      if (mode === 'managed') {
        expect(begin.mock.calls[0]?.[0]).toHaveProperty('managedJoin', managedJoin);
        expect(begin.mock.calls[0]?.[0]).not.toHaveProperty('bindingRefs.usageRef');
      } else expect(begin.mock.calls[0]?.[0]).not.toHaveProperty('managedJoin');
    },
  );
  it.each(['disabled', 'admission', 'lost-ack'] as const)(
    'persists %s station adoption before original booking dispatch',
    async (mode) => {
      const order: string[] = [];
      const begin = vi.fn<CommercialJoinRepositoryPort['beginPaidJoin']>(() => {
        order.push('reserve');
        return resolved({
          outcome: 'reserved',
          operationId,
          reservationId,
          expiresAt: new Date(Date.now() + 900000).toISOString(),
          revision: 9,
        });
      });
      const stationMembership = vi.fn(() => {
        order.push('station');
        if (mode === 'lost-ack') return Promise.reject(new Error('owner response lost'));
        return resolved({
          version: 1 as const,
          outcome: 'NO_ENROLLMENT' as const,
          reason: 'STATION_BINDING_UNAVAILABLE' as const,
        });
      });
      const execute = vi.fn(() => {
        order.push('booking');
        return resolved({ status: 'PENDING' as const });
      });
      const result = await executeCommercialJoin(
        { ...envelope, priceConsent: { amountMinor: 0, currency: 'RUB' } },
        {
          ...dependencies(
            repository({ beginPaidJoin: begin }).repository,
            { execute, read: () => resolved(null) },
            freeFixture(),
          ),
          owner: {
            prepareManaged: () => resolved({ outcome: 'prepared' as const, binding, managedJoin }),
            execute,
            read: () => resolved(null),
          },
          ...(mode === 'disabled' ? {} : { stationMembership }),
        },
      );
      expect(result.kind).toBe('accepted');
      expect(order).toEqual(
        mode === 'disabled' ? ['reserve', 'booking'] : ['station', 'reserve', 'booking'],
      );
      expect(begin.mock.calls[0]?.[0].stationMembership).toEqual({
        version: 1,
        outcome: 'NO_ENROLLMENT',
        reason:
          mode === 'disabled'
            ? 'DISABLED'
            : mode === 'lost-ack'
              ? 'OWNER_UNAVAILABLE'
              : 'STATION_BINDING_UNAVAILABLE',
      });
      expect(execute).toHaveBeenCalledOnce();
    },
  );
  it('never upgrades an existing unadopted operation or dispatches another booking', async () => {
    const stationMembership = vi.fn(),
      execute = vi.fn(),
      prepareManaged = vi.fn();
    const prior: CommercialJoinAttemptView = {
      requestHash: envelope.requestHash,
      commandId: operationId,
      gameId: envelope.gameId,
      state: 'IN_PROGRESS',
      result: null,
      errorCode: null,
      reservation: null,
      receipt: null,
    };
    await executeCommercialJoin(envelope, {
      ...dependencies(
        repository({ getPaidJoinAttempt: () => resolved(prior) }).repository,
        { execute, read: () => resolved(null) },
        freeFixture(),
      ),
      owner: { prepareManaged, execute, read: () => resolved(null) },
      stationMembership,
    });
    expect(stationMembership).not.toHaveBeenCalled();
    expect(prepareManaged).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('never treats an unavailable preflight as legacy or reserves a seat', async () => {
    const begin = vi.fn();
    const prepare = vi.fn();
    const execute = vi.fn();
    const result = await executeCommercialJoin(
      { ...envelope, priceConsent: { amountMinor: 0, currency: 'RUB' } },
      {
        ...dependencies(
          repository({ beginPaidJoin: begin }).repository,
          { execute, read: () => resolved(null) },
          freeFixture(),
        ),
        owner: {
          prepareManaged: () => Promise.reject(new Error('owner unavailable')),
          prepare,
          execute,
          read: () => resolved(null),
        },
      },
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_RECONCILIATION_REQUIRED' });
    expect(begin).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('paid legacy skips managed preflight and preserves request bytes', async () => {
    const prepareManaged = vi.fn();
    const begin = vi.fn<CommercialJoinRepositoryPort['beginPaidJoin']>().mockResolvedValue({
      outcome: 'reserved',
      operationId,
      reservationId,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      revision: 9,
    });
    const owner = { ...ownerPort([{ status: 'PENDING' }]).owner, prepareManaged };
    await executeCommercialJoin(
      envelope,
      dependencies(repository({ beginPaidJoin: begin }).repository, owner),
    );
    expect(prepareManaged).not.toHaveBeenCalled();
    expect(begin.mock.calls[0]?.[0].requestHash).toBe(envelope.requestHash);
  });
  it('replays the original expectation before current price/owner resolution and rejects changed input', async () => {
    const fixture = freeFixture();
    const prepareManaged = vi.fn();
    const execute = vi.fn();
    const begin = vi.fn();
    const prior: CommercialJoinAttemptView = {
      commandId: operationId,
      gameId: envelope.gameId,
      state: 'IN_PROGRESS',
      result: null,
      errorCode: null,
      reservation: null,
      receipt: null,
      managedJoin,
      requestHash: managedJoinRequestHash(managedJoin),
    };
    const deps = {
      ...dependencies(
        repository({ getPaidJoinAttempt: () => resolved(prior), beginPaidJoin: begin }).repository,
        { execute, read: () => resolved(null) },
        fixture,
      ),
      owner: { prepareManaged, execute, read: () => resolved(null) },
    };
    expect((await executeCommercialJoin(envelope, deps)).kind).toBe('accepted');
    expect(
      await executeCommercialJoin({ ...envelope, requestHash: 'f'.repeat(64) }, deps),
    ).toMatchObject({ kind: 'failed', code: 'GAME_COMMERCIAL_ATTEMPT_CONFLICT' });
    expect(fixture.calls).toEqual([]);
    expect(prepareManaged).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('same-key pending managed retry invokes only restricted recovery then reads receipt', async () => {
    const fixture = freeFixture();
    const prepareManaged = vi.fn();
    const execute = vi.fn();
    const begin = vi.fn();
    const recover = vi.fn().mockResolvedValue({ status: 'UNKNOWN' });
    const read = vi.fn().mockResolvedValue({ status: 'UNKNOWN' });
    const prior: CommercialJoinAttemptView = {
      commandId: operationId,
      gameId: envelope.gameId,
      state: 'IN_PROGRESS',
      result: null,
      errorCode: null,
      reservation: {
        id: reservationId,
        state: 'ACTIVE',
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      },
      receipt: null,
      providerBinding: binding,
      managedJoin,
      requestHash: managedJoinRequestHash(managedJoin),
    };
    const deps = {
      ...dependencies(
        repository({
          getPaidJoinAttempt: () => resolved(prior),
          beginPaidJoin: begin,
          confirmPayment: vi.fn(),
        }).repository,
        { execute, read },
        fixture,
      ),
      owner: { prepareManaged, execute, recover, read },
    };
    expect((await executeCommercialJoin(envelope, deps)).kind).toBe('accepted');
    expect(recover).toHaveBeenCalledOnce();
    expect(recover.mock.calls[0]?.[0]).toMatchObject({
      operationId,
      reservationId,
      managedJoin,
      providerBinding: binding,
      actor: { expectedRevision: envelope.expectedRevision },
    });
    expect(read).toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(prepareManaged).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await executeCommercialJoin({ ...envelope, requestHash: 'e'.repeat(64) }, deps);
    expect(recover).toHaveBeenCalledOnce();
  });
  it('a concurrent COMPLETED reserve replay cannot bypass the stored full v2 receipt check', async () => {
    const prior: CommercialJoinAttemptView = {
      commandId: operationId,
      gameId: envelope.gameId,
      state: 'COMPLETED',
      result: {
        commandId: operationId,
        gameId: envelope.gameId,
        revision: 9,
        viewerRelation: 'PARTICIPANT',
        committedAt: new Date().toISOString(),
      },
      errorCode: null,
      reservation: null,
      receipt: null,
      managedJoin,
    };
    const get = vi
      .fn<CommercialJoinRepositoryPort['getPaidJoinAttempt']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(prior);
    const begin = vi.fn<CommercialJoinRepositoryPort['beginPaidJoin']>().mockResolvedValue({
      outcome: 'replayed',
      operationId,
      state: 'COMPLETED',
      result: prior.result!,
    });
    const execute = vi.fn();
    const owner = {
      prepareManaged: () => resolved({ outcome: 'prepared' as const, binding, managedJoin }),
      execute,
      read: () => resolved(null),
    };
    const result = await executeCommercialJoin(
      { ...envelope, priceConsent: { amountMinor: 0, currency: 'RUB' } },
      dependencies(
        repository({ getPaidJoinAttempt: get, beginPaidJoin: begin }).repository,
        owner,
        freeFixture(),
      ),
    );
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') expect(result.body.operation.status).toBe('UNKNOWN');
    expect(execute).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
