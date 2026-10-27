import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  CommercialCreateOwnerPort,
  CommercialCreateOwnerRequest,
  CommercialCreateQuote,
} from './game-create-commercial.js';
import {
  COMMERCIAL_CREATE_OWNER_CONFIRM_PATH,
  COMMERCIAL_CREATE_OWNER_RELEASE_PATH,
  COMMERCIAL_CREATE_OWNER_RESERVE_PATH,
  confirmCommercialCreateReservation,
  createAdvisoryCommercialCreateOwner,
  createBookedOperationCreateOwnerClient,
  createGameCommercialCreateRuntime,
  releaseCommercialCreateReservation,
  type BookedOperationCreateOwnerClientOptions,
  type CommercialCreateDelegationInput,
} from './game-create-commercial-runtime.js';

const OWNER_BASE_URL = 'https://owner.example.test';
const NOW = 1_760_000_000_000;
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const DRAFT_GAME_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_DRAFT_GAME_ID = '13131313-1313-4313-8313-131313131313';
const STATION_ID = '55555555-5555-4555-8555-555555555555';
const COURT_ID = '66666666-6666-4666-8666-666666666666';
const RESERVATION_ID = '77777777-7777-4777-8777-777777777777';
const INSTANCE_ID = '88888888-8888-4888-8888-888888888888';
const RECEIPT_ID = '99999999-9999-4999-8999-999999999999';
const USAGE_REF = '10101010-1010-4010-8010-101010101010';
const BOOKING_REF = '12121212-1212-4212-8212-121212121212';
const SESSION_ID = 'session-0000000001';
const CORRELATION_ID = 'correlation-create-0001';
const IDEMPOTENCY_KEY = 'idempotency-create-0001';
const DELEGATION = 'synthetic-actor-delegation';
const OWNER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ownerRequest(): CommercialCreateOwnerRequest {
  return {
    tenantId: TENANT_ID,
    tenantKey: 'synthetic',
    userId: USER_ID,
    sessionId: SESSION_ID,
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    operationId: OPERATION_ID,
    draftGameId: DRAFT_GAME_ID,
    expectedRevision: 1,
    paymentMode: 'SPLIT',
    paymentIntent: 'AUTO_BEST_PRICE',
    stationId: STATION_ID,
    courtId: COURT_ID,
    startsAt: '2026-11-01T09:00:00.000Z',
    endsAt: '2026-11-01T10:30:00.000Z',
    timezone: 'Europe/Moscow',
    capacity: 4,
    kind: 'OPEN',
    visibility: 'PUBLIC',
  };
}

function advisoryQuote(): CommercialCreateQuote {
  return {
    basis: 'ADVISORY',
    decisionId: 'advisory:0123456789abcdef0123456789abcdef',
    outcome: 'ALLOWED',
    price: null,
    reasonCodes: [],
    evaluatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 900_000).toISOString(),
  };
}

function pricedQuote(): CommercialCreateQuote {
  return {
    ...advisoryQuote(),
    basis: 'OWNER',
    price: {
      amountMinor: 70_000,
      currency: 'RUB',
      expiresAt: new Date(NOW + 300_000).toISOString(),
    },
  };
}

function reservationResponse(): Response {
  return Response.json({
    reservationId: RESERVATION_ID,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    policyVersion: 'policy-1',
    priceSnapshot: { amountMinor: 70_000, currency: 'RUB' },
  });
}

