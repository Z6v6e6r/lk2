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
    profileApiBaseUrl: 'https://api.vivacrm.invalid/end-user/api/v1',
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
    const verification = await provider.verifyPhoneCode({ ...input, code: '1234' });

    const sendUrl = fetchUrl(fetchImplementation.mock.calls[0]?.[0]);
    expect(sendUrl.pathname).toBe('/realms/clients/sms/authentication-code');
    expect(sendUrl.searchParams.get('tenantKey')).toBe('iSkq6G');
    const verifyBody = requestBody(fetchImplementation.mock.calls[1]?.[1]?.body);
    expect(verifyBody).toContain('grant_type=password');
    expect(verifyBody).toContain('client_id=widget');
    expect(verification).toMatchObject({
      identity: { subject: 'viva-user-42' },
      delegation: { refreshToken: 'external-refresh' },
    });
    expect(verification).not.toHaveProperty('accessToken');
  });

  it('binds OAuth subjects to the stable Viva profile identifier', async () => {
    const metrics: VivaIdentityMetric[] = [];
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
    const accessToken = await new SignJWT({
      azp: 'widget',
      name: 'Social Account Name',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.vivacrm.invalid/realms/clients')
      .setSubject('provider-specific-subject')
      .setExpirationTime('5m')
      .sign(privateKey);
    const fetchImplementation = vi.fn<typeof fetch>((request) => {
      const url = fetchUrl(request);
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        return Promise.resolve(
          Response.json({ access_token: accessToken, refresh_token: 'external-refresh' }),
        );
      }
      if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      if (url.pathname.endsWith('/iSkq6G/profile')) {
        return Promise.resolve(
          Response.json({
            id: 'viva-profile-42',
            firstName: 'Алексей',
            lastName: 'Сергеев',
            phone: '+79603073190',
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation,
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-correlation-123',
      identityMode: 'STANDARD',
    });

    expect(result.identity).toMatchObject({
      subject: 'provider-specific-subject',
      providerUserId: 'viva-profile-42',
      displayName: 'Алексей Сергеев',
      phoneE164: '+79603073190',
    });
    expect(result.identityResolution).toBe('CANONICAL_PROFILE');
    const profileCall = fetchImplementation.mock.calls.find(([request]) =>
      fetchUrl(request).pathname.endsWith('/iSkq6G/profile'),
    );
    const profileHeaders = new Headers(profileCall?.[1]?.headers);
    expect(profileHeaders.get('Authorization')).toBe(`Bearer ${accessToken}`);
    expect(profileHeaders.get('Accept')).toBe('application/json');
    expect(profileHeaders.get('X-Correlation-ID')).toBe('oauth-correlation-123');
    expect(
      metrics.map((metric) => ({
        operation: metric.operation,
        outcome: metric.outcome,
        status: metric.status,
        correlationId: metric.correlationId,
      })),
    ).toEqual([
      {
        operation: 'oauth_token_exchange',
        outcome: 'success',
        status: 200,
        correlationId: 'oauth-correlation-123',
      },
      {
        operation: 'jwt_verify',
        outcome: 'success',
        status: undefined,
        correlationId: 'oauth-correlation-123',
      },
      {
        operation: 'profile_read',
        outcome: 'success',
        status: 200,
        correlationId: 'oauth-correlation-123',
      },
      {
        operation: 'oauth_exchange',
        outcome: 'success',
        status: 200,
        correlationId: undefined,
      },
    ]);
  });

  it('returns a verified existing-subject bootstrap when server profile reads are forbidden', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
    const accessToken = await new SignJWT({
      azp: 'widget',
      name: 'Social Account Name',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.vivacrm.invalid/realms/clients')
      .setSubject('already-linked-subject')
      .setExpirationTime('5m')
      .sign(privateKey);
    const fetchImplementation = vi.fn<typeof fetch>((request) => {
      const url = fetchUrl(request);
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        return Promise.resolve(
          Response.json({ access_token: accessToken, refresh_token: 'external-refresh' }),
        );
      }
      if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      if (url.pathname.endsWith('/iSkq6G/profile')) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation,
    });

    const result = await provider.exchangeAuthorizationCode({
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-subject-correlation-123',
      identityMode: 'STANDARD',
    });

    expect(result.identityResolution).toBe('EXISTING_SUBJECT');
    expect(result.identity).toEqual({
      issuer: 'https://kc.vivacrm.invalid/realms/clients',
      subject: 'already-linked-subject',
    });
    expect(result.accessToken).toBe(accessToken);
    expect(result.refreshToken).toBe('external-refresh');
  });

  it('resolves authenticated recovery from verified token claims without a profile request', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
    const accessToken = await new SignJWT({
      azp: 'widget',
      name: 'Existing Account Name',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.vivacrm.invalid/realms/clients')
      .setSubject('already-linked-recovery-subject')
      .setExpirationTime('5m')
      .sign(privateKey);
    const metrics: VivaIdentityMetric[] = [];
    let profileCalls = 0;
    const fetchImplementation = vi.fn<typeof fetch>((request) => {
      const url = fetchUrl(request);
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        return Promise.resolve(
          Response.json({ access_token: accessToken, refresh_token: 'recovered-refresh-token' }),
        );
      }
      if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      if (url.pathname.endsWith('/iSkq6G/profile')) {
        profileCalls += 1;
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation,
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      code: 'recovery-authorization-code',
      codeVerifier: 'recovery-pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-recovery-correlation-123',
      identityMode: 'RECOVERY_SUBJECT_ONLY',
    });

    expect(result.identityResolution).toBe('EXISTING_SUBJECT');
    expect(result.identity).toEqual({
      issuer: 'https://kc.vivacrm.invalid/realms/clients',
      subject: 'already-linked-recovery-subject',
    });
    expect(result.accessToken).toBe(accessToken);
    expect(result.refreshToken).toBe('recovered-refresh-token');
    expect(profileCalls).toBe(0);
    expect(metrics.map((metric) => metric.operation)).toEqual([
      'oauth_token_exchange',
      'jwt_verify',
      'oauth_exchange',
    ]);
  });

  it('does not use subject-only OAuth bootstrap for non-policy profile failures', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
    const accessToken = await new SignJWT({ azp: 'widget' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.vivacrm.invalid/realms/clients')
      .setSubject('already-linked-subject')
      .setExpirationTime('5m')
      .sign(privateKey);
    const fetchImplementation = vi.fn<typeof fetch>((request) => {
      const url = fetchUrl(request);
      if (url.pathname.endsWith('/protocol/openid-connect/token')) {
        return Promise.resolve(
          Response.json({ access_token: accessToken, refresh_token: 'external-refresh' }),
        );
      }
      if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      if (url.pathname.endsWith('/iSkq6G/profile')) {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation,
    });

    await expect(
      provider.exchangeAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-non-policy-correlation-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('reports the safe OAuth failure stage without logging provider credentials', async () => {
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
        identityMode: 'STANDARD',
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
