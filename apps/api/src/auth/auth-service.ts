import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  IdentityProviderError,
  normalizePhoneE164,
  type IdentityProviderKey,
  type IdentityProviderPort,
  type VerifiedPhoneAuthentication,
  type VerifiedExternalIdentity,
  type VivaOAuthProvider,
  type VivaOAuthProviderPort,
} from '@phub/auth';
import {
  VivaDelegationCryptoError,
  decryptVivaDelegationToken,
  encryptVivaDelegationToken,
} from '@phub/auth/viva-delegation';
import type { AppConfig } from '@phub/config';
import { SignJWT } from 'jose';

import type { AuthChallenge, AuthChallengeStore } from './challenge-store.js';
import type { VivaOAuthStateStore } from './oauth-state-store.js';

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

export interface UserAccessProfile {
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export type AccessTokenAudience = 'client' | 'admin';

const ADMIN_ONLY_PERMISSIONS = new Set([
  'notifications.manage',
  'locations.read',
  'locations.manage',
  'locations.publish',
]);

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
  revokeVivaDelegationForRefreshSession(
    tenantKey: string,
    tokenHash: string,
    correlationId: string,
  ): Promise<void>;
  findRefreshSessionById(
    tenantKey: string,
    sessionId: string,
  ): Promise<RefreshSessionIdentity | undefined>;
  getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined>;
  getUserAccessProfile?(tenantId: string, userId: string): Promise<UserAccessProfile | undefined>;
  getUserByPhone?(tenantId: string, phoneE164: string): Promise<AuthUser | undefined>;
  getRefreshSessionPrincipal?(
    tenantKey: string,
    tokenHash: string,
  ): Promise<{ readonly tenantId: string; readonly userId: string } | undefined>;
  saveVivaDelegation(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly refreshTokenCiphertext: string;
    readonly encryptionKeyVersion: string;
    readonly grantedScopes: readonly string[];
    readonly refreshExpiresAt?: Date;
    readonly correlationId: string;
  }): Promise<void>;
  getVivaDelegation(input: { readonly tenantId: string; readonly userId: string }): Promise<
    | {
        readonly issuer: string;
        readonly subject: string;
        readonly refreshTokenCiphertext: string;
        readonly encryptionKeyVersion: string;
        readonly refreshExpiresAt?: string;
      }
    | undefined
  >;
  recordLegalAcceptances(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly source: 'VIVA_OAUTH';
    readonly publicOfferVersion: string;
    readonly personalDataPolicyVersion: string;
    readonly oauthStateHash: string;
  }): Promise<void>;
  recordPhoneLegalAcceptances(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly publicOfferVersion: string;
    readonly personalDataPolicyVersion: string;
  }): Promise<void>;
  recordLegalAcceptanceIntent(input: {
    readonly tenantId: string;
    readonly provider: VivaOAuthProvider;
    readonly stateHash: string;
    readonly correlationId: string;
    readonly publicOfferVersion: string;
    readonly personalDataPolicyVersion: string;
  }): Promise<void>;
}

