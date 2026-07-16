import { describe, expect, it, vi } from 'vitest';

import {
  PadlHubApiClient,
  type ApiClientOptions,
  type AuthenticatedSession,
  type UserContext,
} from './index.js';

const authenticatedSession: AuthenticatedSession = {
  accessToken: 'padlhub-access-token-that-is-long-enough',
  tokenType: 'Bearer',
  expiresAt: '2026-07-11T13:00:00.000Z',
  user: {
    id: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    displayName: 'Алексей',
    firstName: 'Алексей',
  },
  context: {
    tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
    userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
    displayName: 'Алексей',
    phoneLast4: '4567',
    roles: ['client'],
    permissions: ['profile.read'],
  },
};

const userContext: UserContext = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  userId: authenticatedSession.user.id,
  displayName: authenticatedSession.user.displayName,
  phoneLast4: '4567',
  roles: ['client'],
  permissions: ['profile.read'],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': 'server-correlation-1' },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function stringRequestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a string request body');
  return body;
}

function createClient(
  fetchImplementation: typeof fetch,
  overrides: Partial<ApiClientOptions> = {},
): PadlHubApiClient {
  return new PadlHubApiClient({
    baseUrl: 'https://api.padlhub.test/',
    tenantKey: 'local-padel',
    platform: 'web',
    appVersion: '1.2.3',
    fetchImplementation,
    ...overrides,
  });
}

