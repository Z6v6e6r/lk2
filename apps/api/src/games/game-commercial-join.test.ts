import { describe, expect, it } from 'vitest';

import {
  executeCommercialJoin,
  readCommercialJoinOperation,
  commercialJoinRequestHash,
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
        actorUserId: fixtureActor.userId,
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
        actorUserId: fixtureActor.userId,
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
        actorUserId: fixtureActor.userId,
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
        actorUserId: fixtureActor.userId,
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
        actorUserId: fixtureActor.userId,
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
