import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, type BuildAppOptions } from '../app.js';
import type { AuthService } from './auth-service.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '55555555-5555-4555-8555-555555555555';
const config = loadConfig({
  APP_ENV: 'ci',
  VIVA_MODE: 'mock',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost:5432/synthetic',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://localhost:5672',
  JWT_ISSUER: 'session-test',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'synthetic-session-access-secret-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-session-refresh-secret-32-characters',
});
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function bearer(
  options: { audience?: string; tenants?: string[]; expiry?: string | null; sid?: string } = {},
) {
  const jwt = new SignJWT({
    tenants: options.tenants ?? [tenantId],
    roles: options.audience === config.JWT_ADMIN_AUDIENCE ? ['admin'] : ['client'],
    permissions:
      options.audience === config.JWT_ADMIN_AUDIENCE ? ['notifications.manage'] : ['profile.read'],
    sid: options.sid ?? sessionId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(options.audience ?? config.JWT_AUDIENCE)
    .setSubject(userId);
  if (options.expiry !== null) jwt.setExpirationTime(options.expiry ?? '5m');
  return `Bearer ${await jwt.sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET))}`;
}
async function setup(checker?: BuildAppOptions['accessSessionChecker'], service?: AuthService) {
  const reader = vi.fn().mockResolvedValue([]);
  const app = await buildApp({
    config,
    logger: createLogger('sessions-test', 'silent'),
    pool: { query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }) } as unknown as Pool,
    ...(checker ? { accessSessionChecker: checker } : {}),
    authService:
      service ??
      ({
        getUserContext: () => Promise.resolve({ id: userId, tenantId, displayName: 'Synthetic' }),
      } as unknown as AuthService),
    profileContactReader: { listForUser: reader },
  });
  apps.push(app);
  return { app, reader };
}
const path = '/user/api/v1/local-padel/profile/contacts';
describe('access JWT server session check', () => {
  it('binds the check to the resolved tenant, signed subject and signed sid', async () => {
    const checker = vi.fn().mockResolvedValue(true);
    const { app, reader } = await setup(checker);
    expect(
      (await app.inject({ url: path, headers: { authorization: await bearer() } })).statusCode,
    ).toBe(200);
    expect(checker).toHaveBeenCalledWith({ tenantId, userId, sessionId });
    expect(reader).toHaveBeenCalledOnce();
  });
  it('denies the same JWT immediately after its session is revoked without caching', async () => {
    const checker = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { app, reader } = await setup(checker);
    const headers = { authorization: await bearer() };
    expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
    const denied = await app.inject({ url: path, headers });
    expect(denied.statusCode).toBe(401);
    expect(denied.json<{ code: string }>().code).toBe('AUTH_SESSION_REVOKED');
    expect(denied.headers['cache-control']).toBe('private, no-store');
    expect(reader).toHaveBeenCalledOnce();
    expect(checker).toHaveBeenCalledTimes(2);
  });
  it.each([false, undefined, 'true'])(
    'denies non-authoritative checker result %s',
    async (result) => {
      const { app, reader } = await setup(vi.fn().mockResolvedValue(result));
      const response = await app.inject({ url: path, headers: { authorization: await bearer() } });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ code: string }>().code).toBe('AUTH_SESSION_REVOKED');
      expect(reader).not.toHaveBeenCalled();
    },
  );
  it('fails closed when the checker is absent', async () => {
    const { app, reader } = await setup();
    const response = await app.inject({ url: path, headers: { authorization: await bearer() } });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ code: string }>().code).toBe('AUTH_SESSION_CHECK_UNAVAILABLE');
    expect(reader).not.toHaveBeenCalled();
  });
  it('redacts checker failures and permits a later successful retry', async () => {
    const checker = vi
      .fn()
      .mockRejectedValueOnce(new Error('postgresql://private:secret@host PII'))
      .mockResolvedValueOnce(true);
    const { app, reader } = await setup(checker);
    const headers = { authorization: await bearer() };
    const response = await app.inject({ url: path, headers });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret');
    expect(reader).not.toHaveBeenCalled();
    expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
  });
  it.each([
    { audience: config.JWT_ADMIN_AUDIENCE },
    { tenants: [] },
    { expiry: '-1s' },
    { expiry: null },
    { sid: 'invalid' },
  ])('rejects invalid token/tenant before checking session: %j', async (options) => {
    const checker = vi.fn().mockResolvedValue(true);
    const { app, reader } = await setup(checker);
    const response = await app.inject({
      url: path,
      headers: { authorization: await bearer(options) },
    });
    expect([401, 403]).toContain(response.statusCode);
    expect(checker).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });
  it('uses the production AuthService checker binding when no override is supplied', async () => {
    const isAccessSessionActive = vi.fn().mockResolvedValue(false);
    const { app } = await setup(undefined, { isAccessSessionActive } as unknown as AuthService);
    const response = await app.inject({ url: path, headers: { authorization: await bearer() } });
    expect(response.statusCode).toBe(401);
    expect(isAccessSessionActive).toHaveBeenCalledWith({ tenantId, userId, sessionId });
  });
  it('checks admin audience sessions on the common authenticated tenant path', async () => {
    const checker = vi.fn().mockResolvedValue(false);
    const { app } = await setup(checker);
    const response = await app.inject({
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: {
        authorization: await bearer({ audience: config.JWT_ADMIN_AUDIENCE }),
        'x-app-platform': 'cup-admin',
      },
    });
    expect(response.statusCode).toBe(401);
    expect(checker).toHaveBeenCalledOnce();
  });
});
