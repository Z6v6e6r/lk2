import { createHash, createHmac } from 'node:crypto';

import type {
  IdentityProviderPort,
  VerifiedExternalIdentity,
  VivaOAuthProviderPort,
} from '@phub/auth';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import {
  AuthService,
  type AuthRepository,
  type AuthUser,
  type RefreshSessionIdentity,
  type RefreshSessionRotation,
  type TenantAuthBinding,
} from './auth-service.js';
import { MemoryAuthChallengeStore } from './challenge-store.js';
import { MemoryAndroidOAuthStore } from './android-oauth-store.js';
import {
  MemoryVivaOAuthStateStore,
  type VivaOAuthState,
  type VivaOAuthStateStore,
} from './oauth-state-store.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

function loadVivaPhoneConfig() {
  return loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
    JWT_ISSUER: 'phub-identity',
    JWT_AUDIENCE: 'phub-api',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    VIVA_MODE: 'sandbox',
    VIVA_OAUTH_ENABLED: 'true',
    VIVA_OAUTH_REDIRECT_URI: 'https://app.example.test/oauth/callback',
    VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
    VIVA_DELEGATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  });
}

const binding: TenantAuthBinding = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  tenantKey: 'local-padel',
  provider: 'VIVA',
  providerTenantKey: 'iSkq6G',
};
const user: AuthUser = {
  id: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  tenantId: binding.tenantId,
  displayName: 'Игрок ПаделхАБ',
  phoneLast4: '0001',
};

class FakeRepository implements AuthRepository {
  private tokenHash: string | undefined;
  private sessionId: string | undefined;
  private bindingValue: TenantAuthBinding = binding;
  private vivaDelegationRevocationCount = 0;
  private readonly revocationSteps: string[] = [];
  private phoneLegalAcceptanceCount = 0;
  private legalAcceptanceCount = 0;
  private currentLegalAcceptances = true;
  private existingSubjectUser: AuthUser | undefined = user;
  private identityUpsertCount = 0;
  private refreshSessionCreationCount = 0;
  private vivaDelegationSaveCount = 0;
  private rejectNextActiveSessionSave = false;
  private rejectIdentityUpsertAsDisabled = false;
  private vivaDelegation:
    | {
        issuer: string;
        subject: string;
        refreshTokenCiphertext: string;
        encryptionKeyVersion: string;
        refreshExpiresAt?: string;
      }
    | undefined;

  public setBinding(nextBinding: TenantAuthBinding): void {
    this.bindingValue = nextBinding;
  }

  public get vivaDelegationRevocations(): number {
    return this.vivaDelegationRevocationCount;
  }

  public get revocationOrder(): readonly string[] {
    return this.revocationSteps;
  }

  public get phoneLegalAcceptances(): number {
    return this.phoneLegalAcceptanceCount;
  }

  public get legalAcceptances(): number {
    return this.legalAcceptanceCount;
  }

  public get hasVivaDelegation(): boolean {
    return this.vivaDelegation !== undefined;
  }

  public get identityUpserts(): number {
    return this.identityUpsertCount;
  }

  public get refreshSessionCreations(): number {
    return this.refreshSessionCreationCount;
  }

  public get vivaDelegationSaves(): number {
    return this.vivaDelegationSaveCount;
  }

  public get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  public setActiveSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  public rejectNextGuardedDelegationSave(): void {
    this.rejectNextActiveSessionSave = true;
  }

  public setExistingSubjectUser(nextUser: AuthUser | undefined): void {
    this.existingSubjectUser = nextUser;
  }

  public setCurrentLegalAcceptances(value: boolean): void {
    this.currentLegalAcceptances = value;
  }

  public rejectNextIdentityUpsertForDisabledUser(): void {
    this.rejectIdentityUpsertAsDisabled = true;
  }

  public resolveTenantAuthBinding(tenantKey: string): Promise<TenantAuthBinding | undefined> {
    return Promise.resolve(
      tenantKey === this.bindingValue.tenantKey ? this.bindingValue : undefined,
    );
  }

  public resolveExistingExternalIdentity(): Promise<AuthUser | undefined> {
    return Promise.resolve(this.existingSubjectUser);
  }

  public upsertExternalIdentity(): Promise<AuthUser> {
    this.identityUpsertCount += 1;
    if (this.rejectIdentityUpsertAsDisabled) {
      this.rejectIdentityUpsertAsDisabled = false;
      return Promise.reject(new Error('AUTH_USER_NOT_ACTIVE'));
    }
    return Promise.resolve(user);
  }

  public createRefreshSession(input: {
    readonly sessionId: string;
    readonly tokenHash: string;
  }): Promise<void> {
    this.refreshSessionCreationCount += 1;
    this.sessionId = input.sessionId;
    this.tokenHash = input.tokenHash;
    return Promise.resolve();
  }

  public rotateRefreshSession(input: {
    readonly tenantKey: string;
    readonly currentTokenHash: string;
    readonly nextTokenHash: string;
  }): Promise<RefreshSessionRotation> {
    if (input.tenantKey !== binding.tenantKey || input.currentTokenHash !== this.tokenHash) {
      return Promise.resolve({ outcome: 'invalid' });
    }
    this.tokenHash = input.nextTokenHash;
    return Promise.resolve({
      outcome: 'rotated',
      identity: {
        sessionId: this.sessionId ?? 'missing',
        tenantId: binding.tenantId,
        tenantKey: binding.tenantKey,
        user,
      },
    });
  }

  public revokeRefreshSession(_tenantKey: string, tokenHash: string): Promise<boolean> {
    this.revocationSteps.push('session');
    const revoked = tokenHash === this.tokenHash;
    if (revoked) this.tokenHash = undefined;
    return Promise.resolve(revoked);
  }

  public revokeSessionAndVivaDelegation(tenantKey: string, tokenHash: string): Promise<boolean> {
    this.revocationSteps.push('session+delegation');
    this.vivaDelegationRevocationCount += 1;
    const revoked = tenantKey === binding.tenantKey && tokenHash === this.tokenHash;
    if (revoked) this.tokenHash = undefined;
    return Promise.resolve(revoked);
  }

  public getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined> {
    return Promise.resolve(tenantId === user.tenantId && userId === user.id ? user : undefined);
  }

  public getUserByPhone(tenantId: string, phoneE164: string): Promise<AuthUser | undefined> {
    return Promise.resolve(
      tenantId === user.tenantId && phoneE164 === '+79990000001' ? user : undefined,
    );
  }

  public getUserAccessProfile(): Promise<{
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
  }> {
    return Promise.resolve({
      roles: ['client', 'admin'],
      permissions: ['profile.read', 'notifications.manage'],
    });
  }

  public findRefreshSessionById(
    tenantKey: string,
    sessionId: string,
  ): Promise<RefreshSessionIdentity | undefined> {
    if (tenantKey !== binding.tenantKey || sessionId !== this.sessionId) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      sessionId,
      familyId: sessionId,
      tenantId: binding.tenantId,
      tenantKey: binding.tenantKey,
      user,
    });
  }

  public saveVivaDelegation(input: {
    readonly issuer: string;
    readonly subject: string;
    readonly refreshTokenCiphertext: string;
    readonly encryptionKeyVersion: string;
    readonly grantedScopes: readonly string[];
    readonly refreshExpiresAt?: Date;
  }): Promise<void> {
    this.vivaDelegationSaveCount += 1;
    this.vivaDelegation = {
      issuer: input.issuer,
      subject: input.subject,
      refreshTokenCiphertext: input.refreshTokenCiphertext,
      encryptionKeyVersion: input.encryptionKeyVersion,
      ...(input.refreshExpiresAt ? { refreshExpiresAt: input.refreshExpiresAt.toISOString() } : {}),
    };
    return Promise.resolve();
  }

  public saveVivaDelegationForActiveSession(
    input: Parameters<AuthRepository['saveVivaDelegationForActiveSession']>[0],
  ): Promise<boolean> {
    if (this.rejectNextActiveSessionSave) {
      this.rejectNextActiveSessionSave = false;
      return Promise.resolve(false);
    }
    if (input.sessionFamilyId !== this.sessionId) return Promise.resolve(false);
    return this.saveVivaDelegation(input).then(() => true);
  }

  public getVivaDelegation(): Promise<typeof this.vivaDelegation> {
    return Promise.resolve(this.vivaDelegation);
  }

  public recordLegalAcceptances(): Promise<void> {
    this.legalAcceptanceCount += 1;
    return Promise.resolve();
  }

  public recordPhoneLegalAcceptances(): Promise<void> {
    this.phoneLegalAcceptanceCount += 1;
    return Promise.resolve();
  }

  public recordLegalAcceptanceIntent(): Promise<void> {
    return Promise.resolve();
  }

  public hasCurrentLegalAcceptances(): Promise<boolean> {
    return Promise.resolve(this.currentLegalAcceptances);
  }
}