describe('PadlHubApiClient authentication boundary', () => {
  it('creates a public challenge without forwarding a stored token', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        jsonResponse(
          {
            challengeId: 'ac378ca8-b329-4dc1-bb72-da797db725c3',
            expiresAt: '2026-07-11T12:05:00.000Z',
            resendAfterSeconds: 60,
          },
          202,
        ),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'stale-or-external-token',
    });

    const challenge = await client.createAuthChallenge({
      method: 'phone_otp',
      phone: '+79991234567',
    });

    expect(challenge.resendAfterSeconds).toBe(60);
    expect(calls).toHaveLength(1);
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/auth/challenges',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('include');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-App-Platform')).toBe('web');
    expect(headers.get('X-App-Version')).toBe('1.2.3');
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9-]{16,}$/);
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual({
      method: 'phone_otp',
      phone: '+79991234567',
    });
  });

  it('creates valid operation keys when an embedded browser omits Web Crypto and Headers', async () => {
    let observedHeaders: HeadersInit | undefined;
    const fetchImplementation: typeof fetch = (_input, init) => {
      observedHeaders = init?.headers;
      return Promise.resolve(
        jsonResponse(
          {
            challengeId: 'ac378ca8-b329-4dc1-bb72-da797db725c3',
            expiresAt: '2026-07-11T12:05:00.000Z',
            resendAfterSeconds: 60,
          },
          202,
        ),
      );
    };
    const originalCrypto = globalThis.crypto;
    const originalHeaders = globalThis.Headers;
    vi.stubGlobal('crypto', undefined);
    vi.stubGlobal('Headers', undefined);

    try {
      await createClient(fetchImplementation).createAuthChallenge({
        method: 'phone_otp',
        phone: '+79991234567',
      });
    } finally {
      vi.stubGlobal('crypto', originalCrypto);
      vi.stubGlobal('Headers', originalHeaders);
    }

    const headers = new Headers(observedHeaders);
    expect(headers.get('X-Correlation-ID')).toMatch(/^phub-[A-Za-z0-9-]{16,}$/);
    expect(headers.get('Idempotency-Key')).toMatch(/^phub-[A-Za-z0-9-]{16,}$/);
  });

  it('calls native fetch with the global receiver required by embedded browsers', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    vi.stubGlobal('fetch', function (this: unknown): Promise<Response> {
      if (this !== globalThis) throw new Error('Native fetch lost its global receiver');
      called = true;
      return Promise.resolve(
        jsonResponse(
          {
            challengeId: 'ac378ca8-b329-4dc1-bb72-da797db725c3',
            expiresAt: '2026-07-11T12:05:00.000Z',
            resendAfterSeconds: 60,
          },
          202,
        ),
      );
    });

    try {
      await new PadlHubApiClient({
        baseUrl: 'https://api.padlhub.test',
        tenantKey: 'local-padel',
        platform: 'web',
        appVersion: '1.2.3',
      }).createAuthChallenge({ method: 'phone_otp', phone: '+79991234567' });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }

    expect(called).toBe(true);
  });

  it('stores only the returned PadlHub access token in memory after verification', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        requestUrl(input).endsWith('/context')
          ? jsonResponse(userContext)
          : jsonResponse(authenticatedSession),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'token-that-must-not-reach-verification',
    });

    const session = await client.verifyAuthChallenge('ac378ca8-b329-4dc1-bb72-da797db725c3', {
      code: '1234',
    });
    const context = await client.getUserContext();

    expect(session.user.displayName).toBe('Алексей');
    expect(context.phoneLast4).toBe('4567');
    expect(client.getAccessToken()).toBe(authenticatedSession.accessToken);
    const verifyHeaders = new Headers(calls[0]?.init?.headers);
    expect(verifyHeaders.get('Authorization')).toBeNull();
    expect(verifyHeaders.get('Idempotency-Key')).toBeTruthy();
    expect(calls[0]?.init?.credentials).toBe('include');
    const contextHeaders = new Headers(calls[1]?.init?.headers);
    expect(contextHeaders.get('Authorization')).toBe(`Bearer ${authenticatedSession.accessToken}`);
  });

  it('uses one cookie refresh for concurrent protected requests and retries both', async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    let contextCalls = 0;
    const observedRefreshHeaders: Headers[] = [];

    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith('/auth/session/refresh')) {
        refreshCalls += 1;
        observedRefreshHeaders.push(headers);
        await refreshGate;
        return jsonResponse(authenticatedSession);
      }
      if (url.endsWith('/context')) {
        contextCalls += 1;
        if (headers.get('Authorization') === 'Bearer expired-access-token') {
          return jsonResponse(
            {
              code: 'AUTH_TOKEN_INVALID',
              message: 'Сессия недействительна.',
              correlationId: 'server-correlation-1',
            },
            401,
          );
        }
        return jsonResponse(userContext);
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'expired-access-token',
    });

    const first = client.getUserContext();
    const second = client.getUserContext();
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    releaseRefresh?.();

    await expect(Promise.all([first, second])).resolves.toEqual([userContext, userContext]);
    expect(refreshCalls).toBe(1);
    expect(contextCalls).toBe(4);
    expect(observedRefreshHeaders[0]?.get('Authorization')).toBeNull();
    expect(observedRefreshHeaders[0]?.get('X-Session-Intent')).toBe('refresh');
    expect(client.getAccessToken()).toBe(authenticatedSession.accessToken);
  });

  it('retries a recent cross-tab refresh race with the same idempotency key', async () => {
    const observedKeys: string[] = [];
    let calls = 0;
    const fetchImplementation: typeof fetch = (_input, init) => {
      calls += 1;
      observedKeys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
      if (calls === 1) {
        return Promise.resolve(
          jsonResponse(
            {
              code: 'AUTH_REFRESH_RACE',
              message: 'Сессия обновляется в другой вкладке.',
              correlationId: 'refresh-race-1',
            },
            409,
          ),
        );
      }
      return Promise.resolve(jsonResponse(authenticatedSession));
    };
    const client = createClient(fetchImplementation);

    await expect(client.refreshSession()).resolves.toEqual(authenticatedSession);
    expect(observedKeys).toHaveLength(2);
    expect(observedKeys[0]).toBeTruthy();
    expect(observedKeys[1]).toBe(observedKeys[0]);
  });

  it('revokes the cookie session without an Authorization header and clears memory', async () => {
    let observedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = (_input, init) => {
      observedInit = init;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.revokeSession();

    expect(observedInit?.method).toBe('DELETE');
    expect(observedInit?.credentials).toBe('include');
    const headers = new Headers(observedInit?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Session-Intent')).toBe('logout');
    expect(headers.get('Idempotency-Key')).toBeTruthy();
    expect(client.getAccessToken()).toBeUndefined();
  });

  it('keeps the in-memory access token when logout does not reach the server', async () => {
    const fetchImplementation: typeof fetch = () => Promise.reject(new TypeError('offline'));
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await expect(client.revokeSession()).rejects.toThrow('offline');
    expect(client.getAccessToken()).toBe(authenticatedSession.accessToken);
  });

  it('does not try to refresh a rejected public authentication request', async () => {
    let calls = 0;
    const fetchImplementation: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        jsonResponse(
          {
            code: 'AUTH_RATE_LIMITED',
            message: 'Слишком много попыток.',
            correlationId: 'auth-correlation-1',
          },
          429,
        ),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const request = client.createAuthChallenge({ method: 'phone_otp', phone: '+79991234567' });

    await expect(request).rejects.toMatchObject({
      status: 429,
      code: 'AUTH_RATE_LIMITED',
      correlationId: 'auth-correlation-1',
    });
    expect(calls).toBe(1);
  });
});

describe('PadlHubApiClient notification boundary', () => {
  it('uses the canonical inbox query and an idempotent read-cursor command', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        requestUrl(input).includes('/read-cursor')
          ? jsonResponse({
              outcome: 'updated',
              readThrough: {
                id: '11111111-1111-4111-8111-111111111111',
                createdAt: '2026-07-16T12:00:00.000Z',
              },
              changedCount: 1,
              replayed: false,
            })
          : jsonResponse({ items: [], unreadCount: 0 }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.listNotifications({ limit: 25, unreadOnly: true, cursor: 'opaque-cursor' });
    await client.markNotificationsRead('11111111-1111-4111-8111-111111111111');

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/notifications?limit=25&unreadOnly=true&cursor=opaque-cursor',
    );
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/notifications/read-cursor',
    );
    const headers = new Headers(calls[1]?.init?.headers);
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9-]{16,}$/);
    expect(JSON.parse(stringRequestBody(calls[1]?.init?.body))).toEqual({
      throughId: '11111111-1111-4111-8111-111111111111',
    });
  });
});
