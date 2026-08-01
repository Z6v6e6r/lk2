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
  it('loads one public tournament summary by PadlHub id and bounded date range', async () => {
    const summary = {
      id: '91a1c7c6-73d0-4270-a400-3358873e4d9b',
      title: 'Субботний турнир',
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(summary));
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'token-that-must-not-reach-the-public-tournament',
    });

    await expect(
      client.getPublicTournamentSummary(summary.id, {
        dateFrom: '2026-08-01',
        dateTo: '2026-08-16',
      }),
    ).resolves.toEqual(summary);

    const [input, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(requestUrl(input ?? '')).toBe(
      `https://api.padlhub.test/public/api/v1/local-padel/tournaments/${summary.id}?dateFrom=2026-08-01&dateTo=2026-08-16`,
    );
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
  });

  it('loads HomeBase without inventing unavailable Viva sections', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        snapshot: {
          version: 'home-base-v1-7',
          generatedAt: '2026-07-15T12:00:00.000Z',
          source: 'LOCAL_PROJECTION',
          completeness: 'PARTIAL',
        },
        viewerUserId: authenticatedSession.user.id,
        quickActions: [],
        communities: { status: 'UNAVAILABLE' },
        promotions: { status: 'UNAVAILABLE' },
        locations: [],
        additionalLinks: [],
        capabilities: {
          canCreateGame: true,
          canManageTournaments: false,
          canViewCommunities: true,
        },
      }),
    );
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const result = await client.getHomeBase();

    expect(result.snapshot.completeness).toBe('PARTIAL');
    expect(result).not.toHaveProperty('profile');
    expect(requestUrl(fetchImplementation.mock.calls[0]?.[0] ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/home/base',
    );
  });

  it('resolves stable relative location media paths against the configured API origin', async () => {
    const fetchImplementation: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Нагатинская',
              city: 'Москва',
              courtCount: 6,
              coverImageUrl:
                '/public/api/v1/local-padel/location-media/22222222-2222-4222-8222-222222222222',
              route: '/locations/11111111-1111-4111-8111-111111111111',
            },
          ],
        }),
      );
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const result = await client.listLocations();

    expect(result.items[0]?.coverImageUrl).toBe(
      'https://api.padlhub.test/public/api/v1/local-padel/location-media/22222222-2222-4222-8222-222222222222',
    );
  });

  it('reads the published gift certificate catalog without forwarding a token', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(jsonResponse({ id: 'catalog-id', designs: [], denominations: [] }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'token-that-must-not-reach-the-public-catalog',
    });

    await client.getPublicGiftCertificateCatalog();

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/public/api/v1/local-padel/gift-certificate-catalog',
    );
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBeNull();
  });

  it('creates a public gift order through the cookie boundary without trusting a client amount', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(jsonResponse({ order: {}, replayed: false }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'token-that-must-not-reach-the-public-sale',
    });
    const request = {
      catalogId: '11111111-1111-4111-8111-111111111111',
      designId: '22222222-2222-4222-8222-222222222222',
      denominationId: '33333333-3333-4333-8333-333333333333',
      buyerEmail: 'buyer@example.test',
      recipientName: 'Мария',
      recipientEmail: 'recipient@example.test',
      message: null,
      deliveryMode: 'IMMEDIATE' as const,
      scheduledFor: null,
      termsAccepted: true as const,
    };

    await client.createPublicGiftCertificateOrder(request);

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/public/api/v1/local-padel/gift-certificate-orders',
    );
    expect(calls[0]?.init?.credentials).toBe('include');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual(request);
    expect(stringRequestBody(calls[0]?.init?.body)).not.toContain('amountMinor');
  });

  it('downloads a private guest certificate through the purchase cookie boundary', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'token-that-must-not-reach-the-public-download',
    });

    const blob = await client.downloadPublicGiftCertificate('44444444-4444-4444-8444-444444444444');

    expect(blob.type).toBe('application/pdf');
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/public/api/v1/local-padel/gift-certificate-orders/44444444-4444-4444-8444-444444444444/certificate.pdf',
    );
    expect(calls[0]?.init?.credentials).toBe('include');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('Accept')).toBe('application/pdf');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('keeps public Games discovery on the anonymous public API boundary', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(jsonResponse({ items: [], nextCursor: null }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: 'token-that-must-not-reach-public-discovery',
    });

    await client.listPublicGames({ kind: 'RATING', availability: 'INCLUDE_FULL', limit: 20 });

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/public/api/v1/local-padel/games?kind=RATING&availability=INCLUDE_FULL&limit=20',
    );
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBeNull();
  });

  it('sends a retry-safe Games join with the projection revision', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        jsonResponse({
          commandId: 'c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
          operation: { status: 'SUCCEEDED' },
          game: null,
          replayed: false,
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.joinGame('751fe6a8-b0b1-4b2b-873d-a2d785c4e191', 9);

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191/join',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual({ expectedRevision: 9 });
  });

  it('reads a Games operation from the authenticated user boundary', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(jsonResponse({ operation: { status: 'SUCCEEDED' } }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.getGameOperation('c3889c99-b0e3-4a3d-b3e8-a5c99af730ea');

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/game-operations/c3889c99-b0e3-4a3d-b3e8-a5c99af730ea',
    );
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
  });

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

describe('PadlHubApiClient profile privacy boundary', () => {
  it('uses one idempotency key when a privacy update is retried after a network failure', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    let attempt = 0;
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      attempt += 1;
      if (attempt === 1) return Promise.reject(new TypeError('temporary network failure'));
      return Promise.resolve(
        jsonResponse({
          contactPolicy: 'AUTHORIZED',
          chatPolicy: 'NOBODY',
          version: 2,
          updatedAt: '2026-07-17T12:00:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.updateProfilePrivacySettings({
      expectedVersion: 1,
      contactPolicy: 'AUTHORIZED',
      chatPolicy: 'NOBODY',
    });

    expect(calls).toHaveLength(2);
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/profile/privacy',
    );
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    const secondHeaders = new Headers(calls[1]?.init?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toBeTruthy();
    expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
  });
});

describe('PadlHubApiClient booking personalization boundary', () => {
  it('loads unified activity history through PadlHub filters only', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        jsonResponse({
          items: [],
          nextCursor: null,
          freshness: 'FRESH',
          coverage: 'COMPLETE',
          generatedAt: '2026-07-21T09:00:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.listActivityHistory({
      kind: 'TRAINING',
      status: 'COMPLETED',
      cursor: 'opaque-history-cursor',
      limit: 20,
    });

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/bookings/history?kind=TRAINING&status=COMPLETED&cursor=opaque-history-cursor&limit=20',
    );
    expect(requestUrl(calls[0]?.input ?? '')).not.toMatch(/viva|provider|phone/i);
  });

  it('uses canonical preference and recommendation routes without provider selectors', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const url = requestUrl(input);
      if (url.includes('/recommendations/bookings')) {
        return Promise.resolve(
          jsonResponse({
            version: 'a'.repeat(64),
            generatedAt: '2026-07-18T09:00:00.000Z',
            staleAt: '2026-07-18T09:05:00.000Z',
            personalization: 'BASIC',
            items: [],
            nextCursor: null,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          favoriteStationIds: [],
          preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
          useHistory: true,
          version: init?.method === 'PUT' ? 1 : 0,
          updatedAt: init?.method === 'PUT' ? '2026-07-18T09:00:00.000Z' : null,
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const loadedPreferences = await client.getBookingPreferences();
    await client.updateBookingPreferences({
      expectedVersion: 0,
      favoriteStationIds: [],
      preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
      useHistory: true,
      recommendFriends: true,
      recommendationDisplay: 'CARDS',
    });
    await client.listBookingRecommendations({ limit: 6, cursor: 'recommendation-cursor' });

    expect(loadedPreferences).toMatchObject({
      recommendFriends: true,
      recommendationDisplay: 'CARDS',
    });
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/profile/booking-preferences',
    );
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/profile/booking-preferences',
    );
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(requestUrl(calls[2]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/recommendations/bookings?limit=6&cursor=recommendation-cursor',
    );
    expect(calls.map((call) => requestUrl(call.input)).join(' ')).not.toMatch(/viva|provider/i);
  });

  it('starts a filtered training catalog job on v1 and continues its snapshot on v2', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      if (requestUrl(input).includes('/booking-screen-read-jobs')) {
        return Promise.resolve(
          jsonResponse({
            jobId: '41000000-0000-4000-8000-000000000001',
            screen: 'EVENT_CATALOG',
            expiresAt: '2026-08-01T09:02:00.000Z',
            commands: [
              {
                commandId: '41000000-0000-4000-8000-000000000002',
                operation: 'schedule.read',
                date: '2026-08-02',
              },
            ],
            concurrency: 1,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          state: 'READY',
          snapshotVersion: 'a'.repeat(64),
          generatedAt: '2026-08-01T09:00:00.000Z',
          staleAt: '2026-08-01T09:10:00.000Z',
          items: [],
          nextCursor: null,
          totalMatched: 0,
          facets: { kinds: [], categories: [], stations: [] },
          sourceStatus: [
            { source: 'SCHEDULE', localDate: '2026-08-02', state: 'READY', errorCode: null },
          ],
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.startEventCatalogReadJob({
      surface: 'TRAININGS',
      localDates: ['2026-08-02'],
      kinds: ['COACH_GAME', 'GROUP_TRAINING', 'SPLIT'],
      stationIds: ['42000000-0000-4000-8000-000000000001'],
      availability: 'EXCLUDE_FULL',
      startsAfterLocal: '18:00',
      limit: 20,
    });
    await client.continueEventCatalog('43000000-0000-4000-8000-000000000001', 20);

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/booking-screen-read-jobs',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual({
      screen: 'EVENT_CATALOG',
      query: {
        surface: 'TRAININGS',
        localDates: ['2026-08-02'],
        kinds: ['COACH_GAME', 'GROUP_TRAINING', 'SPLIT'],
        stationIds: ['42000000-0000-4000-8000-000000000001'],
        availability: 'EXCLUDE_FULL',
        startsAfterLocal: '18:00',
        limit: 20,
      },
    });
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v2/local-padel/event-catalog?cursor=43000000-0000-4000-8000-000000000001&limit=20',
    );
    expect(new Headers(calls[1]?.init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
    expect(
      calls
        .map((call) => `${requestUrl(call.input)} ${stringRequestBody(call.init?.body ?? '')}`)
        .join(' '),
    ).not.toMatch(/viva|provider/i);
  });

  it('records an idempotent promotion event without client identity fields', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(jsonResponse({ accepted: true }, 202));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.recordPromotionEngagement('90000000-0000-4000-8000-000000000002', 'CLICK');

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/promotions/90000000-0000-4000-8000-000000000002/engagements',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual({ kind: 'CLICK' });
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

  it('registers and revokes one Web Push installation through retry-safe commands', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const installationId = '22222222-2222-4222-8222-222222222222';
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const url = requestUrl(input);
      if (url.endsWith('/config')) {
        return Promise.resolve(
          jsonResponse({ enabled: true, publicKey: 'public-vapid-key-value' }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          outcome: 'updated',
          endpointId: '33333333-3333-4333-8333-333333333333',
          installationId,
          status: init?.method === 'DELETE' ? 'REVOKED' : 'ACTIVE',
          replayed: false,
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.getWebPushConfiguration();
    await client.registerWebPushEndpoint({
      installationId,
      subscription: {
        endpoint: 'https://push.example.test/subscription/abc',
        expirationTime: null,
        keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) },
      },
    });
    await client.revokeWebPushEndpoint(installationId);

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/notification-endpoints/web/config',
    );
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/notification-endpoints/web',
    );
    expect(calls[1]?.init?.method).toBe('POST');
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(stringRequestBody(calls[1]?.init?.body))).toMatchObject({
      installationId,
      subscription: { endpoint: 'https://push.example.test/subscription/abc' },
    });
    expect(requestUrl(calls[2]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/notification-endpoints/web/${installationId}`,
    );
    expect(calls[2]?.init?.method).toBe('DELETE');
    expect(new Headers(calls[2]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('loads the next page of current-user communities without sending identity selectors', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(jsonResponse({ items: [] }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.listMyCommunities({ limit: 20, cursor: 'opaque-community-cursor' });

    const url = requestUrl(calls[0]?.input ?? '');
    expect(url).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/communities/mine?limit=20&cursor=opaque-community-cursor',
    );
    expect(url).not.toContain('phone');
    expect(url).not.toContain('clientId');
  });
});
