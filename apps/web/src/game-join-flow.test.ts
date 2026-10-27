import { describe, expect, it } from 'vitest';

import {
  checkGameJoinConditions,
  classifyGameJoinErrorCode,
  classifyGameJoinOperation,
  classifyGameJoinReadbackNotFound,
  gameJoinConditionsUnavailableMessage,
  gameJoinFlowBlocksPurchase,
  gameJoinPaymentUnavailableMessage,
  gameJoinRequiresPaidFlow,
  gameJoinServiceBlockedMessage,
  readGameJoinCommandResult,
  readGameJoinConditions,
  readUncertainGameJoinError,
  reduceGameJoinFlow,
  resolveGameJoinConsent,
  type GameJoinCommandResultView,
  type GameJoinConditionsView,
  type GameJoinFlowState,
} from './game-join-flow.js';
import { GAME_JOIN_ATTEMPT_QUIET_MS } from './game-join-attempt.js';

const GAME_ID = '55555555-5555-4555-8555-555555555555';
const SUBSCRIPTION_ID = '66666666-6666-4666-8666-666666666666';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const NOW = Date.parse('2026-10-21T08:00:00.000Z');
const CONSENT = { amountMinor: 70000, currency: 'RUB' } as const;

function conditions(overrides: Partial<GameJoinConditionsView> = {}): GameJoinConditionsView {
  return {
    gameId: GAME_ID,
    revision: 7,
    subscriptionInstanceId: SUBSCRIPTION_ID,
    eligibility: 'AVAILABLE',
    reasonCode: null,
    subscriptionApplied: true,
    price: { status: 'ADVISORY', amountMinor: 70000, currency: 'RUB', confirmed: false },
    expiresAt: '2026-10-21T08:00:30.000Z',
    requiresPriceConsent: true,
    ...overrides,
  };
}

function operation(
  status: GameJoinCommandResultView['operation']['status'],
  overrides: Partial<GameJoinCommandResultView['operation']> = {},
): GameJoinCommandResultView {
  return {
    commandId: OPERATION_ID,
    operation: {
      id: OPERATION_ID,
      status,
      gameId: GAME_ID,
      aggregateRevision: null,
      nextAction: { type: 'NONE' },
      error: null,
      commercial: {
        attemptState: 'OWNER_CONFIRMED',
        receipt: {
          provider: 'VIVA',
          status: 'CONFIRMED',
          confirmedAt: '2026-10-21T08:00:01.000Z',
        },
        reason: null,
      },
      ...overrides,
    },
    replayed: false,
  };
}

function waiting(
  state: GameJoinFlowState,
): Extract<GameJoinFlowState, { kind: 'WAIT_FOR_RECONCILIATION' }> {
  if (state.kind !== 'WAIT_FOR_RECONCILIATION') {
    throw new Error(`expected WAIT_FOR_RECONCILIATION, received ${state.kind}`);
  }
  return state;
}

describe('NO_PAYMENT join stays unchanged', () => {
  it('treats a successful free join as success without a commercial signal', () => {
    const result = classifyGameJoinOperation(operation('SUCCEEDED', { commercial: null }), {
      paid: false,
    });
    expect(result.state).toEqual(expect.objectContaining({ kind: 'SUCCEEDED' }));
    expect(gameJoinFlowBlocksPurchase(result.state)).toBe(false);
  });

  it('requires no consent or subscription for a free game', () => {
    expect(
      gameJoinRequiresPaidFlow({
        priceSummary: null,
        viewerPaymentState: 'NOT_REQUIRED',
        allowedActions: ['OPEN_DETAILS', 'JOIN'],
      }),
    ).toBe(false);
    expect(
      checkGameJoinConditions({
        conditions: conditions({
          requiresPriceConsent: false,
          price: { status: 'MISSING', amountMinor: null, currency: 'RUB', confirmed: false },
        }),
        gameId: GAME_ID,
        revision: 7,
        subscriptionInstanceId: SUBSCRIPTION_ID,
        nowMs: NOW,
      }).kind,
    ).toBe('FREE');
  });

  it('flags a paid game for the consent path', () => {
    expect(
      gameJoinRequiresPaidFlow({
        priceSummary: { amountMinor: 70000, currency: 'RUB' },
        viewerPaymentState: 'NOT_REQUIRED',
        allowedActions: ['OPEN_DETAILS', 'JOIN'],
      }),
    ).toBe(true);
    expect(
      gameJoinRequiresPaidFlow({
        priceSummary: null,
        viewerPaymentState: 'REQUIRES_ACTION',
        allowedActions: ['OPEN_DETAILS', 'PAY'],
      }),
    ).toBe(true);
  });
});

