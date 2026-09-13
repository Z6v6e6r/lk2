import type { IdentityProviderError } from '@phub/auth';
import { readFileSync } from 'node:fs';
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
  const accessToken = await new SignJWT({
    azp: 'widget',
    tenant_key: 'iSkq6G',
    identity_provider: 'yandex',
    ...claims,
  })
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

async function signedTokenPair(
  accessClaims: Record<string, unknown>,
  idClaims: Record<string, unknown>,
  subjects: { readonly access?: string; readonly id?: string } = {},
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const sign = (claims: Record<string, unknown>, subject: string) =>
    new SignJWT({
      azp: 'widget',
      tenant_key: 'iSkq6G',
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.vivacrm.invalid/realms/clients')
      .setSubject(subject)
      .setExpirationTime('5m')
      .sign(privateKey);
  return {
    accessToken: await sign(accessClaims, subjects.access ?? 'viva-user-42'),
    idToken: await sign(idClaims, subjects.id ?? 'viva-user-42'),
    jwk,
  };
}

function tokenPairAndJwksFetch(accessToken: string, idToken: string, jwk: Record<string, unknown>) {
  return vi.fn<typeof fetch>((request) => {
    const url = fetchUrl(request);
    if (url.pathname.endsWith('/protocol/openid-connect/token')) {
      return Promise.resolve(
        Response.json({
          access_token: accessToken,
          id_token: idToken,
          refresh_token: 'external-refresh',
        }),
      );
    }
    if (url.pathname.endsWith('/protocol/openid-connect/certs')) {
      return Promise.resolve(Response.json({ keys: [jwk] }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

describe('VivaIdentityProvider', () => {
  it('pins the redacted claim shape observed in a successful LK1 SMS login HAR', () => {
    const evidence = JSON.parse(
      readFileSync(
        new URL(
          '../../../docs/evidence/viva/lk1-successful-sms-login-contract.redacted.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      readonly responseStatus: number;
      readonly jwt: { readonly alg: string; readonly claims: Record<string, unknown> };
      readonly request: { readonly phoneNumber: string };
      readonly normalizedPhoneMatchesRequest: boolean;
    };

    expect(evidence).toMatchObject({
      responseStatus: 200,
      jwt: {
        alg: 'RS256',
        claims: {
          azp: 'string',
          tenant_key: 'string',
          sub: 'string',
          phone_number: 'digits_without_plus',
          phone_number_verified: true,
          exp: 'number',
        },
      },
      request: { phoneNumber: 'digits_without_plus' },
      normalizedPhoneMatchesRequest: true,
    });
  });

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
    expect(fetchImplementation.mock.calls.map(([request]) => fetchUrl(request).origin)).toEqual([
      'https://kc.vivacrm.invalid',
      'https://kc.vivacrm.invalid',
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
      provider: 'yandex',
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
      subject: 'viva-user-42',
    });
    expect(metrics.map((metric) => metric.operation)).toEqual([
      'oauth_token_exchange',
      'jwt_verify',
      'oauth_exchange',
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('accepts broker provenance from the signed ID token when the access token omits it', async () => {
    const { accessToken, idToken, jwk } = await signedTokenPair(
      {},
      { identity_provider: 'yandex' },
    );
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenPairAndJwksFetch(accessToken, idToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-id-token-provenance-123',
      identityMode: 'STANDARD',
    });

    expect(result.identityResolution).toBe('EXISTING_SUBJECT');
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'jwt_verify',
        outcome: 'success',
        provenance: 'id_token',
      }),
    );
  });

  it('records provenance from the access token when both tokens carry it', async () => {
    const { accessToken, idToken, jwk } = await signedTokenPair(
      { identity_provider: 'yandex' },
      { identity_provider: 'yandex' },
    );
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenPairAndJwksFetch(accessToken, idToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-provenance-both-123',
      identityMode: 'STANDARD',
    });

    expect(result.identityResolution).toBe('EXISTING_SUBJECT');
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'jwt_verify',
        outcome: 'success',
        provenance: 'both',
      }),
    );
  });

  it('rejects a broker provenance mismatch between the access token and the ID token', async () => {
    const { accessToken, idToken, jwk } = await signedTokenPair(
      { identity_provider: 'vkid' },
      { identity_provider: 'yandex' },
    );
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenPairAndJwksFetch(accessToken, idToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-provenance-mismatch-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'oauth_exchange',
        failureStage: 'access_token_claims',
        claimFailure: 'provenance_conflict',
      }),
    );
  });

  it('accepts a login whose tokens carry no broker provenance and records the absence', async () => {
    const { accessToken, idToken, jwk } = await signedTokenPair({}, {});
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenPairAndJwksFetch(accessToken, idToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-missing-provenance-123',
      identityMode: 'STANDARD',
    });

    expect(result.identityResolution).toBe('EXISTING_SUBJECT');
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'jwt_verify',
        outcome: 'success',
        provenance: 'absent',
      }),
    );
  });

  it('still fails closed on an absent ID token when broker provenance contradicts the provider', async () => {
    const { accessToken, jwk } = await signedAccessToken({ identity_provider: 'vkid' });
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-provenance-mismatch-456',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'oauth_exchange',
        failureStage: 'access_token_claims',
        claimFailure: 'provenance_mismatch',
      }),
    );
  });

  it('names the tenant-key claim when the token belongs to another tenant', async () => {
    const { accessToken, jwk } = await signedAccessToken({ tenant_key: 'other-tenant' });
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-tenant-key-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'oauth_exchange',
        failureStage: 'access_token_claims',
        claimFailure: 'tenant_key',
      }),
    );
  });

  it('names the authorized-party claim when the token was issued to another client', async () => {
    const { accessToken, jwk } = await signedAccessToken({ azp: 'some-other-client' });
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-authorized-party-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'oauth_exchange',
        failureStage: 'access_token_claims',
        claimFailure: 'authorized_party',
      }),
    );
  });

  it('rejects an ID token whose subject differs from the access token', async () => {
    const { accessToken, idToken, jwk } = await signedTokenPair(
      { identity_provider: 'yandex' },
      { identity_provider: 'yandex' },
      { id: 'other-subject' },
    );
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowExistingSubjectOAuthBootstrap: true,
      fetchImplementation: tokenPairAndJwksFetch(accessToken, idToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-id-token-subject-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect(metrics).toContainEqual(
      expect.objectContaining({ operation: 'oauth_exchange', failureStage: 'id_token' }),
    );
  });

  it('provisions a Yandex-only user from verified issuer and subject claims', async () => {
    const { accessToken, jwk } = await signedAccessToken({
      name: '  Анна\u0000   Падел  ',
      phone_number: '+79990000001',
      email: 'not-an-identity@example.test',
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowSubjectOAuthProvisioning: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-provisioning-correlation-123',
      identityMode: 'STANDARD',
    });

    expect(result).toMatchObject({
      identityResolution: 'SUBJECT_PROVISIONING',
      identity: {
        issuer: 'https://kc.vivacrm.invalid/realms/clients',
        subject: 'viva-user-42',
        displayName: 'Анна Падел',
      },
    });
    expect(result.identity).not.toHaveProperty('phoneE164');
    expect(result.identity).not.toHaveProperty('email');
  });

  it.each([
    ['email', 'person@example.test'],
    ['phone', '+7 (999) 000-00-01'],
  ])(
    'does not persist a %s-shaped preferred username as a public display name',
    async (_, value) => {
      const { accessToken, jwk } = await signedAccessToken({
        name: null,
        given_name: null,
        family_name: null,
        preferred_username: value,
      });
      const provider = new VivaIdentityProvider({
        ...options(),
        mode: 'sandbox',
        allowSubjectOAuthProvisioning: true,
        fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
      });

      const result = await provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-private-username-correlation-123',
        identityMode: 'STANDARD',
      });

      expect(result.identity).toMatchObject({ displayName: 'Игрок ПадлхАБ' });
    },
  );

  it('prefers a signed personal name over preferred username', async () => {
    const { accessToken, jwk } = await signedAccessToken({
      name: null,
      given_name: 'Анна',
      family_name: 'Падел',
      preferred_username: 'person@example.test',
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowSubjectOAuthProvisioning: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-personal-name-correlation-123',
      identityMode: 'STANDARD',
    });

    expect(result.identity).toMatchObject({ displayName: 'Анна Падел' });
  });

  it('rejects Yandex provisioning when the signed provider claim names another upstream', async () => {
    const { accessToken, jwk } = await signedAccessToken({
      identity_provider: 'vkid',
      name: 'Untrusted provider subject',
    });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowSubjectOAuthProvisioning: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-provider-provenance-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('treats a non-string provider claim as not asserted rather than as a valid upstream', async () => {
    const { accessToken, jwk } = await signedAccessToken({
      identity_provider: null,
      name: 'Untrusted provider subject',
    });
    const metrics: VivaIdentityMetric[] = [];
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowSubjectOAuthProvisioning: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
      onMetric: (metric) => metrics.push(metric),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
      code: 'authorization-code',
      codeVerifier: 'pkce-verifier',
      providerTenantKey: 'iSkq6G',
      redirectUri: 'https://app.example.test/callback',
      correlationId: 'oauth-provider-null-123',
      identityMode: 'STANDARD',
    });

    expect(result.identity).toMatchObject({ displayName: 'Untrusted provider subject' });
    expect(metrics).toContainEqual(
      expect.objectContaining({
        operation: 'jwt_verify',
        outcome: 'success',
        provenance: 'absent',
      }),
    );
  });

  it('rejects a signed access token without an expiry', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
    const accessToken = await new SignJWT({
      azp: 'widget',
      tenant_key: 'iSkq6G',
      identity_provider: 'yandex',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://kc.vivacrm.invalid/realms/clients')
      .setSubject('viva-user-42')
      .sign(privateKey);
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      allowSubjectOAuthProvisioning: true,
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-expiry-required-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('resolves authenticated recovery from verified token claims', async () => {
    const { accessToken, jwk } = await signedAccessToken({ name: 'Existing Account Name' });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    const result = await provider.exchangeAuthorizationCode({
      provider: 'yandex',
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
      subject: 'viva-user-42',
    });
  });

  it('fails closed for standard OAuth when existing-subject bootstrap is disabled', async () => {
    const { accessToken, jwk } = await signedAccessToken({ name: 'Social Account Name' });
    const provider = new VivaIdentityProvider({
      ...options(),
      mode: 'sandbox',
      fetchImplementation: tokenAndJwksFetch(accessToken, jwk),
    });

    await expect(
      provider.exchangeAuthorizationCode({
        provider: 'yandex',
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        providerTenantKey: 'iSkq6G',
        redirectUri: 'https://app.example.test/callback',
        correlationId: 'oauth-correlation-123',
        identityMode: 'STANDARD',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
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
        provider: 'yandex',
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
