import { createHash } from 'node:crypto';

import {
  IdentityProviderError,
  normalizePhoneE164,
  type IdentityProviderPort,
  type PhoneVerificationResult,
  type VerifiedExternalIdentity,
  type VivaOAuthExchangeResult,
  type VivaOAuthIdentityMode,
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
  readonly oauthScopes: string;
  readonly timeoutMs: number;
  readonly devPhoneE164: string;
  readonly devOtpCode: string;
  readonly circuitFailureThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly allowExistingSubjectOAuthBootstrap?: boolean;
  readonly allowSubjectOAuthProvisioning?: boolean;
  readonly fetchImplementation?: typeof fetch;
  readonly onMetric?: (metric: VivaIdentityMetric) => void;
}

export interface VivaIdentityMetric {
  readonly operation:
    | 'request_code'
    | 'verify_code'
    | 'oauth_token_exchange'
    | 'jwt_verify'
    | 'oauth_exchange'
    | 'delegation_refresh';
  readonly outcome: 'success' | 'invalid' | 'rate_limited' | 'unavailable';
  readonly status?: number;
  readonly correlationId?: string;
  readonly failureStage?: 'token_request' | 'token_payload' | 'refresh_token' | 'access_token';
  readonly durationMs: number;
  readonly circuitState: 'closed' | 'open';
}

type ResolvedOAuthIdentity =
  | {
      readonly identity: VerifiedExternalIdentity;
      readonly identityResolution: 'CANONICAL_PROFILE' | 'SUBJECT_PROVISIONING';
    }
  | {
      readonly identity: Pick<VerifiedExternalIdentity, 'issuer' | 'subject'>;
      readonly identityResolution: 'EXISTING_SUBJECT';
    };

type VivaIdentityMetricInput = Omit<VivaIdentityMetric, 'durationMs' | 'circuitState'>;

class VivaOAuthStageError extends IdentityProviderError {
  public constructor(
    public readonly failureStage: NonNullable<VivaIdentityMetric['failureStage']>,
    public readonly status?: number,
  ) {
    super('AUTH_PROVIDER_UNAVAILABLE');
    this.name = 'VivaOAuthStageError';
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

function stringClaim(payload: JWTPayload, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function oauthDisplayName(payload: JWTPayload): string {
  const compoundName = [stringClaim(payload, ['given_name']), stringClaim(payload, ['family_name'])]
    .filter(Boolean)
    .join(' ');
  for (const candidate of [
    stringClaim(payload, ['name']),
    compoundName,
    stringClaim(payload, ['preferred_username']),
  ]) {
    const normalized = candidate
      ?.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 120);
    if (
      normalized &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) &&
      !/^\+?[0-9][0-9 ()-]{7,}$/u.test(normalized)
    )
      return normalized;
  }
  return 'Игрок ПадлхАБ';
}

function toVivaPhoneNumber(phoneE164: string): string {
  // Viva's client-realm OTP contract uses the canonical digits without the E.164 `+` prefix.
  return phoneE164.startsWith('+') ? phoneE164.slice(1) : phoneE164;
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
   * idempotency for those side effects. JWKS reads are safe for one retry.
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
  ): Promise<VerifiedExternalIdentity> {
    const { payload } = await jwtVerify(accessToken, this.jwks, {
      issuer: this.issuer,
      algorithms: ['RS256'],
    });
    if (
      payload.azp !== this.options.clientId ||
      stringClaim(payload, ['tenant_key', 'tenantKey']) !== providerTenantKey
    ) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }

    const tokenPhone = normalizePhoneE164(
      stringClaim(payload, ['phone_number', 'phoneNumber', 'phone']) ?? '',
    );
    if (payload.phone_number_verified !== true || tokenPhone !== fallbackPhone) {
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const tokenName = [stringClaim(payload, ['given_name']), stringClaim(payload, ['family_name'])]
      .filter(Boolean)
      .join(' ');
    const displayName =
      stringClaim(payload, ['name', 'preferred_username']) || tokenName || 'Игрок ПадлхАБ';
    return {
      issuer: this.issuer,
      subject: payload.sub,
      phoneE164: tokenPhone,
      displayName,
    };
  }