const provider: IdentityProviderPort = {
  key: 'VIVA',
  requestPhoneCode: () => Promise.resolve(),
  verifyPhoneCode: (input): Promise<VerifiedExternalIdentity> => {
    if (input.code !== '0000') return Promise.reject(new Error('unexpected test code'));
    return Promise.resolve({
      issuer: 'https://identity.example.test',
      subject: 'external-user-1',
      phoneE164: input.phoneE164,
      displayName: user.displayName,
    });
  },
};

const oauthProvider: VivaOAuthProviderPort = {
  createAuthorizationUrl: (input) =>
    `https://identity.example.test/auth?state=${encodeURIComponent(input.state)}`,
  exchangeAuthorizationCode: () =>
    Promise.resolve({
      identity: {
        issuer: 'https://identity.example.test',
        subject: 'external-user-1',
        phoneE164: '+79990000001',
        displayName: user.displayName,
      },
      identityResolution: 'CANONICAL_PROFILE',
      accessToken: 'initial-viva-access-token',
      accessExpiresIn: 300,
      refreshToken: 'initial-viva-refresh-token',
      refreshExpiresIn: 3600,
    }),
  refreshUserDelegation: () =>
    Promise.resolve({
      accessToken: 'refreshed-viva-access-token',
      accessExpiresIn: 300,
      refreshToken: 'rotated-viva-refresh-token',
      refreshExpiresIn: 3600,
    }),
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('provider-neutral authentication routes', () => {
  it('rejects a provider outside the configured OAuth allowlist before creating state', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_ALLOWED_PROVIDERS: 'yandex',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const service = new AuthService({
      config: oauthConfig,
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
    });

    await expect(
      service.startVivaOAuth({
        tenantKey: binding.tenantKey,
        provider: 'vkid',
        publicOfferAccepted: true,
        personalDataPolicyAccepted: true,
        correlationId: 'oauth-disallowed-provider',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('hands off the initial Viva access token once and refreshes it from encrypted delegation', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const repository = new FakeRepository();
    const stateStore = new MemoryVivaOAuthStateStore();
    const identityModes: Array<'STANDARD' | 'RECOVERY_SUBJECT_ONLY'> = [];
    const recordingOAuthProvider: VivaOAuthProviderPort = {
      ...oauthProvider,
      exchangeAuthorizationCode: (input) => {
        identityModes.push(input.identityMode);
        return oauthProvider.exchangeAuthorizationCode(input);
      },
    };
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: recordingOAuthProvider,
      vivaOAuthStateStore: stateStore,
    });

    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'vkid',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'oauth-start-correlation',
    });
    const state = new URL(started.redirectUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    const completed = await service.completeVivaOAuth({
      tenantKey: binding.tenantKey,
      state: state ?? '',
      code: 'authorization-code',
      correlationId: 'oauth-complete-correlation',
      idempotencyKey: 'oauth-complete-idempotency',
      oauthBrowserNonce: started.browserNonce,
    });
    if ('androidRedirectUrl' in completed) throw new Error('Unexpected native callback');
    expect(identityModes).toEqual(['STANDARD']);
    const padlHubSessionId = repository.activeSessionId;
    if (!padlHubSessionId) throw new Error('Expected an active PadlHub session');

    repository.setActiveSessionId(undefined);
    await expect(
      service.issueVivaAccessToken({
        tenantKey: binding.tenantKey,
        tenantId: binding.tenantId,
        userId: user.id,
        sessionId: padlHubSessionId,
        handoffCode: completed.vivaHandoffCode,
        correlationId: 'oauth-handoff-revoked-session',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    repository.setActiveSessionId(padlHubSessionId);
    const initialAccess = await service.issueVivaAccessToken({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: padlHubSessionId,
      handoffCode: completed.vivaHandoffCode,
      correlationId: 'oauth-handoff-correlation',
    });
    expect(initialAccess.accessToken).toBe('initial-viva-access-token');
    await expect(
      jwtVerify(
        initialAccess.profilePhotoGrant,
        new TextEncoder().encode(config.JWT_ACCESS_SECRET),
        {
          issuer: config.JWT_ISSUER,
          audience: `${config.JWT_AUDIENCE}:profile-photo-sync`,
          algorithms: ['HS256'],
        },
      ),
    ).resolves.toMatchObject({
      protectedHeader: { typ: 'phub-profile-photo-grant+jwt' },
      payload: {
        sub: user.id,
        tenantId: binding.tenantId,
        sid: padlHubSessionId,
        scope: 'profile.photo.sync',
      },
    });
    await expect(
      service.issueVivaAccessToken({
        tenantKey: binding.tenantKey,
        tenantId: binding.tenantId,
        userId: user.id,
        sessionId: padlHubSessionId,
        handoffCode: completed.vivaHandoffCode,
        correlationId: 'oauth-handoff-replay',
      }),
    ).rejects.toMatchObject({ code: 'VIVA_REAUTH_REQUIRED' });

    const refreshedAccess = await service.issueVivaAccessToken({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: padlHubSessionId,
      correlationId: 'oauth-refresh-correlation',
    });
    expect(refreshedAccess.accessToken).toBe('refreshed-viva-access-token');
    const savesBeforeRevokedRefresh = repository.vivaDelegationSaves;
    repository.rejectNextGuardedDelegationSave();
    await expect(
      service.issueVivaAccessToken({
        tenantKey: binding.tenantKey,
        tenantId: binding.tenantId,
        userId: user.id,
        sessionId: padlHubSessionId,
        correlationId: 'oauth-refresh-after-logout-correlation',
      }),
    ).rejects.toMatchObject({ code: 'VIVA_REAUTH_REQUIRED' });
    expect(repository.vivaDelegationSaves).toBe(savesBeforeRevokedRefresh);
    const recoverySessionId = padlHubSessionId;

    const recovery = await service.startVivaOAuthRecovery({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: recoverySessionId,
      provider: 'yandex',
      correlationId: 'oauth-recovery-start-correlation',
      idempotencyKey: 'oauth-recovery-start-idempotency',
    });
    await expect(
      service.startVivaOAuthRecovery({
        tenantKey: binding.tenantKey,
        tenantId: binding.tenantId,
        userId: user.id,
        sessionId: recoverySessionId,
        provider: 'yandex',
        correlationId: 'oauth-recovery-replay-correlation',
        idempotencyKey: 'oauth-recovery-start-idempotency',
      }),
    ).resolves.toEqual(recovery);
    await expect(
      service.startVivaOAuthRecovery({
        tenantKey: binding.tenantKey,
        tenantId: binding.tenantId,
        userId: user.id,
        sessionId: recoverySessionId,
        provider: 'vkid',
        correlationId: 'oauth-recovery-conflict-correlation',
        idempotencyKey: 'oauth-recovery-start-idempotency',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    const recoveryState = new URL(recovery.redirectUrl).searchParams.get('state') ?? '';
    const beforeRecoveryAcceptances = repository.legalAcceptances;
    const beforeRecoveryUpserts = repository.identityUpserts;
    const beforeRecoverySessions = repository.refreshSessionCreations;
    const completedRecovery = await service.completeVivaOAuth({
      tenantKey: binding.tenantKey,
      state: recoveryState,
      code: 'recovery-authorization-code',
      correlationId: 'oauth-recovery-complete-correlation',
      idempotencyKey: 'oauth-recovery-complete-idempotency',
      oauthBrowserNonce: recovery.browserNonce,
    });
    if ('androidRedirectUrl' in completedRecovery) throw new Error('Unexpected native callback');
    expect(completedRecovery.vivaRecovery).toBe(true);
    expect(identityModes).toEqual(['STANDARD', 'RECOVERY_SUBJECT_ONLY']);
    expect(repository.legalAcceptances).toBe(beforeRecoveryAcceptances);
    expect(repository.identityUpserts).toBe(beforeRecoveryUpserts);
    expect(repository.refreshSessionCreations).toBe(beforeRecoverySessions);

    const crossBrowserRecovery = await service.startVivaOAuthRecovery({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: recoverySessionId,
      provider: 'yandex',
      correlationId: 'oauth-recovery-cross-browser-start',
      idempotencyKey: 'oauth-recovery-cross-browser-idempotency',
    });
    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: new URL(crossBrowserRecovery.redirectUrl).searchParams.get('state') ?? '',
        code: 'cross-browser-authorization-code',
        correlationId: 'oauth-recovery-cross-browser-complete',
        idempotencyKey: 'oauth-recovery-cross-browser-complete-idempotency',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_OAUTH_BROWSER_MISMATCH' });
    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: new URL(crossBrowserRecovery.redirectUrl).searchParams.get('state') ?? '',
        code: 'original-browser-authorization-code',
        correlationId: 'oauth-recovery-original-browser-complete',
        idempotencyKey: 'oauth-recovery-original-browser-complete-idempotency',
        oauthBrowserNonce: crossBrowserRecovery.browserNonce,
      }),
    ).resolves.toMatchObject({ vivaRecovery: true });

    const legacyState = {
      state: 'pre-browser-binding-state',
      tenantKey: binding.tenantKey,
      provider: 'yandex',
      codeVerifier: 'pre-browser-binding-verifier',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      publicOfferVersion: oauthConfig.PUBLIC_OFFER_VERSION,
      personalDataPolicyVersion: oauthConfig.PERSONAL_DATA_POLICY_VERSION,
      recoveryUserId: user.id,
    } as VivaOAuthState;
    await stateStore.put(legacyState, oauthConfig.AUTH_CHALLENGE_TTL_SECONDS);
    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: legacyState.state,
        code: 'pre-browser-binding-code',
        correlationId: 'pre-browser-binding-callback',
        idempotencyKey: 'pre-browser-binding-idempotency',
        oauthBrowserNonce: 'untrusted-pre-release-nonce',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_OAUTH_BROWSER_MISMATCH' });

    const mismatchedStateStore = {
      claimCallback: () =>
        Promise.resolve({
          outcome: 'claimed',
          state: {
            ...legacyState,
            state: 'stored-state-that-does-not-match-the-callback',
            browserNonceHash: 'b'.repeat(64),
          },
        }),
    } as unknown as VivaOAuthStateStore;
    const mismatchedStateService = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: mismatchedStateStore,
    });
    await expect(
      mismatchedStateService.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: 'callback-state',
        code: 'mismatched-state-code',
        correlationId: 'mismatched-state-callback',
        idempotencyKey: 'mismatched-state-idempotency',
        oauthBrowserNonce: 'untrusted-mismatched-state-nonce',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_CODE_EXPIRED' });

    repository.setCurrentLegalAcceptances(false);
    await expect(
      service.startVivaOAuthRecovery({
        tenantKey: binding.tenantKey,
        tenantId: binding.tenantId,
        userId: user.id,
        sessionId: recoverySessionId,
        provider: 'yandex',
        correlationId: 'oauth-recovery-stale-legal-correlation',
        idempotencyKey: 'oauth-recovery-stale-legal-idempotency',
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_ACCEPTANCE_REQUIRED' });

    repository.setCurrentLegalAcceptances(true);
    const revokedRecovery = await service.startVivaOAuthRecovery({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: recoverySessionId,
      provider: 'yandex',
      correlationId: 'oauth-recovery-revoked-family-start',
      idempotencyKey: 'oauth-recovery-revoked-family-start-idempotency',
    });
    const beforeRevokedRecoverySaves = repository.vivaDelegationSaves;
    repository.setActiveSessionId(undefined);
    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: new URL(revokedRecovery.redirectUrl).searchParams.get('state') ?? '',
        code: 'oauth-recovery-revoked-family-code',
        correlationId: 'oauth-recovery-revoked-family-complete',
        idempotencyKey: 'oauth-recovery-revoked-family-complete-idempotency',
        oauthBrowserNonce: revokedRecovery.browserNonce,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    expect(repository.vivaDelegationSaves).toBe(beforeRevokedRecoverySaves);
    expect(repository.refreshSessionCreations).toBe(beforeRecoverySessions);
  });

  it('fails recovery closed when the verified subject belongs to another PadlHub user', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const repository = new FakeRepository();
    const recoverySessionId = '22ab6e2e-5bb0-4453-9f2c-fd4b8ed32767';
    repository.setActiveSessionId(recoverySessionId);
    repository.setExistingSubjectUser({
      ...user,
      id: '750f25f5-59fe-413c-a5f2-4256a919c674',
    });
    const stateStore = new MemoryVivaOAuthStateStore();
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: stateStore,
    });

    const recovery = await service.startVivaOAuthRecovery({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: recoverySessionId,
      provider: 'yandex',
      correlationId: 'oauth-recovery-conflicting-subject-start',
      idempotencyKey: 'oauth-recovery-conflicting-subject-start-idempotency',
    });

    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: new URL(recovery.redirectUrl).searchParams.get('state') ?? '',
        code: 'oauth-recovery-conflicting-subject-code',
        correlationId: 'oauth-recovery-conflicting-subject-complete',
        idempotencyKey: 'oauth-recovery-conflicting-subject-complete-idempotency',
        oauthBrowserNonce: recovery.browserNonce,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(repository.identityUpserts).toBe(0);
    expect(repository.vivaDelegationSaves).toBe(0);
    expect(repository.refreshSessionCreations).toBe(0);
  });

  it('does not set a new PadlHub refresh cookie after a successful Viva recovery callback', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const repository = new FakeRepository();
    const recoverySessionId = '676d1677-c503-4478-889f-f5e848ebdaf9';
    repository.setActiveSessionId(recoverySessionId);
    const stateStore = new MemoryVivaOAuthStateStore();
    const authService = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: stateStore,
    });
    const recovery = await authService.startVivaOAuthRecovery({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId: recoverySessionId,
      provider: 'yandex',
      correlationId: 'oauth-recovery-cookie-start',
      idempotencyKey: 'oauth-recovery-cookie-start-idempotency',
    });
    const app = await buildApp({
      config: oauthConfig,
      logger: createLogger('api-viva-oauth-recovery-cookie-test', 'silent'),
      authService,
    });
    apps.push(app);
    const state = new URL(recovery.redirectUrl).searchParams.get('state') ?? '';
    const cookieSuffix = createHmac('sha256', oauthConfig.JWT_REFRESH_SECRET)
      .update(state)
      .digest('base64url')
      .slice(0, 16);

    const callback = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/auth/viva/callback?state=${encodeURIComponent(state)}&code=recovery-cookie-code`,
      headers: {
        cookie: `phub_oauth_browser_${cookieSuffix}=${recovery.browserNonce}`,
      },
    });

    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers['set-cookie'] ?? '')).not.toContain('phub_refresh=');
    expect(repository.refreshSessionCreations).toBe(0);
    expect(repository.vivaDelegationSaves).toBe(1);
  });

  it('binds OAuth callback session issuance to the initiating browser cookie', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const authService = new AuthService({
      config: oauthConfig,
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
    });
    const app = await buildApp({
      config: oauthConfig,
      logger: createLogger('api-viva-oauth-browser-binding-test', 'silent'),
      authService,
    });
    apps.push(app);

    const startOAuth = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/auth/viva/authorize',
        headers: { 'idempotency-key': key },
        payload: {
          provider: 'yandex',
          acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
        },
      });
    const firstStart = await startOAuth('viva-oauth-browser-binding-0001');
    const firstState = new URL(
      firstStart.json<{ redirectUrl: string }>().redirectUrl,
    ).searchParams.get('state');
    expect(firstStart.statusCode).toBe(200);
    expect(firstStart.headers['cache-control']).toBe('no-store');

    const crossBrowserCallback = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/auth/viva/callback?state=${encodeURIComponent(firstState ?? '')}&code=cross-browser-code`,
    });
    expect(crossBrowserCallback.statusCode).toBe(401);
    expect(crossBrowserCallback.json()).toMatchObject({ code: 'AUTH_OAUTH_BROWSER_MISMATCH' });
    expect(String(crossBrowserCallback.headers['set-cookie'] ?? '')).not.toContain('phub_refresh=');

    const secondStart = await startOAuth('viva-oauth-browser-binding-0002');
    const secondState = new URL(
      secondStart.json<{ redirectUrl: string }>().redirectUrl,
    ).searchParams.get('state');
    const startCookies = Array.isArray(secondStart.headers['set-cookie'])
      ? secondStart.headers['set-cookie']
      : [secondStart.headers['set-cookie']];
    const browserCookie = startCookies
      .find((value) => value?.startsWith('phub_oauth_browser_'))
      ?.split(';')[0];
    expect(browserCookie).toBeTruthy();
    const browserCookieHeader = startCookies.find((value) =>
      value?.startsWith('phub_oauth_browser_'),
    );
    expect(browserCookieHeader).toContain('HttpOnly');
    expect(browserCookieHeader).toContain('SameSite=Lax');
    expect(browserCookieHeader).toContain('Path=/user/api/v1/local-padel/auth/viva/callback');

    const sameBrowserCallback = await app.inject({
      method: 'GET',
      url: `/user/api/v1/local-padel/auth/viva/callback?state=${encodeURIComponent(secondState ?? '')}&code=same-browser-code`,
      headers: { cookie: browserCookie ?? '' },
    });
    const callbackCookies = Array.isArray(sameBrowserCallback.headers['set-cookie'])
      ? sameBrowserCallback.headers['set-cookie']
      : [sameBrowserCallback.headers['set-cookie']];
    expect(sameBrowserCallback.statusCode).toBe(302);
    expect(callbackCookies.some((value) => value?.startsWith('phub_refresh='))).toBe(true);
    expect(
      callbackCookies.some(
        (value) => value?.startsWith('phub_oauth_browser_') && value.includes('Max-Age=0'),
      ),
    ).toBe(true);

    const concurrentStarts = await Promise.all([
      startOAuth('viva-oauth-browser-binding-0003'),
      startOAuth('viva-oauth-browser-binding-0004'),
    ]);
    const concurrent = concurrentStarts.map((response) => {
      const state = new URL(response.json<{ redirectUrl: string }>().redirectUrl).searchParams.get(
        'state',
      );
      const cookies = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie']
        : [response.headers['set-cookie']];
      return {
        state,
        cookie: cookies.find((value) => value?.startsWith('phub_oauth_browser_'))?.split(';')[0],
      };
    });
    for (const flow of [...concurrent].reverse()) {
      const callback = await app.inject({
        method: 'GET',
        url: `/user/api/v1/local-padel/auth/viva/callback?state=${encodeURIComponent(flow.state ?? '')}&code=concurrent-browser-code`,
        headers: { cookie: flow.cookie ?? '' },
      });
      expect(callback.statusCode).toBe(302);
      expect(String(callback.headers['set-cookie'])).toContain('phub_refresh=');
    }
  });

  it('creates a PadlHub user for a verified Yandex subject when provisioning is enabled', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_ALLOWED_PROVIDERS: 'yandex',
      VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED: 'true',
      PUBLIC_OFFER_VERSION: '2026-07-18',
      PERSONAL_DATA_POLICY_VERSION: '2026-07-18',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const repository = new FakeRepository();
    repository.setExistingSubjectUser(undefined);
    const stateStore = new MemoryVivaOAuthStateStore();
    const subjectProvisioningProvider: VivaOAuthProviderPort = {
      ...oauthProvider,
      exchangeAuthorizationCode: () =>
        Promise.resolve({
          identity: {
            issuer: 'https://identity.example.test',
            subject: 'new-yandex-user',
            displayName: 'Новый игрок',
          },
          identityResolution: 'SUBJECT_PROVISIONING',
          accessToken: 'yandex-access-token',
          refreshToken: 'yandex-refresh-token',
        }),
    };
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: subjectProvisioningProvider,
      vivaOAuthStateStore: stateStore,
    });

    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'yandex',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'subject-provisioning-start',
    });
    const state = new URL(started.redirectUrl).searchParams.get('state') ?? '';
    const completed = await service.completeVivaOAuth({
      tenantKey: binding.tenantKey,
      state,
      code: 'authorization-code',
      correlationId: 'subject-provisioning-complete',
      idempotencyKey: 'subject-provisioning-idempotency',
      oauthBrowserNonce: started.browserNonce,
    });
    if ('androidRedirectUrl' in completed) throw new Error('Unexpected native callback');

    expect(completed.user.id).toBe(user.id);
    expect(repository.identityUpserts).toBe(1);
    expect(repository.refreshSessionCreations).toBe(1);
    expect(repository.legalAcceptances).toBe(1);
    expect(repository.hasVivaDelegation).toBe(true);
  });

  it('issues no session or delegation when the Yandex subject maps to a disabled user', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_ALLOWED_PROVIDERS: 'yandex',
      VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED: 'true',
      PUBLIC_OFFER_VERSION: '2026-07-18',
      PERSONAL_DATA_POLICY_VERSION: '2026-07-18',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const repository = new FakeRepository();
    repository.rejectNextIdentityUpsertForDisabledUser();
    const stateStore = new MemoryVivaOAuthStateStore();
    const subjectProvisioningProvider: VivaOAuthProviderPort = {
      ...oauthProvider,
      exchangeAuthorizationCode: () =>
        Promise.resolve({
          identity: {
            issuer: 'https://identity.example.test',
            subject: 'disabled-yandex-user',
            displayName: 'Заблокированный игрок',
          },
          identityResolution: 'SUBJECT_PROVISIONING',
          accessToken: 'disabled-yandex-access-token',
          refreshToken: 'disabled-yandex-refresh-token',
        }),
    };
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: subjectProvisioningProvider,
      vivaOAuthStateStore: stateStore,
    });

    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'yandex',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'disabled-subject-provisioning-start',
    });

    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state: new URL(started.redirectUrl).searchParams.get('state') ?? '',
        code: 'disabled-subject-authorization-code',
        correlationId: 'disabled-subject-provisioning-complete',
        idempotencyKey: 'disabled-subject-provisioning-idempotency',
        oauthBrowserNonce: started.browserNonce,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_CONFLICT' });
    expect(repository.identityUpserts).toBe(1);
    expect(repository.legalAcceptances).toBe(0);
    expect(repository.vivaDelegationSaves).toBe(0);
    expect(repository.refreshSessionCreations).toBe(0);
  });

  it('bootstraps mixed OAuth only through an already-linked issuer and subject', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
      VIVA_DIRECT_READ_ENABLED: 'true',
    });
    const repository = new FakeRepository();
    const stateStore = new MemoryVivaOAuthStateStore();
    const existingSubjectProvider: VivaOAuthProviderPort = {
      ...oauthProvider,
      exchangeAuthorizationCode: () =>
        Promise.resolve({
          identity: {
            issuer: 'https://identity.example.test',
            subject: 'external-user-1',
            displayName: 'Social Account Name',
          },
          identityResolution: 'EXISTING_SUBJECT',
          accessToken: 'mixed-viva-access-token',
          accessExpiresIn: 300,
          refreshToken: 'mixed-viva-refresh-token',
          refreshExpiresIn: 3600,
        }),
    };
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: existingSubjectProvider,
      vivaOAuthStateStore: stateStore,
    });

    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'vkid',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'mixed-oauth-start-correlation',
    });
    const state = new URL(started.redirectUrl).searchParams.get('state') ?? '';
    const completed = await service.completeVivaOAuth({
      tenantKey: binding.tenantKey,
      state,
      code: 'authorization-code',
      correlationId: 'mixed-oauth-complete-correlation',
      idempotencyKey: 'mixed-oauth-complete-idempotency',
      oauthBrowserNonce: started.browserNonce,
    });
    if ('androidRedirectUrl' in completed) throw new Error('Unexpected native callback');

    expect(completed.user.id).toBe(user.id);
    expect(repository.identityUpserts).toBe(0);
    expect(repository.hasVivaDelegation).toBe(true);
  });

  it('fails closed when mixed OAuth returns an issuer and subject that are not linked', async () => {
    const oauthConfig = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
      VIVA_DIRECT_READ_ENABLED: 'true',
    });
    const repository = new FakeRepository();
    repository.setExistingSubjectUser(undefined);
    const stateStore = new MemoryVivaOAuthStateStore();
    const existingSubjectProvider: VivaOAuthProviderPort = {
      ...oauthProvider,
      exchangeAuthorizationCode: () =>
        Promise.resolve({
          identity: {
            issuer: 'https://identity.example.test',
            subject: 'unlinked-external-user',
            displayName: 'Unlinked User',
          },
          identityResolution: 'EXISTING_SUBJECT',
          accessToken: 'mixed-viva-access-token',
          refreshToken: 'mixed-viva-refresh-token',
        }),
    };
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: existingSubjectProvider,
      vivaOAuthStateStore: stateStore,
    });

    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'yandex',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'unlinked-oauth-start-correlation',
    });
    const state = new URL(started.redirectUrl).searchParams.get('state') ?? '';

    await expect(
      service.completeVivaOAuth({
        tenantKey: binding.tenantKey,
        state,
        code: 'authorization-code',
        correlationId: 'unlinked-oauth-complete-correlation',
        idempotencyKey: 'unlinked-oauth-complete-idempotency',
        oauthBrowserNonce: started.browserNonce,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_LINK_REQUIRED' });
    expect(repository.identityUpserts).toBe(0);
    expect(repository.hasVivaDelegation).toBe(false);
  });

  it('keeps Viva OAuth disabled until the server-side delegation feature is configured', async () => {
    const authService = new AuthService({
      config,
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-viva-oauth-disabled-test', 'silent'),
      authService,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/viva/authorize',
      headers: { 'idempotency-key': 'viva-oauth-start-disabled-001' },
      payload: {
        provider: 'vkid',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('creates a PadlHub session, rotates it via cookie and never exposes an external token', async () => {
    const repository = new FakeRepository();
    const authService = new AuthService({
      config,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-auth-test', 'silent'),
      authService,
    });
    apps.push(app);

    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/challenges',
      headers: { 'idempotency-key': 'auth-challenge-test-0001' },
      payload: { method: 'phone_otp', phone: '+79990000001' },
    });
    expect(challengeResponse.statusCode).toBe(202);
    const challenge = challengeResponse.json<{ challengeId: string }>();

    const missingAcceptance = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challenge.challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-verify-no-legal-0001' },
      payload: { code: '0000' },
    });
    expect(missingAcceptance.statusCode).toBe(400);
    expect(missingAcceptance.json()).toMatchObject({ code: 'LEGAL_ACCEPTANCE_REQUIRED' });

    const verifyResponse = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challenge.challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-verify-test-0000001' },
      payload: {
        code: '0000',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toMatchObject({
      tokenType: 'Bearer',
      user: { id: user.id, displayName: user.displayName },
      context: {
        runtimeCapabilities: {
          communityDirectInvites: false,
          communityRealtime: false,
        },
      },
    });
    const verifiedBody = verifyResponse.json<{
      user: Record<string, unknown>;
      context: {
        tenantId: string;
        phoneLast4?: string;
        runtimeCapabilities: Record<string, boolean>;
      };
    }>();
    expect(Object.keys(verifiedBody.user).sort()).toEqual(['displayName', 'id']);
    expect(verifiedBody.context).toMatchObject({ tenantId: binding.tenantId, phoneLast4: '0001' });
    expect(verifiedBody.context.runtimeCapabilities).toEqual({
      communityDirectory: false,
      communityReadDetail: false,
      communityReadFeed: false,
      communityReadChat: false,
      communityReadRating: false,
      communityCanonical: false,
      communityDirectInvites: false,
      communityRealtime: false,
    });
    expect(repository.phoneLegalAcceptances).toBe(1);
    expect(verifyResponse.body).not.toContain('refreshToken');
    expect(verifyResponse.body).not.toContain('external-user-1');
    const firstSetCookie = String(verifyResponse.headers['set-cookie']);
    expect(firstSetCookie).toContain('phub_refresh=');
    expect(firstSetCookie).toContain('HttpOnly');
    const firstCookie = firstSetCookie.split(';')[0];

    const disallowedOrigin = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/session/refresh',
      headers: {
        cookie: firstCookie,
        origin: 'https://untrusted.example',
        'x-session-intent': 'refresh',
        'idempotency-key': 'auth-refresh-origin-001',
      },
    });
    expect(disallowedOrigin.statusCode).toBe(403);

    const missingIntent = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/session/refresh',
      headers: { cookie: firstCookie, 'idempotency-key': 'auth-refresh-intent-001' },
    });
    expect(missingIntent.statusCode).toBe(400);

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/session/refresh',
      headers: {
        cookie: firstCookie,
        'x-session-intent': 'refresh',
        'idempotency-key': 'auth-refresh-test-0001',
      },
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({
      context: {
        runtimeCapabilities: {
          communityDirectInvites: false,
          communityRealtime: false,
        },
      },
    });
    expect(refreshResponse.body).not.toContain('refreshToken');
    const nextCookie = String(refreshResponse.headers['set-cookie']).split(';')[0];
    expect(nextCookie).not.toBe(firstCookie);

    const replayResponse = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/session/refresh',
      headers: {
        cookie: firstCookie,
        'x-session-intent': 'refresh',
        'idempotency-key': 'auth-refresh-replay-01',
      },
    });
    expect(replayResponse.statusCode).toBe(401);

    const logoutResponse = await app.inject({
      method: 'DELETE',
      url: '/user/api/v1/local-padel/auth/session',
      headers: {
        cookie: nextCookie,
        'x-session-intent': 'logout',
        'idempotency-key': 'auth-logout-test-00001',
      },
    });
    expect(logoutResponse.statusCode).toBe(204);
    expect(repository.revocationOrder).toEqual(['session+delegation']);
  });

  it('persists the server-only Viva refresh delegation from phone authentication', async () => {
    const phoneProjectionConfig = loadVivaPhoneConfig();
    const repository = new FakeRepository();
    const phoneProvider: IdentityProviderPort = {
      key: 'VIVA',
      requestPhoneCode: () => Promise.resolve(),
      verifyPhoneCode: (input) =>
        Promise.resolve({
          identity: {
            issuer: 'https://identity.example.test',
            subject: 'external-user-1',
            phoneE164: input.phoneE164,
            displayName: user.displayName,
          },
          delegation: {
            refreshToken: 'server-only-phone-refresh-token',
            refreshExpiresIn: 3600,
          },
        }),
    };
    const authService = new AuthService({
      config: phoneProjectionConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', phoneProvider]]),
    });
    const app = await buildApp({
      config: phoneProjectionConfig,
      logger: createLogger('api-phone-delegation-test', 'silent'),
      authService,
    });
    apps.push(app);

    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/challenges',
      headers: { 'idempotency-key': 'phone-delegation-challenge-01' },
      payload: { method: 'phone_otp', phone: '+79990000001' },
    });
    const challenge = challengeResponse.json<{ challengeId: string }>();
    const verifyResponse = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challenge.challengeId}/verify`,
      headers: { 'idempotency-key': 'phone-delegation-verify-0001' },
      payload: {
        code: '0000',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });

    expect(verifyResponse.statusCode).toBe(200);
    expect(repository.hasVivaDelegation).toBe(true);
    expect(verifyResponse.body).not.toContain('server-only-phone-refresh-token');
  });

  it('allows Viva phone login without a delegation and defers reauthorization to browser reads', async () => {
    const phoneProjectionConfig = loadVivaPhoneConfig();
    const repository = new FakeRepository();
    const authService = new AuthService({
      config: phoneProjectionConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
    });
    const app = await buildApp({
      config: phoneProjectionConfig,
      logger: createLogger('api-phone-delegation-required-test', 'silent'),
      authService,
    });
    apps.push(app);

    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/challenges',
      headers: { 'idempotency-key': 'phone-no-delegation-challenge-1' },
      payload: { method: 'phone_otp', phone: '+79990000001' },
    });
    const challenge = challengeResponse.json<{ challengeId: string }>();
    const verifyResponse = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challenge.challengeId}/verify`,
      headers: { 'idempotency-key': 'phone-no-delegation-verify-001' },
      payload: {
        code: '0000',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });

    expect(verifyResponse.statusCode).toBe(200);
    expect(repository.hasVivaDelegation).toBe(false);
    expect(verifyResponse.headers['set-cookie']).toBeDefined();
  });

  it('uses the explicit local CUP code without calling Viva sandbox', async () => {
    const cupConfig = loadConfig({
      APP_ENV: 'local',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ADMIN_AUDIENCE: 'phub-admin',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      CUP_DEV_AUTH_ENABLED: 'true',
      CUP_DEV_AUTH_PHONE_E164: '+79990000001',
      CUP_DEV_AUTH_OTP_CODE: '0000',
    });
    const requestPhoneCode = vi.fn();
    const verifyPhoneCode = vi.fn();
    const repository = new FakeRepository();
    const authService = new AuthService({
      config: cupConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([
        [
          'VIVA',
          {
            key: 'VIVA' as const,
            requestPhoneCode,
            verifyPhoneCode,
          },
        ],
      ]),
    });
    const app = await buildApp({
      config: cupConfig,
      logger: createLogger('api-cup-dev-auth-test', 'silent'),
      authService,
    });
    apps.push(app);

    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/challenges',
      headers: {
        'idempotency-key': 'cup-dev-challenge-test-0001',
        'x-app-platform': 'cup-admin',
      },
      payload: { method: 'phone_otp', phone: '+79990000001' },
    });
    expect(challengeResponse.statusCode).toBe(202);
    const challenge = challengeResponse.json<{ challengeId: string }>();

    const verifyResponse = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challenge.challengeId}/verify`,
      headers: {
        'idempotency-key': 'cup-dev-verify-test-000001',
        'x-app-platform': 'cup-admin',
      },
      payload: { code: '0000' },
    });

    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toMatchObject({
      context: {
        userId: user.id,
        roles: ['client', 'admin'],
        permissions: ['profile.read', 'notifications.manage'],
      },
    });
    expect(requestPhoneCode).not.toHaveBeenCalled();
    expect(verifyPhoneCode).not.toHaveBeenCalled();

    const cookie = String(verifyResponse.headers['set-cookie']).split(';')[0];
    const logoutResponse = await app.inject({
      method: 'DELETE',
      url: '/user/api/v1/local-padel/auth/session',
      headers: {
        cookie,
        'idempotency-key': 'cup-dev-logout-test-000001',
        'x-app-platform': 'cup-admin',
        'x-session-intent': 'logout',
      },
    });
    expect(logoutResponse.statusCode).toBe(204);
    expect(repository.vivaDelegationRevocations).toBe(0);
  });

  it('allows only one concurrent verification to consume a challenge', async () => {
    let releaseVerification: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationCalls = 0;
    const slowProvider: IdentityProviderPort = {
      key: 'VIVA',
      requestPhoneCode: () => Promise.resolve(),
      async verifyPhoneCode(input) {
        verificationCalls += 1;
        await verificationGate;
        return {
          issuer: 'https://identity.example.test',
          subject: 'external-user-1',
          phoneE164: input.phoneE164,
          displayName: user.displayName,
        };
      },
    };
    const authService = new AuthService({
      config,
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', slowProvider]]),
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-auth-concurrency-test', 'silent'),
      authService,
    });
    apps.push(app);

    const created = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/challenges',
      headers: { 'idempotency-key': 'auth-concurrent-create-01' },
      payload: { method: 'phone_otp', phone: '+79990000001' },
    });
    const { challengeId } = created.json<{ challengeId: string }>();
    const first = app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-concurrent-verify-01' },
      payload: {
        code: '0000',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });
    await vi.waitFor(() => expect(verificationCalls).toBe(1));
    const second = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-concurrent-verify-02' },
      payload: {
        code: '0000',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'AUTH_CHALLENGE_IN_PROGRESS' });
    expect(verificationCalls).toBe(1);
    releaseVerification?.();
    await expect(first.then((response) => response.statusCode)).resolves.toBe(200);
  });

  it('enforces a server-side resend cooldown for the same tenant and phone', async () => {
    let sends = 0;
    const countingProvider: IdentityProviderPort = {
      ...provider,
      requestPhoneCode: () => {
        sends += 1;
        return Promise.resolve();
      },
    };
    const authService = new AuthService({
      config,
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', countingProvider]]),
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-auth-cooldown-test', 'silent'),
      authService,
    });
    apps.push(app);
    const request = (idempotencyKey: string) =>
      app.inject({
        method: 'POST',
        url: '/user/api/v1/local-padel/auth/challenges',
        headers: { 'idempotency-key': idempotencyKey },
        payload: { method: 'phone_otp', phone: '+79990000001' },
      });

    const first = await request('auth-cooldown-create-0001');
    expect(first.statusCode).toBe(202);
    const firstChallenge = first.json<{ challengeId: string }>();
    const replay = await request('auth-cooldown-create-0001');
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ challengeId: firstChallenge.challengeId });
    const limited = await request('auth-cooldown-create-0002');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    expect(sends).toBe(1);
  });

  it('invalidates an outstanding challenge when the tenant provider binding changes', async () => {
    const repository = new FakeRepository();
    const authService = new AuthService({
      config,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-auth-binding-test', 'silent'),
      authService,
    });
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/challenges',
      headers: { 'idempotency-key': 'auth-binding-create-0001' },
      payload: { method: 'phone_otp', phone: '+79990000001' },
    });
    repository.setBinding({ ...binding, provider: 'LOCAL', providerTenantKey: 'local-padel' });
    const createdChallenge = created.json<{ challengeId: string }>();

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${createdChallenge.challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-binding-verify-0001' },
      payload: {
        code: '0000',
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'AUTH_CODE_EXPIRED' });
  });
  const legacyLinkConfig = () =>
    loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });

  async function completeFirstOAuthLogin(service: AuthService): Promise<void> {
    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'vkid',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'legacy-link-start',
    });
    const state = new URL(started.redirectUrl).searchParams.get('state') ?? '';
    await service.completeVivaOAuth({
      tenantKey: binding.tenantKey,
      state,
      code: 'authorization-code',
      correlationId: 'legacy-link-complete',
      idempotencyKey: 'legacy-link-idempotency',
      oauthBrowserNonce: started.browserNonce,
    });
  }

  it('links the provider viewer phone on OAuth login while the phone stays out of the auth profile', async () => {
    const repository = new FakeRepository();
    const linked: Array<{ tenantId: string; userId: string; phone: string | undefined }> = [];
    const outcomes: string[] = [];
    let providerReads = 0;
    const service = new AuthService({
      config: legacyLinkConfig(),
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
      legacyViewerIdentityLink: {
        enabled: true,
        readViewerPhone: () => {
          providerReads += 1;
          return Promise.resolve('+79104303190');
        },
        readLinkedPhone: () => Promise.resolve(undefined),
        linkPhone: (input) => {
          linked.push({
            tenantId: input.tenantId,
            userId: input.userId,
            phone: input.phoneE164,
          });
          return Promise.resolve('linked' as const);
        },
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    });

    await completeFirstOAuthLogin(service);

    expect(providerReads).toBe(1);
    expect(linked).toEqual([
      { tenantId: binding.tenantId, userId: user.id, phone: '+79104303190' },
    ]);
    expect(outcomes).toEqual(['linked']);
  });

  it('skips the provider phone read when the account already holds a link', async () => {
    const repository = new FakeRepository();
    let providerReads = 0;
    const service = new AuthService({
      config: legacyLinkConfig(),
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
      legacyViewerIdentityLink: {
        enabled: true,
        readViewerPhone: () => {
          providerReads += 1;
          return Promise.resolve('+79104303190');
        },
        readLinkedPhone: () => Promise.resolve('+79104303190'),
        linkPhone: () => Promise.resolve('unchanged' as const),
      },
    });

    await completeFirstOAuthLogin(service);

    expect(providerReads).toBe(0);
  });

  it('never fails the login when the provider phone read or the link storage fails', async () => {
    const outcomes: string[] = [];
    const service = new AuthService({
      config: legacyLinkConfig(),
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
      legacyViewerIdentityLink: {
        enabled: true,
        readViewerPhone: () => Promise.reject(new Error('EXTERNAL_SOURCE_UNAVAILABLE')),
        readLinkedPhone: () => Promise.resolve(undefined),
        linkPhone: () => {
          throw new Error('linkPhone must not run when the provider read failed');
        },
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    });

    await expect(completeFirstOAuthLogin(service)).resolves.toBeUndefined();
    expect(outcomes).toEqual(['unavailable']);
  });
  it('retries the provider phone read with the delegation token when the login token is rejected', async () => {
    const tokens: string[] = [];
    const refreshedWith: string[] = [];
    const outcomes: string[] = [];
    const linked: Array<string | undefined> = [];
    const service = new AuthService({
      config: legacyLinkConfig(),
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
      legacyViewerIdentityLink: {
        enabled: true,
        readViewerPhone: (input) => {
          tokens.push(input.accessToken);
          // The freshly issued login token is rejected by the end-user CRM API on the first attempt.
          return tokens.length === 1
            ? Promise.reject(new Error('EXTERNAL_SOURCE_UNAVAILABLE'))
            : Promise.resolve('+79104303190');
        },
        readLinkedPhone: () => Promise.resolve(undefined),
        refreshDelegation: (input) => {
          refreshedWith.push(input.refreshToken);
          return Promise.resolve({ accessToken: 'delegation-access-token' });
        },
        linkPhone: (input) => {
          linked.push(input.phoneE164);
          return Promise.resolve('linked' as const);
        },
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    });

    await completeFirstOAuthLogin(service);

    expect(tokens).toEqual(['initial-viva-access-token', 'delegation-access-token']);
    expect(refreshedWith).toHaveLength(1);
    expect(linked).toEqual(['+79104303190']);
    expect(outcomes).toEqual(['linked']);
  });

  it('reports an unavailable provider read without failing the login', async () => {
    const outcomes: string[] = [];
    const service = new AuthService({
      config: legacyLinkConfig(),
      repository: new FakeRepository(),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
      legacyViewerIdentityLink: {
        enabled: true,
        readViewerPhone: () => Promise.reject(new Error('EXTERNAL_SOURCE_UNAVAILABLE')),
        readLinkedPhone: () => Promise.resolve(undefined),
        linkPhone: () => {
          throw new Error('linkPhone must not run when no phone was read');
        },
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    });

    await expect(completeFirstOAuthLogin(service)).resolves.toBeUndefined();
    expect(outcomes).toEqual(['unavailable']);
  });
  it('links the legacy phone from the refreshed delegation on the live token path', async () => {
    const repository = new FakeRepository();
    const tokens: string[] = [];
    const outcomes: string[] = [];
    const linked: Array<string | undefined> = [];
    const service = new AuthService({
      config: legacyLinkConfig(),
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
      vivaOAuthStateStore: new MemoryVivaOAuthStateStore(),
      legacyViewerIdentityLink: {
        enabled: true,
        // The login token answers without a phone; only the delegation token exposes it.
        readViewerPhone: (input) => {
          tokens.push(input.accessToken);
          return Promise.resolve(
            input.accessToken === 'refreshed-viva-access-token' ? '+79104303190' : undefined,
          );
        },
        readLinkedPhone: () => Promise.resolve(undefined),
        linkPhone: (input) => {
          linked.push(input.phoneE164);
          return Promise.resolve('linked' as const);
        },
        onOutcome: (outcome) => outcomes.push(outcome),
      },
    });

    const started = await service.startVivaOAuth({
      tenantKey: binding.tenantKey,
      provider: 'vkid',
      publicOfferAccepted: true,
      personalDataPolicyAccepted: true,
      correlationId: 'delegation-link-start',
    });
    const state = new URL(started.redirectUrl).searchParams.get('state') ?? '';
    const completed = await service.completeVivaOAuth({
      tenantKey: binding.tenantKey,
      state,
      code: 'authorization-code',
      correlationId: 'delegation-link-complete',
      idempotencyKey: 'delegation-link-idempotency',
      oauthBrowserNonce: started.browserNonce,
    });
    if ('androidRedirectUrl' in completed) throw new Error('Unexpected native callback');
    const sessionId = repository.activeSessionId;
    if (!sessionId) throw new Error('Expected an active PadlHub session');

    const refreshed = await service.issueVivaAccessToken({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId,
      correlationId: 'delegation-link-refresh',
      handoffCode: completed.vivaHandoffCode,
    });
    expect(refreshed.accessToken).toBe('initial-viva-access-token');

    const rotated = await service.issueVivaAccessToken({
      tenantKey: binding.tenantKey,
      tenantId: binding.tenantId,
      userId: user.id,
      sessionId,
      correlationId: 'delegation-link-rotated',
    });
    expect(rotated.accessToken).toBe('refreshed-viva-access-token');

    expect(tokens).toEqual(['initial-viva-access-token', 'refreshed-viva-access-token']);
    expect(linked).toEqual(['+79104303190']);
    expect(outcomes).toEqual(['absent', 'linked']);
  });
});

async function androidOAuthFixture() {
  let now = Date.now();
  const oauthConfig = { ...loadVivaPhoneConfig(), AUTH_COOKIE_SECURE: true };
  const repository = new FakeRepository();
  const store = new MemoryAndroidOAuthStore(() => now);
  const stateStore = new MemoryVivaOAuthStateStore();
  const providerHandoff = vi.spyOn(stateStore, 'putHandoff');
  const authService = new AuthService({
    config: oauthConfig,
    repository,
    challengeStore: new MemoryAuthChallengeStore(),
    providers: new Map([['VIVA', provider]]),
    vivaOAuthProvider: oauthProvider,
    vivaOAuthStateStore: stateStore,
    androidOAuthStore: store,
  });
  const app = await buildApp({
    config: oauthConfig,
    logger: createLogger('android-oauth-test', 'silent'),
    authService,
  });
  apps.push(app);
  const root = '/user/api/v1/local-padel/auth/viva/android';
  const verifier = 'v'.repeat(43);
  const clientState = 's'.repeat(43);
  const startBody = {
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    clientState,
    acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
  };
  const start = () =>
    app.inject({
      method: 'POST',
      url: root + '/start',
      headers: { 'idempotency-key': 'android-start-synthetic-001' },
      payload: startBody,
    });
  const launch = async () => {
    const started = await start();
    expect(started.statusCode).toBe(200);
    expect(started.cookies).toHaveLength(0);
    const launchPath = started.json<{ launchPath: string }>().launchPath;
    const launched = await app.inject({ method: 'GET', url: launchPath });
    expect(launched.statusCode).toBe(302);
    const providerState = new URL(String(launched.headers.location)).searchParams.get('state');
    const cookie = launched.cookies.map((value) => value.name + '=' + value.value).join('; ');
    return {
      launchPath,
      cookie,
      callback:
        '/user/api/v1/local-padel/auth/viva/callback?code=synthetic-provider-code&state=' +
        providerState,
    };
  };
  const complete = async () => {
    const launched = await launch();
    const callback = await app.inject({
      method: 'GET',
      url: launched.callback,
      headers: { cookie: launched.cookie },
    });
    expect(callback.statusCode).toBe(302);
    const target = new URL(String(callback.headers.location));
    expect(target.origin + target.pathname).toBe('https://lk2.padlhub.su/android/oauth/yandex');
    expect(target.search).toBe('');
    expect(target.hash).not.toContain('viva_handoff');
    expect(callback.cookies.some((value) => value.name === 'phub_refresh')).toBe(false);
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    expect(providerHandoff).not.toHaveBeenCalled();
    const fragment = new URLSearchParams(target.hash.slice(1));
    return {
      code: fragment.get('code') ?? '',
      codeVerifier: verifier,
      clientState: fragment.get('state') ?? '',
    };
  };
  return {
    app,
    root,
    store,
    repository,
    start,
    startBody,
    launch,
    complete,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('Android Yandex login', () => {
  it('requires consent, strict S256 input, a fixed redirect and an idempotent native start', async () => {
    const f = await androidOAuthFixture();
    const send = (payload: Record<string, unknown>, key = 'android-invalid-start-001') =>
      f.app.inject({
        method: 'POST',
        url: f.root + '/start',
        headers: { 'idempotency-key': key },
        payload,
      });
    expect((await send({ ...f.startBody, redirectUri: 'https://evil.invalid' })).statusCode).toBe(
      400,
    );
    expect((await send({ ...f.startBody, codeChallenge: 'plain' })).statusCode).toBe(400);
    expect(
      (
        await send({
          ...f.startBody,
          acceptance: { publicOfferAccepted: false, personalDataPolicyAccepted: true },
        })
      ).statusCode,
    ).toBe(400);
    const first = await f.start();
    const replay = await f.start();
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(first.headers['cache-control']).toBe('no-store');
  });

  it('does not consume launch or provider state on wrong tenant/browser, and launches only once', async () => {
    const f = await androidOAuthFixture();
    const start = await f.start();
    const path = start.json<{ launchPath: string }>().launchPath;
    expect(
      (await f.app.inject({ method: 'GET', url: path.replace('local-padel', 'another-tenant') }))
        .statusCode,
    ).toBe(410);
    const launched = await f.launch();
    expect((await f.app.inject({ method: 'GET', url: launched.launchPath })).statusCode).toBe(410);
    const mismatch = await f.app.inject({ method: 'GET', url: launched.callback });
    expect(mismatch.statusCode).toBe(401);
    expect(f.repository.refreshSessionCreations).toBe(0);
    const accepted = await f.app.inject({
      method: 'GET',
      url: launched.callback,
      headers: { cookie: launched.cookie },
    });
    expect(accepted.statusCode).toBe(302);
    expect(accepted.cookies.some((value) => value.name === 'phub_refresh')).toBe(false);
    expect(
      (
        await f.app.inject({
          method: 'GET',
          url: launched.callback,
          headers: { cookie: launched.cookie },
        })
      ).statusCode,
    ).toBe(410);
  });

  it('rejects swapped proofs, recovers a lost response using only the first exchange key, and fences revocation', async () => {
    const f = await androidOAuthFixture();
    const payload = await f.complete();
    const exchange = (
      body = payload,
      key = 'android-exchange-synthetic-001',
      tenant = 'local-padel',
    ) =>
      f.app.inject({
        method: 'POST',
        url: f.root.replace('local-padel', tenant) + '/exchange',
        headers: { 'idempotency-key': key },
        payload: body,
      });
    for (const changed of [
      { ...payload, codeVerifier: 'x'.repeat(43) },
      { ...payload, clientState: 'x'.repeat(43) },
      { ...payload, code: 'x'.repeat(43) },
    ]) {
      expect((await exchange(changed)).statusCode).toBe(410);
    }
    expect(
      (await exchange(payload, 'android-exchange-synthetic-001', 'another-tenant')).statusCode,
    ).toBe(410);
    const [first, retry] = await Promise.all([exchange(), exchange()]);
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(first.cookies.find((value) => value.name === 'phub_refresh')?.value).toBe(
      retry.cookies.find((value) => value.name === 'phub_refresh')?.value,
    );
    expect(first.headers['x-android-oauth-state']).toBe(payload.clientState);
    expect(first.json()).not.toHaveProperty('refreshToken');
    expect(first.body).not.toContain('viva-access');
    expect(f.repository.refreshSessionCreations).toBe(1);
    expect((await exchange(payload, 'different-exchange-synthetic-002')).statusCode).toBe(409);
    f.repository.setActiveSessionId(undefined);
    const revoked = await exchange();
    expect(revoked.statusCode).toBe(401);
    expect(revoked.cookies).toHaveLength(0);
  });

  it('expires the handoff without sliding TTL on retries', async () => {
    const f = await androidOAuthFixture();
    const payload = await f.complete();
    const exchange = () =>
      f.app.inject({
        method: 'POST',
        url: f.root + '/exchange',
        headers: { 'idempotency-key': 'android-expiry-exchange-001' },
        payload,
      });
    f.advance(119_000);
    expect((await exchange()).statusCode).toBe(200);
    f.advance(1_001);
    const expired = await exchange();
    expect(expired.statusCode).toBe(410);
    expect(expired.cookies).toHaveLength(0);
  });

  it('revokes the exact newly created session when durable handoff storage fails', async () => {
    const f = await androidOAuthFixture();
    vi.spyOn(f.store, 'putHandoff').mockRejectedValueOnce(new Error('synthetic Redis failure'));
    const launched = await f.launch();
    const failed = await f.app.inject({
      method: 'GET',
      url: launched.callback,
      headers: { cookie: launched.cookie },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.cookies.some((value) => value.name === 'phub_refresh')).toBe(false);
    expect(f.repository.revocationOrder).toEqual(['session']);
    expect(f.repository.vivaDelegationRevocations).toBe(0);
  });
});
