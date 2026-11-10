/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_SUBSCRIPTIONS_MAX_PAGES,
  CLIENT_SUBSCRIPTIONS_PAGE_SIZE,
  VivaClientSubscriptionMappingError,
  VivaClientSubscriptionMappingSource,
  type VivaClientSubscriptionMappingSourceOptions,
} from './client-subscription-mapping-source.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_CLIENT = '99999999-9999-4999-8999-999999999999';
const SUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function row(subscriptionId: string, status = 'ACTIVE', extra: Record<string, unknown> = {}) {
  return {
    subscriptionId,
    clientId: CLIENT,
    status,
    product: { id: 'db7a5250-7369-4f43-8ac5-9111be24bc74', name: 'redacted' },
    visitsLeft: 3,
    ...extra,
  };
}

function viva(pages: readonly unknown[]) {
  const calls: string[] = [];
  const headers: Headers[] = [];
  const fetchImplementation = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${target.pathname}${target.search}`);
    headers.push(new Headers(init?.headers));
    const page = Number(target.searchParams.get('page'));
    const body = pages[Math.min(page, pages.length - 1)];
    return typeof body === 'function' ? (body as () => Response)() : json(body);
  });
  return { calls, headers, fetchImplementation: fetchImplementation as unknown as typeof fetch };
}

function source(
  fetchImplementation: typeof fetch,
  overrides: Partial<VivaClientSubscriptionMappingSourceOptions> = {},
): VivaClientSubscriptionMappingSource {
  return new VivaClientSubscriptionMappingSource({
    mode: 'production',
    apiBaseUrl: 'https://viva.example.test',
    apiKey: 'synthetic-admin-key',
    timeoutMs: 1_000,
    fetchImplementation,
    sleep: async () => undefined,
    now: () => Date.parse('2026-11-09T10:00:00.000Z'),
    ...overrides,
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VivaClientSubscriptionMappingError) return error.code;
    throw error;
  }
  return 'resolved';
}

const read = (s: VivaClientSubscriptionMappingSource, providerClientId = CLIENT) =>
  s.read({ providerClientId, correlationId: 'corr-1' });

describe('VivaClientSubscriptionMappingSource', () => {
  it('reads the Admin subscriptions method with the server key and maps usable instances only', async () => {
    const double = viva([
      {
        content: [
          row(SUB_A),
          row(SUB_B, 'HOLD'),
          row(SUB_C, 'EXPIRED'),
          row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'NEW'),
          row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'REFUNDED'),
          row('ffffffff-ffff-4fff-8fff-ffffffffffff', 'NO_VISITS'),
        ],
        totalElements: 6,
        totalPages: 1,
        number: 0,
        last: true,
      },
    ]);
    await expect(read(source(double.fetchImplementation))).resolves.toEqual({
      providerSubscriptionIds: [SUB_A, SUB_B, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      observedAt: '2026-11-09T10:00:00.000Z',
    });
    expect(double.calls).toEqual([
      `GET /api/v1/clients/${CLIENT}/subscriptions?includeFinished=true&page=0&size=200`,
    ]);
    expect(double.calls.some((call) => call.includes('/end-user/'))).toBe(false);
    expect(double.headers[0]!.get('authorization')).toBe('Bearer synthetic-admin-key');
    expect(double.headers[0]!.get('x-correlation-id')).toBe('corr-1');
  });

  it('keeps provider ids exactly as returned', async () => {
    const upper = SUB_A.toUpperCase();
    const double = viva([{ content: [row(upper)], last: true }]);
    await expect(read(source(double.fetchImplementation))).resolves.toMatchObject({
      providerSubscriptionIds: [upper],
    });
  });

  it('returns an empty list only for a complete empty answer', async () => {
    const double = viva([{ content: [], totalElements: 0, totalPages: 0, last: true }]);
    await expect(read(source(double.fetchImplementation))).resolves.toMatchObject({
      providerSubscriptionIds: [],
    });
  });

  it('follows pages and checks the total', async () => {
    const full = Array.from({ length: CLIENT_SUBSCRIPTIONS_PAGE_SIZE }, (_, index) =>
      row(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`),
    );
    const double = viva([
      { content: full, totalElements: 201, totalPages: 2, number: 0, last: false },
      { content: [row(SUB_B)], totalElements: 201, totalPages: 2, number: 1, last: true },
    ]);
    const result = await read(source(double.fetchImplementation));
    expect(result.providerSubscriptionIds).toHaveLength(201);
    expect(double.calls).toHaveLength(2);
  });

  it('refuses a partial read instead of returning fewer instances', async () => {
    const short = viva([{ content: [row(SUB_A)], totalElements: 2, totalPages: 1, last: true }]);
    expect(await code(read(source(short.fetchImplementation)))).toBe(
      'CLIENT_SUBSCRIPTIONS_PARTIAL',
    );
    const endless = viva([
      {
        content: Array.from({ length: CLIENT_SUBSCRIPTIONS_PAGE_SIZE }, (_, index) =>
          row(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`),
        ),
        last: false,
      },
    ]);
    // Same page body every time -> duplicates are detected before the page budget runs out.
    expect(await code(read(source(endless.fetchImplementation)))).toBe(
      'CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID',
    );
    let page = 0;
    const unbounded = vi.fn(async () =>
      json({
        content: Array.from({ length: CLIENT_SUBSCRIPTIONS_PAGE_SIZE }, (_, index) =>
          row(`aaaaaaaa-aaaa-4aaa-8aaa-${String(page * 1000 + index).padStart(12, '0')}`),
        ),
        number: page++,
        last: false,
      }),
    ) as unknown as typeof fetch;
    expect(await code(read(source(unbounded)))).toBe('CLIENT_SUBSCRIPTIONS_PARTIAL');
    expect(page).toBe(CLIENT_SUBSCRIPTIONS_MAX_PAGES);
  });

  it('refuses the whole read when any instance names another client', async () => {
    for (const foreign of [
      row(SUB_B, 'ACTIVE', { clientId: OTHER_CLIENT }),
      row(SUB_B, 'EXPIRED', { clientId: undefined, client: { id: OTHER_CLIENT } }),
    ]) {
      const double = viva([{ content: [row(SUB_A), foreign], last: true }]);
      expect(await code(read(source(double.fetchImplementation)))).toBe(
        'CLIENT_SUBSCRIPTIONS_OWNERSHIP_CONFLICT',
      );
    }
  });

  it('accepts the owner alias in another case', async () => {
    const double = viva([
      { content: [row(SUB_A, 'ACTIVE', { clientId: CLIENT.toUpperCase() })], last: true },
    ]);
    await expect(read(source(double.fetchImplementation))).resolves.toMatchObject({
      providerSubscriptionIds: [SUB_A],
    });
  });

  it('skips an instance with an unknown status without refusing the read', async () => {
    const double = viva([
      { content: [row(SUB_A, 'SOMETHING_NEW'), row(SUB_B)], last: true, totalElements: 2 },
    ]);
    await expect(read(source(double.fetchImplementation))).resolves.toMatchObject({
      providerSubscriptionIds: [SUB_B],
    });
  });

  it.each([
    ['malformed id', [row('not-a-uuid-value')]],
    ['duplicate instance', [row(SUB_A), row(SUB_A.toUpperCase())]],
    ['alias mismatch', [row(SUB_A, 'ACTIVE', { clientSubscriptionId: SUB_B })]],
    ['malformed owner', [row(SUB_A, 'ACTIVE', { clientId: 'client-1' })]],
  ])('refuses a response with a %s', async (_name, content) => {
    const double = viva([{ content, last: true }]);
    expect(await code(read(source(double.fetchImplementation)))).toBe(
      'CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID',
    );
  });

  it('refuses a body that is not the page contract', async () => {
    const double = viva([() => new Response('<html>', { status: 200 })]);
    expect(await code(read(source(double.fetchImplementation)))).toBe(
      'CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID',
    );
    const wrongPage = viva([{ content: [row(SUB_A)], number: 3, last: true }]);
    expect(await code(read(source(wrongPage.fetchImplementation)))).toBe(
      'CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID',
    );
  });

  it('retries 429 once honouring a capped Retry-After, and never retries 401/403', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const throttled = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? json({}, 429, { 'Retry-After': '30' })
        : json({ content: [row(SUB_A)], last: true });
    }) as unknown as typeof fetch;
    await expect(
      read(source(throttled, { sleep: async (ms) => void sleeps.push(ms) })),
    ).resolves.toMatchObject({ providerSubscriptionIds: [SUB_A] });
    expect(sleeps).toEqual([1_000]);

    for (const status of [401, 403, 404]) {
      const calls = vi.fn(async () => json({}, status)) as unknown as typeof fetch;
      expect(await code(read(source(calls)))).toBe('CLIENT_SUBSCRIPTIONS_UNAVAILABLE');
      expect(calls).toHaveBeenCalledTimes(1);
    }
  });

  it('reports a timeout and opens the circuit after repeated failures', async () => {
    let clock = 0;
    const hanging = vi.fn(
      async (_url: URL | string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    const s = source(hanging, {
      timeoutMs: 5,
      maxAttempts: 1,
      circuitFailureThreshold: 2,
      circuitResetMs: 60_000,
      now: () => clock,
    });
    expect(await code(read(s))).toBe('CLIENT_SUBSCRIPTIONS_TIMEOUT');
    expect(await code(read(s))).toBe('CLIENT_SUBSCRIPTIONS_TIMEOUT');
    expect(await code(read(s))).toBe('CLIENT_SUBSCRIPTIONS_CIRCUIT_OPEN');
    expect(hanging).toHaveBeenCalledTimes(2);
    clock = 60_000;
    expect(await code(read(s))).toBe('CLIENT_SUBSCRIPTIONS_TIMEOUT');
  });

  it('does not open the circuit for one client that Viva does not know or answers malformed', async () => {
    const missing = vi.fn(async () => json({}, 404)) as unknown as typeof fetch;
    const s = source(missing, { circuitFailureThreshold: 2 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await code(read(s))).toBe('CLIENT_SUBSCRIPTIONS_UNAVAILABLE');
    }
    expect(missing).toHaveBeenCalledTimes(4);

    const malformed = vi.fn(async () => json({ rows: [] })) as unknown as typeof fetch;
    const m = source(malformed, { circuitFailureThreshold: 2 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await code(read(m))).toBe('CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID');
    }
    expect(malformed).toHaveBeenCalledTimes(4);

    const rejectedKey = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;
    const k = source(rejectedKey, { circuitFailureThreshold: 2 });
    await code(read(k));
    await code(read(k));
    expect(await code(read(k))).toBe('CLIENT_SUBSCRIPTIONS_CIRCUIT_OPEN');
  });

  it('never calls Viva outside sandbox/production or for a malformed client id', async () => {
    const double = viva([{ content: [], last: true }]);
    for (const mode of ['mock', 'disabled'] as const) {
      expect(await code(read(source(double.fetchImplementation, { mode })))).toBe(
        'CLIENT_SUBSCRIPTIONS_DISABLED',
      );
    }
    expect(await code(read(source(double.fetchImplementation), 'client/../x'))).toBe(
      'CLIENT_SUBSCRIPTIONS_CLIENT_ID_INVALID',
    );
    expect(double.calls).toEqual([]);
  });

  it('rejects unsafe configuration', () => {
    const fetchImplementation = viva([]).fetchImplementation;
    expect(() => source(fetchImplementation, { apiKey: '' })).toThrow(
      'VIVA_CLIENT_SUBSCRIPTIONS_CREDENTIALS_REQUIRED',
    );
    for (const apiBaseUrl of [
      'http://viva.example.test',
      'https://viva.example.test/end-user/api',
      'https://user:pass@viva.example.test',
    ]) {
      expect(() => source(fetchImplementation, { apiBaseUrl })).toThrow(
        'VIVA_CLIENT_SUBSCRIPTIONS_BASE_URL_INVALID',
      );
    }
    expect(() => source(fetchImplementation, { maxAttempts: 4 })).toThrow();
  });

  it('emits metrics without provider identifiers', async () => {
    const metrics: unknown[] = [];
    const double = viva([{ content: [row(SUB_A)], last: true }]);
    await read(source(double.fetchImplementation, { onMetric: (metric) => metrics.push(metric) }));
    expect(JSON.stringify(metrics)).not.toContain(CLIENT);
    expect(JSON.stringify(metrics)).not.toContain(SUB_A);
    expect(metrics).toEqual([
      expect.objectContaining({ operation: 'client_subscriptions', outcome: 'success' }),
    ]);
  });
});