  private async resolveOAuthIdentity(
    accessToken: string,
    provider: VivaOAuthProvider,
    providerTenantKey: string,
    correlationId: string,
    identityMode: VivaOAuthIdentityMode,
  ): Promise<ResolvedOAuthIdentity> {
    const startedAt = Date.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(accessToken, this.jwks, {
        issuer: this.issuer,
        algorithms: ['RS256'],
      }));
    } catch {
      this.emit({ operation: 'jwt_verify', outcome: 'unavailable', correlationId }, startedAt);
      throw new VivaOAuthStageError('access_token');
    }
    if (
      payload.azp !== this.options.clientId ||
      stringClaim(payload, ['identity_provider', 'identityProvider']) !== provider ||
      stringClaim(payload, ['tenant_key', 'tenantKey']) !== providerTenantKey ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.exp !== 'number'
    ) {
      this.emit({ operation: 'jwt_verify', outcome: 'unavailable', correlationId }, startedAt);
      throw new VivaOAuthStageError('access_token');
    }
    this.emit({ operation: 'jwt_verify', outcome: 'success', correlationId }, startedAt);
    if (identityMode === 'RECOVERY_SUBJECT_ONLY') {
      return {
        identity: {
          issuer: this.issuer,
          subject: payload.sub,
        },
        identityResolution: 'EXISTING_SUBJECT',
      };
    }
    if (this.options.allowSubjectOAuthProvisioning) {
      return {
        identity: {
          issuer: this.issuer,
          subject: payload.sub,
          displayName: oauthDisplayName(payload),
        },
        identityResolution: 'SUBJECT_PROVISIONING',
      };
    }
    if (this.options.allowExistingSubjectOAuthBootstrap) {
      return {
        identity: {
          issuer: this.issuer,
          subject: payload.sub,
        },
        identityResolution: 'EXISTING_SUBJECT',
      };
    }
    throw new VivaOAuthStageError('access_token');
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
    readonly provider: VivaOAuthProvider;
    readonly code: string;
    readonly codeVerifier: string;
    readonly providerTenantKey: string;
    readonly redirectUri: string;
    readonly correlationId: string;
    readonly identityMode: VivaOAuthIdentityMode;
  }): Promise<VivaOAuthExchangeResult> {
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
      this.emit(
        {
          operation: 'oauth_exchange',
          outcome: 'unavailable',
          correlationId: input.correlationId,
          failureStage: 'token_request',
        },
        startedAt,
      );
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
    let tokens: z.infer<typeof tokenResponseSchema>;
    try {
      tokens = tokenResponseSchema.parse(await response.json());
    } catch {
      this.emit(
        {
          operation: 'oauth_exchange',
          outcome: 'unavailable',
          status: response.status,
          correlationId: input.correlationId,
          failureStage: 'token_payload',
        },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (!tokens.refresh_token) {
      this.emit(
        {
          operation: 'oauth_exchange',
          outcome: 'unavailable',
          status: response.status,
          correlationId: input.correlationId,
          failureStage: 'refresh_token',
        },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    this.emit(
      {
        operation: 'oauth_token_exchange',
        outcome: 'success',
        status: response.status,
        correlationId: input.correlationId,
      },
      startedAt,
    );
    let resolvedIdentity: Awaited<ReturnType<VivaIdentityProvider['resolveOAuthIdentity']>>;
    try {
      resolvedIdentity = await this.resolveOAuthIdentity(
        tokens.access_token,
        input.provider,
        input.providerTenantKey,
        input.correlationId,
        input.identityMode,
      );
    } catch (error) {
      const stageError = error instanceof VivaOAuthStageError ? error : undefined;
      this.emit(
        {
          operation: 'oauth_exchange',
          outcome: 'unavailable',
          correlationId: input.correlationId,
          failureStage: stageError?.failureStage ?? 'access_token',
          ...(stageError?.status ? { status: stageError.status } : {}),
        },
        startedAt,
      );
      throw new IdentityProviderError('AUTH_PROVIDER_UNAVAILABLE');
    }
    this.emit(
      { operation: 'oauth_exchange', outcome: 'success', status: response.status },
      startedAt,
    );
    const exchangedTokens = {
      accessToken: tokens.access_token,
      ...(tokens.expires_in ? { accessExpiresIn: tokens.expires_in } : {}),
      refreshToken: tokens.refresh_token,
      ...(tokens.refresh_expires_in ? { refreshExpiresIn: tokens.refresh_expires_in } : {}),
    };
    return resolvedIdentity.identityResolution === 'CANONICAL_PROFILE'
      ? { ...exchangedTokens, ...resolvedIdentity }
      : { ...exchangedTokens, ...resolvedIdentity };
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
    url.searchParams.set('phoneNumber', toVivaPhoneNumber(input.phoneE164));
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
            phone_number: toVivaPhoneNumber(input.phoneE164),
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
