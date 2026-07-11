import type { IdentityProviderError } from '@phub/auth';
import { describe, expect, it, vi } from 'vitest';

import { VivaIdentityProvider } from './identity.js';

const input = {
  phoneE164: '+79991234567',
  providerTenantKey: 'iSkq6G',
  correlationId: 'test-correlation-123',
} as const;

function options() {
  return {
    mode: 'mock' as const,
    baseUrl: 'https://kc.vivacrm.invalid',
    realm: 'clients',
    clientId: 'widget',
    channel: 'cascade',
    profileApiBaseUrl: 'https://api.vivacrm.invalid/end-user/api/v1',
    timeoutMs: 100,
    devPhoneE164: '+79990000001',
    devOtpCode: '0000',
  };
}

function fetchUrl(value: Parameters<typeof fetch>[0] | undefined): URL {
  if (typeof value === 'string') return new URL(value);
  if (value instanceof URL) return value;
  if (value instanceof Request) return new URL(value.url);
  throw new Error('Expected a fetch URL');
}

function requestBody(value: BodyInit | null | undefined): string {
  if (typeof value !== 'string') throw new Error('Expected a string request body');
  return value;
}

describe('VivaIdentityProvider', () => {
  it('supports a deterministic local Viva-mode login without exposing Viva tokens', async () => {
    const provider = new VivaIdentityProvider(options());
    const localInput = { ...input, phoneE164: '+79990000001' } as const;
    await expect(provider.requestPhoneCode(localInput)).resolves.toBeUndefined();
    const identity = await provider.verifyPhoneCode({ ...localInput, code: '0000' });
    expect(identity).toMatchObject({
      phoneE164: localInput.phoneE164,
      displayName: 'Игрок ПадлхАБ',
    });
    expect(identity).not.toHaveProperty('accessToken');
    expect(identity).not.toHaveProperty('refreshToken');
  });

  it('rejects an invalid local code with a stable PadlHub error', async () => {
    const provider = new VivaIdentityProvider(options());
    await expect(provider.verifyPhoneCode({ ...input, code: '1111' })).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID',
    } satisfies Partial<IdentityProviderError>);
  });

  it('uses the current Viva SMS and token contracts only inside the adapter', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({ access_token: 'external-secret', refresh_token: 'external-refresh' }),
      );
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation,
      resolveIdentityFromAccessToken: () =>
        Promise.resolve({
          issuer: 'https://kc.vivacrm.ru/realms/clients',
          subject: 'viva-user-42',
          phoneE164: input.phoneE164,
          displayName: 'Алексей',
        }),
    });

    await provider.requestPhoneCode(input);
    const identity = await provider.verifyPhoneCode({ ...input, code: '1234' });

    const sendUrl = fetchUrl(fetchImplementation.mock.calls[0]?.[0]);
    expect(sendUrl.pathname).toBe('/realms/clients/sms/authentication-code');
    expect(sendUrl.searchParams.get('tenantKey')).toBe('iSkq6G');
    const verifyBody = requestBody(fetchImplementation.mock.calls[1]?.[1]?.body);
    expect(verifyBody).toContain('grant_type=password');
    expect(verifyBody).toContain('client_id=widget');
    expect(identity.subject).toBe('viva-user-42');
  });

  it('opens its circuit after bounded upstream failures', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      circuitFailureThreshold: 2,
      circuitCooldownMs: 60_000,
      fetchImplementation,
    });

    await expect(provider.requestPhoneCode(input)).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    await expect(provider.requestPhoneCode(input)).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    await expect(provider.requestPhoneCode(input)).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
