// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
import { auth, config } from './ios/testing/cabinet-fixtures.js';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222';
const requestUrl = (url: Parameters<typeof fetch>[0]) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
afterEach(() => vi.restoreAllMocks());
it.each(['logout', 'refresh'] as const)(
  'Android original command rejects late ACK after %s and duplicate dispatch',
  async (mode) => {
    let finish!: (r: Response) => void,
      refreshes = 0;
    const fetchImplementation = vi.fn<typeof fetch>((url) =>
      requestUrl(url).endsWith('/auth/session/refresh')
        ? Promise.resolve(Response.json({ ...auth, accessToken: `synthetic-token-${++refreshes}` }))
        : requestUrl(url).endsWith('/participants/me')
          ? new Promise((r) => {
              finish = r;
            })
          : Promise.resolve(Response.json({})),
    );
    const gateway = createBrowserAuthGateway({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      appVersion: 'test',
      platform: 'android',
      nativeSessionTransport: true,
      fetchImplementation,
    });
    await gateway.restoreSession();
    const pending = gateway.leaveGame(id, { idempotencyKey: key }),
      rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(gateway.leaveGame(id, { idempotencyKey: key })).rejects.toThrow();
    if (mode === 'logout') gateway.closeQuarterCreate?.();
    else await gateway.restoreSession();
    finish(Response.json({}));
    await rejected;
    expect(
      fetchImplementation.mock.calls.filter(([url]) =>
        requestUrl(url).endsWith('/participants/me'),
      ),
    ).toHaveLength(1);
  },
);
it.each([401, 503, 'network'] as const)('Android no mutation replay after %s', async (status) => {
  const fetchImplementation = vi.fn<typeof fetch>((url) =>
    requestUrl(url).endsWith('/auth/session/refresh')
      ? Promise.resolve(Response.json(auth))
      : status === 'network'
        ? Promise.reject(new TypeError('lost ACK'))
        : Promise.resolve(
            Response.json({ error: { code: 'UNAVAILABLE', message: 'unavailable' } }, { status }),
          ),
  );
  const gateway = createBrowserAuthGateway({
    baseUrl: config.apiBaseUrl,
    tenantKey: config.tenantKey,
    appVersion: 'test',
    platform: 'android',
    nativeSessionTransport: true,
    fetchImplementation,
  });
  await gateway.restoreSession();
  await expect(gateway.leaveGame(id, { idempotencyKey: key })).rejects.toThrow();
  expect(
    fetchImplementation.mock.calls.filter(([url]) => requestUrl(url).endsWith('/participants/me')),
  ).toHaveLength(1);
  expect(
    fetchImplementation.mock.calls.filter(([url]) =>
      requestUrl(url).endsWith('/auth/session/refresh'),
    ),
  ).toHaveLength(1);
});
it('rejects original ACK when token rotates while SDK decodes the response body', async () => {
  let release!: (v: unknown) => void,
    refreshes = 0;
  const body = vi.fn(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const response = Response.json({});
  vi.spyOn(response, 'json').mockImplementation(body);
  const fetchImplementation = vi.fn<typeof fetch>((url) =>
    Promise.resolve(
      requestUrl(url).endsWith('/auth/session/refresh')
        ? Response.json({ ...auth, accessToken: `synthetic-token-${++refreshes}` })
        : response,
    ),
  );
  const gateway = createBrowserAuthGateway({
    baseUrl: config.apiBaseUrl,
    tenantKey: config.tenantKey,
    appVersion: 'test',
    platform: 'android',
    nativeSessionTransport: true,
    fetchImplementation,
  });
  await gateway.restoreSession();
  const command = gateway.leaveGame(id, { idempotencyKey: key }),
    rejected = expect(command).rejects.toThrow('AUTH_PRINCIPAL_CHANGED');
  await vi.waitFor(() => expect(release).toBeDefined());
  await gateway.restoreSession();
  release({});
  await rejected;
  expect(
    fetchImplementation.mock.calls.filter(([url]) => requestUrl(url).endsWith('/participants/me')),
  ).toHaveLength(1);
});
