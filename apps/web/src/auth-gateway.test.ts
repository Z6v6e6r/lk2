// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { createBrowserAuthGateway } from './auth-gateway.js';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('browser auth gateway', () => {
  it('coalesces the same tournament detail lookup by id and range until it settles', async () => {
    const summary = {
      id: '91a1c7c6-73d0-4270-a400-3358873e4d9b',
      title: 'Субботний турнир',
    };
    const fetchImplementation = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(summary)));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });
    const range = { dateFrom: '2026-08-01', dateTo: '2026-08-16' };

    const first = gateway.getPublicTournamentSummary?.(summary.id, range);
    const duplicate = gateway.getPublicTournamentSummary?.(summary.id, range);

    expect(first).toBe(duplicate);
    await expect(first).resolves.toEqual(summary);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    await gateway.getPublicTournamentSummary?.(summary.id, range);
    await gateway.getPublicTournamentSummary?.('00000000-0000-4000-8000-000000000002', range);
    await gateway.getPublicTournamentSummary?.(summary.id, {
      ...range,
      dateTo: '2026-08-17',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it('keeps public gift payment commands anonymous and resolves the hosted API origin', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        payment: {
          id: '11111111-1111-4111-8111-111111111111',
          orderId: '22222222-2222-4222-8222-222222222222',
          provider: 'PADLHUB_SANDBOX',
          status: 'PENDING',
          amountMinor: 500_000,
          currency: 'RUB',
          createdAt: '2026-07-19T10:00:00.000Z',
          confirmedAt: null,
        },
        nextAction: {
          type: 'REDIRECT',
          url: '/public/api/v1/padlhub/gift-certificate-payment-sandbox/payment-id',
        },
        replayed: false,
      }),
    );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    const intent = await gateway.createPublicGiftCertificatePaymentIntent(
      '22222222-2222-4222-8222-222222222222',
    );

    expect(intent.nextAction.url).toBe(
      'https://api.padlhub.test/public/api/v1/padlhub/gift-certificate-payment-sandbox/payment-id',
    );
    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
  });

  it('restores through the HttpOnly cookie and keeps the access token in memory', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          accessToken: 'short-lived-padlhub-token',
          tokenType: 'Bearer',
          expiresAt: '2026-07-11T12:10:00.000Z',
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: 'Анна',
          },
          context: {
            userId: '00000000-0000-4000-8000-000000000001',
            tenantId: '00000000-0000-4000-8000-000000000002',
            displayName: 'Анна',
            phoneLast4: '0001',
            roles: ['client'],
            permissions: ['profile.read'],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    const restored = await gateway.restoreSession();

    expect(restored?.context.user.displayName).toBe('Анна');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const [refreshUrl, refreshInit] = fetchImplementation.mock.calls[0] ?? [];
    expect(refreshUrl).toBe('https://api.padlhub.test/user/api/v1/padlhub/auth/session/refresh');
    expect(refreshInit?.credentials).toBe('include');
    expect(new Headers(refreshInit?.headers).has('Authorization')).toBe(false);
  });

  it('coalesces concurrent Home reads without pinning a resolved snapshot', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const dashboard = { snapshot: { version: 'home-v1-test' } };
    const refreshedDashboard = { snapshot: { version: 'home-v1-refreshed' } };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(dashboard))
      .mockResolvedValueOnce(Response.json(refreshedDashboard));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const [first, second] = await Promise.all([
      gateway.getHomeDashboard(),
      gateway.getHomeDashboard(),
    ]);

    expect(first).toEqual(dashboard);
    expect(second).toBe(first);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [homeUrl, homeInit] = fetchImplementation.mock.calls[1] ?? [];
    expect(homeUrl).toBe('https://api.padlhub.test/user/api/v1/padlhub/home');
    expect(new Headers(homeInit?.headers).get('Authorization')).toBe(
      'Bearer short-lived-padlhub-token',
    );

    await expect(gateway.getHomeDashboard()).resolves.toEqual(refreshedDashboard);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('coalesces local Home Base reads without pinning a resolved partial snapshot', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const homeBase = {
      snapshot: {
        version: 'home-base-v1-test',
        generatedAt: '2026-07-29T12:00:00.000Z',
        source: 'LOCAL_PROJECTION',
        completeness: 'PARTIAL',
      },
      viewerUserId: session.context.userId,
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
    };
    const refreshed = {
      ...homeBase,
      snapshot: { ...homeBase.snapshot, version: 'home-base-v1-refreshed' },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(homeBase))
      .mockResolvedValueOnce(Response.json(refreshed));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const [first, second] = await Promise.all([gateway.getHomeBase(), gateway.getHomeBase()]);

    expect(first).toEqual(homeBase);
    expect(second).toBe(first);
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/home/base',
    );
    await expect(gateway.getHomeBase()).resolves.toEqual(refreshed);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('coalesces notification reads, briefly caches them, and invalidates after marking read', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const inbox = { items: [], unreadCount: 2 };
    const refreshedInbox = { items: [], unreadCount: 0 };
    let inboxReads = 0;
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.includes('/notifications?limit=50')) {
        inboxReads += 1;
        return Promise.resolve(Response.json(inboxReads === 1 ? inbox : refreshedInbox));
      }
      if (url.endsWith('/notifications/read-cursor')) {
        return Promise.resolve(Response.json({ unreadCount: 0 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const first = gateway.listNotifications();
    const second = gateway.listNotifications();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(inbox);
    await expect(gateway.listNotifications()).resolves.toEqual(inbox);
    expect(inboxReads).toBe(1);

    await gateway.markNotificationsRead('notification-2');
    await expect(gateway.listNotifications()).resolves.toEqual(refreshedInbox);
    expect(inboxReads).toBe(2);
  });

  it('coalesces first community pages by page size and preserves ten-item Home pagination', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const tenItemPage = { items: [], nextCursor: 'home-community-cursor' };
    const twentyItemPage = { items: [] };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(tenItemPage))
      .mockResolvedValueOnce(Response.json(twentyItemPage));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const [firstTen, duplicateTen, firstTwenty] = await Promise.all([
      gateway.listMyCommunities(undefined, 10),
      gateway.listMyCommunities(undefined, 10),
      gateway.listMyCommunities(),
    ]);

    expect(duplicateTen).toBe(firstTen);
    expect(firstTwenty).toEqual(twentyItemPage);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/communities/mine?limit=10',
    );
    expect(fetchImplementation.mock.calls[2]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/communities/mine?limit=20',
    );
  });

  it('rejects a Home Base snapshot bound to another PadlHub user', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(
        Response.json({
          snapshot: {
            version: 'home-base-v1-mismatch',
            generatedAt: '2026-07-29T12:00:00.000Z',
            source: 'LOCAL_PROJECTION',
            completeness: 'PARTIAL',
          },
          viewerUserId: '99999999-9999-4999-8999-999999999999',
          quickActions: [],
          communities: { status: 'UNAVAILABLE' },
          promotions: { status: 'UNAVAILABLE' },
          locations: [],
          additionalLinks: [],
          capabilities: {
            canCreateGame: false,
            canManageTournaments: false,
            canViewCommunities: false,
          },
        }),
      );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getHomeBase()).rejects.toThrow('HOME_BASE_VIEWER_MISMATCH');
  });

  it('exchanges a fragment handoff once and keeps the Viva access token only in memory', async () => {
    window.history.replaceState({}, '', '/#viva_handoff=one-time-handoff-code-12345');
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(
        Response.json({
          accessToken: 'short-lived-viva-access-token',
          expiresAt: '2099-07-11T12:05:00.000Z',
        }),
      );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();

    expect(gateway.getVivaAccessToken()).toBe('short-lived-viva-access-token');
    expect(window.location.hash).toBe('');
    const [brokerUrl, brokerInit] = fetchImplementation.mock.calls[1] ?? [];
    expect(brokerUrl).toBe('https://api.padlhub.test/user/api/v1/padlhub/auth/viva/access');
    expect(typeof brokerInit?.body).toBe('string');
    expect(JSON.parse(brokerInit?.body as string)).toEqual({
      handoffCode: 'one-time-handoff-code-12345',
    });
    expect(new Headers(brokerInit?.headers).get('Authorization')).toBe(
      'Bearer short-lived-padlhub-token',
    );
  });

  it('loads and caches the server-owned routing plan after authentication', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const routingPlan = {
      revision: '4',
      mode: 'PADLHUB_ONLY',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      operations: [],
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(routingPlan));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const [first, second] = await Promise.all([gateway.getRoutingPlan(), gateway.getRoutingPlan()]);

    expect(first).toEqual(routingPlan);
    expect(second).toBe(first);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImplementation.mock.calls[1] ?? [];
    expect(url).toBe('https://api.padlhub.test/user/api/v1/padlhub/routing-plan');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer short-lived-padlhub-token',
    );
  });

  it('loads the canonical PadlHub profile when profile.read is not direct', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const operations = [
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read',
    ].map((operation) => ({ operation, transport: 'PADLHUB_API', fallback: 'PADLHUB_API' }));
    const profile = {
      userId,
      displayName: 'Анна Петрова',
      avatarUrl:
        '/public/api/v1/media/profile-photos/00000000-0000-4000-8000-000000000002/33333333-3333-4333-8333-333333333333',
      phoneLast4: '0001',
      balanceMinor: 54_000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(
        Response.json({
          revision: '5',
          mode: 'PADLHUB_ONLY',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          operations,
        }),
      )
      .mockResolvedValueOnce(Response.json(profile));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await gateway.getRoutingPlan();
    await expect(gateway.getSelfProfile()).resolves.toEqual(profile);

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls[2]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/profile',
    );
  });

  it('loads a viewer-filtered profile only through the PadlHub API', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const targetUserId = '6a81e965-c508-4321-812c-4be323606a70';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const profileView = {
      profile: {
        userId: targetUserId,
        displayName: 'Мария Соколова',
        level: { label: 'C', assessmentRequired: false },
      },
      access: {
        audience: 'OTHER',
        tier: 'BASIC',
        visibleSections: ['BASIC', 'PLAYER_LEVEL'],
        contact: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
        chat: { status: 'LOCKED', reason: 'ACCESS_REQUIRED' },
      },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(profileView));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getPlayerProfile(targetUserId)).resolves.toEqual(profileView);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      `https://api.padlhub.test/user/api/v1/padlhub/profiles/${targetUserId}`,
    );
  });

  it('loads and updates owner privacy only through idempotent PadlHub commands', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const current = {
      contactPolicy: 'AUTHORIZED',
      chatPolicy: 'AUTHORIZED',
      version: 1,
      updatedAt: '2026-07-17T12:00:00.000Z',
    };
    const updated = { ...current, chatPolicy: 'NOBODY', version: 2 };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(current))
      .mockResolvedValueOnce(Response.json(updated));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getProfilePrivacy()).resolves.toEqual(current);
    await expect(
      gateway.updateProfilePrivacy({
        expectedVersion: 1,
        contactPolicy: 'AUTHORIZED',
        chatPolicy: 'NOBODY',
      }),
    ).resolves.toEqual(updated);

    expect(fetchImplementation.mock.calls[1]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/profile/privacy',
    );
    expect(fetchImplementation.mock.calls[2]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/profile/privacy',
    );
    const updateInit = fetchImplementation.mock.calls[2]?.[1];
    expect(updateInit?.method).toBe('PUT');
    expect(new Headers(updateInit?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(typeof updateInit?.body).toBe('string');
    if (typeof updateInit?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(updateInit.body)).toEqual({
      expectedVersion: 1,
      contactPolicy: 'AUTHORIZED',
      chatPolicy: 'NOBODY',
    });
  });

  it('loads upcoming bookings through the server-directed Viva list/details job', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const bookings = {
      version: 'b'.repeat(64),
      generatedAt: '2026-07-15T18:00:00.000Z',
      staleAt: '2026-07-15T18:05:00.000Z',
      items: [],
    };
    const job = {
      jobId: '10000000-0000-4000-8000-000000000001',
      screen: 'MY_BOOKINGS',
      expiresAt: '2099-07-11T12:02:00.000Z',
      concurrency: 1,
      commands: [
        {
          commandId: '20000000-0000-4000-8000-000000000001',
          operation: 'bookings.read',
          detailsOperation: 'bookings.details.read',
          page: 0,
          size: 50,
        },
      ],
    };
    const operationNames = [
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read',
    ];
    let projectionReady = false;
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.endsWith('/bookings/upcoming')) {
        return Promise.resolve(
          projectionReady
            ? Response.json(bookings)
            : Response.json({ code: 'BOOKINGS_PROJECTION_NOT_READY' }, { status: 503 }),
        );
      }
      if (url.endsWith('/booking-screen-read-jobs')) return Promise.resolve(Response.json(job));
      if (url.endsWith('/routing-plan')) {
        return Promise.resolve(
          Response.json({
            revision: '8',
            mode: 'MIXED_END_USER_READS',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            operations: operationNames.map((operation) => ({
              operation,
              transport: 'PADLHUB_API',
              fallback: 'UNAVAILABLE',
            })),
            directViva: {
              apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
              providerTenantKey: 'iSkq6G',
              accessTokenPath: '/auth/viva/access',
              allowedRequestHeaders: ['Authorization'],
            },
          }),
        );
      }
      if (url.endsWith('/auth/viva/access')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'short-lived-viva-token',
            expiresAt: '2099-07-11T12:05:00.000Z',
          }),
        );
      }
      if (url.includes('/v2/iSkq6G/bookings?')) {
        return Promise.resolve(
          Response.json({
            content: [{ id: 'active-private-booking', isCancelled: false }],
          }),
        );
      }
      if (url.includes('/v1/iSkq6G/bookings/list?')) {
        return Promise.resolve(
          Response.json([{ id: 'active-private-booking', isCancelled: false }]),
        );
      }
      if (url.includes('/results/')) {
        return Promise.resolve(
          Response.json({ accepted: true, replayed: false, itemCount: 1 }, { status: 202 }),
        );
      }
      if (url.endsWith(`/booking-screen-read-jobs/${job.jobId}/complete`)) {
        projectionReady = true;
        return Promise.resolve(
          Response.json({
            screen: 'MY_BOOKINGS',
            state: 'READY',
            completedCommands: 1,
            totalCommands: 1,
            bookings,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const firstRead = gateway.getUpcomingBookings();
    const coalescedRead = gateway.getUpcomingBookings();
    expect(coalescedRead).toBe(firstRead);
    await expect(firstRead).resolves.toEqual(bookings);

    const urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(
      urls.filter((url) => url.endsWith('/user/api/v1/padlhub/booking-screen-read-jobs')),
    ).toHaveLength(1);
    expect(urls).toContain(
      'https://api.vivacrm.invalid/end-user/api/v2/iSkq6G/bookings?page=0&size=50',
    );
    expect(urls.filter((url) => url.startsWith('https://api.vivacrm.invalid/'))).toHaveLength(2);
    expect(urls.filter((url) => url.endsWith('/bookings/upcoming'))).toHaveLength(2);
    expect(urls.filter((url) => url.endsWith('/auth/viva/access'))).toHaveLength(1);
  });

  it('renders a fresh My bookings projection without contacting Viva', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const bookings = {
      version: 'c'.repeat(64),
      generatedAt: new Date().toISOString(),
      staleAt: new Date(Date.now() + 60_000).toISOString(),
      items: [],
    };
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'short-lived-padlhub-token',
            tokenType: 'Bearer',
            expiresAt: '2099-07-11T12:10:00.000Z',
            user: { id: userId, displayName: 'Анна' },
            context: {
              userId,
              tenantId: '00000000-0000-4000-8000-000000000002',
              displayName: 'Анна',
              phoneLast4: '0001',
              roles: ['client'],
              permissions: ['profile.read'],
            },
          }),
        );
      }
      if (url.endsWith('/bookings/upcoming')) return Promise.resolve(Response.json(bookings));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getUpcomingBookings()).resolves.toEqual(bookings);

    const urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.filter((url) => url.endsWith('/bookings/upcoming'))).toHaveLength(1);
    expect(urls.some((url) => url.includes('vivacrm'))).toBe(false);
    expect(urls.some((url) => url.endsWith('/booking-screen-read-jobs'))).toBe(false);
  });

  it('refreshes activity history in the browser before reading the PadlHub projection', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const jobId = '10000000-0000-4000-8000-000000000011';
    const commandId = '20000000-0000-4000-8000-000000000011';
    const history = {
      items: [],
      nextCursor: null,
      freshness: 'FRESH',
      coverage: 'COMPLETE',
      generatedAt: '2026-08-01T20:00:00.000Z',
    };
    const operationNames = [
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read',
    ];
    let historyProjectionReads = 0;
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.endsWith('/activity-history-read-jobs')) {
        return Promise.resolve(
          Response.json({
            jobId,
            screen: 'ACTIVITY_HISTORY',
            expiresAt: '2099-07-11T12:02:00.000Z',
            concurrency: 1,
            commands: [{ commandId, operation: 'bookings.history.read', page: 0, size: 50 }],
          }),
        );
      }
      if (url.endsWith('/routing-plan')) {
        return Promise.resolve(
          Response.json({
            revision: '9',
            mode: 'MIXED_END_USER_READS',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            operations: operationNames.map((operation) => ({
              operation,
              transport: 'PADLHUB_API',
              fallback: 'UNAVAILABLE',
            })),
            directViva: {
              apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
              providerTenantKey: 'iSkq6G',
              accessTokenPath: '/auth/viva/access',
              allowedRequestHeaders: ['Authorization'],
            },
          }),
        );
      }
      if (url.endsWith('/auth/viva/access')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'short-lived-viva-token',
            expiresAt: '2099-07-11T12:05:00.000Z',
          }),
        );
      }
      if (url.includes('/v2/iSkq6G/bookings/history?')) {
        return Promise.resolve(
          Response.json({
            content: [],
            totalPages: 0,
            totalElements: 0,
            last: true,
            numberOfElements: 0,
            size: 50,
            number: 0,
            empty: true,
          }),
        );
      }
      if (url.includes(`/activity-history-read-jobs/${jobId}/results/${commandId}`)) {
        return Promise.resolve(
          Response.json({ accepted: true, replayed: false, itemCount: 0 }, { status: 202 }),
        );
      }
      if (url.endsWith(`/activity-history-read-jobs/${jobId}/complete`)) {
        return Promise.resolve(
          Response.json({
            screen: 'ACTIVITY_HISTORY',
            state: 'READY',
            completedCommands: 1,
            totalCommands: 1,
          }),
        );
      }
      if (url.includes('/bookings/history?')) {
        historyProjectionReads += 1;
        return Promise.resolve(
          Response.json(
            historyProjectionReads === 1 ? { ...history, freshness: 'STALE' } : history,
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getActivityHistory({ status: 'COMPLETED', limit: 20 })).resolves.toEqual(
      history,
    );

    const urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(urls).toContain(
      'https://api.vivacrm.invalid/end-user/api/v2/iSkq6G/bookings/history?includeCanceled=true&page=0&size=50',
    );
    expect(urls.at(-1)).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/bookings/history?status=COMPLETED&limit=20',
    );
  });

  it('keeps the self profile on PadlHub when a routing plan advertises direct Viva', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const operationNames = [
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read',
    ];
    const routingPlan = {
      revision: '6',
      mode: 'MIXED_END_USER_READS',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      operations: operationNames.map((operation) => ({
        operation,
        transport: operation === 'profile.read' ? 'DIRECT_VIVA' : 'PADLHUB_API',
        fallback: operation === 'profile.read' ? 'UNAVAILABLE' : 'PADLHUB_API',
      })),
      directViva: {
        apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
        providerTenantKey: 'iSkq6G',
        accessTokenPath: '/auth/viva/access',
        allowedRequestHeaders: ['Authorization'],
      },
    };
    const avatarUrl =
      '/public/api/v1/media/profile-photos/00000000-0000-4000-8000-000000000002/33333333-3333-4333-8333-333333333333';
    const padlHubProfile = {
      userId,
      displayName: 'Анна Петрова',
      avatarUrl,
      phoneLast4: '0001',
      balanceMinor: 54_000,
      currency: 'RUB',
      level: { label: 'D', value: 0, assessmentRequired: true },
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(routingPlan))
      .mockResolvedValueOnce(Response.json(padlHubProfile));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getRoutingPlan()).resolves.toEqual(routingPlan);
    const [selfProfile, profile] = await Promise.all([
      gateway.getSelfProfile(),
      gateway.getPlayerProfile(userId),
    ]);

    expect(selfProfile).toMatchObject({
      userId,
      displayName: 'Анна Петрова',
      balanceMinor: 54_000,
      avatarUrl,
    });
    expect(profile).toMatchObject({
      profile: {
        userId,
        displayName: 'Анна Петрова',
        avatarUrl,
        level: { label: 'D', value: 0, assessmentRequired: true },
      },
      privateAccount: {
        phoneLast4: '0001',
        balanceMinor: 54_000,
        currency: 'RUB',
      },
      access: { audience: 'SELF', tier: 'SELF' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls[2]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/profile',
    );
  });

  it('relays server-directed schedule reads before requesting recommendation completion', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read', 'games.play'],
      },
    };
    const operationNames = [
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read',
    ];
    const job = {
      jobId: '10000000-0000-4000-8000-000000000001',
      screen: 'FOR_ME',
      expiresAt: '2099-07-11T12:02:00.000Z',
      concurrency: 2,
      commands: [
        {
          commandId: '20000000-0000-4000-8000-000000000001',
          operation: 'schedule.read',
          date: '2026-07-30',
        },
        {
          commandId: '20000000-0000-4000-8000-000000000002',
          operation: 'schedule.read',
          date: '2026-07-31',
        },
      ],
    };
    const recommendationPage = {
      version: 'a'.repeat(64),
      generatedAt: '2026-07-30T09:00:00.000Z',
      staleAt: '2026-07-30T09:05:00.000Z',
      personalization: 'BASIC',
      items: [],
      nextCursor: null,
    };
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.endsWith('/booking-screen-read-jobs')) return Promise.resolve(Response.json(job));
      if (url.endsWith('/routing-plan')) {
        return Promise.resolve(
          Response.json({
            revision: '7',
            mode: 'MIXED_END_USER_READS',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            operations: operationNames.map((operation) => ({
              operation,
              transport: operation === 'profile.read' ? 'DIRECT_VIVA' : 'PADLHUB_API',
              fallback: operation === 'profile.read' ? 'UNAVAILABLE' : 'PADLHUB_API',
            })),
            directViva: {
              apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
              providerTenantKey: 'iSkq6G',
              accessTokenPath: '/auth/viva/access',
              allowedRequestHeaders: ['Authorization'],
            },
          }),
        );
      }
      if (url.endsWith('/auth/viva/access')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'short-lived-viva-token',
            expiresAt: '2099-07-11T12:05:00.000Z',
          }),
        );
      }
      if (url.startsWith('https://api.vivacrm.invalid/')) {
        return Promise.resolve(Response.json({ content: [] }));
      }
      if (url.includes('/results/')) {
        return Promise.resolve(
          Response.json({ accepted: true, replayed: false, itemCount: 0 }, { status: 202 }),
        );
      }
      if (url.endsWith(`/booking-screen-read-jobs/${job.jobId}/complete`)) {
        return Promise.resolve(
          Response.json({
            screen: 'FOR_ME',
            state: 'READY',
            completedCommands: 2,
            totalCommands: 2,
            page: recommendationPage,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const firstRead = gateway.listBookingRecommendations({ limit: 6 });
    const coalescedRead = gateway.listBookingRecommendations({ limit: 6 });
    expect(coalescedRead).toBe(firstRead);
    await expect(firstRead).resolves.toEqual(recommendationPage);

    const urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(
      urls.filter((url) => url.endsWith('/user/api/v1/padlhub/booking-screen-read-jobs')),
    ).toHaveLength(1);
    expect(urls.filter((url) => url.startsWith('https://api.vivacrm.invalid/'))).toHaveLength(2);
    expect(urls.filter((url) => url.endsWith('/auth/viva/access'))).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/results/'))).toHaveLength(2);
    expect(urls).toContain(
      `https://api.padlhub.test/user/api/v1/padlhub/booking-screen-read-jobs/${job.jobId}/complete`,
    );
    expect(urls.some((url) => url.includes('/recommendations/bookings'))).toBe(false);
  });

  it('loads three Home dates first and expands the same job with the remaining four', async () => {
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read', 'games.play'],
      },
    };
    const jobId = '10000000-0000-4000-8000-000000000010';
    const commands = Array.from({ length: 7 }, (_, index) => ({
      commandId: `20000000-0000-4000-8000-00000000001${index}`,
      operation: 'schedule.read',
      date: `2026-08-0${index + 1}`,
    }));
    const initialPage = {
      version: 'a'.repeat(64),
      generatedAt: '2026-08-01T09:00:00.000Z',
      staleAt: '2099-08-01T09:05:00.000Z',
      personalization: 'BASIC',
      items: [],
      nextCursor: null,
    };
    const expandedPage = { ...initialPage, version: 'b'.repeat(64) };
    let completionCount = 0;
    const completionPhases: unknown[] = [];
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.endsWith('/booking-screen-read-jobs')) {
        return Promise.resolve(
          Response.json({
            jobId,
            screen: 'FOR_ME',
            expiresAt: '2099-08-01T09:02:00.000Z',
            concurrency: 3,
            commands,
          }),
        );
      }
      if (url.endsWith('/routing-plan')) {
        return Promise.resolve(
          Response.json({
            revision: '8',
            mode: 'MIXED_END_USER_READS',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            operations: [
              'profile.read',
              'bookings.read',
              'bookings.details.read',
              'bookings.history.read',
              'subscriptions.read',
              'schedule.read',
            ].map((operation) => ({
              operation,
              transport: operation === 'profile.read' ? 'DIRECT_VIVA' : 'PADLHUB_API',
              fallback: operation === 'profile.read' ? 'UNAVAILABLE' : 'PADLHUB_API',
            })),
            directViva: {
              apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
              providerTenantKey: 'iSkq6G',
              accessTokenPath: '/auth/viva/access',
              allowedRequestHeaders: ['Authorization'],
            },
          }),
        );
      }
      if (url.endsWith('/auth/viva/access')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'short-lived-viva-token',
            expiresAt: '2099-08-01T09:05:00.000Z',
          }),
        );
      }
      if (url.startsWith('https://api.vivacrm.invalid/')) {
        return Promise.resolve(Response.json({ content: [] }));
      }
      if (url.includes('/results/')) {
        return Promise.resolve(
          Response.json({ accepted: true, replayed: false, itemCount: 0 }, { status: 202 }),
        );
      }
      if (url.endsWith(`/booking-screen-read-jobs/${jobId}/complete`)) {
        completionCount += 1;
        completionPhases.push((JSON.parse(init?.body as string) as { phase?: unknown }).phase);
        return Promise.resolve(
          Response.json({
            screen: 'FOR_ME',
            state: completionCount < 3 ? 'PARTIAL' : 'READY',
            completedCommands: completionCount < 3 ? 3 : 7,
            totalCommands: 7,
            page: completionCount < 3 ? initialPage : expandedPage,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.listHomeBookingRecommendations?.({ limit: 14 })).resolves.toEqual(
      initialPage,
    );
    let urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.filter((url) => url.startsWith('https://api.vivacrm.invalid/'))).toHaveLength(3);
    expect(urls.filter((url) => url.includes('/results/'))).toHaveLength(3);
    expect(completionPhases).toEqual(['HOME_INITIAL']);

    await expect(
      gateway.listHomeBookingRecommendations?.({ limit: 14, phase: 'TOURNAMENTS' }),
    ).resolves.toEqual(initialPage);
    urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.filter((url) => url.startsWith('https://api.vivacrm.invalid/'))).toHaveLength(3);
    expect(completionPhases).toEqual(['HOME_INITIAL', 'HOME_TOURNAMENTS']);

    await expect(
      gateway.listHomeBookingRecommendations?.({ limit: 14, phase: 'EXPANDED' }),
    ).resolves.toEqual(expandedPage);
    urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(
      urls.filter((url) => url.endsWith('/user/api/v1/padlhub/booking-screen-read-jobs')),
    ).toHaveLength(1);
    expect(urls.filter((url) => url.startsWith('https://api.vivacrm.invalid/'))).toHaveLength(7);
    expect(urls.filter((url) => url.includes('/results/'))).toHaveLength(7);
    expect(
      urls.filter((url) => url.endsWith(`/booking-screen-read-jobs/${jobId}/complete`)),
    ).toHaveLength(3);
    expect(completionPhases).toEqual(['HOME_INITIAL', 'HOME_TOURNAMENTS', 'FULL']);
  });

  it('loads the complete group-training catalog through the dedicated read screen', async () => {
    const operationNames = [
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read',
    ];
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: '00000000-0000-4000-8000-000000000001', displayName: 'Анна' },
      context: {
        userId: '00000000-0000-4000-8000-000000000001',
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read', 'games.play'],
      },
    };
    const jobId = '10000000-0000-4000-8000-000000000003';
    const trainingSchedule = {
      version: 'b'.repeat(64),
      generatedAt: '2026-07-30T09:00:00.000Z',
      staleAt: '2099-07-30T09:01:00.000Z',
      items: [],
    };
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.endsWith('/booking-screen-read-jobs')) {
        expect(JSON.parse(init?.body as string)).toEqual({ screen: 'GROUP_TRAININGS' });
        return Promise.resolve(
          Response.json({
            jobId,
            screen: 'GROUP_TRAININGS',
            expiresAt: '2099-07-11T12:02:00.000Z',
            concurrency: 3,
            commands: [
              {
                commandId: '20000000-0000-4000-8000-000000000003',
                operation: 'schedule.read',
                date: '2026-07-30',
              },
            ],
          }),
        );
      }
      if (url.endsWith('/routing-plan')) {
        return Promise.resolve(
          Response.json({
            revision: '7',
            mode: 'MIXED_END_USER_READS',
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            operations: operationNames.map((operation) => ({
              operation,
              transport: operation === 'profile.read' ? 'DIRECT_VIVA' : 'PADLHUB_API',
              fallback: operation === 'profile.read' ? 'UNAVAILABLE' : 'PADLHUB_API',
            })),
            directViva: {
              apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
              providerTenantKey: 'iSkq6G',
              accessTokenPath: '/auth/viva/access',
              allowedRequestHeaders: ['Authorization'],
            },
          }),
        );
      }
      if (url.endsWith('/auth/viva/access')) {
        return Promise.resolve(
          Response.json({
            accessToken: 'short-lived-viva-token',
            expiresAt: '2099-07-11T12:05:00.000Z',
          }),
        );
      }
      if (url.startsWith('https://api.vivacrm.invalid/')) {
        return Promise.resolve(Response.json({ content: [] }));
      }
      if (url.includes('/results/')) {
        return Promise.resolve(
          Response.json({ accepted: true, replayed: false, itemCount: 0 }, { status: 202 }),
        );
      }
      if (url.endsWith(`/booking-screen-read-jobs/${jobId}/complete`)) {
        expect(JSON.parse(init?.body as string)).toEqual({ limit: 500 });
        return Promise.resolve(
          Response.json({
            screen: 'GROUP_TRAININGS',
            state: 'READY',
            completedCommands: 1,
            totalCommands: 1,
            trainings: trainingSchedule,
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const firstRead = gateway.listTrainingSchedule();
    const coalescedRead = gateway.listTrainingSchedule();
    expect(coalescedRead).toBe(firstRead);
    await expect(firstRead).resolves.toEqual(trainingSchedule);

    const urls = fetchImplementation.mock.calls.map(([input]) => requestUrl(input));
    expect(
      urls.filter((url) => url.endsWith('/user/api/v1/padlhub/booking-screen-read-jobs')),
    ).toHaveLength(1);
    expect(urls.filter((url) => url.includes('/results/'))).toHaveLength(1);
  });

  it('keeps direct-chat commands on PadlHub HTTP with stable idempotency across a network retry', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const clientMessageId = '33333333-3333-4333-8333-333333333333';
    const session = {
      accessToken: 'short-lived-padlhub-token',
      tokenType: 'Bearer',
      expiresAt: '2099-07-11T12:10:00.000Z',
      user: { id: userId, displayName: 'Анна' },
      context: {
        userId,
        tenantId: '00000000-0000-4000-8000-000000000002',
        displayName: 'Анна',
        phoneLast4: '0001',
        roles: ['client'],
        permissions: ['profile.read'],
      },
    };
    const sentMessage = {
      id: '44444444-4444-4444-8444-444444444444',
      conversationId,
      sequence: 1,
      sender: { userId, displayName: 'Анна' },
      messageType: 'TEXT',
      body: 'Привет',
      createdAt: '2026-08-03T10:00:00.000Z',
    };
    const conversation = {
      id: conversationId,
      kind: 'DIRECT',
      participant: {
        userId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Борис',
      },
      unreadCount: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    let sendAttempts = 0;
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/auth/session/refresh')) return Promise.resolve(Response.json(session));
      if (url.endsWith('/conversations?limit=50')) {
        return Promise.resolve(Response.json({ items: [conversation] }));
      }
      if (url.endsWith('/conversations/direct')) {
        return Promise.resolve(
          Response.json({ outcome: 'ok', conversation, created: false, replayed: false }),
        );
      }
      if (url.includes(`/conversations/${conversationId}/messages?`)) {
        return Promise.resolve(Response.json({ messages: [] }));
      }
      if (url.endsWith(`/conversations/${conversationId}/read-cursor`)) {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const parsedBody: unknown = JSON.parse(init.body);
        if (
          typeof parsedBody !== 'object' ||
          parsedBody === null ||
          !('throughSequence' in parsedBody) ||
          typeof parsedBody.throughSequence !== 'number'
        ) {
          throw new Error('Expected a numeric throughSequence');
        }
        return Promise.resolve(
          Response.json({
            outcome: 'ok',
            readThroughSequence: parsedBody.throughSequence,
            changed: true,
            replayed: false,
          }),
        );
      }
      if (url.endsWith(`/conversations/${conversationId}/messages`)) {
        sendAttempts += 1;
        if (sendAttempts === 1) return Promise.reject(new TypeError('network interrupted'));
        return Promise.resolve(
          Response.json({ outcome: 'ok', message: sentMessage, replayed: false }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.listConversations()).resolves.toEqual({ items: [conversation] });
    await expect(
      gateway.createDirectConversation(conversation.participant.userId, clientMessageId),
    ).resolves.toMatchObject({ conversation, created: false });
    await expect(gateway.listConversationMessages(conversationId, 7)).resolves.toEqual({
      messages: [],
    });
    await expect(
      gateway.markConversationRead(conversationId, 7, clientMessageId),
    ).resolves.toMatchObject({ readThroughSequence: 7 });
    await expect(
      gateway.sendConversationMessage(conversationId, { clientMessageId, body: 'Привет' }),
    ).resolves.toEqual({ outcome: 'ok', message: sentMessage, replayed: false });

    const sendCalls = fetchImplementation.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith(`/conversations/${conversationId}/messages`),
    );
    expect(sendCalls).toHaveLength(2);
    for (const [, init] of sendCalls) {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(clientMessageId);
      expect(typeof init?.body).toBe('string');
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toEqual({ clientMessageId, body: 'Привет' });
    }
    const callsByUrl = new Map(
      fetchImplementation.mock.calls.map(([input, init]) => [requestUrl(input), init]),
    );
    const createInit = callsByUrl.get(
      'https://api.padlhub.test/user/api/v1/padlhub/conversations/direct',
    );
    expect(createInit?.method).toBe('POST');
    expect(new Headers(createInit?.headers).get('Idempotency-Key')).toBe(clientMessageId);
    expect(typeof createInit?.body).toBe('string');
    if (typeof createInit?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(createInit.body)).toEqual({ otherUserId: conversation.participant.userId });
    expect(
      [...callsByUrl.keys()].some((url) =>
        url.endsWith(`/conversations/${conversationId}/messages?afterSequence=7&limit=100`),
      ),
    ).toBe(true);
    const readInit = callsByUrl.get(
      `https://api.padlhub.test/user/api/v1/padlhub/conversations/${conversationId}/read-cursor`,
    );
    expect(readInit?.method).toBe('PUT');
    expect(new Headers(readInit?.headers).get('Idempotency-Key')).toBe(clientMessageId);
  });
});
