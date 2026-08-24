import { describe, expect, it, vi } from 'vitest';
import {
  ManagedSubscriptionRuntimeQuoteClient,
  ManagedSubscriptionRuntimeQuoteClientError,
  MANAGED_SUBSCRIPTION_RUNTIME_V1_QUOTE_PATH,
} from './index.js';

const quoteRequest = {
  action: 'JOIN_GAME',
  target: { kind: 'GAME', id: 'game:123', expectedRevision: 4 },
  preferredSubscriptionInstanceId: 'subscription_instance:123',
  paymentIntent: 'USE_SUBSCRIPTION',
} as const;
const envelope = {
  actorDelegation: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhY3RvciJ9.signature',
  correlationId: 'correlation:123',
  idempotencyKey: 'idempotency:123',
} as const;
const fullPriceOnly = {
  contractVersion: 1,
  nonBinding: true,
  requiresReservationRecheck: true,
  outcome: 'FULL_PRICE_ONLY',
  paymentIntent: 'USE_SUBSCRIPTION',
  decisionId: 'decision:123',
  serviceAllowed: true,
  subscriptionBenefitAllowed: false,
  selectedSubscription: null,
  benefit: null,
  price: {
    priceRevision: 1,
    basePriceMinor: 400000,
    discountMinor: 0,
    surchargeMinor: 0,
    finalPriceMinor: 400000,
    currency: 'RUB',
  },
  limits: {
    activeServices: 0,
    activeServicesLimit: 3,
    dailyUsed: 1,
    dailyLimit: 1,
    weeklyUsed: 1,
    weeklyLimit: null,
    monthlyUsed: 1,
    monthlyLimit: null,
    remainingUnits: 2,
  },
  blockers: [{ code: 'DAILY_LIMIT_REACHED' }],
  warnings: [],
  alternatives: [{ paymentIntent: 'PAY_FULL_PRICE', requiresExplicitUserConfirmation: true }],
  evaluatedAt: '2026-08-24T10:00:00.000Z',
  expiresAt: '2026-08-24T10:02:00.000Z',
} as const;

function client(fetchImplementation: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new ManagedSubscriptionRuntimeQuoteClient({
    enabled: true,
    baseUrl: 'https://subscription-runtime.example.test',
    integrationToken: 'test-integration-token-20260824-safe',
    timeoutMs: 250,
    fetchImplementation,
    ...overrides,
  });
}

