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
});
