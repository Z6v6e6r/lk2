/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import {
  VivaResidencySourceAdapter,
  VivaResidencySourceError,
  type VivaResidencySourceOptions,
} from './residency-source.js';

const NOW = Date.parse('2026-11-05T09:00:00.000Z');
const PRODUCT_ID = '0f2a7c4e-1b3d-4e5f-8a90-123456789abc';
const OTHER_PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const INSTANCE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function adapter(overrides: Partial<VivaResidencySourceOptions> = {}): VivaResidencySourceAdapter {
  return new VivaResidencySourceAdapter({
    mode: 'production',
    apiBaseUrl: 'https://viva.example.test',
    apiKey: 'server-only-key',
    productId: PRODUCT_ID,
    timeoutMs: 500,
    maxAttempts: 2,
    retryBaseDelayMs: 1,
    circuitFailureThreshold: 5,
    circuitResetMs: 30_000,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    ...overrides,
  });
}

function requestUrl(input: URL | RequestInfo): URL {
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(
  content: readonly unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    content,
    totalElements: content.length,
    totalPages: 1,
    number: 0,
    last: true,
    ...overrides,
  };
}

function instance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscriptionId: INSTANCE_A,
    clientId: CLIENT_ID,
    productId: PRODUCT_ID,
    product: { id: PRODUCT_ID, name: 'Резидентство' },
    status: 'ACTIVE',
    activationDate: '2026-09-01',
    expirationDate: '2027-09-01',
    ...overrides,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof VivaResidencySourceError ? error.code : 'UNEXPECTED_ERROR';
  }
}