describe('ManagedSubscriptionRuntimeQuoteClient', () => {
  it('fails closed before fetch while disabled', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      new ManagedSubscriptionRuntimeQuoteClient({ enabled: false, fetchImplementation }).quote(
        quoteRequest,
        envelope,
      ),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_DISABLED' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('requires enabled runtime configuration and secure URLs', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    for (const options of [
      { enabled: true, timeoutMs: 250 },
      {
        enabled: true,
        baseUrl: 'http://subscription-runtime.example.test',
        integrationToken: 'x',
        timeoutMs: 250,
      },
      {
        enabled: true,
        baseUrl: 'https://subscription-runtime.example.test',
        integrationToken: ' ',
        timeoutMs: 250,
      },
      {
        enabled: true,
        baseUrl: 'https://subscription-runtime.example.test',
        integrationToken: 'x',
        timeoutMs: 99,
      },
      {
        enabled: true,
        baseUrl: 'https://token@subscription-runtime.example.test',
        integrationToken: 'x',
        timeoutMs: 250,
      },
      {
        enabled: true,
        baseUrl: 'https://subscription-runtime.example.test/#fragment',
        integrationToken: 'x'.repeat(32),
        timeoutMs: 250,
      },
      {
        enabled: true,
        baseUrl: 'https://subscription-runtime.example.test/?unsafe=1',
        integrationToken: 'x'.repeat(32),
        timeoutMs: 250,
      },
      {
        enabled: true,
        baseUrl: 'https://subscription-runtime.example.test/base/',
        integrationToken: 'x'.repeat(32),
        timeoutMs: 250,
      },
    ]) {
      await expect(
        new ManagedSubscriptionRuntimeQuoteClient({ ...options, fetchImplementation }).quote(
          quoteRequest,
          envelope,
        ),
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID' });
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('sends only the canonical request and server envelope headers', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(fullPriceOnly), { status: 200 }));
    const result = await client(fetchImplementation).quote(quoteRequest, envelope);
    expect(result.outcome).toBe('FULL_PRICE_ONLY');
    expect(result.alternatives).toEqual([
      { paymentIntent: 'PAY_FULL_PRICE', requiresExplicitUserConfirmation: true },
    ]);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    const requestUrl =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url?.url;
    expect(requestUrl).toBe(
      `https://subscription-runtime.example.test${MANAGED_SUBSCRIPTION_RUNTIME_V1_QUOTE_PATH}`,
    );
    expect(init?.headers).toMatchObject({
      'X-Subscription-Actor-Delegation': envelope.actorDelegation,
      'X-Correlation-ID': envelope.correlationId,
      'Idempotency-Key': envelope.idempotencyKey,
      'X-Subscriptions-Integration-Token': 'test-integration-token-20260824-safe',
      'X-Subscription-Runtime-Contract-Version': '1',
    });
    expect(init?.redirect).toBe('error');
    expect(typeof init?.body).toBe('string');
    const requestBody = typeof init?.body === 'string' ? init.body : '';
    expect(JSON.parse(requestBody)).toEqual(quoteRequest);
    expect(requestBody).not.toContain(envelope.actorDelegation);
    expect(init?.headers).not.toHaveProperty('Authorization');
    expect(init?.headers).not.toHaveProperty('X-Tenant-ID');
    expect(init?.headers).not.toHaveProperty('X-Actor-Ref-Hash');
  });

  it('rejects unsanitized input before fetch', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      client(fetchImplementation).quote(
        { ...quoteRequest, target: { ...quoteRequest.target, id: 'bad id' } },
        envelope,
      ),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID' });
    await expect(
      client(fetchImplementation).quote(quoteRequest, {
        ...envelope,
        actorDelegation: 'not-a-jwt',
      }),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_SERVER_ENVELOPE_INVALID' });
    await expect(
      client(fetchImplementation).quote(
        { ...quoteRequest, target: { ...quoteRequest.target, expectedRevision: 0 } },
        envelope,
      ),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID' });
    await expect(
      client(fetchImplementation).quote(
        { ...quoteRequest, target: { ...quoteRequest.target, kind: 'TOURNAMENT' } },
        envelope,
      ),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID' });
    await expect(
      client(fetchImplementation).quote({ ...quoteRequest, ignored: true } as never, envelope),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('preserves only the upstream status while discarding the remote error body', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ secret: 'must-not-cross-the-boundary' }), { status: 409 }),
      );

    await expect(client(fetchImplementation).quote(quoteRequest, envelope)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_RUNTIME_REQUEST_FAILED',
      status: 409,
    });
  });

  it('accepts an explicit full-price decision without subscription blockers', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...fullPriceOnly,
          paymentIntent: 'PAY_FULL_PRICE',
          blockers: [],
          alternatives: [],
        }),
        { status: 200 },
      ),
    );
    await expect(
      client(fetchImplementation).quote(
        { ...quoteRequest, paymentIntent: 'PAY_FULL_PRICE' },
        envelope,
      ),
    ).resolves.toMatchObject({ outcome: 'FULL_PRICE_ONLY', blockers: [], alternatives: [] });
  });

  it('accepts fail-closed retry reasons emitted by the ph-admin v1 boundary', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...fullPriceOnly,
          outcome: 'RETRY_LATER',
          paymentIntent: 'AUTO_BEST_PRICE',
          serviceAllowed: false,
          price: null,
          blockers: [{ code: 'PROVIDER_IDENTITY_UNAVAILABLE' }],
          alternatives: [],
        }),
        { status: 200 },
      ),
    );
    await expect(
      client(fetchImplementation).quote(
        { ...quoteRequest, paymentIntent: 'AUTO_BEST_PRICE' },
        envelope,
      ),
    ).resolves.toMatchObject({
      outcome: 'RETRY_LATER',
      blockers: [{ code: 'PROVIDER_IDENTITY_UNAVAILABLE' }],
    });
  });

  it('accepts the canonical service-unavailable blocker emitted by ph-admin', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...fullPriceOnly,
          outcome: 'SERVICE_BLOCKED',
          paymentIntent: 'AUTO_BEST_PRICE',
          serviceAllowed: false,
          price: null,
          blockers: [{ code: 'SERVICE_UNAVAILABLE' }],
          alternatives: [],
        }),
        { status: 200 },
      ),
    );
    await expect(
      client(fetchImplementation).quote(
        { ...quoteRequest, paymentIntent: 'AUTO_BEST_PRICE' },
        envelope,
      ),
    ).resolves.toMatchObject({
      outcome: 'SERVICE_BLOCKED',
      blockers: [{ code: 'SERVICE_UNAVAILABLE' }],
    });
  });

  it.each([
    [
      'unknown response shape',
      new Response(JSON.stringify({ ...fullPriceOnly, unknown: true }), { status: 200 }),
      'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    ],
    [
      'unknown outcome',
      new Response(JSON.stringify({ ...fullPriceOnly, outcome: 'UNKNOWN' }), { status: 200 }),
      'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    ],
    [
      'price arithmetic',
      new Response(
        JSON.stringify({ ...fullPriceOnly, price: { ...fullPriceOnly.price, finalPriceMinor: 1 } }),
        { status: 200 },
      ),
      'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    ],
    [
      'duplicate reasons',
      new Response(
        JSON.stringify({
          ...fullPriceOnly,
          blockers: [...fullPriceOnly.blockers, ...fullPriceOnly.blockers],
        }),
        { status: 200 },
      ),
      'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    ],
    [
      'multiple alternatives',
      new Response(
        JSON.stringify({
          ...fullPriceOnly,
          alternatives: [...fullPriceOnly.alternatives, ...fullPriceOnly.alternatives],
        }),
        { status: 200 },
      ),
      'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    ],
    [
      'bad outcome flags',
      new Response(JSON.stringify({ ...fullPriceOnly, outcome: 'ENTITLEMENT_APPLIED' }), {
        status: 200,
      }),
      'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    ],
    ['HTTP status', new Response('{}', { status: 503 }), 'SUBSCRIPTION_RUNTIME_REQUEST_FAILED'],
  ])('fails closed for %s', async (_name, response, code) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(client(fetchImplementation).quote(quoteRequest, envelope)).rejects.toMatchObject({
      code,
    });
  });

  it('maps an aborted request to the stable timeout error', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    await expect(
      client(fetchImplementation, { timeoutMs: 100 }).quote(quoteRequest, envelope),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_RUNTIME_TIMEOUT' });
  });

  it('does not expose implementation errors as contract errors', () => {
    const error = new ManagedSubscriptionRuntimeQuoteClientError('SUBSCRIPTION_RUNTIME_DISABLED');
    expect(error.message).toBe('SUBSCRIPTION_RUNTIME_DISABLED');
  });

  it('does not include a service token in configuration errors', async () => {
    const token = 'private-test-token';
    await expect(
      client(vi.fn<typeof fetch>(), {
        baseUrl: 'http://example.test',
        integrationToken: token,
      }).quote(quoteRequest, envelope),
    ).rejects.not.toThrow(token);
  });

  it('does not include a forwarded user authorization token in errors', async () => {
    const authorization = 'Bearer user-token-not-for-errors';
    await expect(
      client(vi.fn<typeof fetch>()).quote(quoteRequest, {
        ...envelope,
        actorDelegation: 'invalid',
      }),
    ).rejects.not.toThrow(authorization);
  });
});