describe('paid JOIN consent', () => {
  it('uses the server-owned amount for an explicit consent step and never posts before it', () => {
    const check = checkGameJoinConditions({
      conditions: conditions(),
      gameId: GAME_ID,
      revision: 7,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      nowMs: NOW,
    });
    expect(check.kind).toBe('CONSENT');
    expect(check.consent).toEqual({ amountMinor: 70000, currency: 'RUB' });

    const state = reduceGameJoinFlow(
      { kind: 'IDLE' },
      {
        type: 'CONDITIONS_CONSENT_REQUIRED',
        expiresAt: conditions().expiresAt,
        revision: 7,
        consent: check.consent!,
        subscriptionInstanceId: check.subscriptionInstanceId!,
      },
    );
    expect(state).toEqual(expect.objectContaining({ kind: 'NEEDS_CONSENT', consent: CONSENT }));
    expect(gameJoinFlowBlocksPurchase(state)).toBe(true);
  });

  it('rejects a consent for a different amount and never auto-accepts a changed price', () => {
    const state: GameJoinFlowState = {
      kind: 'NEEDS_CONSENT',
      expiresAt: conditions().expiresAt,
      revision: 7,
      consent: CONSENT,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      message: '',
    };
    const stale = reduceGameJoinFlow(state, {
      type: 'CONSENT_GIVEN',
      consent: { amountMinor: 90000, currency: 'RUB' },
    });
    expect(stale.kind).toBe('NEEDS_CONSENT');
    if (stale.kind === 'NEEDS_CONSENT') {
      expect(stale.consent).toEqual(CONSENT);
      expect(stale.message).toContain('Цена изменилась');
    }
    const accepted = reduceGameJoinFlow(state, { type: 'CONSENT_GIVEN', consent: CONSENT });
    expect(accepted).toEqual({ kind: 'DISPATCHING' });
  });

  it('re-shows a new server price after the price confirmation is rejected', () => {
    const first = checkGameJoinConditions({
      conditions: conditions(),
      gameId: GAME_ID,
      revision: 7,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      nowMs: NOW,
    });
    expect(first.consent?.amountMinor).toBe(70000);

    const plan = classifyGameJoinErrorCode('GAME_PRICE_CONFIRMATION_REQUIRED', { paid: true });
    expect(plan).toEqual({
      state: { kind: 'CHECKING_CONDITIONS', reason: 'PRICE_CHANGED' },
      custody: 'DISCARD',
      reloadConditions: true,
    });

    // The refetched conditions carry the new amount; consent is only possible for that amount.
    const second = checkGameJoinConditions({
      conditions: conditions({
        price: { status: 'ADVISORY', amountMinor: 90000, currency: 'RUB', confirmed: false },
      }),
      gameId: GAME_ID,
      revision: 7,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      nowMs: NOW,
    });
    expect(second.consent).toEqual({ amountMinor: 90000, currency: 'RUB' });
  });

  it('does not invent consent when the amount is missing, expired or not available', () => {
    for (const broken of [
      conditions({
        price: { status: 'MISSING', amountMinor: null, currency: 'RUB', confirmed: false },
      }),
      conditions({ expiresAt: '2026-10-21T07:59:59.000Z' }),
      conditions({ eligibility: 'UNAVAILABLE' }),
    ]) {
      const check = checkGameJoinConditions({
        conditions: broken,
        gameId: GAME_ID,
        revision: 7,
        subscriptionInstanceId: SUBSCRIPTION_ID,
        nowMs: NOW,
      });
      expect(check.kind).toBe('UNAVAILABLE');
      expect(check.consent).toBeNull();
    }
    expect(
      resolveGameJoinConsent({
        conditions: conditions({ requiresPriceConsent: false }),
        gameId: GAME_ID,
        revision: 7,
        subscriptionInstanceId: SUBSCRIPTION_ID,
        nowMs: NOW,
      }),
    ).toBeNull();
  });
});