describe('VivaResidencySourceAdapter', () => {
  it('keeps an unconfigured product explicit and never calls Viva', async () => {
    const fetchImplementation = vi.fn();
    const source = adapter({ productId: '', fetchImplementation });
    await expect(
      source.read({ providerClientId: CLIENT_ID, correlationId: 'correlation' }),
    ).rejects.toMatchObject({ code: 'RESIDENCY_PRODUCT_NOT_CONFIGURED' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('never substitutes mock data for a real provider read', async () => {
    for (const mode of ['mock', 'disabled'] as const) {
      const fetchImplementation = vi.fn();
      const source = adapter({ mode, fetchImplementation });
      await expect(
        source.read({ providerClientId: CLIENT_ID, correlationId: 'correlation' }),
      ).rejects.toMatchObject({ code: 'RESIDENCY_SOURCE_DISABLED' });
      expect(fetchImplementation).not.toHaveBeenCalled();
    }
  });

  it('returns ACTIVE only for a valid instance of the exact configured product', async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void requestUrl(input);
      void init;
      return jsonResponse(page([instance()]));
    });
    const source = adapter({ fetchImplementation });
    const observation = await source.read({
      providerClientId: CLIENT_ID,
      correlationId: 'corr-1',
    });
    expect(observation).toEqual({
      active: true,
      validFrom: '2026-09-01',
      validUntil: '2027-09-01',
      checkedAt: new Date(NOW).toISOString(),
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0]!;
    const parsed = requestUrl(url);
    expect(parsed.origin).toBe('https://viva.example.test');
    expect(parsed.pathname).toBe(`/api/v1/clients/${CLIENT_ID}/subscriptions`);
    expect(parsed.searchParams.get('includeFinished')).toBe('true');
    expect(parsed.searchParams.get('page')).toBe('0');
    expect(parsed.searchParams.get('size')).toBe('200');
    expect(init).toMatchObject({
      method: 'GET',
      headers: {
        Authorization: 'Bearer server-only-key',
        'X-Correlation-ID': 'corr-1',
      },
    });
  });

  it('does not treat a same-named subscription of another product as residency', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(
        page([
          instance({
            subscriptionId: INSTANCE_B,
            productId: OTHER_PRODUCT_ID,
            product: { id: OTHER_PRODUCT_ID, name: 'Резидентство' },
            status: 'ACTIVE',
          }),
        ]),
      ),
    );
    const observation = await adapter({ fetchImplementation }).read({
      providerClientId: CLIENT_ID,
      correlationId: 'corr-2',
    });
    expect(observation).toMatchObject({
      active: false,
      validFrom: null,
      validUntil: null,
      checkedAt: new Date(NOW).toISOString(),
    });
  });

  it('does not treat a frozen or held exact-product instance as active residency', async () => {
    for (const frozen of [
      { isFrozen: true },
      { holdUntil: '2026-12-01' },
      { frozenUntil: '2026-12-01' },
    ]) {
      const fetchImplementation = vi.fn(async () => jsonResponse(page([instance(frozen)])));
      const observation = await adapter({ fetchImplementation }).read({
        providerClientId: CLIENT_ID,
        correlationId: 'corr-frozen',
      });
      expect(observation.active).toBe(false);
    }
  });

  it('fails closed on an unrecognized provider status instead of reporting absence', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(page([instance({ status: 'SUSPENDED_UNKNOWN' })])),
    );
    await expect(
      adapter({ fetchImplementation }).read({
        providerClientId: CLIENT_ID,
        correlationId: 'corr-status',
      }),
    ).rejects.toMatchObject({ code: 'RESIDENCY_SOURCE_RESPONSE_INVALID' });
  });

  it('rejects a base URL with a path instead of silently targeting another endpoint', () => {
    expect(() => adapter({ apiBaseUrl: 'https://viva.example.test/api' })).toThrow(
      'VIVA_RESIDENCY_SOURCE_BASE_URL_INVALID',
    );
  });

  it('reports NONE with the last validity of an expired exact-product instance', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(
        page([
          instance({
            status: 'EXPIRED',
            activationDate: '2025-09-01',
            expirationDate: '2026-09-01',
          }),
        ]),
      ),
    );
    const observation = await adapter({ fetchImplementation }).read({
      providerClientId: CLIENT_ID,
      correlationId: 'corr-3',
    });
    expect(observation).toMatchObject({
      active: false,
      validFrom: '2025-09-01',
      validUntil: '2026-09-01',
    });
  });

  it('does not prove absence when any provider row lacks product identity', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(
        page([instance({ subscriptionId: INSTANCE_A, productId: undefined, product: undefined })]),
      ),
    );
    await expect(
      adapter({ fetchImplementation }).read({
        providerClientId: CLIENT_ID,
        correlationId: 'corr-4',
      }),
    ).rejects.toMatchObject({ code: 'RESIDENCY_PRODUCT_IDENTITY_MISSING' });
  });

  it('reads every page declared by provider pagination metadata', async () => {
    const fetchImplementation = vi
      .fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        void requestUrl(input);
        void init;
        return jsonResponse(page([]));
      })
      .mockResolvedValueOnce(
        jsonResponse(
          page([instance({ subscriptionId: INSTANCE_A })], {
            totalElements: 2,
            totalPages: 2,
            number: 0,
            last: false,
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          page([instance({ subscriptionId: INSTANCE_B })], {
            totalElements: 2,
            totalPages: 2,
            number: 1,
            last: true,
          }),
        ),
      );
    const observation = await adapter({ fetchImplementation }).read({
      providerClientId: CLIENT_ID,
      correlationId: 'corr-5',
    });
    expect(observation.active).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchImplementation.mock.calls[1]![0]).searchParams.get('page')).toBe('1');
  });

  it('returns PARTIAL instead of NONE when bounded pagination cannot prove completeness', async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const requestedPage = Number(requestUrl(input).searchParams.get('page'));
      const subscriptionId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(requestedPage).padStart(12, '0')}`;
      return jsonResponse(
        page([instance({ subscriptionId })], {
          totalElements: 10_000,
          totalPages: 11,
          number: requestedPage,
          last: false,
        }),
      );
    });
    await expect(
      adapter({ fetchImplementation }).read({
        providerClientId: CLIENT_ID,
        correlationId: 'corr-6',
      }),
    ).rejects.toMatchObject({ code: 'RESIDENCY_SOURCE_PARTIAL' });
  });

  it('rejects a totalElements count that contradicts the received rows', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(page([instance()], { totalElements: 2, totalPages: 1, last: true })),
    );
    await expect(
      adapter({ fetchImplementation }).read({
        providerClientId: CLIENT_ID,
        correlationId: 'corr-7',
      }),
    ).rejects.toMatchObject({ code: 'RESIDENCY_SOURCE_PARTIAL' });
  });

  it('rejects provider rows owned by another client', async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(page([instance({ clientId: OTHER_PRODUCT_ID })])),
    );
    expect(
      await errorCode(
        adapter({ fetchImplementation }).read({
          providerClientId: CLIENT_ID,
          correlationId: 'corr-8',
        }),
      ),
    ).toBe('RESIDENCY_OWNERSHIP_CONFLICT');
  });

  it('treats inconsistent owner aliases and instance aliases as invalid', async () => {
    const mismatchedClient = vi.fn(async () =>
      jsonResponse(page([instance({ client: { id: OTHER_PRODUCT_ID } })])),
    );
    expect(
      await errorCode(
        adapter({ fetchImplementation: mismatchedClient }).read({
          providerClientId: CLIENT_ID,
          correlationId: 'corr-9',
        }),
      ),
    ).toBe('RESIDENCY_OWNERSHIP_CONFLICT');

    const mismatchedInstance = vi.fn(async () =>
      jsonResponse(page([instance({ clientSubscriptionId: INSTANCE_B })])),
    );
    expect(
      await errorCode(
        adapter({ fetchImplementation: mismatchedInstance }).read({
          providerClientId: CLIENT_ID,
          correlationId: 'corr-10',
        }),
      ),
    ).toBe('RESIDENCY_SOURCE_RESPONSE_INVALID');
  });

  it('keeps concurrent reads isolated to their own resolved client', async () => {
    const otherClient = '77777777-7777-4777-8777-777777777777';
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const clientId = requestUrl(input).pathname.split('/')[4];
      return jsonResponse(page([instance({ clientId })]));
    });
    const source = adapter({ fetchImplementation });
    const [first, second] = await Promise.all([
      source.read({ providerClientId: CLIENT_ID, correlationId: 'corr-concurrent-a' }),
      source.read({ providerClientId: otherClient, correlationId: 'corr-concurrent-b' }),
    ]);
    expect(first.active).toBe(true);
    expect(second.active).toBe(true);
  });

  it('maps provider HTTP failures and invalid payloads to explicit source errors', async () => {
    const unavailable = vi.fn(async () => jsonResponse({}, 503));
    expect(
      await errorCode(
        adapter({ fetchImplementation: unavailable }).read({
          providerClientId: CLIENT_ID,
          correlationId: 'corr-11',
        }),
      ),
    ).toBe('RESIDENCY_SOURCE_UNAVAILABLE');
    expect(unavailable).toHaveBeenCalledTimes(2);

    const invalid = vi.fn(async () => jsonResponse({ unexpected: true }, 200));
    expect(
      await errorCode(
        adapter({ fetchImplementation: invalid }).read({
          providerClientId: CLIENT_ID,
          correlationId: 'corr-12',
        }),
      ),
    ).toBe('RESIDENCY_SOURCE_RESPONSE_INVALID');

    const malformedJson = vi.fn(async () => new Response('not-json', { status: 200 }));
    expect(
      await errorCode(
        adapter({ fetchImplementation: malformedJson }).read({
          providerClientId: CLIENT_ID,
          correlationId: 'corr-12b',
        }),
      ),
    ).toBe('RESIDENCY_SOURCE_RESPONSE_INVALID');
  });

  it('maps an abort to a timeout and opens the breaker after repeated failure', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timedOut = adapter({
      fetchImplementation: vi.fn(async () => {
        throw abort;
      }),
      maxAttempts: 1,
    });
    expect(
      await errorCode(timedOut.read({ providerClientId: CLIENT_ID, correlationId: 'corr-13' })),
    ).toBe('RESIDENCY_SOURCE_TIMEOUT');

    const failingFetch = vi.fn(async () => jsonResponse({}, 503));
    const circuit = adapter({
      fetchImplementation: failingFetch,
      maxAttempts: 1,
      circuitFailureThreshold: 1,
    });
    expect(
      await errorCode(circuit.read({ providerClientId: CLIENT_ID, correlationId: 'corr-14' })),
    ).toBe('RESIDENCY_SOURCE_UNAVAILABLE');
    expect(
      await errorCode(circuit.read({ providerClientId: CLIENT_ID, correlationId: 'corr-15' })),
    ).toBe('RESIDENCY_CIRCUIT_OPEN');
    expect(failingFetch).toHaveBeenCalledTimes(1);
  });
});
