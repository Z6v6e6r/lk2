import { describe, expect, it, vi } from 'vitest';

import type { CreateStoredGameInput, CreateStoredGameResult } from '@phub/database';
import { bookedOperationAdmissionId } from '@phub/subscription-runtime-adapter';

import {
  assertValidCommercialCreateBody,
  commercialCreateDraftGameId,
  commercialCreateOperationId,
  commercialCreateRequestHash,
  executeCommercialCreate,
  isManagedCreatePaymentMode,
  readCommercialCreateOperation,
  type CommercialCreateCommandEnvelope,
  type CommercialCreateDependencies,
  type CommercialCreateGamePayload,
  type CommercialCreateOwnerRequest,
  type CommercialCreateQuote,
} from './game-create-commercial.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const stationId = '44444444-4444-4444-8444-444444444444';
const idempotencyKey = 'games-commercial-create-0001';
const idempotencyKeySha256 = `sha256:${'a'.repeat(64)}`;
const committedAt = '2026-10-27T08:00:00.000Z';

const payload: CommercialCreateGamePayload = {
  title: 'Платная игра',
  kind: 'FRIENDLY',
  visibility: 'PUBLIC',
  stationId,
  startsAt: '2026-10-28T09:00:00.000Z',
  endsAt: '2026-10-28T10:30:00.000Z',
  timezone: 'Europe/Moscow',
  capacity: 4,
  waitlistEnabled: true,
  paymentMode: 'SPLIT',
};

function envelope(
  overrides: Partial<CommercialCreateCommandEnvelope> = {},
): CommercialCreateCommandEnvelope {
  return {
    tenantId,
    tenantKey: 'iSkq6G',
    userId,
    sessionId,
    correlationId: 'corr-commercial-create-0001',
    idempotencyKey,
    idempotencyKeySha256,
    payload,
    ...overrides,
  };
}

function quote(overrides: Partial<CommercialCreateQuote> = {}): CommercialCreateQuote {
  return {
    basis: 'ADVISORY',
    decisionId: 'advisory:decision-0001',
    outcome: 'ALLOWED',
    price: null,
    reasonCodes: [],
    evaluatedAt: '2026-10-27T07:59:00.000Z',
    expiresAt: '2026-10-27T08:14:00.000Z',
    ...overrides,
  };
}