describe('trusted paid success', () => {
  it('preserves service-denial semantics in readback as well as thrown errors', () => {
    const result = classifyGameJoinOperation(
      operation('FAILED', {
        commercial: null,
        error: { code: 'GAME_SERVICE_BLOCKED', message: 'blocked' },
      }),
      { paid: true },
    );
    expect(result.state.kind).toBe('SERVICE_BLOCKED');
    expect(result.custody).toBe('DISCARD');
  });
  it('retains original custody when readback cannot yet find a dispatched operation', () => {
    const plan = classifyGameJoinErrorCode('GAME_OPERATION_NOT_FOUND', { paid: true });
    expect(plan.custody).toBe('KEEP');
    expect(plan.state.kind).toBe('WAIT_FOR_RECONCILIATION');
  });
  it.each([
    {},
    { provider: 'OTHER', status: 'CONFIRMED', confirmedAt: '2026-10-21T08:00:01Z' },
    { provider: 'VIVA', status: 'PENDING', confirmedAt: '2026-10-21T08:00:01Z' },
    { provider: 'VIVA', status: 'CONFIRMED', confirmedAt: 'invalid' },
  ])('does not manufacture a confirmed receipt from %j', (receipt) => {
    const raw = operation('SUCCEEDED');
    const parsed = readGameJoinCommandResult({
      ...raw,
      operation: {
        ...raw.operation,
        commercial: { attemptState: 'UNKNOWN', receipt, reason: null },
      },
    });
    expect(parsed).not.toBeNull();
    expect(classifyGameJoinOperation(parsed!, { paid: true }).trustedSuccess).toBe(false);
  });

  it.each([
    [
      'receipt',
      {
        attemptState: 'UNKNOWN' as const,
        receipt: {
          provider: 'VIVA' as const,
          status: 'CONFIRMED' as const,
          confirmedAt: '2026-10-21T08:00:01.000Z',
        },
        reason: null,
      },
    ],
    ['owner-confirmed', { attemptState: 'OWNER_CONFIRMED' as const, receipt: null, reason: null }],
  ])('accepts SUCCEEDED only with a trusted %s signal', (_label, commercial) => {
    const result = classifyGameJoinOperation(operation('SUCCEEDED', { commercial }), {
      paid: true,
    });
    expect(result.state.kind).toBe('SUCCEEDED');
    expect(result.trustedSuccess).toBe(true);
  });

  it('does not show success for a paid operation without a trusted signal', () => {
    for (const commercial of [
      null,
      { attemptState: 'OWNER_PENDING' as const, receipt: null, reason: null },
      { attemptState: 'DISPATCH_STARTED' as const, receipt: null, reason: null },
    ]) {
      const result = classifyGameJoinOperation(operation('SUCCEEDED', { commercial }), {
        paid: true,
      });
      expect(result.state.kind).toBe('WAIT_FOR_RECONCILIATION');
      expect(result.custody).toBe('KEEP');
      expect(result.trustedSuccess).toBe(false);
      expect(gameJoinFlowBlocksPurchase(result.state)).toBe(true);
    }
  });
});

