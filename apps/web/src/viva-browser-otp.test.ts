import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeVivaBrowserPhoneCode,
  requestVivaBrowserPhoneCode,
  VIVA_BROWSER_OTP_TIMEOUT_MS,
} from './viva-browser-otp.js';

const transport = {
  kind: 'browser_phone_otp_v1' as const,
  requestCodeUrl: 'https://kc.example.test/realms/clients/sms/authentication-code',
  tokenUrl: 'https://kc.example.test/realms/clients/protocol/openid-connect/token',
  clientId: 'widget',
  channel: 'cascade',
  providerTenantKey: 'iSkq6G',
  phoneNumber: '79990000001',
};

afterEach(() => vi.unstubAllGlobals());

describe('Viva browser OTP transport', () => {
  it('sends exactly the public browser request without credentials or custom headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await requestVivaBrowserPhoneCode(transport);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0];
    if (!(url instanceof URL)) throw new Error('Expected URL');
    expect(url.toString()).toContain('phoneNumber=79990000001');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'omit' });
  });

  it('uses form POST and returns only the access token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'discard-me' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeVivaBrowserPhoneCode(transport, '1234')).resolves.toBe('access-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected string body');
    expect(body).toContain('phone_number=79990000001');
  });

  it('maps provider 401 without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeVivaBrowserPhoneCode(transport, '1234')).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled browser request and does not retry it', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const request = requestVivaBrowserPhoneCode(transport);
    const rejected = expect(request).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(VIVA_BROWSER_OTP_TIMEOUT_MS);

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
