import { describe, expect, it, vi } from 'vitest';
import { PadlHubApiClient } from '@phub/api-sdk';
import type { AuthenticatedSession } from '@phub/api-sdk';

import { createIOSFetch, IOSSession } from './session.js';
import type { IOSConfiguration, IOSSessionPlugin } from './session.js';

const config: IOSConfiguration = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: '1.0',
  appBuild: '1',
};
const fixture: AuthenticatedSession = {
  accessToken: 'synthetic-short-lived-access',
  tokenType: 'Bearer',
  expiresAt: '2099-01-01T00:00:00Z',
  user: { id: '11111111-1111-4111-8111-111111111111', displayName: 'Тест' },
  context: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Тест',
    roles: ['client'],
    permissions: ['profile.read'],
  },
};
function result(body: unknown, status = 200) {
  return {
    status,
    body: status === 204 ? '' : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  };
}
function setup(request = vi.fn<IOSSessionPlugin['request']>().mockResolvedValue(result(fixture))) {
  const plugin: IOSSessionPlugin = { configuration: () => Promise.resolve(config), request };
  const api = new PadlHubApiClient({
    baseUrl: config.apiBaseUrl,
    tenantKey: config.tenantKey,
    platform: 'ios',
    appVersion: config.appVersion,
    fetchImplementation: createIOSFetch(config, plugin),
  });
  return { request, plugin, api, session: new IOSSession(config, api) };
}
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;