export type AuthServiceErrorCode =
  | 'AUTH_PHONE_INVALID'
  | 'AUTH_CODE_INVALID'
  | 'AUTH_CODE_EXPIRED'
  | 'AUTH_CHALLENGE_IN_PROGRESS'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_PROVIDER_UNAVAILABLE'
  | 'AUTH_ADMIN_ACCESS_DENIED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_REFRESH_RACE'
  | 'VIVA_REAUTH_REQUIRED'
  | 'VIVA_DELEGATION_BUSY'
  | 'LEGAL_ACCEPTANCE_REQUIRED'
  | 'AUTH_IDENTITY_CONFLICT'
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
  AUTH_ADMIN_ACCESS_DENIED: 403,
  AUTH_SESSION_REVOKED: 401,
  AUTH_REFRESH_RACE: 409,
  VIVA_REAUTH_REQUIRED: 401,
  VIVA_DELEGATION_BUSY: 409,
  LEGAL_ACCEPTANCE_REQUIRED: 400,
  AUTH_IDENTITY_CONFLICT: 409,
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
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface AuthServiceOptions {
  readonly config: AppConfig;
  readonly repository: AuthRepository;
  readonly challengeStore: AuthChallengeStore;
  readonly providers: ReadonlyMap<IdentityProviderKey, IdentityProviderPort>;
  readonly vivaOAuthProvider?: VivaOAuthProviderPort;
  readonly vivaOAuthStateStore?: VivaOAuthStateStore;
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

  private isCupDevAuthentication(
    phoneE164: string,
    audience: AccessTokenAudience | undefined,
  ): boolean {
    return (
      this.options.config.APP_ENV === 'local' &&
      this.options.config.CUP_DEV_AUTH_ENABLED &&
      audience === 'admin' &&
      phoneE164 === this.options.config.CUP_DEV_AUTH_PHONE_E164
    );
  }

  private mapProviderError(error: unknown): never {
    if (error instanceof IdentityProviderError) {
      throw new AuthServiceError(error.code);
    }
    throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
  }

  private mapIdentityRepositoryError(error: unknown): never {
    if (error instanceof Error && error.message === 'AUTH_CANONICAL_IDENTITY_CONFLICT') {
      throw new AuthServiceError('AUTH_IDENTITY_CONFLICT');
    }
    throw error;
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

  private encryptVivaRefreshToken(value: string): string {
    try {
      return encryptVivaDelegationToken(value, this.options.config.VIVA_DELEGATION_ENCRYPTION_KEY);
    } catch {
      throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    }
  }

  private decryptVivaRefreshToken(value: string, keyVersion: string): string {
    try {
      return decryptVivaDelegationToken({
        value,
        keyText: this.options.config.VIVA_DELEGATION_ENCRYPTION_KEY,
        keyVersion,
        expectedKeyVersion: this.options.config.VIVA_DELEGATION_KEY_VERSION,
      });
    } catch (error) {
      if (error instanceof VivaDelegationCryptoError && error.code === 'KEY_UNAVAILABLE') {
        throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
      }
      throw new AuthServiceError('VIVA_REAUTH_REQUIRED');
    }
  }

  public async startVivaOAuth(input: {
    readonly tenantKey: string;
    readonly provider: VivaOAuthProvider;
    readonly publicOfferAccepted: boolean;
    readonly personalDataPolicyAccepted: boolean;
    readonly correlationId: string;
  }): Promise<{ redirectUrl: string }> {
    if (
      !this.options.config.VIVA_OAUTH_ENABLED ||
      !this.options.vivaOAuthProvider ||
      !this.options.vivaOAuthStateStore
    ) {
      throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (!input.publicOfferAccepted || !input.personalDataPolicyAccepted) {
      throw new AuthServiceError('LEGAL_ACCEPTANCE_REQUIRED');
    }
    const redirectUri = this.options.config.VIVA_OAUTH_REDIRECT_URI;
    if (!redirectUri) throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    const binding = await this.binding(input.tenantKey);
    if (binding.provider !== 'VIVA') throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const stateHash = createHash('sha256').update(state).digest('hex');
    await this.options.repository.recordLegalAcceptanceIntent({
      tenantId: binding.tenantId,
      provider: input.provider,
      stateHash,
      correlationId: input.correlationId,
      publicOfferVersion: this.options.config.PUBLIC_OFFER_VERSION,
      personalDataPolicyVersion: this.options.config.PERSONAL_DATA_POLICY_VERSION,
    });
    await this.options.vivaOAuthStateStore.put(
      {
        state,
        tenantKey: binding.tenantKey,
        provider: input.provider,
        codeVerifier,
        publicOfferAccepted: true,
        personalDataPolicyAccepted: true,
        publicOfferVersion: this.options.config.PUBLIC_OFFER_VERSION,
        personalDataPolicyVersion: this.options.config.PERSONAL_DATA_POLICY_VERSION,
      },
      this.options.config.AUTH_CHALLENGE_TTL_SECONDS,
    );
    return {
      redirectUrl: this.options.vivaOAuthProvider.createAuthorizationUrl({
        provider: input.provider,
        tenantKey: binding.providerTenantKey,
        redirectUri,
        state,
        codeChallenge,
      }),
    };
  }

  public async completeVivaOAuth(input: {
    readonly tenantKey: string;
    readonly state: string;
    readonly code: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
  }): Promise<AuthSessionResult & { readonly vivaHandoffCode: string }> {
    if (
      !this.options.config.VIVA_OAUTH_ENABLED ||
      !this.options.vivaOAuthProvider ||
      !this.options.vivaOAuthStateStore
    ) {
      throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    }
    const redirectUri = this.options.config.VIVA_OAUTH_REDIRECT_URI;
    if (!redirectUri) throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    const pending = await this.options.vivaOAuthStateStore.take(input.state);
    if (!pending || pending.tenantKey !== input.tenantKey || !input.code) {
      throw new AuthServiceError('AUTH_CODE_EXPIRED');
    }
    const binding = await this.binding(input.tenantKey);
    if (binding.provider !== 'VIVA') throw new AuthServiceError('AUTH_CODE_EXPIRED');
    let result: Awaited<ReturnType<VivaOAuthProviderPort['exchangeAuthorizationCode']>>;
    try {
      result = await this.options.vivaOAuthProvider.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: pending.codeVerifier,
        providerTenantKey: binding.providerTenantKey,
        redirectUri,
        correlationId: input.correlationId,
      });
    } catch (error) {
      this.mapProviderError(error);
    }
    let user: AuthUser;
    try {
      user = await this.options.repository.upsertExternalIdentity({
        binding,
        identity: result.identity,
        correlationId: input.correlationId,
      });
    } catch (error) {
      this.mapIdentityRepositoryError(error);
    }
    await this.options.repository.recordLegalAcceptances({
      tenantId: binding.tenantId,
      userId: user.id,
      correlationId: input.correlationId,
      source: 'VIVA_OAUTH',
      publicOfferVersion: pending.publicOfferVersion,
      personalDataPolicyVersion: pending.personalDataPolicyVersion,
      oauthStateHash: createHash('sha256').update(input.state).digest('hex'),
    });
    await this.options.repository.saveVivaDelegation({
      tenantId: binding.tenantId,
      userId: user.id,
      issuer: result.identity.issuer,
      subject: result.identity.subject,
      refreshTokenCiphertext: this.encryptVivaRefreshToken(result.refreshToken),
      encryptionKeyVersion: this.options.config.VIVA_DELEGATION_KEY_VERSION,
      grantedScopes: this.options.config.VIVA_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
      ...(result.refreshExpiresIn
        ? { refreshExpiresAt: new Date(this.now().getTime() + result.refreshExpiresIn * 1000) }
        : {}),
      correlationId: input.correlationId,
    });
    const sessionId = this.deriveUuid('viva-oauth-session', [
      input.tenantKey,
      input.state,
      input.idempotencyKey,
    ]);
    const refreshToken = this.deriveRefreshToken('viva-oauth-refresh', [
      input.tenantKey,
      input.state,
      input.idempotencyKey,
    ]);
    await this.options.repository.createRefreshSession({
      sessionId,
      tenantId: binding.tenantId,
      userId: user.id,
      tokenHash: this.refreshTokenHash(refreshToken),
      expiresAt: new Date(
        this.now().getTime() + this.options.config.AUTH_REFRESH_TTL_SECONDS * 1000,
      ),
      correlationId: input.correlationId,
    });
    const vivaHandoffCode = randomBytes(24).toString('base64url');
    await this.options.vivaOAuthStateStore.putHandoff(
      {
        code: vivaHandoffCode,
        tenantId: binding.tenantId,
        userId: user.id,
        accessToken: result.accessToken,
        expiresAt: new Date(
          this.now().getTime() + (result.accessExpiresIn ?? 300) * 1000,
        ).toISOString(),
      },
      120,
    );
    const session = await this.sessionResult(
      { sessionId, tenantId: binding.tenantId, tenantKey: binding.tenantKey, user },
      refreshToken,
    );
    return { ...session, vivaHandoffCode };
  }

  public async issueVivaAccessToken(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly handoffCode?: string;
    readonly correlationId: string;
  }): Promise<{ accessToken: string; expiresAt: string }> {
    if (
      !this.options.config.VIVA_OAUTH_ENABLED ||
      !this.options.vivaOAuthProvider ||
      !this.options.vivaOAuthStateStore
    ) {
      throw new AuthServiceError('AUTH_PROVIDER_UNAVAILABLE');
    }
    if (input.handoffCode) {
      const handoff = await this.options.vivaOAuthStateStore.takeHandoff(input.handoffCode);
      if (!handoff || handoff.tenantId !== input.tenantId || handoff.userId !== input.userId) {
        throw new AuthServiceError('VIVA_REAUTH_REQUIRED');
      }
      return { accessToken: handoff.accessToken, expiresAt: handoff.expiresAt };
    }

    const claimId = randomUUID();
    const lockKey = `${input.tenantId}:${input.userId}`;
    const claimed = await this.options.vivaOAuthStateStore.claimRefresh(lockKey, claimId, 15);
    if (!claimed) throw new AuthServiceError('VIVA_DELEGATION_BUSY');
    try {
      const delegation = await this.options.repository.getVivaDelegation(input);
      if (
        !delegation ||
        (delegation.refreshExpiresAt &&
          Date.parse(delegation.refreshExpiresAt) <= this.now().getTime())
      ) {
        throw new AuthServiceError('VIVA_REAUTH_REQUIRED');
      }
      const refreshToken = this.decryptVivaRefreshToken(
        delegation.refreshTokenCiphertext,
        delegation.encryptionKeyVersion,
      );
      let refreshed: Awaited<ReturnType<VivaOAuthProviderPort['refreshUserDelegation']>>;
      try {
        refreshed = await this.options.vivaOAuthProvider.refreshUserDelegation({
          refreshToken,
          correlationId: input.correlationId,
        });
      } catch (error) {
        if (error instanceof IdentityProviderError && error.code === 'AUTH_CODE_INVALID') {
          throw new AuthServiceError('VIVA_REAUTH_REQUIRED');
        }
        this.mapProviderError(error);
      }
      const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
      await this.options.repository.saveVivaDelegation({
        tenantId: input.tenantId,
        userId: input.userId,
        issuer: delegation.issuer,
        subject: delegation.subject,
        refreshTokenCiphertext: this.encryptVivaRefreshToken(nextRefreshToken),
        encryptionKeyVersion: this.options.config.VIVA_DELEGATION_KEY_VERSION,
        grantedScopes: this.options.config.VIVA_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
        ...(refreshed.refreshExpiresIn
          ? { refreshExpiresAt: new Date(this.now().getTime() + refreshed.refreshExpiresIn * 1000) }
          : delegation.refreshExpiresAt
            ? { refreshExpiresAt: new Date(delegation.refreshExpiresAt) }
            : {}),
        correlationId: input.correlationId,
      });
      return {
        accessToken: refreshed.accessToken,
        expiresAt: new Date(
          this.now().getTime() + (refreshed.accessExpiresIn ?? 300) * 1000,
        ).toISOString(),
      };
    } finally {
      await this.options.vivaOAuthStateStore.releaseRefresh(lockKey, claimId);
    }
  }

  private async issueAccessToken(
    identity: RefreshSessionIdentity,
    audience: AccessTokenAudience,
  ): Promise<{
    accessToken: string;
    expiresAt: string;
    roles: readonly string[];
    permissions: readonly string[];
  }> {
    const issuedAt = this.now();
    const expiresAt = new Date(
      issuedAt.getTime() + this.options.config.AUTH_ACCESS_TTL_SECONDS * 1000,
    );
    const storedAccess = (await this.options.repository.getUserAccessProfile?.(
      identity.tenantId,
      identity.user.id,
    )) ?? {
      roles: ['client'],
      permissions: ['profile.read'],
    };
    this.assertAudienceAccess(audience, storedAccess);
    const roles =
      audience === 'admin'
        ? storedAccess.roles
        : storedAccess.roles.filter((role) => role !== 'admin');
    const permissions =
      audience === 'admin'
        ? storedAccess.permissions
        : storedAccess.permissions.filter((permission) => !ADMIN_ONLY_PERMISSIONS.has(permission));
    const accessToken = await new SignJWT({
      tenants: [identity.tenantId],
      roles,
      permissions,
      sid: identity.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.options.config.JWT_ISSUER)
      .setAudience(
        audience === 'admin'
          ? this.options.config.JWT_ADMIN_AUDIENCE
          : this.options.config.JWT_AUDIENCE,
      )
      .setSubject(identity.user.id)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(new TextEncoder().encode(this.options.config.JWT_ACCESS_SECRET));
    return { accessToken, expiresAt: expiresAt.toISOString(), roles, permissions };
  }

  private assertAudienceAccess(audience: AccessTokenAudience, access: UserAccessProfile): void {
    if (
      audience === 'admin' &&
      (!access.roles.includes('admin') ||
        !access.permissions.some((permission) => ADMIN_ONLY_PERMISSIONS.has(permission)))
    ) {
      throw new AuthServiceError('AUTH_ADMIN_ACCESS_DENIED');
    }
  }

  private async assertUserAudienceAccess(
    tenantId: string,
    userId: string,
    audience: AccessTokenAudience,
  ): Promise<void> {
    if (audience !== 'admin') return;
    const access = (await this.options.repository.getUserAccessProfile?.(tenantId, userId)) ?? {
      roles: ['client'],
      permissions: ['profile.read'],
    };
    this.assertAudienceAccess(audience, access);
  }

  private async sessionResult(
    identity: RefreshSessionIdentity,
    refreshToken: string,
    audience: AccessTokenAudience = 'client',
  ): Promise<AuthSessionResult> {
    const access = await this.issueAccessToken(identity, audience);
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
    readonly accessAudience?: AccessTokenAudience;
  }): Promise<{ challengeId: string; expiresAt: string; resendAfterSeconds: number }> {
    const phoneE164 = normalizePhoneE164(input.phone);
    if (!phoneE164) throw new AuthServiceError('AUTH_PHONE_INVALID');
    const binding = await this.binding(input.tenantKey);
    const cupDevAuthentication = this.isCupDevAuthentication(phoneE164, input.accessAudience);
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
    if (cupDevAuthentication) {
      return {
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt,
        resendAfterSeconds: this.options.config.AUTH_CHALLENGE_RESEND_SECONDS,
      };
    }
    try {
      await this.provider(binding.provider).requestPhoneCode({
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
    readonly accessAudience?: AccessTokenAudience;
    readonly acceptance?: {
      readonly publicOfferAccepted: boolean;
      readonly personalDataPolicyAccepted: boolean;
    };
  }): Promise<AuthSessionResult> {
    if (!OTP_PATTERN.test(input.code)) throw new AuthServiceError('AUTH_CODE_INVALID');
    const audience = input.accessAudience ?? 'client';
    if (
      audience === 'client' &&
      (!input.acceptance?.publicOfferAccepted || !input.acceptance.personalDataPolicyAccepted)
    ) {
      throw new AuthServiceError('LEGAL_ACCEPTANCE_REQUIRED');
    }
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
        input.accessAudience,
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

    const cupDevAuthentication = this.isCupDevAuthentication(
      challenge.phoneE164,
      input.accessAudience,
    );
    let user: AuthUser;
    let phoneDelegation: VerifiedPhoneAuthentication['delegation'];
    if (cupDevAuthentication) {
      if (input.code !== this.options.config.CUP_DEV_AUTH_OTP_CODE) {
        const attempts = await this.options.challengeStore.incrementAttempts(challenge.id);
        if (attempts !== undefined && attempts >= this.options.config.AUTH_CHALLENGE_MAX_ATTEMPTS) {
          await this.options.challengeStore.delete(challenge.id);
        } else {
          await this.options.challengeStore.release(challenge.id, claimId);
        }
        throw new AuthServiceError('AUTH_CODE_INVALID');
      }
      const localUser = await this.options.repository.getUserByPhone?.(
        challenge.tenantId,
        challenge.phoneE164,
      );
      if (!localUser) {
        await this.options.challengeStore.release(challenge.id, claimId);
        throw new AuthServiceError('AUTH_ADMIN_ACCESS_DENIED');
      }
      user = localUser;
    } else {
      let externalIdentity: VerifiedExternalIdentity;
      try {
        const verification = await this.provider(challenge.provider).verifyPhoneCode({
          phoneE164: challenge.phoneE164,
          code: input.code,
          providerTenantKey: challenge.providerTenantKey,
          correlationId: input.correlationId,
        });
        if ('identity' in verification) {
          externalIdentity = verification.identity;
          phoneDelegation = verification.delegation;
        } else {
          externalIdentity = verification;
        }
      } catch (error) {
        if (error instanceof IdentityProviderError && error.code === 'AUTH_CODE_INVALID') {
          const attempts = await this.options.challengeStore.incrementAttempts(challenge.id);
          if (
            attempts !== undefined &&
            attempts >= this.options.config.AUTH_CHALLENGE_MAX_ATTEMPTS
          ) {
            await this.options.challengeStore.delete(challenge.id);
          } else {
            await this.options.challengeStore.release(challenge.id, claimId);
          }
        } else {
          await this.options.challengeStore.release(challenge.id, claimId);
        }
        this.mapProviderError(error);
      }
      const identityBinding: TenantAuthBinding = {
        tenantId: challenge.tenantId,
        tenantKey: challenge.tenantKey,
        provider: challenge.provider,
        providerTenantKey: challenge.providerTenantKey,
      };
      try {
        user = await this.options.repository.upsertExternalIdentity({
          binding: identityBinding,
          identity: externalIdentity,
          correlationId: input.correlationId,
        });
      } catch (error) {
        this.mapIdentityRepositoryError(error);
      }
      if (audience === 'client') {
        await this.options.repository.recordPhoneLegalAcceptances({
          tenantId: challenge.tenantId,
          userId: user.id,
          correlationId: input.correlationId,
          publicOfferVersion: this.options.config.PUBLIC_OFFER_VERSION,
          personalDataPolicyVersion: this.options.config.PERSONAL_DATA_POLICY_VERSION,
        });
      }
      if (challenge.provider === 'VIVA' && phoneDelegation) {
        await this.options.repository.saveVivaDelegation({
          tenantId: challenge.tenantId,
          userId: user.id,
          issuer: externalIdentity.issuer,
          subject: externalIdentity.subject,
          refreshTokenCiphertext: this.encryptVivaRefreshToken(phoneDelegation.refreshToken),
          encryptionKeyVersion: this.options.config.VIVA_DELEGATION_KEY_VERSION,
          grantedScopes: this.options.config.VIVA_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
          ...(phoneDelegation.refreshExpiresIn
            ? {
                refreshExpiresAt: new Date(
                  this.now().getTime() + phoneDelegation.refreshExpiresIn * 1000,
                ),
              }
            : {}),
          correlationId: input.correlationId,
        });
      } else if (challenge.provider === 'VIVA' && this.options.config.HOME_VIVA_SYNC_ENABLED) {
        throw new AuthServiceError('VIVA_REAUTH_REQUIRED');
      }
    }
    try {
      await this.assertUserAudienceAccess(challenge.tenantId, user.id, audience);
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
        input.accessAudience,
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
    accessAudience: AccessTokenAudience = 'client',
  ): Promise<AuthSessionResult> {
    await this.binding(tenantKey);
    if (accessAudience === 'admin' && this.options.repository.getRefreshSessionPrincipal) {
      const principal = await this.options.repository.getRefreshSessionPrincipal(
        tenantKey,
        this.refreshTokenHash(currentRefreshToken),
      );
      if (!principal) throw new AuthServiceError('AUTH_SESSION_REVOKED');
      await this.assertUserAudienceAccess(principal.tenantId, principal.userId, accessAudience);
    }
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
    return this.sessionResult(rotation.identity, nextRefreshToken, accessAudience);
  }

  public async revokeSession(
    tenantKey: string,
    refreshToken: string,
    correlationId: string,
    revokeVivaDelegation = true,
  ): Promise<void> {
    await this.binding(tenantKey);
    const tokenHash = this.refreshTokenHash(refreshToken);
    if (revokeVivaDelegation) {
      await this.options.repository.revokeVivaDelegationForRefreshSession(
        tenantKey,
        tokenHash,
        correlationId,
      );
    }
    await this.options.repository.revokeRefreshSession(tenantKey, tokenHash, correlationId);
  }

  public getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined> {
    return this.options.repository.getUserContext(tenantId, userId);
  }
}
