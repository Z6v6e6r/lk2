import { describe, expect, it, vi } from 'vitest';
import { createNativeApiFetch, type AndroidSessionPlugin } from './native-api-fetch.js';

const config = {
  apiBaseUrl: 'https://lk2.padlhub.su',
  tenantKey: 'local-padel',
  appVersion: 'test',
};
const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
const result = (status = 200) => ({
  status,
  headers: { 'content-type': 'application/json', 'set-cookie': 'synthetic-not-for-JS' },
  body: btoa('{"ok":true}'),
});
function plugin() {
  return {
    configuration: vi.fn().mockResolvedValue(config),
    request: vi.fn<AndroidSessionPlugin['request']>().mockResolvedValue(result()),
  };
}

describe('Android native bridge adapter', () => {
  it('resolves account and nested avatars against the API while preserving account data and routes', async () => {
    const native = plugin();
    const photo = '/public/api/v1/media/profile-photos/tenant/photo';
    const account = {
      userId: 'synthetic-account',
      displayName: 'Анна Петрова',
      firstName: 'Анна',
      lastName: 'Петрова',
      phoneLast4: '0001',
      balanceMinor: 54000,
      currency: 'RUB',
      level: { label: 'C+', value: 3.8, assessmentRequired: false },
      avatarUrl: photo,
      participants: [{ avatarUrl: photo, route: '/profile/synthetic-account' }],
    };
    native.request.mockResolvedValue({
      ...result(),
      body: Buffer.from(JSON.stringify(account)).toString('base64'),
    });
    const response = await createNativeApiFetch(config, native)(`${root}/profile`);
    expect(await response.json()).toEqual({
      ...account,
      avatarUrl: config.apiBaseUrl + photo,
      participants: [{ avatarUrl: config.apiBaseUrl + photo, route: '/profile/synthetic-account' }],
    });
    expect(native.request).toHaveBeenCalledOnce();
  });

  it('uses only the native plugin and strips credential response headers', async () => {
    const native = plugin();
    const response = await createNativeApiFetch(config, native)(`${root}/profile`, {
      credentials: 'include',
      headers: { Authorization: 'Bearer synthetic-access' },
    });
    expect(native.request).toHaveBeenCalledWith({
      path: '/user/api/v1/local-padel/profile',
      method: 'GET',
      headers: { authorization: 'Bearer synthetic-access' },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });
  it.each([
    [503, 'application/json', '{"avatarUrl":"/error","code":"UNAVAILABLE"}'],
    [200, 'text/plain', '/public/api/v1/media/photo'],
    [200, 'application/json', '{invalid'],
  ])('preserves error and non-JSON bodies (%s, %s)', async (status, contentType, body) => {
    const native = plugin();
    native.request.mockResolvedValue({
      status,
      headers: { 'Content-Type': contentType },
      body: btoa(body),
    });
    const response = await createNativeApiFetch(config, native)(`${root}/profile`);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
  });
  it.each([
    'https://api.vivacrm.invalid/end-user/api/profile',
    `${config.apiBaseUrl}/user/api/v1/other-tenant/profile`,
    `${config.apiBaseUrl}/user/api/v1/local-padel-evil/profile`,
    `${root}/../profile`,
    `${root}/%2e%2e/profile`,
    `${root}/profile#secret`,
  ])('rejects a foreign or ambiguous URL before entering native code: %s', async (url) => {
    const native = plugin();
    await expect(createNativeApiFetch(config, native)(url)).rejects.toThrow();
    expect(native.request).not.toHaveBeenCalled();
  });
  it('does not accept JS cookies or initiate an already aborted operation', async () => {
    const native = plugin();
    const fetch = createNativeApiFetch(config, native);
    await expect(fetch(`${root}/profile`, { headers: { Cookie: 'synthetic' } })).rejects.toThrow();
    await expect(fetch(`${root}/profile`, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(native.request).not.toHaveBeenCalled();
  });
  it('does not remount on empty startup, but expires an active session once after refresh 401', async () => {
    const native = plugin();
    const expire = vi.fn();
    const fetch = createNativeApiFetch(config, native, expire);
    native.request.mockResolvedValueOnce(result(401));
    await fetch(`${root}/auth/session/refresh`, { method: 'POST' });
    expect(expire).not.toHaveBeenCalled();
    await fetch(`${root}/auth/challenges/id/verify`, { method: 'POST' });
    native.request.mockResolvedValue(result(401));
    await fetch(`${root}/auth/session/refresh`, { method: 'POST' });
    await fetch(`${root}/auth/session/refresh`, { method: 'POST' });
    expect(expire).toHaveBeenCalledOnce();
  });
  it('redacts raw native failures while retaining the SDK network-retry classification', async () => {
    const native = plugin();
    native.request
      .mockRejectedValueOnce({
        code: 'NATIVE_STORAGE_UNAVAILABLE',
        message: 'sensitive-native-detail',
      })
      .mockRejectedValueOnce({
        code: 'NATIVE_NETWORK_UNAVAILABLE',
        message: 'sensitive-native-detail',
      });
    const fetch = createNativeApiFetch(config, native);
    await expect(fetch(`${root}/profile`)).rejects.toMatchObject({
      code: 'NATIVE_SESSION_UNAVAILABLE',
    });
    await expect(fetch(`${root}/profile`)).rejects.toThrow('Native network unavailable');
  });

  it('reports stale data with its saved time and clears only the same successful resource', async () => {
    const native = plugin();
    const observe = vi.fn();
    const fetch = createNativeApiFetch(config, native, undefined, observe);
    native.request.mockResolvedValueOnce({
      ...result(),
      cache: { state: 'stale', savedAt: 1_790_530_000_000 },
    });
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/home/base',
      state: 'stale',
      savedAt: 1_790_530_000_000,
    });
    await fetch(`${root}/profile`);
    expect(observe).toHaveBeenCalledOnce();
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/home/base',
      state: 'live',
    });
    native.request.mockResolvedValueOnce(result(403));
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/home/base',
      state: 'unavailable',
      invalidate: true,
    });
    await fetch(`${root}/home/base`);
    native.request.mockResolvedValueOnce(result(404));
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ invalidate: true }));
    native.request.mockResolvedValueOnce(result(404));
    await fetch(`${root}/home/base`);
    expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ invalidate: false }));
  });

  it('ignores spoofed HTTP cache metadata and late observations after logout starts', async () => {
    const native = plugin();
    const observe = vi.fn();
    const fetch = createNativeApiFetch(config, native, undefined, observe);
    native.request.mockResolvedValueOnce({
      ...result(),
      headers: { 'x-phub-cache-state': 'stale' },
    });
    await fetch(`${root}/locations`);
    expect(observe).toHaveBeenLastCalledWith({
      path: '/user/api/v1/local-padel/locations',
      state: 'live',
    });
    observe.mockClear();
    let finish!: (value: Awaited<ReturnType<AndroidSessionPlugin['request']>>) => void;
    native.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = fetch(`${root}/home/base`);
    await fetch(`${root}/auth/session`, { method: 'DELETE' });
    finish({ ...result(), cache: { state: 'stale', savedAt: 1_790_530_000_000 } });
    await pending;
    expect(observe).not.toHaveBeenCalled();
  });
});