interface RecordedCall {
  readonly url: URL;
  readonly method: string | undefined;
  readonly redirect: RequestRedirect | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface TransportFixture {
  readonly client: CommercialCreateOwnerPort;
  readonly options: BookedOperationCreateOwnerClientOptions;
  readonly calls: readonly RecordedCall[];
  readonly issued: readonly CommercialCreateDelegationInput[];
  readonly metrics: readonly string[];
  readonly fetchImplementation: Mock<typeof fetch>;
}

function createTransport(
  handler: (call: RecordedCall) => Promise<Response>,
  overrides: {
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly issueDelegation?: (input: CommercialCreateDelegationInput) => Promise<string>;
  } = {},
): TransportFixture {
  const calls: RecordedCall[] = [];
  const issued: CommercialCreateDelegationInput[] = [];
  const metrics: string[] = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const call: RecordedCall = {
      url,
      method: init?.method,
      redirect: init?.redirect,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    };
    calls.push(call);
    return handler(call);
  });
  const options: BookedOperationCreateOwnerClientOptions = {
    baseUrl: OWNER_BASE_URL,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    environment: 'development',
    issueDelegation:
      overrides.issueDelegation ??
      ((input) => {
        issued.push(input);
        return Promise.resolve(DELEGATION);
      }),
    fetchImplementation,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    onMetric: (metric) => metrics.push(metric),
  };
  const client = createBookedOperationCreateOwnerClient(options);
  return { client, options, calls, issued, metrics, fetchImplementation };
}

function reserveInput(
  overrides: {
    readonly preferredSubscriptionInstanceId?: string;
    readonly quote?: CommercialCreateQuote | null;
  } = {},
): CommercialCreateOwnerRequest & { readonly quote: CommercialCreateQuote | null } {
  return {
    ...ownerRequest(),
    ...(overrides.preferredSubscriptionInstanceId === undefined
      ? {}
      : { preferredSubscriptionInstanceId: overrides.preferredSubscriptionInstanceId }),
    quote: overrides.quote === undefined ? advisoryQuote() : overrides.quote,
  };
}

const baseConfig = {
  APP_ENV: 'ci' as const,
  GAME_COMMERCIAL_CREATE_ENABLED: true,
  GAME_COMMERCIAL_CREATE_OWNER_BASE_URL: OWNER_BASE_URL,
  GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS: 1_000,
  GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'ADVISORY' as const,
};

const repository = {
  create: () => Promise.reject(new Error('the local writer must not run in this test')),
};

