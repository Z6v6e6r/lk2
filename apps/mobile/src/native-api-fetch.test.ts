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
});
