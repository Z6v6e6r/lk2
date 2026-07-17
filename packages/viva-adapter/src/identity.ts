import { createHash } from 'node:crypto';

import {
  IdentityProviderError,
  normalizePhoneE164,
  type IdentityProviderPort,
  type PhoneVerificationResult,
  type VerifiedExternalIdentity,
  type VivaOAuthProvider,
  type VivaOAuthProviderPort,
} from '@phub/auth';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

export interface VivaIdentityProviderOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  readonly baseUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly channel: string;
  readonly profileApiBaseUrl: string;
  readonly oauthScopes: string;
  readonly timeoutMs: number;
  readonly devPhoneE164: string;
  readonly devOtpCode: string;
  readonly circuitFailureThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly resolveIdentityFromAccessToken?: (
    accessToken: string,
    fallbackPhone: string,
  ) => Promise<VerifiedExternalIdentity>;
  readonly onMetric?: (metric: VivaIdentityMetric) => void;
}

export interface VivaIdentityMetric {
  readonly operation: 'request_code' | 'verify_code' | 'oauth_exchange' | 'delegation_refresh';
  readonly outcome: 'success' | 'invalid' | 'rate_limited' | 'unavailable';
  readonly status?: number;
  readonly durationMs: number;
  readonly circuitState: 'closed' | 'open';
}

type VivaIdentityMetricInput = Omit<VivaIdentityMetric, 'durationMs' | 'circuitState'>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

const profileResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
  middleName: z.string().nullish(),
  phone: z.string().nullish(),
});