describe('advisory commercial CREATE owner (WARN)', () => {
  it('returns a deterministic advisory quote without price authority', async () => {
    const owner = createAdvisoryCommercialCreateOwner({ now: () => NOW });
    const input = ownerRequest();
    const first = await owner.quote(input);
    const second = await owner.quote(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      basis: 'ADVISORY',
      outcome: 'ALLOWED',
      price: null,
      reasonCodes: [],
    });
    expect(first.decisionId).toMatch(/^advisory:[a-f0-9]{32}$/);
    expect(first.decisionId).toMatch(OWNER_IDENTIFIER_PATTERN);
    expect(first.evaluatedAt).toBe(new Date(NOW).toISOString());
    expect(first.expiresAt).toBe(new Date(NOW + 900_000).toISOString());
    // The decision id names exactly one derived target, so a second draft is a second decision.
    const other = await owner.quote({ ...input, draftGameId: OTHER_DRAFT_GAME_ID });
    expect(other.decisionId).not.toBe(first.decisionId);
  });

  it('never calls fetch and reports SKIPPED_ADVISORY on reserve', async () => {
    const metrics: string[] = [];
    const fetchImplementation = vi.fn(() => {
      throw new Error('the advisory owner must not touch the network');
    });
    vi.stubGlobal('fetch', fetchImplementation);
    const owner = createAdvisoryCommercialCreateOwner({ onMetric: (m) => metrics.push(m) });
    await expect(owner.reserve({ ...ownerRequest(), quote: null })).resolves.toEqual({
      status: 'SKIPPED_ADVISORY',
      reason: 'GAME_COMMERCIAL_CREATE_WARN',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(metrics).toEqual(['advisory_reserve_skipped']);
  });

  it('reads as unknown and releases without any side effect', async () => {
    const metrics: string[] = [];
    const owner = createAdvisoryCommercialCreateOwner({ onMetric: (m) => metrics.push(m) });
    await expect(owner.read?.(ownerRequest())).resolves.toEqual({ status: 'UNKNOWN' });
    await expect(
      owner.release?.({
        tenantId: TENANT_ID,
        tenantKey: 'synthetic',
        userId: USER_ID,
        sessionId: SESSION_ID,
        correlationId: CORRELATION_ID,
        operationId: OPERATION_ID,
        reason: 'RECONCILIATION',
      }),
    ).resolves.toBeUndefined();
    expect(metrics).toEqual(['advisory_release']);
  });
});

describe('commercial CREATE runtime composition', () => {
  it('stays undefined while the flag is off, so the route keeps GAME_PAYMENT_REQUIRED', () => {
    const runtime = createGameCommercialCreateRuntime({
      config: { ...baseConfig, GAME_COMMERCIAL_CREATE_ENABLED: false },
      repository,
    });
    expect(runtime).toBeUndefined();
  });

  it('composes the advisory owner for the default ADVISORY transport without network access', async () => {
    const fetchImplementation = vi.fn(() => {
      throw new Error('the advisory composition must not touch the network');
    });
    vi.stubGlobal('fetch', fetchImplementation);
    const metrics: string[] = [];
    const runtime = createGameCommercialCreateRuntime({
      config: baseConfig,
      repository,
      onMetric: (metric) => metrics.push(metric),
    });
    expect(runtime).toBeDefined();
    await expect(runtime?.owner.reserve({ ...ownerRequest(), quote: null })).resolves.toEqual({
      status: 'SKIPPED_ADVISORY',
      reason: 'GAME_COMMERCIAL_CREATE_WARN',
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(metrics).toEqual(['advisory_reserve_skipped']);
  });

  it('fails closed for BOOKED_OPERATION without a delegation boundary', () => {
    const runtime = createGameCommercialCreateRuntime({
      config: { ...baseConfig, GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'BOOKED_OPERATION' },
      repository,
    });
    expect(runtime).toBeUndefined();
  });

  it('fails closed for BOOKED_OPERATION without an owner base url', () => {
    const runtime = createGameCommercialCreateRuntime({
      config: {
        ...baseConfig,
        GAME_COMMERCIAL_CREATE_OWNER_BASE_URL: undefined,
        GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'BOOKED_OPERATION',
      },
      repository,
      bookedOperationBoundary: {
        issueCreateDelegation: () => Promise.resolve(DELEGATION),
      },
    });
    expect(runtime).toBeUndefined();
  });

  it('composes the booked-operation transport through the injected delegation boundary', async () => {
    const metrics: string[] = [];
    const issued: CommercialCreateDelegationInput[] = [];
    const calls: Array<{ readonly url: string; readonly body: unknown }> = [];
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      calls.push({
        url: url.toString(),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      });
      return Promise.resolve(reservationResponse());
    });
    vi.stubGlobal('fetch', fetchImplementation);
    const runtime = createGameCommercialCreateRuntime({
      config: { ...baseConfig, GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'BOOKED_OPERATION' },
      repository,
      bookedOperationBoundary: {
        issueCreateDelegation: (input) => {
          issued.push(input);
          return Promise.resolve(DELEGATION);
        },
      },
      onMetric: (metric) => metrics.push(metric),
    });
    expect(runtime).toBeDefined();
    await expect(runtime?.owner.reserve(reserveInput())).resolves.toEqual({ status: 'PENDING' });
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      tenantId: TENANT_ID,
      tenantKey: 'synthetic',
      userId: USER_ID,
      sessionId: SESSION_ID,
      operationId: OPERATION_ID,
      correlationId: CORRELATION_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      action: 'CREATE_GAME',
    });
    expect(issued[0]?.requestSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${OWNER_BASE_URL}${COMMERCIAL_CREATE_OWNER_RESERVE_PATH}`);
    expect(calls[0]?.body).toMatchObject({
      operationId: OPERATION_ID,
      action: 'CREATE_GAME',
      target: { kind: 'GAME', id: DRAFT_GAME_ID, expectedRevision: 1 },
      paymentMode: 'SPLIT',
      paymentIntent: 'AUTO_BEST_PRICE',
      preferredSubscriptionInstanceId: null,
      priceSnapshot: null,
    });
    expect(metrics).toEqual(['reserve_success']);
  });

  it('rejects an owner base url that is not a plain https origin', () => {
    expect(() =>
      createGameCommercialCreateRuntime({
        config: {
          ...baseConfig,
          GAME_COMMERCIAL_CREATE_OWNER_BASE_URL: 'https://owner.example.test/tenant',
          GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT: 'BOOKED_OPERATION',
        },
        repository,
        bookedOperationBoundary: {
          issueCreateDelegation: () => Promise.resolve(DELEGATION),
        },
      }),
    ).toThrow('GAME_COMMERCIAL_CREATE_OWNER_CONFIGURATION_INVALID');
  });
});

describe('booked-operation CREATE owner transport', () => {
  it('sends the frozen reserve contract and maps a strict reservation to PENDING', async () => {
    const fixture = createTransport(() => Promise.resolve(reservationResponse()));
    const input = reserveInput({
      quote: pricedQuote(),
      preferredSubscriptionInstanceId: INSTANCE_ID,
    });
    await expect(fixture.client.reserve(input)).resolves.toEqual({ status: 'PENDING' });
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0];
    expect(call?.url.toString()).toBe(`${OWNER_BASE_URL}${COMMERCIAL_CREATE_OWNER_RESERVE_PATH}`);
    expect(call?.method).toBe('POST');
    expect(call?.redirect).toBe('error');
    expect(call?.headers).toEqual({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idempotency-create-0001',
      'X-Correlation-ID': CORRELATION_ID,
      'X-Subscription-Actor-Delegation': DELEGATION,
    });
    const expectedBody = {
      operationId: OPERATION_ID,
      action: 'CREATE_GAME',
      target: { kind: 'GAME', id: DRAFT_GAME_ID, expectedRevision: 1 },
      paymentMode: 'SPLIT',
      paymentIntent: 'AUTO_BEST_PRICE',
      preferredSubscriptionInstanceId: INSTANCE_ID,
      priceSnapshot: { amountMinor: 70_000, currency: 'RUB' },
    };
    expect(call?.body).toEqual(expectedBody);
    // The delegation is bound to exactly the body that was sent, and only to that body.
    expect(fixture.issued).toHaveLength(1);
    expect(fixture.issued[0]?.requestSha256).toBe(
      `sha256:${createHash('sha256').update(JSON.stringify(expectedBody), 'utf8').digest('hex')}`,
    );
    expect(fixture.metrics).toEqual(['reserve_success']);
  });

  it('times out as UNKNOWN without retrying the write', async () => {
    const stalled = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('synthetic abort')), {
            once: true,
          });
        }),
    );
    const metrics: string[] = [];
    const client = createBookedOperationCreateOwnerClient({
      baseUrl: OWNER_BASE_URL,
      timeoutMs: 100,
      environment: 'development',
      issueDelegation: () => Promise.resolve(DELEGATION),
      fetchImplementation: stalled,
      onMetric: (metric) => metrics.push(metric),
    });
    await expect(client.reserve(reserveInput())).resolves.toEqual({ status: 'UNKNOWN' });
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(metrics).toEqual(['reserve_timeout']);
  });

  it('maps a conflict (409) to UNKNOWN without a replacement POST', async () => {
    const fixture = createTransport(() => Promise.resolve(new Response(null, { status: 409 })));
    await expect(fixture.client.reserve(reserveInput())).resolves.toEqual({ status: 'UNKNOWN' });
    expect(fixture.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fixture.metrics).toEqual(['reserve_conflict']);
  });

  it('maps a known typed refusal to REJECTED with the stable code', async () => {
    const fixture = createTransport(() =>
      Promise.resolve(Response.json({ reason: 'GAME_SERVICE_BLOCKED' }, { status: 403 })),
    );
    await expect(fixture.client.reserve(reserveInput())).resolves.toEqual({
      status: 'REJECTED',
      code: 'GAME_SERVICE_BLOCKED',
    });
    expect(fixture.metrics).toEqual(['reserve_rejected']);
  });

  it('keeps an unknown typed refusal and an unavailable owner UNKNOWN', async () => {
    const unknownReason = createTransport(() =>
      Promise.resolve(Response.json({ reason: 'SOMETHING_UNKNOWN' }, { status: 422 })),
    );
    await expect(unknownReason.client.reserve(reserveInput())).resolves.toEqual({
      status: 'UNKNOWN',
    });
    expect(unknownReason.metrics).toEqual(['reserve_failure']);

    const unavailable = createTransport(() => Promise.resolve(new Response(null, { status: 503 })));
    await expect(unavailable.client.reserve(reserveInput())).resolves.toEqual({
      status: 'UNKNOWN',
    });
    expect(unavailable.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(unavailable.metrics).toEqual(['reserve_failure']);
  });

  it('keeps a malformed 2xx body UNKNOWN instead of reporting a reservation', async () => {
    const malformed = createTransport(() =>
      Promise.resolve(Response.json({ reservationId: 'not-a-uuid', expiresAt: 'soon' })),
    );
    await expect(malformed.client.reserve(reserveInput())).resolves.toEqual({ status: 'UNKNOWN' });
    expect(malformed.metrics).toEqual(['reserve_failure']);
  });

  it('opens the circuit after three failures and stops fetching until the window closes', async () => {
    const clock = { value: NOW };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('synthetic transport error'));
    const metrics: string[] = [];
    const client = createBookedOperationCreateOwnerClient({
      baseUrl: OWNER_BASE_URL,
      timeoutMs: 1_000,
      environment: 'development',
      issueDelegation: () => Promise.resolve(DELEGATION),
      fetchImplementation,
      now: () => clock.value,
      onMetric: (metric) => metrics.push(metric),
    });
    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(client.reserve(reserveInput())).resolves.toEqual({ status: 'UNKNOWN' });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);

    // Outside the 10s window the circuit is open: an immediate UNKNOWN without a fetch.
    clock.value = NOW + 9_999;
    await expect(client.reserve(reserveInput())).resolves.toEqual({ status: 'UNKNOWN' });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(metrics.filter((metric) => metric === 'reserve_circuit_open')).toHaveLength(1);

    // Half-open probe after the window: one request is allowed and success closes the circuit.
    clock.value = NOW + 10_000;
    fetchImplementation.mockResolvedValueOnce(reservationResponse());
    await expect(client.reserve(reserveInput())).resolves.toEqual({ status: 'PENDING' });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(metrics.filter((metric) => metric === 'reserve_success')).toHaveLength(1);
  });

  it('does not dispatch an ill-formed request', async () => {
    const fixture = createTransport(() => Promise.resolve(reservationResponse()));
    await expect(
      fixture.client.reserve({ ...reserveInput(), operationId: 'not-a-uuid' }),
    ).resolves.toEqual({ status: 'UNKNOWN' });
    expect(fixture.fetchImplementation).not.toHaveBeenCalled();
    expect(fixture.metrics).toEqual(['reserve_failure']);
  });

  it('fails a malformed delegation before any owner call', async () => {
    const fixture = createTransport(() => Promise.resolve(reservationResponse()), {
      issueDelegation: () => Promise.resolve('bad delegation with spaces'),
    });
    await expect(fixture.client.reserve(reserveInput())).resolves.toEqual({ status: 'UNKNOWN' });
    expect(fixture.fetchImplementation).not.toHaveBeenCalled();
    expect(fixture.metrics).toEqual(['reserve_failure']);
  });

  it('rejects a cached/authoritative quote request until the LK1 quote contract lands', async () => {
    const fixture = createTransport(() => Promise.resolve(reservationResponse()));
    await expect(fixture.client.quote(ownerRequest())).rejects.toThrow(
      'GAME_COMMERCIAL_CREATE_QUOTE_TRANSPORT_UNAVAILABLE',
    );
    expect(fixture.fetchImplementation).not.toHaveBeenCalled();
  });

  it('exchanges a pending reservation for a trusted receipt', async () => {
    const receipt = {
      receiptId: RECEIPT_ID,
      confirmedAt: new Date(NOW + 120_000).toISOString(),
      appliedRule: 'ENTITLEMENT_APPLIED',
      usageRef: USAGE_REF,
      bookingRef: BOOKING_REF,
    };
    const fixture = createTransport(() => Promise.resolve(Response.json(receipt)));
    const outcome = await confirmCommercialCreateReservation(fixture.options, {
      request: ownerRequest(),
      reservationId: RESERVATION_ID,
    });
    // Only the public-safe receipt view is exposed: the internal owner identifiers stay inside.
    expect(outcome).toEqual({
      status: 'CONFIRMED',
      receipt: { provider: 'VIVA', status: 'CONFIRMED', confirmedAt: receipt.confirmedAt },
    });
    expect(JSON.stringify(outcome)).not.toContain(RECEIPT_ID);
    expect(JSON.stringify(outcome)).not.toContain(USAGE_REF);
    expect(JSON.stringify(outcome)).not.toContain(BOOKING_REF);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.url.toString()).toBe(
      `${OWNER_BASE_URL}${COMMERCIAL_CREATE_OWNER_CONFIRM_PATH}`,
    );
    expect(fixture.calls[0]?.body).toEqual({
      operationId: OPERATION_ID,
      reservationId: RESERVATION_ID,
    });
    expect(fixture.metrics).toEqual(['confirm_success']);
  });

  it('keeps a malformed receipt or a failed confirm UNKNOWN', async () => {
    const malformed = createTransport(() =>
      Promise.resolve(Response.json({ receiptId: RECEIPT_ID, confirmedAt: 'yesterday' })),
    );
    await expect(
      confirmCommercialCreateReservation(malformed.options, {
        request: ownerRequest(),
        reservationId: RESERVATION_ID,
      }),
    ).resolves.toEqual({ status: 'UNKNOWN' });
    expect(malformed.metrics).toEqual(['confirm_unknown']);

    const failed = createTransport(() => Promise.resolve(new Response(null, { status: 500 })));
    await expect(
      confirmCommercialCreateReservation(failed.options, {
        request: ownerRequest(),
        reservationId: RESERVATION_ID,
      }),
    ).resolves.toEqual({ status: 'UNKNOWN' });
    expect(failed.metrics).toEqual(['confirm_unknown']);
  });

  it('swallows port-level release failures and never retries the recovery write', async () => {
    const unavailable = createTransport(() => Promise.resolve(new Response(null, { status: 503 })));
    await unavailable.client.release?.({
      tenantId: TENANT_ID,
      tenantKey: 'synthetic',
      userId: USER_ID,
      sessionId: SESSION_ID,
      correlationId: CORRELATION_ID,
      operationId: OPERATION_ID,
      reason: 'RECONCILIATION',
    });
    expect(unavailable.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(unavailable.calls[0]?.url.toString()).toBe(
      `${OWNER_BASE_URL}${COMMERCIAL_CREATE_OWNER_RELEASE_PATH}`,
    );
    expect(unavailable.calls[0]?.body).toEqual({ operationId: OPERATION_ID });
    expect(unavailable.metrics).toEqual(['release']);

    const networkFailure = createTransport(() =>
      Promise.reject(new Error('synthetic transport error')),
    );
    await networkFailure.client.release?.({
      tenantId: TENANT_ID,
      tenantKey: 'synthetic',
      userId: USER_ID,
      sessionId: SESSION_ID,
      correlationId: CORRELATION_ID,
      operationId: OPERATION_ID,
      reason: 'LOCAL_WRITE_REJECTED',
    });
    expect(networkFailure.metrics).toEqual(['release']);
  });

  it('releases a named reservation through the recovery-only helper', async () => {
    const fixture = createTransport(() => Promise.resolve(Response.json({ released: true })));
    await expect(
      releaseCommercialCreateReservation(fixture.options, {
        tenantId: TENANT_ID,
        tenantKey: 'synthetic',
        userId: USER_ID,
        sessionId: SESSION_ID,
        correlationId: CORRELATION_ID,
        operationId: OPERATION_ID,
        reason: 'RECONCILIATION',
        reservationId: RESERVATION_ID,
      }),
    ).resolves.toBeUndefined();
    expect(fixture.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fixture.calls[0]?.body).toEqual({
      operationId: OPERATION_ID,
      reservationId: RESERVATION_ID,
    });
    expect(fixture.metrics).toEqual(['release']);
  });
});
