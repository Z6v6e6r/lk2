import { describe, expect, it, vi } from 'vitest';
import { createNativeApiFetch } from './native-api-fetch.js';

const config = {
  apiBaseUrl: 'https://lk.nano.padlhub.su',
  tenantKey: 'padlhub',
  appVersion: 'test',
};
const root = `${config.apiBaseUrl}/user/api/v1/padlhub`;
describe('native API boundary', () => {
  it('sends first-party requests without cookies or redirect credential forwarding', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const fetch = createNativeApiFetch(config, transport);
    await fetch(`${root}/profile`, {
      credentials: 'include',
      headers: { Authorization: 'Bearer test-only' },
    });
    expect(transport).toHaveBeenCalledWith(
      `${root}/profile`,
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
      }),
    );
    expect(transport.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    'https://api.vivacrm.invalid/end-user/api/profile',
    `${config.apiBaseUrl}/user/api/v1/other-tenant/profile`,
    `${config.apiBaseUrl}/user/api/v1/padlhub-evil/profile`,
    `${config.apiBaseUrl}/redirect`,
    `${root}/auth/viva/access`,
    `${root}/booking-screen-read-jobs`,
    `${root}/notification-endpoints/web`,
  ])('blocks unsupported destinations without making a request: %s', async (url) => {
    const transport = vi.fn<typeof fetch>();
    await expect(createNativeApiFetch(config, transport)(url)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not attempt a cookie refresh', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 }));
    const fetch = createNativeApiFetch(config, transport);
    await fetch(`${root}/auth/challenges/test/verify`);
    await fetch(`${root}/profile`);
    await expect(fetch(`${root}/auth/session/refresh`)).rejects.toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