function stringClaim(payload: JWTPayload, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export class VivaIdentityProvider implements IdentityProviderPort, VivaOAuthProviderPort {
  public readonly key = 'VIVA' as const;
  private readonly fetchImplementation: typeof fetch;
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  public constructor(private readonly options: VivaIdentityProviderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.issuer = `${options.baseUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(options.realm)}`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/protocol/openid-connect/certs`), {
      timeoutDuration: options.timeoutMs,
      cooldownDuration: 30_000,
      [customFetch]: (url, init) => this.fetchWithPolicy(new URL(url), init, true),
    });
  }

  private emit(metric: VivaIdentityMetricInput, startedAt: number): void {
    try {
      this.options.onMetric?.({
        ...metric,
        durationMs: Math.max(0, Date.now() - startedAt),
        circuitState: Date.now() < this.circuitOpenUntil ? 'open' : 'closed',
      });
    } catch {
      // Telemetry must not change authentication behavior.
    }
  }

  private ensureAvailable(): void {
    if (this.options.mode === 'disabled') {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  private ensureCircuitClosed(): void {
    if (Date.now() < this.circuitOpenUntil) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (this.circuitOpenUntil > 0) {
      this.circuitOpenUntil = 0;
      this.consecutiveFailures = 0;
    }
  }

  private recordExternalFailure(): void {
    this.consecutiveFailures += 1;
    const threshold = this.options.circuitFailureThreshold ?? 5;
    if (this.consecutiveFailures >= threshold) {
      this.circuitOpenUntil = Date.now() + (this.options.circuitCooldownMs ?? 30_000);
    }
  }

  private recordExternalResponse(response: Response): void {
    if (response.status >= 500) this.recordExternalFailure();
    else if (response.status !== 429) this.consecutiveFailures = 0;
  }

  /**
   * OTP send/token exchange use one attempt because Viva has not documented
   * idempotency for those side effects. The profile GET is safe for one retry.
   */
  private async fetchWithPolicy(
    url: URL,
    init: RequestInit,
    retryableRead = false,
  ): Promise<Response> {
    const attempts = retryableRead ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.ensureCircuitClosed();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          ...init,
          signal: controller.signal,
        });
        this.recordExternalResponse(response);
        if (response.status < 500 || attempt === attempts) return response;
      } catch {
        this.recordExternalFailure();
        if (attempt === attempts) throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
  }

  private async resolveIdentity(
    accessToken: string,
    fallbackPhone: string,
    providerTenantKey: string,
    correlationId: string,
  ): Promise<VerifiedExternalIdentity> {
    if (this.options.resolveIdentityFromAccessToken) {
      return this.options.resolveIdentityFromAccessToken(accessToken, fallbackPhone);
    }

    const { payload } = await jwtVerify(accessToken, this.jwks, {
      issuer: this.issuer,
      algorithms: ['RS256'],
    });
    if (payload.azp !== this.options.clientId) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }

    const profile = await this.resolveVivaProfile(accessToken, providerTenantKey, correlationId);
    const profileName = [profile.firstName, profile.middleName, profile.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');
    const tokenName = [stringClaim(payload, ['given_name']), stringClaim(payload, ['family_name'])]
      .filter(Boolean)
      .join(' ');
    const displayName =
      profileName ||
      stringClaim(payload, ['name', 'preferred_username']) ||
      tokenName ||
      'Игрок ПаделхАБ';
    const phoneE164 = normalizePhoneE164(profile.phone ?? '') ?? fallbackPhone;
    return {
      issuer: this.issuer,
      subject: payload.sub,
      providerUserId: String(profile.id),
      phoneE164,
      displayName,
    };
  }

  private async resolveVivaProfile(
    accessToken: string,
    providerTenantKey: string,
    correlationId: string,
  ): Promise<z.infer<typeof profileResponseSchema> & { readonly id: string | number }> {
    const profileUrl = new URL(
      `${this.options.profileApiBaseUrl.replace(/\/$/, '')}/${encodeURIComponent(providerTenantKey)}/profile`,
    );
    const profileResponse = await this.fetchWithPolicy(
      profileUrl,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Correlation-ID': correlationId,
        },
      },
      true,
    );
    if (!profileResponse.ok) throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    const profile = profileResponseSchema.parse(await profileResponse.json());
    if (profile.id === undefined) throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    return profile as z.infer<typeof profileResponseSchema> & { readonly id: string | number };
  }

  private async resolveOAuthIdentity(
    accessToken: string,
    providerTenantKey: string,
    correlationId: string,
  ): Promise<VerifiedExternalIdentity> {
    const { payload } = await jwtVerify(accessToken, this.jwks, {
      issuer: this.issuer,
      algorithms: ['RS256'],
    });
    if (payload.azp !== this.options.clientId || typeof payload.sub !== 'string' || !payload.sub) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const profile = await this.resolveVivaProfile(accessToken, providerTenantKey, correlationId);
    const profileName = [profile.firstName, profile.middleName, profile.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');
    const displayName =
      profileName ||
      stringClaim(payload, ['name', 'preferred_username']) ||
      [stringClaim(payload, ['given_name']), stringClaim(payload, ['family_name'])]
        .filter(Boolean)
        .join(' ') ||
      'Игрок ПадлхАБ';
    const phoneE164 = normalizePhoneE164(
      profile.phone ?? stringClaim(payload, ['phone_number', 'phoneNumber', 'phone']) ?? '',
    );
    return {
      issuer: this.issuer,
      subject: payload.sub,
      providerUserId: String(profile.id),
      displayName,
      ...(phoneE164 ? { phoneE164 } : {}),
    };
  }

  public createAuthorizationUrl(input: {
    readonly provider: VivaOAuthProvider;
    readonly tenantKey: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
  }): string {
    this.ensureAvailable();
    const url = new URL(`${this.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: this.options.oauthScopes,
      kc_idp_hint: input.provider,
      tenant_key: input.tenantKey,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  public async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly providerTenantKey: string;
    readonly redirectUri: string;
    readonly correlationId: string;
  }): Promise<{
    readonly identity: VerifiedExternalIdentity;
    readonly accessToken: string;
    readonly accessExpiresIn?: number;
    readonly refreshToken: string;
    readonly refreshExpiresIn?: number;
  }> {
    const startedAt = Date.now();
    this.ensureAvailable();
    let response: Response;
    try {
      response = await this.fetchWithPolicy(
        new URL(`${this.issuer}/protocol/openid-connect/token`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Correlation-ID': input.correlationId,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.options.clientId,
            code: input.code,
            redirect_uri: input.redirectUri,
            code_verifier: input.codeVerifier,
          }).toString(),
        },
      );
    } catch {
      this.emit({ operation: 'oauth_exchange', outcome: 'unavailable' }, startedAt);
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 400 || response.status === 401) {
      this.emit(
        { operation: 'oauth_exchange', outcome: 'invalid', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_CODE_INVALID');
    }
    if (response.status === 429) {
      this.emit(
        { operation: 'oauth_exchange', outcome: 'rate_limited', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_RATE_LIMITED');
    }
    if (!response.ok) {
      this.emit(
        { operation: 'oauth_exchange', outcome: 'unavailable', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const tokens = tokenResponseSchema.parse(await response.json());
    if (!tokens.refresh_token) throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    const identity = await this.resolveOAuthIdentity(
      tokens.access_token,
      input.providerTenantKey,
      input.correlationId,
    );
    this.emit(
      { operation: 'oauth_exchange', outcome: 'success', status: response.status },
      startedAt,
    );
    return {
      identity,
      accessToken: tokens.access_token,
      ...(tokens.expires_in ? { accessExpiresIn: tokens.expires_in } : {}),
      refreshToken: tokens.refresh_token,
      ...(tokens.refresh_expires_in ? { refreshExpiresIn: tokens.refresh_expires_in } : {}),
    };
  }

  public async refreshUserDelegation(input: {
    readonly refreshToken: string;
    readonly correlationId: string;
  }): Promise<{
    readonly accessToken: string;
    readonly accessExpiresIn?: number;
    readonly refreshToken?: string;
    readonly refreshExpiresIn?: number;
  }> {
    const startedAt = Date.now();
    this.ensureAvailable();
    let response: Response;
    try {
      response = await this.fetchWithPolicy(
        new URL(`${this.issuer}/protocol/openid-connect/token`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Correlation-ID': input.correlationId,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.options.clientId,
            refresh_token: input.refreshToken,
          }).toString(),
        },
      );
    } catch {
      this.emit({ operation: 'delegation_refresh', outcome: 'unavailable' }, startedAt);
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 400 || response.status === 401) {
      this.emit(
        { operation: 'delegation_refresh', outcome: 'invalid', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_CODE_INVALID');
    }
    if (response.status === 429) {
      this.emit(
        { operation: 'delegation_refresh', outcome: 'rate_limited', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_RATE_LIMITED');
    }
    if (!response.ok) {
      this.emit(
        { operation: 'delegation_refresh', outcome: 'unavailable', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const tokens = tokenResponseSchema.parse(await response.json());
    this.emit(
      { operation: 'delegation_refresh', outcome: 'success', status: response.status },
      startedAt,
    );
    return {
      accessToken: tokens.access_token,
      ...(tokens.expires_in ? { accessExpiresIn: tokens.expires_in } : {}),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.refresh_expires_in ? { refreshExpiresIn: tokens.refresh_expires_in } : {}),
    };
  }

  public async requestPhoneCode(input: {
    readonly phoneE164: string;
    readonly providerTenantKey: string;
    readonly correlationId: string;
  }): Promise<void> {
    const startedAt = Date.now();
    this.ensureAvailable();
    if (this.options.mode === 'mock') {
      if (input.phoneE164 !== this.options.devPhoneE164) {
        this.emit({ operation: 'request_code', outcome: 'invalid' }, startedAt);
        throw new IdentityProviderError('AUTH_CODE_INVALID');
      }
      this.emit({ operation: 'request_code', outcome: 'success' }, startedAt);
      return;
    }

    const url = new URL(`${this.issuer}/sms/authentication-code`);
    url.searchParams.set('phoneNumber', input.phoneE164);
    url.searchParams.set('channel', this.options.channel);
    url.searchParams.set('tenantKey', input.providerTenantKey);
    let response: Response;
    try {
      response = await this.fetchWithPolicy(url, {
        method: 'GET',
        headers: { 'X-Correlation-ID': input.correlationId },
      });
    } catch (error) {
      this.emit({ operation: 'request_code', outcome: 'unavailable' }, startedAt);
      if (error instanceof IdentityProviderError) throw error;
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 429) {
      this.emit(
        { operation: 'request_code', outcome: 'rate_limited', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_RATE_LIMITED');
    }
    if (!response.ok) {
      this.emit(
        { operation: 'request_code', outcome: 'unavailable', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    this.emit(
      { operation: 'request_code', outcome: 'success', status: response.status },
      startedAt,
    );
  }

  public async verifyPhoneCode(input: {
    readonly phoneE164: string;
    readonly code: string;
    readonly providerTenantKey: string;
    readonly correlationId: string;
  }): Promise<PhoneVerificationResult> {
    const startedAt = Date.now();
    this.ensureAvailable();
    if (this.options.mode === 'mock') {
      if (input.phoneE164 !== this.options.devPhoneE164 || input.code !== this.options.devOtpCode) {
        this.emit({ operation: 'verify_code', outcome: 'invalid' }, startedAt);
        throw new IdentityProviderError('AUTH_CODE_INVALID');
      }
      const subject = createHash('sha256').update(input.phoneE164).digest('hex');
      this.emit({ operation: 'verify_code', outcome: 'success' }, startedAt);
      return {
        issuer: `${this.issuer}/mock`,
        subject,
        phoneE164: input.phoneE164,
        displayName: 'Игрок ПадлхАБ',
      };
    }

    let response: Response;
    try {
      response = await this.fetchWithPolicy(
        new URL(`${this.issuer}/protocol/openid-connect/token`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Correlation-ID': input.correlationId,
          },
          body: new URLSearchParams({
            grant_type: 'password',
            phone_number: input.phoneE164,
            code: input.code,
            client_id: this.options.clientId,
            tenant_key: input.providerTenantKey,
          }).toString(),
        },
      );
    } catch (error) {
      this.emit({ operation: 'verify_code', outcome: 'unavailable' }, startedAt);
      if (error instanceof IdentityProviderError) throw error;
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (response.status === 400 || response.status === 401) {
      this.emit(
        { operation: 'verify_code', outcome: 'invalid', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_CODE_INVALID');
    }
    if (response.status === 429) {
      this.emit(
        { operation: 'verify_code', outcome: 'rate_limited', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_RATE_LIMITED');
    }
    if (!response.ok) {
      this.emit(
        { operation: 'verify_code', outcome: 'unavailable', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }

    try {
      const tokens = tokenResponseSchema.parse(await response.json());
      const identity = await this.resolveIdentity(
        tokens.access_token,
        input.phoneE164,
        input.providerTenantKey,
        input.correlationId,
      );
      this.emit(
        { operation: 'verify_code', outcome: 'success', status: response.status },
        startedAt,
      );
      return {
        identity,
        ...(tokens.refresh_token
          ? {
              delegation: {
                refreshToken: tokens.refresh_token,
                ...(tokens.refresh_expires_in
                  ? { refreshExpiresIn: tokens.refresh_expires_in }
                  : {}),
              },
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof IdentityProviderError) throw error;
      this.emit(
        { operation: 'verify_code', outcome: 'unavailable', status: response.status },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
  }
}
