import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE_PRIVACY_SETTINGS } from '@phub/domain';

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
  it('uses only source-neutral read-only community view routes', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({ items: [] })));
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });
    const communityId = '11111111-1111-4111-8111-111111111111';

    await client.listCommunityReadExperienceFeed(communityId, { limit: 20 });
    await client.listCommunityReadExperienceChat(communityId, { limit: 50 });
    await client.getCommunityReadExperienceRating(communityId, {
      period: '30d',
      tab: 'dynamics',
    });

    expect(fetchImplementation.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      `https://api.padlhub.test/user/api/v1/local-padel/community-views/${communityId}/feed?limit=20`,
      `https://api.padlhub.test/user/api/v1/local-padel/community-views/${communityId}/chat?limit=50`,
      `https://api.padlhub.test/user/api/v1/local-padel/community-views/${communityId}/rating?period=30d&tab=dynamics`,
    ]);
    for (const [, init] of fetchImplementation.mock.calls) expect(init?.cache).toBe('no-store');
  });

  it('issues a realtime ticket only through the authenticated no-store API boundary', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ticket: 'signed-one-time-realtime-ticket-that-is-long-enough',
        expiresAt: '2026-08-04T12:00:30.000Z',
      }),
    );
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await expect(client.issueRealtimeTicket()).resolves.toMatchObject({
      expiresAt: '2026-08-04T12:00:30.000Z',
    });
    const [input, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(requestUrl(input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/realtime/tickets',
    );
    expect(init?.method).toBe('POST');
    expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
  });

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

  it('resolves stable relative community logos in a ready HomeBase section', async () => {
    const relativeLogo =
      '/public/api/v1/media/community-logos/86afbe01-0318-4dd2-bc25-303b7bf0d430/11111111-1111-4111-8111-111111111111';
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        snapshot: {
          version: 'home-base-v1-8',
          generatedAt: '2026-08-14T10:00:00.000Z',
          source: 'LOCAL_PROJECTION',
          completeness: 'PARTIAL',
        },
        viewerUserId: authenticatedSession.user.id,
        quickActions: [],
        communities: {
          status: 'READY',
          revision: '8',
          observedAt: '2026-08-14T09:59:00.000Z',
          staleAt: '2026-08-14T10:04:00.000Z',
          value: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'ПаделХаб',
              logoUrl: relativeLogo,
              isVerified: true,
              unreadChatCount: 0,
              route: '/communities/11111111-1111-4111-8111-111111111111',
            },
          ],
        },
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

    expect(result.communities.status).toBe('READY');
    if (result.communities.status === 'UNAVAILABLE') throw new Error('Expected ready communities');
    expect(result.communities.value[0]?.logoUrl).toBe(`https://api.padlhub.test${relativeLogo}`);
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

  it('uploads client-assisted profile bytes with authentication and resolves the stable avatar URL', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        jsonResponse(
          {
            avatarUrl:
              '/public/api/v1/media/profile-photos/86afbe01-0318-4dd2-bc25-303b7bf0d430/33333333-3333-4333-8333-333333333333',
            replayed: false,
          },
          201,
        ),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const result = await client.syncUserProfilePhoto({
      body: new Uint8Array([1, 2, 3]).buffer,
      contentType: 'image/jpeg',
      grant: 'profile-photo-grant-token',
    });

    expect(result.avatarUrl).toBe(
      'https://api.padlhub.test/public/api/v1/media/profile-photos/86afbe01-0318-4dd2-bc25-303b7bf0d430/33333333-3333-4333-8333-333333333333',
    );
    expect(calls).toHaveLength(1);
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/profile/photo',
    );
    expect(new Headers(calls[0]?.init?.headers).get('Content-Type')).toBe('image/jpeg');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(new Headers(calls[0]?.init?.headers).get('X-Profile-Photo-Grant')).toBe(
      'profile-photo-grant-token',
    );
  });

  it('does not retry profile-photo bytes after a network failure', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await expect(
      client.syncUserProfilePhoto({
        body: new Uint8Array([1, 2, 3]).buffer,
        contentType: 'image/jpeg',
        grant: 'profile-photo-grant-token',
      }),
    ).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
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

    await client.joinGame(
      '751fe6a8-b0b1-4b2b-873d-a2d785c4e191',
      9,
      '95a76d36-d8a7-4ff5-a988-84f33c0fd05a',
    );

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/games/751fe6a8-b0b1-4b2b-873d-a2d785c4e191/join',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual({
      expectedRevision: 9,
      invitationId: '95a76d36-d8a7-4ff5-a988-84f33c0fd05a',
    });
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

  it('starts Viva recovery with browser credentials and one retry-safe operation key', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      if (calls.length === 1) return Promise.reject(new TypeError('temporary network failure'));
      return Promise.resolve(
        jsonResponse({ redirectUrl: 'https://identity.example.test/yandex-recovery' }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await expect(client.createVivaOAuthRecovery()).resolves.toEqual({
      redirectUrl: 'https://identity.example.test/yandex-recovery',
    });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(requestUrl(call.input)).toBe(
        'https://api.padlhub.test/user/api/v1/local-padel/auth/viva/reauthorize',
      );
      expect(call.init?.method).toBe('POST');
      expect(call.init?.credentials).toBe('include');
      expect(new Headers(call.init?.headers).get('Authorization')).toBe(
        `Bearer ${authenticatedSession.accessToken}`,
      );
      expect(JSON.parse(stringRequestBody(call.init?.body))).toEqual({ provider: 'yandex' });
    }
    const firstKey = new Headers(calls[0]?.init?.headers).get('Idempotency-Key');
    expect(firstKey).toBeTruthy();
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBe(firstKey);
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
          ...DEFAULT_PROFILE_PRIVACY_SETTINGS,
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

describe('PadlHubApiClient messaging boundary', () => {
  it('issues the realtime ticket through the authenticated PadlHub API only', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const client = createClient(
      (input, init) => {
        calls.push({ input, ...(init === undefined ? {} : { init }) });
        return Promise.resolve(
          jsonResponse({ ticket: 'x'.repeat(64), expiresAt: '2026-08-03T12:00:30.000Z' }),
        );
      },
      { initialAccessToken: authenticatedSession.accessToken },
    );

    await client.issueMessagingRealtimeTicket();

    expect(requestUrl(calls[0]?.input ?? '')).toContain('/messaging/realtime-ticket');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toMatch(/^Bearer /);
  });

  it('uses only PadlHub conversation routes and retry-safe commands', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const otherUserId = '11111111-1111-4111-8111-111111111111';
    const gameId = '44444444-4444-4444-8444-444444444444';
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const url = requestUrl(input);
      if (url.endsWith('/conversations?limit=25')) {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (url.endsWith('/conversations/direct')) {
        return Promise.resolve(
          jsonResponse({ outcome: 'ok', conversation: {}, created: true, replayed: false }),
        );
      }
      if (url.endsWith('/conversations/game')) {
        return Promise.resolve(
          jsonResponse({ outcome: 'ok', conversation: {}, created: true, replayed: false }),
        );
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ outcome: 'ok', message: {}, replayed: false }));
      }
      if (url.includes('/read-cursor')) {
        return Promise.resolve(
          jsonResponse({ outcome: 'ok', readThroughSequence: 1, changed: true, replayed: false }),
        );
      }
      return Promise.resolve(jsonResponse({ messages: [] }));
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.listConversations(25);
    await client.createDirectConversation(otherUserId);
    await client.getOrCreateGameConversation(gameId);
    await client.listConversationMessages(conversationId, { afterSequence: 4, limit: 50 });
    await client.sendConversationMessage(conversationId, 'Привет');
    await client.markConversationRead(conversationId, 5);

    expect(requestUrl(calls[0]?.input ?? '')).toContain('/conversations?limit=25');
    expect(JSON.parse(stringRequestBody(calls[1]?.init?.body))).toEqual({ otherUserId });
    expect(JSON.parse(stringRequestBody(calls[2]?.init?.body))).toEqual({ gameId });
    expect(requestUrl(calls[3]?.input ?? '')).toContain(
      `/conversations/${conversationId}/messages?afterSequence=4&limit=50`,
    );
    const sendHeaders = new Headers(calls[4]?.init?.headers);
    const sendBody = JSON.parse(stringRequestBody(calls[4]?.init?.body)) as {
      clientMessageId: string;
      body: string;
    };
    expect(sendHeaders.get('Idempotency-Key')).toBe(sendBody.clientMessageId);
    expect(sendBody.body).toBe('Привет');
    expect(JSON.parse(stringRequestBody(calls[5]?.init?.body))).toEqual({ throughSequence: 5 });
    expect(calls.map((call) => requestUrl(call.input)).join(' ')).not.toMatch(/viva|provider/i);
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
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Сообщество',
              logoUrl:
                '/public/api/v1/media/community-logos/86afbe01-0318-4dd2-bc25-303b7bf0d430/11111111-1111-4111-8111-111111111111',
              isVerified: true,
              unreadChatCount: 0,
              route: '/communities/11111111-1111-4111-8111-111111111111',
            },
          ],
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const page = await client.listMyCommunities({ limit: 20, cursor: 'opaque-community-cursor' });

    const url = requestUrl(calls[0]?.input ?? '');
    expect(url).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/communities/mine?limit=20&cursor=opaque-community-cursor',
    );
    expect(url).not.toContain('phone');
    expect(url).not.toContain('clientId');
    expect(page.items[0]?.logoUrl).toBe(
      'https://api.padlhub.test/public/api/v1/media/community-logos/86afbe01-0318-4dd2-bc25-303b7bf0d430/11111111-1111-4111-8111-111111111111',
    );
  });

  it('resolves the stable relative logo in community detail', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const relativeLogo =
      '/public/api/v1/media/community-logos/86afbe01-0318-4dd2-bc25-303b7bf0d430/11111111-1111-4111-8111-111111111111';
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: communityId,
        title: 'ПаделХаб',
        logoUrl: relativeLogo,
        isVerified: true,
        description: null,
        memberCount: 42,
        readOnly: true,
      }),
    );
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const detail = await client.getCommunityReadExperienceDetail(communityId);

    expect(detail.logoUrl).toBe(`https://api.padlhub.test${relativeLogo}`);
  });

  it('uses canonical discovery/detail without identity or invite selectors', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        requestUrl(input).includes('?')
          ? jsonResponse({ items: [] })
          : jsonResponse({
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Private Padel',
              logoUrl: null,
              isVerified: true,
              visibility: 'LISTED_PRIVATE',
              joinAction: 'REQUEST_TO_JOIN',
            }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });
    const communityId = '11111111-1111-4111-8111-111111111111';

    await client.discoverCommunities({ query: 'private padel', limit: 20 });
    await client.getCommunityDetail(communityId);

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/communities?query=private+padel&limit=20',
    );
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}`,
    );
    for (const call of calls) {
      const url = requestUrl(call.input);
      expect(url).not.toContain('phone');
      expect(url).not.toContain('clientId');
      expect(url).not.toContain('invite');
    }
  });

  it('loads only the authenticated user community membership state', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        jsonResponse({
          communityId,
          membershipStatus: 'NONE',
          role: null,
          membershipRevision: 0,
          joinRequest: null,
          joinAction: 'REQUEST_TO_JOIN',
          updatedAt: null,
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.getMyCommunityMembershipState(communityId);

    const url = requestUrl(calls[0]?.input ?? '');
    expect(url).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/members/me`,
    );
    expect(url).not.toMatch(/actor|role|userId|phone|clientId/);
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  it('uses retry-stable keys and revision-only community membership command bodies', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    let joinAttempt = 0;
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      if (requestUrl(input).endsWith('/members/me/join') && joinAttempt++ === 0) {
        return Promise.reject(new TypeError('temporary network failure'));
      }
      return Promise.resolve(
        jsonResponse({
          communityId,
          membershipStatus: 'ACTIVE',
          role: 'MEMBER',
          membershipRevision: 2,
          joinRequest: null,
          joinAction: 'OPEN_COMMUNITY',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.joinOrRequestCommunityMembership(communityId, {
      expectedMembershipRevision: 0,
    });
    await client.cancelMyCommunityJoinRequest(communityId, requestId, {
      expectedMembershipRevision: 1,
      expectedRequestRevision: 2,
    });
    await client.leaveCommunity(communityId, { expectedMembershipRevision: 2 });

    expect(calls).toHaveLength(4);
    const joinHeaders = calls.slice(0, 2).map((call) => new Headers(call.init?.headers));
    expect(joinHeaders[0]?.get('Idempotency-Key')).toBeTruthy();
    expect(joinHeaders[1]?.get('Idempotency-Key')).toBe(joinHeaders[0]?.get('Idempotency-Key'));
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/members/me/join`,
    );
    expect(requestUrl(calls[2]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/join-requests/${requestId}/cancel`,
    );
    expect(requestUrl(calls[3]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/members/me/leave`,
    );

    const bodies = calls.map(
      (call) => JSON.parse(stringRequestBody(call.init?.body)) as Record<string, unknown>,
    );
    expect(bodies[0]).toEqual({ expectedMembershipRevision: 0 });
    expect(bodies[1]).toEqual({ expectedMembershipRevision: 0 });
    expect(bodies[2]).toEqual({ expectedMembershipRevision: 1, expectedRequestRevision: 2 });
    expect(bodies[3]).toEqual({ expectedMembershipRevision: 2 });
    for (const [index, body] of bodies.entries()) {
      expect(calls[index]?.init?.method).toBe('POST');
      expect(new Headers(calls[index]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
      expect(body).not.toHaveProperty('actor');
      expect(body).not.toHaveProperty('role');
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('phone');
      expect(body).not.toHaveProperty('clientId');
    }
  });

  it('transfers community ownership with one retry-stable key and explicit revisions', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const targetUserId = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      if (calls.length === 1) return Promise.reject(new TypeError('temporary network failure'));
      return Promise.resolve(
        jsonResponse({
          communityId,
          previousOwner: {
            userId: authenticatedSession.user.id,
            role: 'ADMIN',
            revision: 5,
          },
          owner: { userId: targetUserId, previousRole: 'MEMBER', role: 'OWNER', revision: 3 },
          transferredAt: '2026-08-04T12:00:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.transferCommunityOwnership(communityId, {
      targetUserId,
      expectedOwnerRevision: 4,
      expectedTargetRevision: 2,
    });

    expect(calls).toHaveLength(2);
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/ownership-transfers`,
    );
    const firstKey = new Headers(calls[0]?.init?.headers).get('Idempotency-Key');
    expect(firstKey).toBeTruthy();
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBe(firstKey);
    expect(JSON.parse(stringRequestBody(calls[1]?.init?.body))).toEqual({
      targetUserId,
      expectedOwnerRevision: 4,
      expectedTargetRevision: 2,
    });
  });

  it('uses opaque content cursors and retry-stable community content commands', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const postId = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    let createAttempts = 0;
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const url = requestUrl(input);
      if (url.endsWith('/posts') && createAttempts++ === 0) {
        return Promise.reject(new TypeError('temporary network failure'));
      }
      if (url.includes('/feed')) {
        return Promise.resolve(jsonResponse({ items: [], watermark: '2026-08-04T12:00:00.000Z' }));
      }
      if (url.endsWith('/reaction')) {
        return Promise.resolve(
          jsonResponse({
            targetType: 'POST',
            targetId: postId,
            reaction: 'LIKE',
            active: true,
            revision: 1,
            updatedAt: '2026-08-04T12:00:00.000Z',
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          id: postId,
          communityId,
          authorUserId: authenticatedSession.user.id,
          status: 'PUBLISHED',
          body: 'Первый пост',
          revision: 1,
          createdAt: '2026-08-04T12:00:00.000Z',
          publishedAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          archivedAt: null,
          restoreUntil: null,
          retentionUntil: null,
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.listCommunityFeed(communityId, { limit: 20, cursor: 'opaque-feed-cursor' });
    await client.createCommunityPost(communityId, { body: 'Первый пост' });
    await client.setCommunityReaction(communityId, 'POST', postId, { reaction: 'LIKE' });

    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/feed?limit=20&cursor=opaque-feed-cursor`,
    );
    expect(calls).toHaveLength(4);
    const createHeaders = calls.slice(1, 3).map((call) => new Headers(call.init?.headers));
    expect(createHeaders[0]?.get('Idempotency-Key')).toBeTruthy();
    expect(createHeaders[1]?.get('Idempotency-Key')).toBe(createHeaders[0]?.get('Idempotency-Key'));
    expect(JSON.parse(stringRequestBody(calls[2]?.init?.body))).toEqual({ body: 'Первый пост' });
    expect(requestUrl(calls[3]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/posts/${postId}/reaction`,
    );
    expect(calls[3]?.init?.method).toBe('PUT');
  });

  it('recovers Community events from an explicit durable sequence', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        jsonResponse({
          items: [],
          afterSequence: 12,
          latestSequence: 12,
          retainedFromSequence: 1,
          hasMore: false,
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });
    await expect(
      client.recoverCommunityEvents('11111111-1111-4111-8111-111111111111', {
        afterSequence: 12,
        limit: 50,
      }),
    ).resolves.toMatchObject({ latestSequence: 12 });
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/events?afterSequence=12&limit=50',
    );
    expect(calls[0]?.init?.cache).toBe('no-store');
  });

  it('issues, finalizes, polls and downloads community media only through scoped contracts', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const mediaId = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const url = requestUrl(input);
      if (url.endsWith('/variants/FEED')) {
        return Promise.resolve(
          new Response(new Blob(['webp']), {
            status: 200,
            headers: { 'Content-Type': 'image/webp' },
          }),
        );
      }
      if (url.endsWith('/media/uploads')) {
        return Promise.resolve(
          jsonResponse({
            id: mediaId,
            communityId,
            uploaderUserId: authenticatedSession.user.id,
            mediaType: 'IMAGE',
            state: 'UPLOADING',
            revision: 1,
            declaredContentType: 'image/jpeg',
            declaredByteSize: 1024,
            declaredSha256: 'a'.repeat(64),
            upload: {
              method: 'PUT',
              url: 'https://quarantine.padlhub.test/upload',
              requiredHeaders: { 'Content-Type': 'image/jpeg' },
              expiresAt: '2026-08-04T12:15:00.000Z',
            },
            createdAt: '2026-08-04T12:00:00.000Z',
            updatedAt: '2026-08-04T12:00:00.000Z',
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          id: mediaId,
          communityId,
          uploaderUserId: authenticatedSession.user.id,
          mediaType: 'IMAGE',
          state: 'SCANNING',
          revision: 2,
          declaredContentType: 'image/jpeg',
          declaredByteSize: 1024,
          declaredSha256: 'a'.repeat(64),
          finalizedAt: '2026-08-04T12:01:00.000Z',
          createdAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:01:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.issueCommunityMediaUpload(communityId, {
      mediaType: 'IMAGE',
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256: 'a'.repeat(64),
    });
    await client.finalizeCommunityMediaUpload(communityId, mediaId, { expectedRevision: 1 });
    await client.getCommunityMediaStatus(communityId, mediaId);
    await client.downloadCommunityMediaVariant(communityId, mediaId, 'FEED');

    expect(requestUrl(calls[0]?.input ?? '')).toContain(
      `/communities/${communityId}/media/uploads`,
    );
    expect(JSON.parse(stringRequestBody(calls[0]?.init?.body))).toEqual({
      mediaType: 'IMAGE',
      contentType: 'image/jpeg',
      byteSize: 1024,
      sha256: 'a'.repeat(64),
    });
    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(requestUrl(calls[1]?.input ?? '')).toContain(`/media/${mediaId}/finalize`);
    expect(new Headers(calls[1]?.init?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(calls[2]?.init?.cache).toBe('no-store');
    expect(requestUrl(calls[3]?.input ?? '')).toContain(`/media/${mediaId}/variants/FEED`);
    expect(new Headers(calls[3]?.init?.headers).get('Accept')).toBe('image/webp');
    expect(new Headers(calls[3]?.init?.headers).get('Authorization')).toBe(
      `Bearer ${authenticatedSession.accessToken}`,
    );
  });

  it('exposes typed canonical reload metadata for an expired Community event gap', async () => {
    const fetchImplementation: typeof fetch = () =>
      Promise.resolve(
        jsonResponse(
          {
            code: 'COMMUNITY_EVENT_GAP_EXPIRED',
            message: 'История истекла.',
            correlationId: 'gap-correlation',
            recoveryAction: 'FULL_CANONICAL_RELOAD',
            latestSequence: 40,
            retainedFromSequence: 20,
          },
          409,
        ),
      );
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });
    await expect(
      client.recoverCommunityEvents('11111111-1111-4111-8111-111111111111', {
        afterSequence: 1,
      }),
    ).rejects.toMatchObject({
      name: 'CommunityEventGapExpiredError',
      code: 'COMMUNITY_EVENT_GAP_EXPIRED',
      recoveryAction: 'FULL_CANONICAL_RELOAD',
      latestSequence: 40,
      retainedFromSequence: 20,
    });
  });

  it('retries community creation with one key and only public contract fields', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      if (calls.length === 1) return Promise.reject(new TypeError('temporary network failure'));
      return Promise.resolve(
        jsonResponse({
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Padel Friends',
          description: null,
          visibility: 'PUBLIC',
          joinPolicy: 'INSTANT',
          publishingPreset: 'OPEN_COMMUNITY',
          status: 'ACTIVE',
          revision: 1,
          ownerUserId: authenticatedSession.user.id,
          createdAt: '2026-08-03T10:00:00.000Z',
          updatedAt: '2026-08-03T10:00:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.createCommunity({
      title: 'Padel Friends',
      visibility: 'PUBLIC',
      joinPolicy: 'INSTANT',
      publishingPreset: 'OPEN_COMMUNITY',
    });

    expect(calls).toHaveLength(2);
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    const secondHeaders = new Headers(calls[1]?.init?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toBeTruthy();
    expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/communities',
    );
    const body = JSON.parse(stringRequestBody(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      title: 'Padel Friends',
      visibility: 'PUBLIC',
      joinPolicy: 'INSTANT',
      publishingPreset: 'OPEN_COMMUNITY',
    });
    expect(body).not.toHaveProperty('actorUserId');
    expect(body).not.toHaveProperty('quotaOverride');
  });

  it('keeps DIRECT invite tokens in no-store JSON bodies and retries commands with stable keys', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const inviteId = '22222222-2222-4222-8222-222222222222';
    const token = 'direct_invite_token_abcdefghijklmnopqrstuvwxyz0123456789';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const commandAttempts = new Map<string, number>();
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      const url = requestUrl(input);
      const isRetryableCommand =
        url.endsWith('/direct-invites') ||
        url.endsWith('/community-direct-invites/redeem') ||
        url.endsWith(`/community-direct-invites/${inviteId}/revoke`);
      if (isRetryableCommand) {
        const attempt = commandAttempts.get(url) ?? 0;
        commandAttempts.set(url, attempt + 1);
        if (attempt === 0) return Promise.reject(new TypeError('temporary network failure'));
      }
      if (url.includes(`/communities/${communityId}/direct-invites?`)) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                id: inviteId,
                communityId,
                status: 'ACTIVE',
                revision: 1,
                createdAt: '2026-08-04T10:00:00.000Z',
                expiresAt: '2026-08-11T10:00:00.000Z',
                updatedAt: '2026-08-04T10:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (url.endsWith('/community-direct-invites/preview')) {
        return Promise.resolve(
          jsonResponse({
            inviteId,
            inviteRevision: 3,
            community: {
              id: communityId,
              title: 'Hidden Padel',
              logoUrl: null,
              isVerified: true,
              visibility: 'HIDDEN',
            },
            expiresAt: '2026-08-11T10:00:00.000Z',
            membershipRevision: 4,
            redeemAction: 'CONFIRM_MEMBERSHIP',
          }),
        );
      }
      if (url.endsWith('/community-direct-invites/redeem')) {
        return Promise.resolve(
          jsonResponse({
            communityId,
            membershipStatus: 'ACTIVE',
            role: 'MEMBER',
            membershipRevision: 5,
            joinRequest: null,
            joinAction: 'OPEN_COMMUNITY',
            updatedAt: '2026-08-04T10:00:00.000Z',
          }),
        );
      }
      if (url.endsWith('/revoke')) {
        return Promise.resolve(
          jsonResponse({
            id: inviteId,
            communityId,
            status: 'REVOKED',
            revision: 2,
            createdAt: '2026-08-04T10:00:00.000Z',
            expiresAt: '2026-08-11T10:00:00.000Z',
            updatedAt: '2026-08-04T11:00:00.000Z',
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          {
            id: inviteId,
            communityId,
            status: 'ACTIVE',
            revision: 1,
            token,
            createdAt: '2026-08-04T10:00:00.000Z',
            expiresAt: '2026-08-11T10:00:00.000Z',
          },
          201,
        ),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    const page = await client.listCommunityDirectInvites(communityId, {
      limit: 20,
      cursor: 'opaque-direct-invite-cursor',
    });
    const created = await client.createCommunityDirectInvite(communityId, {
      expectedIssuerMembershipRevision: 9,
    });
    const preview = await client.previewCommunityDirectInvite({ token });
    await client.redeemCommunityDirectInvite({
      token,
      expectedInviteRevision: 3,
      expectedMembershipRevision: 4,
    });
    await client.revokeCommunityDirectInvite(inviteId, { expectedInviteRevision: 1 });

    expect(page.items[0]).not.toHaveProperty('token');
    expect(page.items[0]).not.toHaveProperty('tokenHash');
    expect(created.token).toBe(token);
    expect(preview.inviteRevision).toBe(3);
    expect(preview.membershipRevision).toBe(4);
    expect(calls).toHaveLength(8);
    expect(requestUrl(calls[0]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/direct-invites?limit=20&cursor=opaque-direct-invite-cursor`,
    );
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/direct-invites`,
    );
    expect(requestUrl(calls[3]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/community-direct-invites/preview',
    );
    expect(requestUrl(calls[4]?.input ?? '')).toBe(
      'https://api.padlhub.test/user/api/v1/local-padel/community-direct-invites/redeem',
    );
    expect(requestUrl(calls[6]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/community-direct-invites/${inviteId}/revoke`,
    );

    expect(calls[0]?.init?.body).toBeUndefined();
    expect(JSON.parse(stringRequestBody(calls[1]?.init?.body))).toEqual({
      expectedIssuerMembershipRevision: 9,
    });
    expect(JSON.parse(stringRequestBody(calls[2]?.init?.body))).toEqual({
      expectedIssuerMembershipRevision: 9,
    });
    expect(JSON.parse(stringRequestBody(calls[3]?.init?.body))).toEqual({ token });
    expect(JSON.parse(stringRequestBody(calls[4]?.init?.body))).toEqual({
      token,
      expectedInviteRevision: 3,
      expectedMembershipRevision: 4,
    });
    expect(JSON.parse(stringRequestBody(calls[5]?.init?.body))).toEqual({
      token,
      expectedInviteRevision: 3,
      expectedMembershipRevision: 4,
    });
    expect(JSON.parse(stringRequestBody(calls[6]?.init?.body))).toEqual({
      expectedInviteRevision: 1,
    });
    expect(JSON.parse(stringRequestBody(calls[7]?.init?.body))).toEqual({
      expectedInviteRevision: 1,
    });

    for (const call of calls) {
      const url = requestUrl(call.input);
      expect(url).not.toContain(token);
      expect(url).not.toMatch(/actor|issuer|userId|role|status|expiry|maxUses/i);
      expect(call.init?.cache).toBe('no-store');
      if (call.init?.body) {
        const body = JSON.parse(stringRequestBody(call.init.body)) as Record<string, unknown>;
        for (const forbiddenKey of [
          'actor',
          'actorUserId',
          'issuerUserId',
          'userId',
          'role',
          'status',
          'expiry',
          'expiresAt',
          'maxUses',
        ]) {
          expect(body).not.toHaveProperty(forbiddenKey);
        }
      }
    }

    for (const indexes of [
      [1, 2],
      [4, 5],
      [6, 7],
    ]) {
      const firstHeaders = new Headers(calls[indexes[0] ?? -1]?.init?.headers);
      const secondHeaders = new Headers(calls[indexes[1] ?? -1]?.init?.headers);
      expect(firstHeaders.get('Idempotency-Key')).toBeTruthy();
      expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
    }

    expect(new Headers(calls[0]?.init?.headers).get('Idempotency-Key')).toBeNull();
    expect(new Headers(calls[3]?.init?.headers).get('Idempotency-Key')).toBeNull();
  });

  it('retries a membership pin command with one key and no client-supplied actor', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const fetchImplementation: typeof fetch = (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      if (calls.length === 1) return Promise.reject(new TypeError('temporary network failure'));
      return Promise.resolve(
        jsonResponse({
          communityId,
          pinned: true,
          revision: 4,
          updatedAt: '2026-08-03T10:00:00.000Z',
        }),
      );
    };
    const client = createClient(fetchImplementation, {
      initialAccessToken: authenticatedSession.accessToken,
    });

    await client.setMyCommunityMembershipPin(communityId, {
      pinned: true,
      expectedRevision: 3,
    });

    expect(calls).toHaveLength(2);
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    const secondHeaders = new Headers(calls[1]?.init?.headers);
    expect(firstHeaders.get('Idempotency-Key')).toBeTruthy();
    expect(secondHeaders.get('Idempotency-Key')).toBe(firstHeaders.get('Idempotency-Key'));
    expect(requestUrl(calls[1]?.input ?? '')).toBe(
      `https://api.padlhub.test/user/api/v1/local-padel/communities/${communityId}/members/me/pin`,
    );
    expect(JSON.parse(stringRequestBody(calls[1]?.init?.body))).toEqual({
      pinned: true,
      expectedRevision: 3,
    });
  });
});
