// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { createBrowserAuthGateway } from './auth-gateway.js';

describe('browser auth gateway', () => {
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
      'subscriptions.read',
      'schedule.read',
    ].map((operation) => ({ operation, transport: 'PADLHUB_API', fallback: 'PADLHUB_API' }));
    const profile = {
      userId,
      displayName: 'Анна Петрова',
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
    await expect(gateway.getUserProfile(userId)).resolves.toEqual(profile);

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

  it('keeps bookings behind PadlHub when a stored plan incorrectly requests direct Viva', async () => {
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
      'subscriptions.read',
      'schedule.read',
    ];
    const routingPlan = {
      revision: '99',
      mode: 'MIXED_END_USER_READS',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      operations: operationNames.map((operation) => ({
        operation,
        transport: 'DIRECT_VIVA',
        fallback: 'UNAVAILABLE',
      })),
      directViva: {
        apiBaseUrl: 'https://api.vivacrm.invalid/end-user/api',
        providerTenantKey: 'iSkq6G',
        accessTokenPath: '/auth/viva/access',
        allowedRequestHeaders: ['Authorization'],
      },
    };
    const bookings = {
      version: 'home-17',
      generatedAt: '2026-07-15T18:00:00.000Z',
      staleAt: '2026-07-15T18:05:00.000Z',
      items: [],
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(routingPlan))
      .mockResolvedValueOnce(Response.json(bookings));
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    await expect(gateway.getUpcomingBookings()).resolves.toEqual(bookings);

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fetchImplementation.mock.calls[2]?.[0]).toBe(
      'https://api.padlhub.test/user/api/v1/padlhub/bookings/upcoming',
    );
  });

  it('executes only profile.read in Viva and drops the external profile identifier', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const vivaProfileId = '7aa93a46-9fa8-42b2-9894-490874fe53f7';
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
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(session))
      .mockResolvedValueOnce(Response.json(routingPlan))
      .mockResolvedValueOnce(
        Response.json({
          accessToken: 'short-lived-viva-access-token',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: vivaProfileId,
          firstName: 'Анна',
          middleName: null,
          lastName: 'Петрова',
          phone: '+7 999 000-00-01',
          deposit: 54_000,
          customFields: [],
        }),
      );
    const gateway = createBrowserAuthGateway({
      baseUrl: 'https://api.padlhub.test/',
      tenantKey: 'padlhub',
      appVersion: 'test',
      fetchImplementation,
    });

    await gateway.restoreSession();
    const profile = await gateway.getUserProfile(userId);

    expect(profile).toMatchObject({ userId, displayName: 'Анна Петрова', balanceMinor: 54_000 });
    expect(JSON.stringify(profile)).not.toContain(vivaProfileId);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    const [vivaUrl, vivaInit] = fetchImplementation.mock.calls[3] ?? [];
    expect(vivaUrl).toBeInstanceOf(URL);
    expect((vivaUrl as URL).toString()).toBe(
      'https://api.vivacrm.invalid/end-user/api/v1/iSkq6G/profile',
    );
    expect(Object.fromEntries(new Headers(vivaInit?.headers))).toEqual({
      authorization: 'Bearer short-lived-viva-access-token',
    });
  });
});
