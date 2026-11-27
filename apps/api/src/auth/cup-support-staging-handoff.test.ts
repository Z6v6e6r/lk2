import { randomBytes, randomUUID } from 'node:crypto';

import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import type { CupReplyReader } from '../support/cup-replies.js';
import { loadCupSupportHandoffIssuer } from './cup-support-staging-handoff.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

const origin = 'https://lk2.padlhub.su';
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sessionId = '55555555-5555-4555-8555-555555555555';
const draft = '67a945d8-a42b-4ae2-935a-327c371ec2e4';
const url = '/user/api/v1/local-padel/auth/cup-support-staging-handoff';
const key = randomBytes(32);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

async function fixture({
  enabled = true,
  active = true,
  sharedAudience = false,
  replies = false,
} = {}) {
  const issue = loadCupSupportHandoffIssuer({
    CUP_SUPPORT_STAGING_HANDOFF_ENABLED: String(enabled),
    CUP_SUPPORT_STAGING_HANDOFF_SECRET: key.toString('base64url'),
  });
  const accessSessionChecker = vi.fn(() => Promise.resolve(active));
  const cupReplyReader = vi.fn<CupReplyReader>().mockResolvedValue({ messages: [], next: null });
  const app = await buildApp({
    config: sharedAudience ? { ...config, JWT_ADMIN_AUDIENCE: config.JWT_AUDIENCE } : config,
    logger: createLogger('api-test', 'silent'),
    pool: {
      query: () => Promise.resolve({ rows: [{ id: tenantId }] }),
    } as unknown as Pool,
    accessSessionChecker,
    ...(issue ? { cupSupportHandoffIssuer: issue } : {}),
    ...(replies ? { cupReplyReader } : {}),
  });
  apps.push(app);
  return { app, accessSessionChecker, cupReplyReader };
}

