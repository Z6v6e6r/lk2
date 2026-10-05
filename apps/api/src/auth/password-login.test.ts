import { createHash, createHmac } from 'node:crypto';

import { loadConfig } from '@phub/config';
import type { LocalPasswordLoginRepository } from '@phub/database/password-login';
import { createLogger } from '@phub/observability';
import { jwtVerify } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { AuthService, type AuthRepository } from './auth-service.js';
import { MemoryAuthChallengeStore } from './challenge-store.js';
import { hashLocalPassword, reservePasswordLoginSlot } from './local-password.js';

const config = loadConfig({
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const password = 'Synthetic password 42!';
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashLocalPassword(password);
});
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(passwordConfig = config) {
  const repository = {
    resolveTenantAuthBinding: vi.fn().mockResolvedValue({
      tenantId,
      tenantKey: 'local-padel',
      provider: 'VIVA',
      providerTenantKey: 'synthetic',
    }),
    hasCurrentLegalAcceptances: vi.fn().mockResolvedValue(true),
    isAccessSessionActive: vi.fn().mockResolvedValue(true),
    getUserAccessProfile: vi
      .fn()
      .mockResolvedValue({ roles: ['client'], permissions: ['profile.read'] }),
  };
  const local: LocalPasswordLoginRepository = {
    findCredential: vi.fn().mockResolvedValue({ id: userId, userId, generation: 3, passwordHash }),
    commitLogin: vi.fn<LocalPasswordLoginRepository['commitLogin']>((input) =>
      Promise.resolve({
        outcome: 'created',
        sessionId: input.sessionId,
        expiresAt: input.expiresAt.toISOString(),
        user: { id: userId, tenantId, displayName: 'Synthetic' },
      }),
    ),
  };
  const limiter = { allow: vi.fn().mockResolvedValue(true) };
  const service = new AuthService({
    config: passwordConfig,
    repository: repository as unknown as AuthRepository,
    localPasswordRepository: local,
    passwordLoginLimiter: limiter,
    providers: new Map(),
    challengeStore: new MemoryAuthChallengeStore(),
  });
  const app = await buildApp({
    config: passwordConfig,
    logger: createLogger('password-test', 'silent'),
    authService: service,
  });
  apps.push(app);
  return { app, repository, local, limiter, service };
}
const url = '/user/api/v1/local-padel/auth/password/login';
const headers = {
  'idempotency-key': 'synthetic-password-login-key-01',
  'x-session-intent': 'password-login',
};
describe('consumer password login through the real API builder', () => {
  it('issues only client audience, matches the existing refresh hash and exposes no credentials', async () => {
    const { app, local, limiter } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'x-app-platform': 'cup-admin' },
      payload: { email: ' PLAYER@EXAMPLE.TEST ', password },
    });
    expect(response.statusCode).toBe(200);
    const payload = await jwtVerify(
      response.json<{ accessToken: string }>().accessToken,
      new TextEncoder().encode(config.JWT_ACCESS_SECRET),
      { audience: config.JWT_AUDIENCE },
    );
    expect(payload.payload.sub).toBe(userId);
    expect(payload.payload.aud).not.toBe(config.JWT_ADMIN_AUDIENCE);
    const cookie = response.cookies.find((entry) => entry.name === 'phub_refresh');
    expect(cookie?.httpOnly).toBe(true);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).not.toContain(password);
    expect(response.body).not.toContain('player@example.test');
    expect(response.body).not.toContain('refreshToken');
    const input = vi.mocked(local.commitLogin).mock.calls[0]![0];
    expect(input.tokenHash).toBe(
      createHmac('sha256', config.JWT_REFRESH_SECRET).update(cookie!.value).digest('hex'),
    );
    expect(input.credential.generation).toBe(3);
    expect(limiter.allow).toHaveBeenCalledWith(tenantId, 'player@example.test', expect.any(String));
  });
  it.each(['unknown', 'wrong', 'disabled', 'malformed'] as const)(
    'returns the same 401 for %s credentials',
    async (mode) => {
      const { app, local } = await fixture();
      if (mode === 'unknown' || mode === 'disabled')
        vi.mocked(local.findCredential).mockResolvedValue(undefined);
      if (mode === 'malformed')
        vi.mocked(local.findCredential).mockResolvedValue({
          id: userId,
          userId,
          generation: 3,
          passwordHash: 'untrusted-cost',
        });
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: {
          email: 'player@example.test',
          password: mode === 'wrong' ? 'Other synthetic password!' : password,
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('AUTH_CREDENTIAL_INVALID');
      expect(response.cookies).toHaveLength(0);
      expect(local.commitLogin).not.toHaveBeenCalled();
    },
  );
  it('rejects browser authority fields and missing idempotency before lookup', async () => {
    const { app, local } = await fixture();
    for (const extra of [
      { userId },
      { verified: true },
      { audience: 'admin' },
      { roles: ['admin'] },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { email: 'player@example.test', password, ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { email: 'player@example.test', password },
        })
      ).statusCode,
    ).toBe(400);
    expect(local.findCredential).not.toHaveBeenCalled();
  });
  it('denies a foreign browser origin before credential lookup', async () => {
    const { app, local } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, origin: 'https://foreign.example.test' },
      payload: { email: 'player@example.test', password },
    });
    expect(response.statusCode).toBe(403);
    expect(local.findCredential).not.toHaveBeenCalled();
  });
  it('requires explicit login intent and prevents caching even before parsing', async () => {
    const { app, local } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': headers['idempotency-key'] },
      payload: { email: 'player@example.test', password },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('SESSION_INTENT_REQUIRED');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(local.findCredential).not.toHaveBeenCalled();
  });
  it('returns 429 with no-store on the sixth route attempt before lookup or KDF', async () => {
    const { app, local } = await fixture();
    for (let i = 0; i < 5; i++) {
      const rejected = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { email: 'player@example.test', password: 'short' },
      });
      expect(rejected.statusCode).toBe(401);
    }
    expect(local.findCredential).toHaveBeenCalledTimes(5);
    const limited = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { email: 'player@example.test', password },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code: string }>().code).toBe('RATE_LIMIT_EXCEEDED');
    expect(limited.headers['cache-control']).toBe('private, no-store');
    expect(local.findCredential).toHaveBeenCalledTimes(5);
  });
  it('persists only public technical digests independent of refresh key material', async () => {
    const first = await fixture();
    const second = await fixture({
      ...config,
      JWT_REFRESH_SECRET: 'different-synthetic-refresh-key-with-32-characters',
    });
    const payload = { email: 'player@example.test', password };
    await first.app.inject({ method: 'POST', url, headers, payload });
    await second.app.inject({ method: 'POST', url, headers, payload });
    const original = vi.mocked(first.local.commitLogin).mock.calls[0]![0];
    const rotated = vi.mocked(second.local.commitLogin).mock.calls[0]![0];
    expect(original.commandKeyHash).toBe(rotated.commandKeyHash);
    expect(original.requestHash).toBe(rotated.requestHash);
    expect(original.tokenHash).not.toBe(rotated.tokenHash);
    expect(original.sessionId).not.toBe(rotated.sessionId);
    expect(original.requestHash).toBe(
      createHash('sha256')
        .update(
          JSON.stringify({
            contract: 'LOCAL_PASSWORD_V1',
            tenantId,
            emailKey: 'player@example.test',
            credentialId: userId,
            generation: 3,
            audience: 'client',
            publicOfferVersion: config.PUBLIC_OFFER_VERSION,
            personalDataPolicyVersion: config.PERSONAL_DATA_POLICY_VERSION,
          }),
        )
        .digest('hex'),
    );
    expect(Object.keys(original)).not.toContain('derivationKeyId');
  });
  it.each(['denied', 'unavailable'] as const)(
    'fails before lookup when admission is %s',
    async (mode) => {
      const { app, local, limiter } = await fixture();
      if (mode === 'denied') limiter.allow.mockResolvedValue(false);
      else limiter.allow.mockRejectedValue(new Error('synthetic Redis failure'));
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { email: 'player@example.test', password },
      });
      expect(response.statusCode).toBe(mode === 'denied' ? 429 : 503);
      expect(local.findCredential).not.toHaveBeenCalled();
      expect(response.headers['cache-control']).toContain('no-store');
    },
  );
  it('caps the whole DB/KDF operation and releases slots after failure', async () => {
    const { service, repository } = await fixture();
    const first = reservePasswordLoginSlot();
    const second = reservePasswordLoginSlot();
    const input = {
      tenantKey: 'local-padel',
      email: 'player@example.test',
      password,
      clientIp: '127.0.0.1',
      idempotencyKey: headers['idempotency-key'],
      correlationId: 'synthetic-password-test',
    };
    try {
      await expect(service.loginWithPassword(input)).rejects.toMatchObject({
        code: 'AUTH_PROVIDER_UNAVAILABLE',
      });
    } finally {
      first();
      second();
    }
    expect(repository.resolveTenantAuthBinding).not.toHaveBeenCalled();
    await expect(service.loginWithPassword(input)).resolves.toMatchObject({ user: { id: userId } });
  });
  it('reproduces the same credential after a lost response', async () => {
    const { app, local } = await fixture();
    const first = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { email: 'player@example.test', password },
    });
    const second = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { email: 'PLAYER@example.test', password },
    });
    expect(second.cookies[0]?.value).toBe(first.cookies[0]?.value);
    const calls = vi.mocked(local.commitLogin).mock.calls;
    expect(calls[1]![0].sessionId).toBe(calls[0]![0].sessionId);
    expect(calls[1]![0].requestHash).toBe(calls[0]![0].requestHash);
  });
  it('requires legal acceptance and rechecks the issued session before returning a cookie', async () => {
    const { app, local, repository } = await fixture();
    repository.hasCurrentLegalAcceptances.mockResolvedValue(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { email: 'player@example.test', password },
        })
      ).json<{ code: string }>().code,
    ).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    expect(local.commitLogin).not.toHaveBeenCalled();
    repository.hasCurrentLegalAcceptances.mockResolvedValue(true);
    repository.isAccessSessionActive.mockResolvedValue(false);
    const denied = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { email: 'player@example.test', password },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.cookies).toHaveLength(0);
  });
  it('redacts dependency errors and exposes no setup/recovery command', async () => {
    const { app, local } = await fixture();
    vi.mocked(local.findCredential).mockRejectedValue(
      new Error('synthetic-private-email@example.test'),
    );
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { email: 'player@example.test', password },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('synthetic-private-email');
    for (const path of ['/auth/password/setup', '/auth/recovery/complete'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/user/api/v1/local-padel' + path,
            headers,
            payload: { verified: true },
          })
        ).statusCode,
      ).toBe(404);
  });
});