describe('unknown and reconciliation keep custody', () => {
  it('maps UNKNOWN to status-checking without a replacement purchase', () => {
    const result = classifyGameJoinOperation(
      operation('UNKNOWN', {
        nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 7 },
        commercial: { attemptState: 'UNKNOWN', receipt: null, reason: 'RECONCILIATION_REQUIRED' },
      }),
      { paid: true },
    );
    expect(waiting(result.state)).toEqual(
      expect.objectContaining({ reason: 'UNKNOWN', retryAfterSeconds: 7 }),
    );
    expect(result.custody).toBe('KEEP');
    expect(gameJoinFlowBlocksPurchase(result.state)).toBe(true);
    expect(gameJoinFlowBlocksPurchase(result.state)).toBe(true);
  });

  it('maps PROCESSING/WAIT_FOR_RECONCILIATION to readback polling', () => {
    const result = classifyGameJoinOperation(
      operation('PROCESSING', {
        nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 3 },
        commercial: { attemptState: 'OWNER_PENDING', receipt: null, reason: null },
      }),
      { paid: true },
    );
    expect(waiting(result.state)).toEqual(
      expect.objectContaining({ reason: 'OWNER_PENDING', retryAfterSeconds: 3 }),
    );
    expect(result.custody).toBe('KEEP');
  });

  it('keeps custody for owner-unavailable and reconciliation error codes', () => {
    for (const code of [
      'GAME_OWNER_UNAVAILABLE',
      'GAME_RECONCILIATION_REQUIRED',
      'GAME_COMMERCIAL_ATTEMPT_CONFLICT',
      'GAME_ALREADY_RESERVED',
    ]) {
      const plan = classifyGameJoinErrorCode(code, { paid: true });
      expect(plan.custody).toBe('KEEP');
      expect(plan.state.kind).toBe('WAIT_FOR_RECONCILIATION');
      expect(gameJoinFlowBlocksPurchase(plan.state)).toBe(true);
    }
  });

  it('keeps custody for an uncertain transport failure and never offers a new purchase', () => {
    const uncertain = {
      name: 'GameJoinAttemptUncertainError',
      code: 'GAME_OWNER_UNAVAILABLE',
      operationStatus: 'UNKNOWN',
      recoveryAction: 'KEEP_SAME_ATTEMPT',
      canStartNewPurchase: false,
      gameId: GAME_ID,
      idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };
    expect(readUncertainGameJoinError(uncertain)).toEqual({
      gameId: GAME_ID,
      idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(readUncertainGameJoinError(new Error('network'))).toBeNull();
    const plan = classifyGameJoinErrorCode('GAME_COMMERCIAL_JOIN_UNCERTAIN', { paid: true });
    expect(plan.custody).toBe('KEEP');
    expect(gameJoinFlowBlocksPurchase(plan.state)).toBe(true);
  });

  it('recovery on mount reports status-checking and keeps the attempt', () => {
    const state = reduceGameJoinFlow(
      { kind: 'IDLE' },
      {
        type: 'RECOVERY_FOUND',
        operationId: OPERATION_ID,
      },
    );
    expect(waiting(state).reason).toBe('RECOVERY');
    expect(gameJoinFlowBlocksPurchase(state)).toBe(true);
  });
});

