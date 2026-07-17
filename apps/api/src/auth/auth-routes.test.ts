import type {
  IdentityProviderPort,
  VerifiedExternalIdentity,
  VivaOAuthProviderPort,
} from '@phub/auth';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import {
  AuthService,
  type AuthRepository,
  type AuthUser,
  type RefreshSessionRotation,
  type TenantAuthBinding,
} from './auth-service.js';
import { MemoryAuthChallengeStore } from './challenge-store.js';
import { MemoryVivaOAuthStateStore } from './oauth-state-store.js';

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

  public resolveTenantAuthBinding(tenantKey: string): Promise<TenantAuthBinding | undefined> {
    return Promise.resolve(
      tenantKey === this.bindingValue.tenantKey ? this.bindingValue : undefined,
    );
  }

  public upsertExternalIdentity(): Promise<AuthUser> {
    return Promise.resolve(user);
  }

  public createRefreshSession(input: {
    readonly sessionId: string;
    readonly tokenHash: string;
  }): Promise<void> {
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
    const revoked = tokenHash === this.tokenHash;
    if (revoked) this.tokenHash = undefined;
    return Promise.resolve(revoked);
  }

  public revokeVivaDelegationForRefreshSession(): Promise<void> {
    this.vivaDelegationRevocationCount += 1;
    return Promise.resolve();
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

  public findRefreshSessionById(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public saveVivaDelegation(input: {
    readonly issuer: string;
    readonly subject: string;
    readonly refreshTokenCiphertext: string;
    readonly encryptionKeyVersion: string;
    readonly grantedScopes: readonly string[];
    readonly refreshExpiresAt?: Date;
  }): Promise<void> {
    this.vivaDelegation = {
      issuer: input.issuer,
      subject: input.subject,
      refreshTokenCiphertext: input.refreshTokenCiphertext,
      encryptionKeyVersion: input.encryptionKeyVersion,
      ...(input.refreshExpiresAt ? { refreshExpiresAt: input.refreshExpiresAt.toISOString() } : {}),
    };
    return Promise.resolve();
  }

  public getVivaDelegation(): Promise<typeof this.vivaDelegation> {
    return Promise.resolve(this.vivaDelegation);
  }

  public recordLegalAcceptances(): Promise<void> {
    return Promise.resolve();
  }

  public recordLegalAcceptanceIntent(): Promise<void> {
    return Promise.resolve();
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
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
    });
    const repository = new FakeRepository();
    const stateStore = new MemoryVivaOAuthStateStore();
    const service = new AuthService({
      config: oauthConfig,
      repository,
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map([['VIVA', provider]]),
      vivaOAuthProvider: oauthProvider,
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
    });

    const initialAccess = await service.issueVivaAccessToken({
      tenantId: binding.tenantId,
      userId: user.id,
      handoffCode: completed.vivaHandoffCode,
      correlationId: 'oauth-handoff-correlation',
    });
    expect(initialAccess.accessToken).toBe('initial-viva-access-token');
    await expect(
      service.issueVivaAccessToken({
        tenantId: binding.tenantId,
        userId: user.id,
        handoffCode: completed.vivaHandoffCode,
        correlationId: 'oauth-handoff-replay',
      }),
    ).rejects.toMatchObject({ code: 'VIVA_REAUTH_REQUIRED' });

    const refreshedAccess = await service.issueVivaAccessToken({
      tenantId: binding.tenantId,
      userId: user.id,
      correlationId: 'oauth-refresh-correlation',
    });
    expect(refreshedAccess.accessToken).toBe('refreshed-viva-access-token');
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
    const authService = new AuthService({
      config,
      repository: new FakeRepository(),
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

    const verifyResponse = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challenge.challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-verify-test-0000001' },
      payload: { code: '0000' },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json()).toMatchObject({
      tokenType: 'Bearer',
      user: { id: user.id, displayName: user.displayName },
    });
    const verifiedBody = verifyResponse.json<{
      user: Record<string, unknown>;
      context: { tenantId: string; phoneLast4?: string };
    }>();
    expect(Object.keys(verifiedBody.user).sort()).toEqual(['displayName', 'id']);
    expect(verifiedBody.context).toMatchObject({ tenantId: binding.tenantId, phoneLast4: '0001' });
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
      payload: { code: '0000' },
    });
    await vi.waitFor(() => expect(verificationCalls).toBe(1));
    const second = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/auth/challenges/${challengeId}/verify`,
      headers: { 'idempotency-key': 'auth-concurrent-verify-02' },
      payload: { code: '0000' },
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
      payload: { code: '0000' },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'AUTH_CODE_EXPIRED' });
  });
});
