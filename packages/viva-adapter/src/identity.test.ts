import type { IdentityProviderError } from '@phub/auth';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { VivaIdentityProvider, type VivaIdentityMetric } from './identity.js';

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
    oauthScopes: 'openid',
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

async function signedAccessToken(claims: Record<string, unknown>) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const accessToken = await new SignJWT({ azp: 'widget', tenant_key: 'iSkq6G', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://kc.vivacrm.invalid/realms/clients')
    .setSubject('viva-user-42')
    .setExpirationTime('5m')
    .sign(privateKey);
  return { accessToken, jwk };
}

function tokenAndJwksFetch(accessToken: string, jwk: Record<string, unknown>) {
  return vi.fn<typeof fetch>((request) => {
    const url = fetchUrl(request);
    if (url.pathname.endsWith('/protocol/openid-connect/token')) {
      return Promise.resolve(
        Response.json({ access_token: accessToken, refresh_token: 'external-refresh' }),
      );
    }
    if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

describe('VivaIdentityProvider', () => {
  it('supports deterministic mock login without exposing Viva tokens', async () => {
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

  it('rejects an invalid mock code with a stable PadlHub error', async () => {
    const provider = new VivaIdentityProvider(options());
    await expect(provider.verifyPhoneCode({ ...input, code: '1111' })).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID',
    } satisfies Partial<IdentityProviderError>);
  });

  it('uses the current Viva SMS and token contracts only inside the adapter', async () => {
    const { accessToken, jwk } = await signedAccessToken({
      phone_number: '79991234567',
      phone_number_verified: true,
      name: 'Алексей',
    });
    const fetchImplementation = vi.fn<typeof fetch>((request) => {
      const url = fetchUrl(request);
      if (url.pathname.endsWith('/sms/authentication-code')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        return Promise.resolve(
          Response.json({ access_token: accessToken, refresh_token: 'external-refresh' }),
        );
      }
      if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation,
    });

    await provider.requestPhoneCode(input);
    const verification = await provider.verifyPhoneCode({ ...input, code: '1234' });

    const sendUrl = fetchUrl(fetchImplementation.mock.calls[0]?.[0]);
    expect(sendUrl.pathname).toBe('/realms/clients/sms/authentication-code');
    expect(sendUrl.searchParams.get('phoneNumber')).toBe('79991234567');
    expect(sendUrl.searchParams.get('tenantKey')).toBe('iSkq6G');
    const verifyParams = new URLSearchParams(
      requestBody(fetchImplementation.mock.calls[1]?.[1]?.body),
    );
    expect(verifyParams.get('grant_type')).toBe('password');
    expect(verifyParams.get('phone_number')).toBe('79991234567');
    expect(verifyParams.get('client_id')).toBe('widget');
    expect(verifyParams.get('tenant_key')).toBe('iSkq6G');
    expect(verification).toMatchObject({
      identity: { subject: 'viva-user-42', phoneE164: '+79991234567' },
      delegation: { refreshToken: 'external-refresh' },
    });
    expect(verification).not.toHaveProperty('accessToken');
  });

  it('resolves OTP identity from verified token claims without an End User API request', async () => {
    const { accessToken, jwk } = await signedAccessToken({
      phone_number: '79991234567',
      phone_number_verified: true,
      name: 'Alexey Sergeev',
    });
    const fetchImplementation = tokenAndJwksFetch(accessToken, jwk);
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation,
    });

    const result = await provider.verifyPhoneCode({ ...input, code: '1234' });

    expect(result).toMatchObject({
      identity: {
        issuer: 'https://kc.vivacrm.invalid/realms/clients',
        subject: 'viva-user-42',
        phoneE164: input.phoneE164,
        displayName: 'Alexey Sergeev',
      },
      delegation: { refreshToken: 'external-refresh' },
    });
    expect(fetchImplementation.mock.calls.map(([request]) => fetchUrl(request).pathname)).toEqual([
      '/realms/clients/protocol/openid-connect/token',
      '/realms/clients/protocol/openid-connect/certs',
    ]);
  });

  it.each([
    ['a mismatched phone', { phone_number: '+79990000000', phone_number_verified: true }],
    ['an unverified phone', { phone_number: '79991234567', phone_number_verified: false }],
    [
      'a mismatched tenant',
      {
        phone_number: '79991234567',
        phone_number_verified: true,
        tenant_key: 'anotherTenant',
      },
    ],
    [
      'a mismatched authorized party',
      {
        phone_number: '79991234567',
        phone_number_verified: true,
        azp: 'another-client',
      },
    ],
  ])('rejects OTP identity with %s', async (_label, claims) => {
    const { accessToken, jwk } = await signedAccessToken(claims);
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    await expect(provider.verifyPhoneCode({ ...input, code: '1234' })).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects an OTP access token with an invalid signature', async () => {
    const { accessToken } = await signedAccessToken({
      phone_number: '79991234567',
      phone_number_verified: true,
    });
    const { jwk: unrelatedJwk } = await signedAccessToken({
      phone_number: '79991234567',
      phone_number_verified: true,
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: tokenAndJwksFetch(accessToken, unrelatedJwk),
    });

    await expect(provider.verifyPhoneCode({ ...input, code: '1234' })).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
  });

  it('returns a verified existing subject for OAuth without an End User API request', async () => {
    const { accessToken, jwk } = await signedAccessToken({ name: 'Social Account Name' });
    const fetchImplementation = tokenAndJwksFetch(accessToken, jwk);
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation,
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-subject-correlation-123',
    });

    expect(result.identityResolution).toBe('EXISTING_SUBJECT');
    expect(result.identity).toEqual({
      issuer: 'https://kc.vivacrm.invalid/realms/clients',
      subject: 'viva-user-42',
      displayName: 'Social Account Name',
    });
    expect(metrics.map((metric) => metric.operation)).toEqual([
      'oauth_token_exchange',
      'jwt_verify',
      'oauth_exchange',
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('fails closed for OAuth when existing-subject bootstrap is disabled', async () => {
    const { accessToken, jwk } = await signedAccessToken({ name: 'Social Account Name' });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-correlation-123',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('allows subject-only OAuth recovery when standard bootstrap is disabled', async () => {
    const { accessToken, jwk } = await signedAccessToken({ name: 'Linked Account Name' });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'recovery-authorization-code',
        codeVerifier: 'recovery-pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-recovery-correlation-123',
        identityMode: 'RECOVERY_SUBJECT_ONLY',
      }),
    ).resolves.toMatchObject({
      identity: {
        issuer: 'https://kc.vivacrm.invalid/realms/clients',
        subject: 'viva-user-42',
      },
      identityResolution: 'EXISTING_SUBJECT',
    });
  });

  it('reports a safe OAuth failure stage without logging provider credentials', async () => {
    const metrics: unknown[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ access_token: 'external-secret' })),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-correlation-123',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });

    expect(metrics).toEqual([
      expect.objectContaining({
        correlationId: 'oauth-correlation-123',
        operation: 'oauth_exchange',
        outcome: 'unavailable',
        status: 200,
        failureStage: 'refresh_token',
      }),
    ]);
    expect(JSON.stringify(metrics)).not.toContain('external-secret');
    expect(JSON.stringify(metrics)).not.toContain('authorization-code');
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
