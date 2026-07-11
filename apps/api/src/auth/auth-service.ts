import { createHmac, randomUUID } from 'node:crypto';

import {
  IdentityProviderError,
  normalizePhoneE164,
  type IdentityProviderKey,
  type IdentityProviderPort,
  type VerifiedExternalIdentity,
} from '@phub/auth';
import type { AppConfig } from '@phub/config';
import { SignJWT } from 'jose';

import type { AuthChallenge, AuthChallengeStore } from './challenge-store.js';

const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const OTP_PATTERN = /^\d{4}$/;

export interface TenantAuthBinding {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly provider: IdentityProviderKey;
  readonly providerTenantKey: string;
}

export interface AuthUser {
  readonly id: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly phoneLast4?: string;
}

export interface RefreshSessionIdentity {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly user: AuthUser;
}

export type RefreshSessionRotation =
  | { readonly outcome: 'rotated'; readonly identity: RefreshSessionIdentity }
  | { readonly outcome: 'race' }
  | { readonly outcome: 'invalid' };

export interface AuthRepository {
  resolveTenantAuthBinding(tenantKey: string): Promise<TenantAuthBinding | undefined>;
  upsertExternalIdentity(input: {
    readonly binding: TenantAuthBinding;
    readonly identity: VerifiedExternalIdentity;
    readonly correlationId: string;
  }): Promise<AuthUser>;
  createRefreshSession(input: {
    readonly sessionId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly correlationId: string;
  }): Promise<void>;
  rotateRefreshSession(input: {
    readonly tenantKey: string;
    readonly currentTokenHash: string;
    readonly nextTokenHash: string;
    readonly nextExpiresAt: Date;
    readonly correlationId: string;
    readonly nextSessionId: string;
  }): Promise<RefreshSessionRotation>;
  revokeRefreshSession(
    tenantKey: string,
    tokenHash: string,
    correlationId: string,
  ): Promise<boolean>;
  findRefreshSessionById(
    tenantKey: string,
    sessionId: string,
  ): Promise<RefreshSessionIdentity | undefined>;
  getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined>;
}

export type AuthServiceErrorCode =
  | 'AUTH_PHONE_INVALID'
  | 'AUTH_CODE_INVALID'
  | 'AUTH_CODE_EXPIRED'
  | 'AUTH_CHALLENGE_IN_PROGRESS'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_PROVIDER_UNAVAILABLE'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_REFRESH_RACE'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'TENANT_KEY_INVALID'
  | 'TENANT_NOT_FOUND';

const errorStatus: Readonly<Record<AuthServiceErrorCode, number>> = {
  AUTH_PHONE_INVALID: 400,
  AUTH_CODE_INVALID: 401,
  AUTH_CODE_EXPIRED: 410,
  AUTH_CHALLENGE_IN_PROGRESS: 409,
  AUTH_RATE_LIMITED: 429,
  AUTH_PROVIDER_UNAVAILABLE: 503,
  AUTH_SESSION_REVOKED: 401,
  AUTH_REFRESH_RACE: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  TENANT_KEY_INVALID: 400,
  TENANT_NOT_FOUND: 404,
};

export class AuthServiceError extends Error {
  public readonly status: number;

  public constructor(public readonly code: AuthServiceErrorCode) {
    super(code);
    this.name = 'AuthServiceError';
    this.status = errorStatus[code];
  }
}

export interface AuthSessionResult {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresAt: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
  readonly user: AuthUser;
}

export interface AuthServiceOptions {
  readonly config: AppConfig;
  readonly repository: AuthRepository;
  readonly challengeStore: AuthChallengeStore;
  readonly providers: ReadonlyMap<IdentityProviderKey, IdentityProviderPort>;
  readonly now?: () => Date;
}

export class AuthService {
  private readonly now: () => Date;

  public constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private async binding(tenantKey: string): Promise<TenantAuthBinding> {
    if (!TENANT_KEY_PATTERN.test(tenantKey)) throw new AuthServiceError('TENANT_KEY_INVALID');
    const binding = await this.options.repository.resolveTenantAuthBinding(tenantKey);
    if (!binding) throw new AuthServiceError('TENANT_NOT_FOUND');
    return binding;
  }

  private provider(key: IdentityProviderKey): IdentityProviderPort {
    const provider = this.options.providers.get(key);
    if (!provider) throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    return provider;
  }

  private mapProviderError(error: unknown): never {
    if (error instanceof IdentityProviderError) {
      throw new AuthServiceError(error.code);
    }
    throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
  }

  private refreshTokenHash(token: string): string {
    return createHmac('sha256', this.options.config.JWT_REFRESH_SECRET).update(token).digest('hex');
  }

  private deriveSecret(label: string, values: readonly string[]): Buffer {
    const hmac = createHmac('sha256', this.options.config.JWT_REFRESH_SECRET).update(label);
    for (const value of values) hmac.update('\0').update(value);
    return hmac.digest();
  }