describe('iOS first-party session adapter', () => {
  it.each([
    'https://vivacrm.test/user/api/v1/local-padel/context',
    'https://lk2.padlhub.su.evil.test/user/api/v1/local-padel/context',
    `${root}/../other/context`,
    `${root}/%2e%2e/context`,
    `${root}/context?token=secret`,
    `${root}/context#x`,
    `${root}/auth/viva/authorize`,
    `${root}/profile`,
    `${root}/games`,
    `${root}/context/`,
  ])('rejects non-allowlisted URL %s without a bridge call', async (url) => {
    const { plugin, request } = setup();
    await expect(createIOSFetch(config, plugin)(url)).rejects.toMatchObject({
      code: 'NATIVE_REQUEST_REJECTED',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('retries network failures using the existing SDK idempotency key, without cookie or bearer on refresh', async () => {
    const { api, request } = setup(
      vi
        .fn<IOSSessionPlugin['request']>()
        .mockRejectedValueOnce({
          code: 'NATIVE_NETWORK_UNAVAILABLE',
          message: 'Do not expose raw native errors',
        })
        .mockResolvedValueOnce(result(fixture)),
    );
    await api.refreshSession();
    expect(request).toHaveBeenCalledTimes(2);
    const first = request.mock.calls[0]![0];
    const second = request.mock.calls[1]![0];
    expect(first.operation).toBe('refresh');
    expect(first.headers['idempotency-key']).toBe(second.headers['idempotency-key']);
    expect(first.headers['x-session-intent']).toBe('refresh');
    expect(first.headers['x-app-platform']).toBe('ios');
    expect(first.headers.cookie).toBeUndefined();
    expect(first.headers.authorization).toBeUndefined();
    expect(api.getAccessToken()).toBe(fixture.accessToken);
  });

  it('never falls back to browser fetch and does not retry a Keychain error as a network error', async () => {
    const { api, request } = setup(
      vi.fn<IOSSessionPlugin['request']>().mockRejectedValue({
        code: 'NATIVE_STORAGE_UNAVAILABLE',
        message: 'sensitive diagnostics',
      }),
    );
    await expect(api.refreshSession()).rejects.toMatchObject({
      code: 'NATIVE_SESSION_UNAVAILABLE',
      message: 'Native session unavailable',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(api.getAccessToken()).toBeUndefined();
  });

  it('strips cookie response headers defensively at the JS boundary', async () => {
    const { plugin } = setup(
      vi.fn<IOSSessionPlugin['request']>().mockResolvedValue({
        ...result({}),
        headers: {
          'Set-Cookie': 'must-not-reach-response',
          Cookie: 'secret',
          'X-Correlation-ID': 'correlation',
        },
      }),
    );
    const response = await createIOSFetch(config, plugin)(`${root}/context`);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cookie')).toBeNull();
    expect(response.headers.get('x-correlation-id')).toBe('correlation');
  });

  it('coalesces concurrent expired reads into one refresh and retries with the new access token', async () => {
    let reads = 0;
    const { api, request } = setup(
      vi.fn<IOSSessionPlugin['request']>().mockImplementation((input) => {
        if (input.operation === 'refresh') return Promise.resolve(result(fixture));
        reads++;
        if (reads <= 2) return Promise.resolve(result({ code: 'AUTH_SESSION_REVOKED' }, 401));
        expect(input.headers.authorization).toBe(`Bearer ${fixture.accessToken}`);
        return Promise.resolve(result(fixture.context));
      }),
    );
    api.setAccessToken('expired-access');
    await Promise.all([api.getUserContext(), api.getUserContext()]);
    expect(request.mock.calls.filter(([input]) => input.operation === 'refresh')).toHaveLength(1);
    expect(reads).toBe(4);
  });

  it('restores once, distinguishes revoked from offline, and clears access on logout', async () => {
    const { api, request, session } = setup();
    const first = session.restore();
    expect(session.restore()).toBe(first);
    await first;
    expect(session.getSnapshot()).toEqual({ status: 'signed-in', session: fixture });
    request.mockResolvedValueOnce(result(null, 204));
    await session.logout();
    expect(session.getSnapshot().status).toBe('signed-out');
    expect(api.getAccessToken()).toBeUndefined();
    request.mockResolvedValueOnce(result({ code: 'AUTH_SESSION_REVOKED' }, 401));
    await session.restore();
    expect(session.getSnapshot().status).toBe('signed-out');
    request.mockResolvedValueOnce(result({ code: 'UNAVAILABLE' }, 503));
    await session.restore();
    expect(session.getSnapshot()).toEqual({ status: 'offline', retry: 'restore' });
  });

  it('does not claim logout success during a network failure and retries revocation', async () => {
    const { api, request, session } = setup();
    await session.restore();
    request.mockRejectedValue({ code: 'NATIVE_NETWORK_UNAVAILABLE' });
    await session.logout();
    expect(api.getAccessToken()).toBeUndefined();
    expect(session.getSnapshot()).toEqual({ status: 'offline', retry: 'logout' });
    request.mockResolvedValue(result(null, 204));
    await session.logout();
    expect(session.getSnapshot().status).toBe('signed-out');
  });

  it('rejects a second lifecycle operation until restoration finishes', async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const { session } = setup(
      vi.fn<IOSSessionPlugin['request']>().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      ),
    );
    const restore = session.restore();
    await expect(session.logout()).rejects.toThrow('Session operation in progress');
    finish(result(fixture));
    await restore;
    expect(session.getSnapshot().status).toBe('signed-in');
  });

  it('requires exactly four OTP digits and reuses the API acceptance contract', async () => {
    const { request, session } = setup(
      vi
        .fn<IOSSessionPlugin['request']>()
        .mockResolvedValueOnce(result({ code: 'AUTH_SESSION_REVOKED' }, 401)),
    );
    await session.restore();
    for (const code of ['123', '123456', 'abcd'])
      await expect(session.verify(fixture.user.id, code)).rejects.toMatchObject({
        code: 'NATIVE_REQUEST_REJECTED',
      });
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce(result(fixture));
    await session.verify(fixture.user.id, '1234');
    const verification = request.mock.calls[1]![0];
    expect(verification.operation).toBe('verify');
    expect(JSON.parse(verification.body!)).toEqual({
      code: '1234',
      acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
    });
    expect(session.getSnapshot().status).toBe('signed-in');
  });
});