describe('separate blocked states', () => {
  it('shows service blocked separately from payment and price', () => {
    const service = classifyGameJoinErrorCode('GAME_SERVICE_BLOCKED', { paid: true });
    expect(service).toEqual({
      state: { kind: 'SERVICE_BLOCKED', message: gameJoinServiceBlockedMessage() },
      custody: 'DISCARD',
      reloadConditions: false,
    });
    const payment = classifyGameJoinErrorCode('GAME_PAYMENT_REQUIRED', { paid: true });
    expect(payment.state).toEqual({
      kind: 'PAYMENT_UNAVAILABLE',
      message: gameJoinPaymentUnavailableMessage(),
    });
    expect(gameJoinServiceBlockedMessage()).not.toBe(gameJoinPaymentUnavailableMessage());
    expect(gameJoinServiceBlockedMessage()).not.toContain('Платёжный контур');
  });

  it('asks for a subscription without posting', () => {
    const plan = classifyGameJoinErrorCode('GAME_SUBSCRIPTION_SELECTION_REQUIRED', { paid: true });
    expect(plan.state.kind).toBe('NEEDS_SUBSCRIPTION');
    expect(plan.custody).toBe('DISCARD');
    expect(gameJoinFlowBlocksPurchase(plan.state)).toBe(true);
  });

  it('reports an unavailable conditions check instead of inventing a price', () => {
    const state = reduceGameJoinFlow(
      { kind: 'CHECKING_CONDITIONS', reason: 'USER_REQUEST' },
      {
        type: 'CONDITIONS_UNAVAILABLE',
        message: gameJoinConditionsUnavailableMessage(),
      },
    );
    expect(state).toEqual(
      expect.objectContaining({ kind: 'FAILED', message: gameJoinConditionsUnavailableMessage() }),
    );
  });

  it('maps definitive rejections to a retriable failure and unknown paid errors to reconciliation', () => {
    const full = classifyGameJoinErrorCode('GAME_FULL', { paid: true });
    expect(full.custody).toBe('DISCARD');
    expect(full.state.kind).toBe('FAILED');

    const unknownPaid = classifyGameJoinErrorCode(undefined, { paid: true });
    expect(unknownPaid.custody).toBe('KEEP');
    expect(unknownPaid.state.kind).toBe('WAIT_FOR_RECONCILIATION');

    const unknownFree = classifyGameJoinErrorCode(undefined, { paid: false });
    expect(unknownFree.custody).toBe('DISCARD');
    expect(unknownFree.state.kind).toBe('FAILED');
  });

  it('does not allow a new purchase from a point-in-time missing readback', () => {
    const plan = classifyGameJoinErrorCode('GAME_OPERATION_NOT_FOUND', { paid: true });
    expect(plan.custody).toBe('KEEP');
    expect(plan.state).toEqual(expect.objectContaining({ kind: 'WAIT_FOR_RECONCILIATION' }));
  });
});

describe('contract readers', () => {
  it('reads a command result with commercial data and rejects malformed bodies', () => {
    const view = readGameJoinCommandResult({
      commandId: OPERATION_ID,
      operation: {
        id: OPERATION_ID,
        status: 'UNKNOWN',
        gameId: GAME_ID,
        aggregateRevision: null,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 5 },
        error: null,
        commercial: {
          attemptState: 'UNKNOWN',
          reservation: null,
          price: { amountMinor: 1, currency: 'RUB', consent: 'SETTLED' },
          receipt: null,
          reason: 'RECONCILIATION_REQUIRED',
        },
      },
      game: null,
      replayed: false,
    });
    expect(view?.operation.status).toBe('UNKNOWN');
    expect(view?.operation.commercial?.attemptState).toBe('UNKNOWN');
    expect(
      readGameJoinCommandResult({ operation: { id: OPERATION_ID, status: 'WHAT' } }),
    ).toBeNull();
    expect(readGameJoinCommandResult(null)).toBeNull();
  });

  it('reads the conditions contract including requiresPriceConsent', () => {
    const view = readGameJoinConditions({
      gameId: GAME_ID,
      revision: 7,
      ownerRevision: null,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      eligibility: 'AVAILABLE',
      reasonCode: null,
      subscriptionApplied: true,
      price: { status: 'ADVISORY', amountMinor: 70000, currency: 'RUB', confirmed: false },
      freeMinutes: 60,
      paidMinutes: 30,
      evaluatedAt: '2026-10-21T07:59:50.000Z',
      expiresAt: '2026-10-21T08:00:30.000Z',
      nonBinding: true,
      requiresReservationRecheck: true,
      requiresPriceConsent: true,
      source: 'LK1_PRICE_PREVIEW',
      providerMode: 'MOCK',
    });
    expect(view?.requiresPriceConsent).toBe(true);
    expect(view?.price.amountMinor).toBe(70000);
    // A response that does not state requiresPriceConsent is not trusted as a consent basis.
    expect(
      readGameJoinConditions({
        gameId: GAME_ID,
        revision: 7,
        subscriptionInstanceId: SUBSCRIPTION_ID,
        eligibility: 'AVAILABLE',
        reasonCode: null,
        subscriptionApplied: true,
        price: { status: 'ADVISORY', amountMinor: 70000, currency: 'RUB', confirmed: false },
        expiresAt: '2026-10-21T08:00:30.000Z',
      }),
    ).toBeNull();
  });

  it('rejects a stale consent snapshot from another revision or subscription', () => {
    const check = checkGameJoinConditions({
      conditions: conditions({ revision: 8 }),
      gameId: GAME_ID,
      revision: 7,
      subscriptionInstanceId: SUBSCRIPTION_ID,
      nowMs: NOW,
    });
    expect(check.kind).toBe('UNAVAILABLE');
  });
});