  private deriveUuid(label: string, values: readonly string[]): string {
    const bytes = this.deriveSecret(label, values).subarray(0, 16);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private deriveRefreshToken(label: string, values: readonly string[]): string {
    return this.deriveSecret(label, values).toString('base64url');
  }

  private async issueAccessToken(identity: RefreshSessionIdentity): Promise<{
    accessToken: string;
    expiresAt: string;
  }> {
    const issuedAt = this.now();
    const expiresAt = new Date(
      issuedAt.getTime() + this.options.config.AUTH_ACCESS_TTL_SECONDS * 1000,
    );
    const accessToken = await new SignJWT({
      tenants: [identity.tenantId],
      roles: ['client'],
      permissions: ['profile.read'],
      sid: identity.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.options.config.JWT_ISSUER)
      .setAudience(this.options.config.JWT_AUDIENCE)
      .setSubject(identity.user.id)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(new TextEncoder().encode(this.options.config.JWT_ACCESS_SECRET));
    return { accessToken, expiresAt: expiresAt.toISOString() };
  }

  private async sessionResult(
    identity: RefreshSessionIdentity,
    refreshToken: string,
  ): Promise<AuthSessionResult> {
    const access = await this.issueAccessToken(identity);
    return {
      ...access,
      refreshToken,
      refreshExpiresAt: new Date(
        this.now().getTime() + this.options.config.AUTH_REFRESH_TTL_SECONDS * 1000,
      ).toISOString(),
      tokenType: 'Bearer',
      user: identity.user,
    };
  }

  public async startPhoneChallenge(input: {
    readonly tenantKey: string;
    readonly phone: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
  }): Promise<{ challengeId: string; expiresAt: string; resendAfterSeconds: number }> {
    const phoneE164 = normalizePhoneE164(input.phone);
    if (!phoneE164) throw new AuthServiceError('AUTH_PHONE_INVALID');
    const binding = await this.binding(input.tenantKey);
    const provider = this.provider(binding.provider);
    const now = this.now();
    const challengeId = this.deriveUuid('auth-challenge', [input.tenantKey, input.idempotencyKey]);
    const existing = await this.options.challengeStore.get(challengeId);
    if (existing) {
      if (existing.tenantId !== binding.tenantId || existing.phoneE164 !== phoneE164) {
        throw new AuthServiceError('IDEMPOTENCY_KEY_CONFLICT');
      }
      return {
        challengeId: existing.id,
        expiresAt: existing.expiresAt,
        resendAfterSeconds: Math.max(
          0,
          Math.ceil((Date.parse(existing.resendAt) - now.getTime()) / 1000),
        ),
      };
    }
    const challenge: AuthChallenge = {
      id: challengeId,
      tenantId: binding.tenantId,
      tenantKey: binding.tenantKey,
      provider: binding.provider,
      providerTenantKey: binding.providerTenantKey,
      phoneE164,
      attempts: 0,
      expiresAt: new Date(
        now.getTime() + this.options.config.AUTH_CHALLENGE_TTL_SECONDS * 1000,
      ).toISOString(),
      resendAt: new Date(
        now.getTime() + this.options.config.AUTH_CHALLENGE_RESEND_SECONDS * 1000,
      ).toISOString(),
    };

    const reserved = await this.options.challengeStore.put(
      challenge,
      this.options.config.AUTH_CHALLENGE_TTL_SECONDS,
      this.options.config.AUTH_CHALLENGE_RESEND_SECONDS,
    );
    if (!reserved) throw new AuthServiceError('AUTH_RATE_LIMITED');
    try {
      await provider.requestPhoneCode({
        phoneE164,
        providerTenantKey: binding.providerTenantKey,
        correlationId: input.correlationId,
      });
    } catch (error) {
      await this.options.challengeStore.delete(challenge.id);
      if (error instanceof IdentityProviderError && error.code === 'AUTH_CODE_INVALID') {
        throw new AuthServiceError('AUTH_PHONE_INVALID');
      }
      this.mapProviderError(error);
    }
    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      resendAfterSeconds: this.options.config.AUTH_CHALLENGE_RESEND_SECONDS,
    };
  }

  public async verifyPhoneChallenge(input: {
    readonly tenantKey: string;
    readonly challengeId: string;
    readonly code: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
  }): Promise<AuthSessionResult> {
    if (!OTP_PATTERN.test(input.code)) throw new AuthServiceError('AUTH_CODE_INVALID');
    const sessionId = this.deriveUuid('auth-login-session', [
      input.tenantKey,
      input.challengeId,
      input.idempotencyKey,
    ]);
    const replay = await this.options.repository.findRefreshSessionById(input.tenantKey, sessionId);
    if (replay) {
      return this.sessionResult(
        replay,
        this.deriveRefreshToken('auth-login-refresh', [
          input.tenantKey,
          input.challengeId,
          input.idempotencyKey,
        ]),
      );
    }
    const currentBinding = await this.binding(input.tenantKey);
    const challenge = await this.options.challengeStore.get(input.challengeId);
    if (!challenge || challenge.tenantKey !== input.tenantKey) {
      throw new AuthServiceError('AUTH_CODE_EXPIRED');
    }
    if (
      currentBinding.tenantId !== challenge.tenantId ||
      currentBinding.provider !== challenge.provider ||
      currentBinding.providerTenantKey !== challenge.providerTenantKey
    ) {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_CODE_EXPIRED');
    }
    if (
      Date.parse(challenge.expiresAt) <= this.now().getTime() ||
      challenge.attempts >= this.options.config.AUTH_CHALLENGE_MAX_ATTEMPTS
    ) {
      await this.options.challengeStore.delete(challenge.id);
      throw new AuthServiceError('AUTH_CODE_EXPIRED');
    }

    const claimId = randomUUID();
    const claimed = await this.options.challengeStore.claim(challenge.id, claimId, 30);
    if (!claimed) throw new AuthServiceError('AUTH_CHALLENGE_IN_PROGRESS');

    let externalIdentity: VerifiedExternalIdentity;
    try {
      externalIdentity = await this.provider(challenge.provider).verifyPhoneCode({
        phoneE164: challenge.phoneE164,
        code: input.code,
        providerTenantKey: challenge.providerTenantKey,
        correlationId: input.correlationId,
      });
    } catch (error) {
      if (error instanceof IdentityProviderError && error.code === 'AUTH_CODE_INVALID') {
        const attempts = await this.options.challengeStore.incrementAttempts(challenge.id);
        if (attempts !== undefined && attempts >= this.options.config.AUTH_CHALLENGE_MAX_ATTEMPTS) {
          await this.options.challengeStore.delete(challenge.id);
        } else {
          await this.options.challengeStore.release(challenge.id, claimId);
        }
      } else {
        await this.options.challengeStore.release(challenge.id, claimId);
      }
      this.mapProviderError(error);
    }

    const binding: TenantAuthBinding = {
      tenantId: challenge.tenantId,
      tenantKey: challenge.tenantKey,
      provider: challenge.provider,
      providerTenantKey: challenge.providerTenantKey,
    };
    try {
      const user = await this.options.repository.upsertExternalIdentity({
        binding,
        identity: externalIdentity,
        correlationId: input.correlationId,
      });
      const refreshToken = this.deriveRefreshToken('auth-login-refresh', [
        input.tenantKey,
        input.challengeId,
        input.idempotencyKey,
      ]);
      const refreshExpiresAt = new Date(
        this.now().getTime() + this.options.config.AUTH_REFRESH_TTL_SECONDS * 1000,
      );
      await this.options.repository.createRefreshSession({
        sessionId,
        tenantId: challenge.tenantId,
        userId: user.id,
        tokenHash: this.refreshTokenHash(refreshToken),
        expiresAt: refreshExpiresAt,
        correlationId: input.correlationId,
      });
      await this.options.challengeStore.delete(challenge.id);
      return this.sessionResult(
        { sessionId, tenantId: challenge.tenantId, tenantKey: challenge.tenantKey, user },
        refreshToken,
      );
    } catch (error) {
      await this.options.challengeStore.release(challenge.id, claimId);
      throw error;
    }
  }

  public async refreshSession(
    tenantKey: string,
    currentRefreshToken: string,
    correlationId: string,
    idempotencyKey: string,
  ): Promise<AuthSessionResult> {
    await this.binding(tenantKey);
    const nextRefreshToken = this.deriveRefreshToken('auth-session-refresh', [
      tenantKey,
      currentRefreshToken,
      idempotencyKey,
    ]);
    const nextSessionId = this.deriveUuid('auth-refresh-session', [
      tenantKey,
      currentRefreshToken,
      idempotencyKey,
    ]);
    const nextExpiresAt = new Date(
      this.now().getTime() + this.options.config.AUTH_REFRESH_TTL_SECONDS * 1000,
    );
    const rotation = await this.options.repository.rotateRefreshSession({
      tenantKey,
      currentTokenHash: this.refreshTokenHash(currentRefreshToken),
      nextTokenHash: this.refreshTokenHash(nextRefreshToken),
      nextExpiresAt,
      correlationId,
      nextSessionId,
    });
    if (rotation.outcome === 'race') throw new AuthServiceError('AUTH_REFRESH_RACE');
    if (rotation.outcome === 'invalid') throw new AuthServiceError('AUTH_SESSION_REVOKED');
    return this.sessionResult(rotation.identity, nextRefreshToken);
  }

  public async revokeSession(
    tenantKey: string,
    refreshToken: string,
    correlationId: string,
  ): Promise<void> {
    await this.binding(tenantKey);
    await this.options.repository.revokeRefreshSession(
      tenantKey,
      this.refreshTokenHash(refreshToken),
      correlationId,
    );
  }

  public getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined> {
    return this.options.repository.getUserContext(tenantId, userId);
  }
}