function applied(
  overrides: Partial<Extract<CreateStoredGameResult, { outcome: 'applied' }>> = {},
): Extract<CreateStoredGameResult, { outcome: 'applied' }> {
  return {
    outcome: 'applied',
    gameId: commercialCreateDraftGameId({
      tenantId,
      userId,
      idempotencyKeySha256,
    }),
    operationId: commercialCreateOperationId({ tenantId, userId, idempotencyKeySha256 }),
    revision: 1,
    committedAt,
    replayed: false,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<CommercialCreateDependencies> = {},
): CommercialCreateDependencies & {
  create: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  quote: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn().mockResolvedValue(applied());
  const reserve = vi
    .fn()
    .mockResolvedValue({ status: 'SKIPPED_ADVISORY', reason: 'GAME_COMMERCIAL_CREATE_WARN' });
  const quoteFn = vi.fn().mockResolvedValue(quote());
  const base: CommercialCreateDependencies = {
    repository: { create },
    owner: {
      quote: quoteFn,
      reserve,
    },
    now: () => Date.parse('2026-10-27T08:00:00.000Z'),
    ...overrides,
  };
  return { ...base, create, reserve, quote: quoteFn };
}

describe('managed commercial CREATE orchestration', () => {
  it('creates the local PROVISIONING draft under the owner lock input and never reports success', async () => {
    const deps = dependencies();
    const result = await executeCommercialCreate(envelope(), deps);

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('unreachable');
    const draftGameId = commercialCreateDraftGameId({ tenantId, userId, idempotencyKeySha256 });
    const operationId = bookedOperationAdmissionId(tenantId, userId, idempotencyKeySha256);

    expect(deps.create).toHaveBeenCalledTimes(1);
    const write = deps.create.mock.calls[0]![0] as CreateStoredGameInput;
    expect(write).toMatchObject({
      tenantId,
      actorUserId: userId,
      idempotencyKey,
      gameId: draftGameId,
      operationId,
      paymentMode: 'SPLIT',
      joinCutoffAt: '2026-10-28T08:30:00.000Z',
    });
    expect(write.requestHash).toBe(
      commercialCreateRequestHash(envelope(), { joinCutoffAt: '2026-10-28T08:30:00.000Z' }),
    );

    expect(deps.reserve).toHaveBeenCalledTimes(1);
    const reserveInput = deps.reserve.mock.calls[0]![0] as CommercialCreateOwnerRequest;
    expect(reserveInput).toMatchObject({
      operationId,
      draftGameId,
      expectedRevision: 1,
      paymentMode: 'SPLIT',
      tenantId,
      userId,
      sessionId,
    });

    expect(result.body.operation).toMatchObject({
      type: 'CREATE_GAME',
      status: 'UNKNOWN',
      gameId: draftGameId,
      aggregateRevision: 1,
      nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 5 },
      error: null,
      commercial: {
        attemptState: 'WARN_OBSERVED',
        reservation: null,
        receipt: null,
        price: null,
        quote: { basis: 'ADVISORY', outcome: 'ALLOWED' },
      },
    });
    expect(result.body.replayed).toBe(false);
    assertValidCommercialCreateBody(result.body);
  });

  it('derives a stable draft id and operation id from claims and the request key only', () => {
    const first = commercialCreateDraftGameId({ tenantId, userId, idempotencyKeySha256 });
    const second = commercialCreateDraftGameId({ tenantId, userId, idempotencyKeySha256 });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(
      commercialCreateDraftGameId({
        tenantId,
        userId,
        idempotencyKeySha256: `sha256:${'b'.repeat(64)}`,
      }),
    );
    expect(first).not.toBe(
      commercialCreateDraftGameId({
        tenantId,
        userId: '55555555-5555-4555-8555-555555555555',
        idempotencyKeySha256,
      }),
    );
    expect(first).not.toBe(
      commercialCreateDraftGameId({
        tenantId: '66666666-6666-4666-8666-666666666666',
        userId,
        idempotencyKeySha256,
      }),
    );
    expect(commercialCreateOperationId({ tenantId, userId, idempotencyKeySha256 })).toBe(
      bookedOperationAdmissionId(tenantId, userId, idempotencyKeySha256),
    );
  });

  it('refuses a payment mode outside the managed contour before any write', async () => {
    const deps = dependencies();
    const result = await executeCommercialCreate(
      envelope({ payload: { ...payload, paymentMode: 'ORGANIZER_PAYS' } }),
      deps,
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_PAYMENT_MODE_MISMATCH' });
    expect(deps.quote).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(isManagedCreatePaymentMode('SPLIT')).toBe(true);
    expect(isManagedCreatePaymentMode('SUBSCRIPTION')).toBe(true);
    expect(isManagedCreatePaymentMode('NO_PAYMENT')).toBe(false);
    expect(isManagedCreatePaymentMode('ORGANIZER_PAYS')).toBe(false);
  });

  it('keeps WARN advisory quotes non-binding when the quote is unavailable', async () => {
    const onQuoteFailure = vi.fn();
    const deps = dependencies({ onQuoteFailure });
    deps.quote.mockRejectedValueOnce(new Error('owner unavailable'));
    const result = await executeCommercialCreate(envelope(), deps);

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('unreachable');
    expect(result.body.operation.commercial.attemptState).toBe('WARN_OBSERVED');
    expect(result.body.operation.commercial.quote).toBeNull();
    expect(onQuoteFailure).toHaveBeenCalledWith('GAME_COMMERCIAL_CREATE_QUOTE_UNAVAILABLE');
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it('leaves an advisory quote refusal out of the create result (observation only)', async () => {
    const deps = dependencies();
    deps.quote.mockResolvedValueOnce(quote({ outcome: 'SERVICE_BLOCKED' }));
    const result = await executeCommercialCreate(envelope(), deps);
    // An advisory quote has no authority: it is recorded and the create proceeds.
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('unreachable');
    expect(result.body.operation.commercial.quote).toMatchObject({
      basis: 'ADVISORY',
      outcome: 'SERVICE_BLOCKED',
    });
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit price echo when the owner quote is authoritative', async () => {
    const price = {
      amountMinor: 250000,
      currency: 'RUB' as const,
      expiresAt: '2026-10-27T08:10:00.000Z',
    };
    const authoritative = quote({ basis: 'OWNER', price, expiresAt: '2026-10-27T08:10:00.000Z' });
    const deps = dependencies();
    deps.quote.mockResolvedValue(authoritative);

    const missing = await executeCommercialCreate(envelope(), deps);
    expect(missing).toMatchObject({ kind: 'failed', code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });

    const changed = await executeCommercialCreate(
      envelope({ priceConsent: { amountMinor: 249999, currency: 'RUB' } }),
      deps,
    );
    expect(changed).toMatchObject({ kind: 'failed', code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(deps.create).not.toHaveBeenCalled();

    const accepted = await executeCommercialCreate(
      envelope({ priceConsent: { amountMinor: 250000, currency: 'RUB' } }),
      deps,
    );
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('unreachable');
    expect(accepted.body.operation.commercial.price).toEqual({
      amountMinor: 250000,
      currency: 'RUB',
      consent: 'SETTLED',
    });
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired authoritative quote without writing', async () => {
    const deps = dependencies();
    deps.quote.mockResolvedValue(
      quote({
        basis: 'OWNER',
        evaluatedAt: '2026-10-27T07:58:00.000Z',
        price: { amountMinor: 100, currency: 'RUB', expiresAt: '2026-10-27T07:59:00.000Z' },
        expiresAt: '2026-10-27T07:59:00.000Z',
      }),
    );
    const result = await executeCommercialCreate(
      envelope({ priceConsent: { amountMinor: 100, currency: 'RUB' } }),
      deps,
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('treats the price snapshot expiry as an expired consent, not only the decision expiry', async () => {
    const deps = dependencies();
    deps.quote.mockResolvedValue(
      quote({
        basis: 'OWNER',
        price: { amountMinor: 100, currency: 'RUB', expiresAt: '2026-10-27T07:59:00.000Z' },
        expiresAt: '2026-10-27T09:00:00.000Z',
      }),
    );
    const result = await executeCommercialCreate(
      envelope({ priceConsent: { amountMinor: 100, currency: 'RUB' } }),
      deps,
    );
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_PRICE_CONFIRMATION_REQUIRED' });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed authoritative quote instead of interpreting it', async () => {
    const deps = dependencies({ onQuoteFailure: vi.fn() });
    deps.quote.mockResolvedValueOnce({
      ...quote({ basis: 'OWNER' }),
      reasonCodes: ['NOT A CODE'],
    });
    const result = await executeCommercialCreate(envelope(), deps);
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_OWNER_UNAVAILABLE' });
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('drops a malformed advisory quote from the published body but keeps the create observation', async () => {
    const deps = dependencies();
    deps.quote.mockResolvedValueOnce({ ...quote(), decisionId: '' });
    const result = await executeCommercialCreate(envelope(), deps);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('unreachable');
    expect(result.body.operation.commercial.quote).toBeNull();
    expect(result.body.operation.commercial.attemptState).toBe('WARN_OBSERVED');
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to advertise an operation the writer did not create for the derived draft', async () => {
    const onOwnerFailure = vi.fn();
    const deps = dependencies({ onOwnerFailure });
    deps.create.mockResolvedValueOnce(applied({ gameId: stationId }));
    const result = await executeCommercialCreate(envelope(), deps);
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_OWNER_UNAVAILABLE' });
    expect(onOwnerFailure).toHaveBeenCalledWith('GAME_CREATE_DRAFT_ID_MISMATCH');
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it('maps authoritative owner refusals to stable managed failures without a write', async () => {
    const cases = [
      ['SERVICE_BLOCKED', 'GAME_SERVICE_BLOCKED'],
      ['SUBSCRIPTION_SELECTION_REQUIRED', 'GAME_SUBSCRIPTION_SELECTION_REQUIRED'],
      ['UNAVAILABLE', 'GAME_OWNER_UNAVAILABLE'],
    ] as const;
    for (const [outcome, code] of cases) {
      const deps = dependencies();
      deps.quote.mockResolvedValue(quote({ basis: 'OWNER', outcome }));
      const result = await executeCommercialCreate(envelope(), deps);
      expect(result).toMatchObject({ kind: 'failed', code });
      expect(deps.create).not.toHaveBeenCalled();
    }
  });

  it('replays the same local operation without a second owner request', async () => {
    const deps = dependencies();
    deps.create.mockResolvedValueOnce(applied({ replayed: true }));
    const result = await executeCommercialCreate(envelope(), deps);
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') throw new Error('unreachable');
    expect(result.body.replayed).toBe(true);
    expect(result.body.operation.status).toBe('UNKNOWN');
    expect(result.body.operation.commercial.attemptState).toBe('UNKNOWN');
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it('maps duplicate keys and local writer rejections without a second attempt', async () => {
    const conflict = dependencies();
    conflict.create.mockResolvedValueOnce({ outcome: 'idempotency_conflict' });
    expect(await executeCommercialCreate(envelope(), conflict)).toMatchObject({
      kind: 'failed',
      code: 'GAME_COMMERCIAL_ATTEMPT_CONFLICT',
    });
    expect(conflict.reserve).not.toHaveBeenCalled();

    const location = dependencies();
    location.create.mockResolvedValueOnce({ outcome: 'rejected', code: 'GAME_LOCATION_INVALID' });
    expect(await executeCommercialCreate(envelope(), location)).toEqual({
      kind: 'create_rejected',
      code: 'GAME_LOCATION_INVALID',
    });
    expect(location.reserve).not.toHaveBeenCalled();
  });

  it('keeps unresolved owner outcomes UNKNOWN instead of FAILED and never retries the POST', async () => {
    const pending = dependencies();
    pending.reserve.mockResolvedValueOnce({ status: 'PENDING' });
    const accepted = await executeCommercialCreate(envelope(), pending);
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('unreachable');
    expect(accepted.body.operation).toMatchObject({
      status: 'PROCESSING',
      nextAction: { type: 'NONE' },
      commercial: { attemptState: 'OWNER_PENDING', reason: null },
    });

    for (const outcome of [
      { status: 'UNKNOWN' },
      new Error('owner timeout after accept'),
    ] as const) {
      const deps = dependencies();
      if (outcome instanceof Error) deps.reserve.mockRejectedValueOnce(outcome);
      else deps.reserve.mockResolvedValueOnce(outcome);
      const result = await executeCommercialCreate(envelope(), deps);
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') throw new Error('unreachable');
      expect(result.body.operation).toMatchObject({
        status: 'UNKNOWN',
        error: null,
        nextAction: { type: 'WAIT_FOR_RECONCILIATION', retryAfterSeconds: 5 },
        commercial: {
          attemptState: 'UNKNOWN',
          reason: 'GAME_RECONCILIATION_REQUIRED',
          receipt: null,
          reservation: null,
        },
      });
      expect(deps.reserve).toHaveBeenCalledTimes(1);
      expect(deps.reserve.mock.calls[0]![0]).toMatchObject({
        operationId: commercialCreateOperationId({ tenantId, userId, idempotencyKeySha256 }),
      });
    }
  });

  it('returns a stable failure when the owner explicitly rejects after the durable create', async () => {
    const onOwnerFailure = vi.fn();
    const deps = dependencies({ onOwnerFailure });
    deps.reserve.mockResolvedValueOnce({ status: 'REJECTED', code: 'GAME_SERVICE_BLOCKED' });
    const result = await executeCommercialCreate(envelope(), deps);
    expect(result).toMatchObject({ kind: 'failed', code: 'GAME_SERVICE_BLOCKED' });
    expect(onOwnerFailure).toHaveBeenCalledWith('GAME_SERVICE_BLOCKED');
  });

  it('keeps a quote refusal behind the request-key identity and binds consent into the hash', () => {
    const base = commercialCreateRequestHash(envelope(), { joinCutoffAt: committedAt });
    expect(base).toBe(commercialCreateRequestHash(envelope(), { joinCutoffAt: committedAt }));
    expect(base).not.toBe(
      commercialCreateRequestHash(envelope({ priceConsent: { amountMinor: 1, currency: 'RUB' } }), {
        joinCutoffAt: committedAt,
      }),
    );
    expect(base).not.toBe(
      commercialCreateRequestHash(envelope({ subscriptionInstanceId: stationId }), {
        joinCutoffAt: committedAt,
      }),
    );
    expect(
      commercialCreateRequestHash(
        envelope({ payload: { ...payload, paymentMode: 'SUBSCRIPTION' } }),
        {
          joinCutoffAt: committedAt,
        },
      ),
    ).not.toBe(base);
  });

  it('reads back a still-provisioning create as UNKNOWN and never as FAILED', () => {
    const operationId = commercialCreateOperationId({ tenantId, userId, idempotencyKeySha256 });
    const body = readCommercialCreateOperation({
      operationId,
      gameId: commercialCreateDraftGameId({ tenantId, userId, idempotencyKeySha256 }),
      revision: 1,
      createdAt: committedAt,
      updatedAt: committedAt,
    });
    expect(body.operation).toMatchObject({
      type: 'CREATE_GAME',
      status: 'UNKNOWN',
      error: null,
      nextAction: { type: 'WAIT_FOR_RECONCILIATION' },
      commercial: { attemptState: 'UNKNOWN', reason: 'GAME_RECONCILIATION_REQUIRED' },
    });
    expect(body.replayed).toBe(true);
    assertValidCommercialCreateBody(body);
  });

  it('rejects malformed operation bodies before they reach the public API', () => {
    const operationId = commercialCreateOperationId({ tenantId, userId, idempotencyKeySha256 });
    const body = readCommercialCreateOperation({
      operationId,
      gameId: commercialCreateDraftGameId({ tenantId, userId, idempotencyKeySha256 }),
      revision: 1,
      createdAt: committedAt,
      updatedAt: committedAt,
    });
    expect(() =>
      assertValidCommercialCreateBody({
        ...body,
        operation: { ...body.operation, status: 'UNKNOWN', nextAction: { type: 'NONE' } },
      }),
    ).toThrow('GAME_COMMERCIAL_CREATE_RESPONSE_INVALID');
    expect(() =>
      assertValidCommercialCreateBody({
        ...body,
        commandId: 'not-a-uuid',
      }),
    ).toThrow('GAME_COMMERCIAL_CREATE_RESPONSE_INVALID');
  });
});