describe('classifyGameJoinReadbackNotFound', () => {
  const savedAt = '2026-10-21T08:00:00.000Z';

  function attempt(overrides: Record<string, unknown> = {}) {
    return { state: 'PENDING', savedAt, ...overrides } as {
      state: string;
      savedAt: string;
      dispatchStartedAt?: string;
    };
  }

  it('keeps custody before the quiet window when the POST was never dispatched', () => {
    const plan = classifyGameJoinReadbackNotFound(attempt(), {
      now: new Date(Date.parse(savedAt) + GAME_JOIN_ATTEMPT_QUIET_MS - 1),
    });
    expect(plan.release).toBe(false);
    expect(plan.state).toMatchObject({ kind: 'WAIT_FOR_RECONCILIATION', reason: 'UNVERIFIED' });
    expect(plan.retryAfterSeconds).toBe(1);
    expect(JSON.stringify(plan.state)).toContain('Сервер пока не нашёл исходную операцию');
  });

  it('releases an undispatched attempt exactly at the quiet boundary', () => {
    const plan = classifyGameJoinReadbackNotFound(attempt(), {
      now: new Date(Date.parse(savedAt) + GAME_JOIN_ATTEMPT_QUIET_MS),
    });
    expect(plan.release).toBe(true);
    expect(plan.state).toMatchObject({ kind: 'FAILED', code: 'GAME_OPERATION_NOT_FOUND' });
    expect(JSON.stringify(plan.state)).toContain('подтверждённой записи нет');
  });

  it('measures a dispatched attempt from dispatchStartedAt, not from savedAt', () => {
    const dispatchedAt = '2026-10-21T08:05:00.000Z';
    const young = classifyGameJoinReadbackNotFound(attempt({ dispatchStartedAt: dispatchedAt }), {
      now: new Date(Date.parse(dispatchedAt) + 59_000),
    });
    expect(young.release).toBe(false);
    const quiet = classifyGameJoinReadbackNotFound(attempt({ dispatchStartedAt: dispatchedAt }), {
      now: new Date(Date.parse(dispatchedAt) + 60_000),
    });
    expect(quiet.release).toBe(true);
  });

  it('never releases trusted success custody and keeps custody on a malformed clock', () => {
    expect(
      classifyGameJoinReadbackNotFound(attempt({ state: 'SUCCEEDED' }), {
        now: new Date(Date.parse(savedAt) + 10 * GAME_JOIN_ATTEMPT_QUIET_MS),
      }).release,
    ).toBe(false);
    expect(
      classifyGameJoinReadbackNotFound(attempt({ savedAt: 'not-a-date' }), {
        now: new Date(Date.parse(savedAt) + 10 * GAME_JOIN_ATTEMPT_QUIET_MS),
      }).release,
    ).toBe(false);
  });
});
