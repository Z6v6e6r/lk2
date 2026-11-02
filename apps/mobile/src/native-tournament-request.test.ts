import { describe, it, expect, vi } from 'vitest';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';
import { createBrowserAuthGateway } from '../../web/src/auth-gateway.js';
const id = '11111111-1111-4111-8111-111111111111',
  key = '22222222-2222-4222-8222-222222222222',
  config = { apiBaseUrl: 'https://lk2.padlhub.su', tenantKey: 'local-padel', appVersion: 'test' },
  root = config.apiBaseUrl + '/user/api/v1/local-padel/tournaments/' + id,
  publicRoot = config.apiBaseUrl + '/public/api/v1/local-padel/tournaments',
  range = '?dateFrom=2026-11-01&dateTo=2026-11-16',
  headers = { authorization: 'Bearer synthetic-token', 'idempotency-key': key };
const response = (body: unknown, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: btoa(JSON.stringify(body)),
});
function fixture() {
  const plugin = {
    configuration: vi.fn(),
    request: vi.fn<AndroidSessionPlugin['request']>().mockResolvedValue(response({})),
  };
  return { plugin, fetch: createNativeApiFetch(config, plugin) };
}
describe('concrete Android tournament bridge', () => {
  it('only fixed dated public discovery forwards no credentials', async () => {
    const f = fixture();
    await f.fetch(publicRoot + range);
    const request = f.plugin.request.mock.calls[0]![0];
    expect(request.path).toBe('/public/api/v1/local-padel/tournaments' + range);
    expect(request.headers).not.toHaveProperty('authorization');
    expect(request.headers).not.toHaveProperty('cookie');
    expect(request.body).toBeUndefined();
  });
  it.each([
    publicRoot + range + '&dateFrom=2026-11-02',
    publicRoot + '?dateFrom=2026-02-30&dateTo=2026-03-02',
    publicRoot + '?dateFrom=2026-11-01&dateTo=2026-11-17',
    publicRoot + range + '&limit=51',
    publicRoot + range + '&source=viva',
    publicRoot.replace('local-padel', 'foreign') + range,
    publicRoot.replace('tournaments', 'games') + range,
    publicRoot + range + '&availability=WAITLIST',
    publicRoot + '/' + id + range + '&limit=2',
  ])('refuses unexpected public request %s', async (url) => {
    const f = fixture();
    await expect(f.fetch(url)).rejects.toThrow();
    expect(f.plugin.request).not.toHaveBeenCalled();
  });
  it.each([
    { authorization: 'Bearer synthetic-token' },
    { cookie: 'synthetic-cookie' },
    { 'idempotency-key': key },
  ])('refuses credentials on public discovery', async (h) => {
    const f = fixture();
    await expect(f.fetch(publicRoot + range, { headers: h })).rejects.toThrow();
    expect(f.plugin.request).not.toHaveBeenCalled();
  });
  it('pins exact JOIN/LEAVE/retry fields, key and read selector', async () => {
    const f = fixture();
    for (const action of [{ action: 'JOIN' }, { action: 'LEAVE', originalJoinOperationId: key }])
      await f.fetch(root + '/registrations', {
        method: 'POST',
        headers,
        body: JSON.stringify(action),
      });
    await f.fetch(root + '/registration-operations/' + key + '/retry', { method: 'POST', headers });
    await f.fetch(root + '/registration-operation?operationId=' + key, { headers });
    expect(f.plugin.request).toHaveBeenCalledTimes(4);
    expect(f.plugin.request.mock.calls[1]![0].body).toBe(
      JSON.stringify({ action: 'LEAVE', originalJoinOperationId: key }),
    );
  });
  it.each([
    '{}',
    'null',
    '{"action":"JOIN","action":"JOIN"}',
    '{"action":"JOIN","gender":"MALE"}',
    '{"action":"JOIN","clientId":"7"}',
    '{"action":"LEAVE"}',
  ])('rejects forged or duplicate command body %s', async (body) => {
    const f = fixture();
    await expect(
      f.fetch(root + '/registrations', { method: 'POST', headers, body }),
    ).rejects.toThrow();
    expect(f.plugin.request).not.toHaveBeenCalled();
  });
  it.each(['/registrations?', '/waitlist', '/registration-operations/' + key + '/retry?x=1'])(
    'rejects unreviewed command route %s',
    async (path) => {
      const f = fixture();
      await expect(
        f.fetch(root + path, { method: 'POST', headers, body: '{"action":"JOIN"}' }),
      ).rejects.toThrow();
      expect(f.plugin.request).not.toHaveBeenCalled();
    },
  );
  it('actual SDK and gateway pass only native transport, no mutation401/network retry', async () => {
    for (const failure of [401, 'network'] as const) {
      const f = fixture();
      f.plugin.request.mockImplementation((input) =>
        input.path.endsWith('/refresh')
          ? Promise.resolve(
              response({
                accessToken: 'synthetic-token',
                tokenType: 'Bearer',
                expiresAt: '2099-01-01T00:00:00Z',
                user: { id, displayName: 'Synthetic' },
                context: { tenantId: key, userId: id, roles: ['client'], permissions: [] },
              }),
            )
          : failure === 'network'
            ? Promise.reject(
                Object.assign(new Error('synthetic network failure'), {
                  code: 'NATIVE_NETWORK_UNAVAILABLE',
                }),
              )
            : Promise.resolve(
                response(
                  {
                    error: {
                      code: 'AUTH_REQUIRED',
                      message: 'synthetic',
                      correlationId: 'synthetic',
                    },
                  },
                  401,
                ),
              ),
      );
      const gateway = createBrowserAuthGateway({
        baseUrl: config.apiBaseUrl,
        tenantKey: config.tenantKey,
        appVersion: 'test',
        platform: 'android',
        nativeSessionTransport: true,
        fetchImplementation: f.fetch,
      });
      await gateway.restoreSession();
      expect(gateway.tournamentPrincipal?.()).toContain(id);
      f.plugin.request.mockClear();
      await expect(gateway.commandTournament!(id, { action: 'JOIN' }, key)).rejects.toThrow();
      expect(f.plugin.request).toHaveBeenCalledTimes(1);
      expect(f.plugin.request.mock.calls[0]![0].path).toBe(
        '/user/api/v1/local-padel/tournaments/' + id + '/registrations',
      );
    }
  });
  it('unreviewed Android memory transport remains closed', async () => {
    const transport = vi.fn<typeof fetch>();
    const gateway = createBrowserAuthGateway({
      baseUrl: config.apiBaseUrl,
      tenantKey: config.tenantKey,
      appVersion: 'test',
      platform: 'android',
      fetchImplementation: transport,
    });
    expect(gateway.tournamentPrincipal?.()).toBeNull();
    await expect(gateway.commandTournament!(id, { action: 'JOIN' }, key)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