async function accessToken({
  audience = config.JWT_AUDIENCE,
  roles = ['client'],
  tenant = tenantId,
  exp = Math.floor(Date.now() / 1000) + 300,
}: {
  audience?: string | string[];
  roles?: string[];
  tenant?: string;
  exp?: number;
} = {}): Promise<string> {
  return new SignJWT({ tenants: [tenant], roles, permissions: [], sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(audience)
    .setSubject(userId)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function headers(token?: string, requestOrigin = origin) {
  return {
    origin: requestOrigin,
    'idempotency-key': randomUUID(),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('CUP Support STAGING reply history', () => {
  const history = '/user/api/v1/local-padel/support/cup-replies';
  it('uses only the authenticated client principal and rejects recipient overrides', async () => {
    const { app, cupReplyReader } = await fixture({ replies: true });
    const token = await accessToken();
    const result = await app.inject({ url: history, headers: headers(token) });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(cupReplyReader).toHaveBeenCalledExactlyOnceWith(userId, undefined);
    const forged = await app.inject({
      url: `${history}?recipient=${draft}`,
      headers: headers(token),
    });
    expect(forged.statusCode).toBe(400);
    expect(cupReplyReader).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated, revoked and non-client sessions', async () => {
    const { app, cupReplyReader } = await fixture({ replies: true });
    expect((await app.inject({ url: history })).statusCode).toBe(401);
    const staff = await accessToken({ roles: ['staff'] });
    expect((await app.inject({ url: history, headers: headers(staff) })).statusCode).toBe(403);
    const stale = await fixture({ replies: true, active: false });
    const token = await accessToken();
    expect((await stale.app.inject({ url: history, headers: headers(token) })).statusCode).toBe(
      401,
    );
    expect(cupReplyReader).not.toHaveBeenCalled();
    expect(stale.cupReplyReader).not.toHaveBeenCalled();
  });
});

describe('CUP Support STAGING handoff', () => {
  it('uses an independent canonical signing key and omits the route by default', async () => {
    expect(loadCupSupportHandoffIssuer({})).toBeUndefined();
    const enabled = { CUP_SUPPORT_STAGING_HANDOFF_ENABLED: 'true' };
    for (const secret of [
      undefined,
      key.subarray(0, 31).toString('base64url'),
      key.toString('base64'),
    ]) {
      expect(() =>
        loadCupSupportHandoffIssuer({ ...enabled, CUP_SUPPORT_STAGING_HANDOFF_SECRET: secret }),
      ).toThrow(/distinct canonical base64url key/);
    }
    expect(() =>
      loadCupSupportHandoffIssuer({
        ...enabled,
        CUP_SUPPORT_STAGING_HANDOFF_SECRET: key.toString('base64url'),
        JWT_ACCESS_SECRET: key.toString('base64url'),
      }),
    ).toThrow(/distinct canonical base64url key/);

    const { app } = await fixture({ enabled: false });
    expect(
      (await app.inject({ method: 'POST', url, headers: headers(), payload: { draft } }))
        .statusCode,
    ).toBe(404);
  });

  it('issues only a short draft-bound proof from the active client principal', async () => {
    const { app, accessSessionChecker } = await fixture();
    const token = await accessToken();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: headers(token),
      payload: { draft },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    const body = response.json<{ proof: string }>();
    expect(Object.keys(body)).toEqual(['proof']);
    const { protectedHeader, payload } = await jwtVerify(body.proof, key, {
      algorithms: ['HS256'],
      issuer: 'lk2',
      audience: 'cup-support-staging/intake',
    });
    expect(protectedHeader).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'draft',
      'exp',
      'iat',
      'iss',
      'jti',
      'sub',
      'tenant',
    ]);
    expect(payload).toMatchObject({
      iss: 'lk2',
      aud: 'cup-support-staging/intake',
      sub: userId,
      tenant: 'padlhub',
      draft,
    });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(90);
    expect(accessSessionChecker).toHaveBeenCalledWith({ tenantId, userId, sessionId });
  });

  it('never lets a proof outlive the access credential used to issue it', async () => {
    const { app } = await fixture();
    const exp = Math.floor(Date.now() / 1000) + 30;
    const response = await app.inject({
      method: 'POST',
      url,
      headers: headers(await accessToken({ exp })),
      payload: { draft },
    });
    expect(response.statusCode).toBe(200);
    expect((await jwtVerify(response.json<{ proof: string }>().proof, key)).payload.exp).toBe(exp);
  });

  it('rejects unauthenticated, staff, multi-audience, cross-tenant and revoked sessions', async () => {
    const { app } = await fixture();
    const payload = { draft };
    const call = (token: string | undefined, requestUrl = url) =>
      app.inject({ method: 'POST', url: requestUrl, headers: headers(token), payload });
    expect((await call(undefined)).statusCode).toBe(401);
    expect(
      (await call(await accessToken({ audience: config.JWT_ADMIN_AUDIENCE }))).statusCode,
    ).toBe(401);
    expect(
      (
        await call(
          await accessToken({
            audience: [config.JWT_AUDIENCE, config.JWT_ADMIN_AUDIENCE],
          }),
        )
      ).statusCode,
    ).toBe(403);
    expect((await call(await accessToken({ roles: ['admin'] }))).statusCode).toBe(403);
    expect((await call(await accessToken({ tenant: randomUUID() }))).statusCode).toBe(403);
    expect(
      (await call(await accessToken(), url.replace('/local-padel/', '/padlhub/'))).statusCode,
    ).toBe(403);
    const revoked = await fixture({ active: false });
    const response = await revoked.app.inject({
      method: 'POST',
      url,
      headers: headers(await accessToken()),
      payload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });

    const shared = await fixture({ sharedAudience: true });
    expect(
      (
        await shared.app.inject({
          method: 'POST',
          url,
          headers: headers(await accessToken()),
          payload,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('requires the exact LK2 origin and accepts exactly a lowercase draft UUID', async () => {
    const { app } = await fixture();
    const token = await accessToken();
    const call = (payload: object, requestHeaders = headers(token)) =>
      app.inject({ method: 'POST', url, headers: requestHeaders, payload });
    expect((await call({ draft }, headers(token, 'https://padlhub.su'))).statusCode).toBe(403);
    expect((await call({ draft }, headers(token, ''))).statusCode).toBe(403);
    expect(
      (
        await call({ draft }, { origin, authorization: `Bearer ${token}` } as ReturnType<
          typeof headers
        >)
      ).statusCode,
    ).toBe(400);
    for (const payload of [
      { draft: draft.toUpperCase() },
      { draft: 'not-a-uuid' },
      { draft, sub: randomUUID() },
    ]) {
      expect((await call(payload)).statusCode).toBe(400);
    }
  });
});
