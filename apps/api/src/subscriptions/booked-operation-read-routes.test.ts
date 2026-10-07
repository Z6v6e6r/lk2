import { randomUUID } from 'node:crypto';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import {
  BookedOperationReadClient,
  BOOKED_OPERATION_READ_PREFIX,
} from '@phub/subscription-runtime-adapter';
import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppWithActiveSession } from '../testing/build-test-app.js';
import { SubscriptionRuntimeActorDelegationIssuer } from './subscription-runtime-actor-delegation-issuer.js';

const tenantId = randomUUID();
const userId = randomUUID();
const sessionId = randomUUID();
const operationId = randomUUID();
const providerMappingId = randomUUID();
const tenantKey = 'synthetic-tenant';
const route = `/user/api/v1/${tenantKey}/booked-operations/${operationId}`;
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-characters',
});
const apps: Awaited<ReturnType<typeof buildAppWithActiveSession>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const pool = {
  query: vi.fn((sql: string) => {
    if (sql.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
    return Promise.reject(new Error('Unexpected DB access'));
  }),
} as unknown as Pool;

async function auth(overrides: { permissions?: string[]; tenants?: string[] } = {}) {
  const token = await new SignJWT({
    sid: sessionId,
    tenants: overrides.tenants ?? [tenantId],
    permissions: overrides.permissions ?? ['games.play'],
    roles: ['client'],
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  return { authorization: `Bearer ${token}`, 'x-correlation-id': 'b1-synthetic-correlation' };
}

async function fixture() {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const issuer = new SubscriptionRuntimeActorDelegationIssuer({
    privateKeyPem: await exportPKCS8(keys.privateKey),
    keyId: 'b1-synthetic-key',
    issuer: 'https://lk2.example.test',
    audience: 'lk1-booked-read',
    ttlSeconds: 30,
  });
  const context = {
    resolve: vi.fn().mockResolvedValue({
      outcome: 'ok',
      providerClientId: 'synthetic-provider-client',
      providerMappingId,
    }),
  };
  const response = {
    contractVersion: 1,
    operationId,
    status: 'PENDING',
    asOf: '2026-10-06T08:00:00.000Z',
    reason: 'OWNER_PENDING',
  };
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    expect(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url).toBe(
      'https://owner.example.test' + BOOKED_OPERATION_READ_PREFIX + operationId,
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    const proof = headers.get('X-Subscription-Actor-Delegation');
    expect(proof).toBeTruthy();
    const { payload } = await jwtVerify(proof!, keys.publicKey, {
      issuer: 'https://lk2.example.test',
      audience: 'lk1-booked-read',
    });
    expect(payload).toMatchObject({
      sub: userId,
      tenant_id: tenantId,
      tenant_key: tenantKey,
      sid: sessionId,
      provider_mapping_id: providerMappingId,
      provider_client_id: 'synthetic-provider-client',
      caller: 'lk2-api',
      scope: 'subscription-runtime.booked-operation.read',
      method: 'GET',
      path: BOOKED_OPERATION_READ_PREFIX + operationId,
      operation_id: operationId,
      correlation_id: 'b1-synthetic-correlation',
    });
    expect(payload).not.toHaveProperty('action');
    return Response.json(response);
  });
  const client = new BookedOperationReadClient({
    baseUrl: 'https://owner.example.test',
    timeoutMs: 500,
    environment: 'production',
    fetchImplementation,
  });
  const app = await buildAppWithActiveSession({
    config,
    pool,
    logger: createLogger('b1-test', 'silent'),
    bookedOperationRead: { actorContextRepository: context, delegationIssuer: issuer, client },
  });
  apps.push(app);
  return { app, context, fetchImplementation, response };
}

describe('commercial owner read boundary', () => {
  it('uses actual PadlHub auth/tenant/permissions and signs only resolved actor; repeated GET never creates', async () => {
    const f = await fixture();
    const headers = await auth();
    for (let i = 0; i < 2; i++) {
      const response = await f.app.inject({ method: 'GET', url: route, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual(f.response);
    }
    expect(f.context.resolve).toHaveBeenCalledWith({ tenantId, userId, sessionId });
    expect(f.fetchImplementation).toHaveBeenCalledTimes(2);
    for (const request of [
      { method: 'GET' as const, url: route },
      { method: 'GET' as const, url: route, headers: await auth({ tenants: [randomUUID()] }) },
      { method: 'GET' as const, url: route, headers: await auth({ permissions: [] }) },
      { method: 'GET' as const, url: route + '?actorClientId=guessed', headers },
      { method: 'POST' as const, url: route, headers, payload: { userId, clientId: 'guessed' } },
    ])
      expect((await f.app.inject(request)).statusCode).not.toBe(200);
    expect(f.fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each(['session_inactive', 'provider_mapping_unavailable'])(
    'denies %s before owner access',
    async (outcome) => {
      const f = await fixture();
      f.context.resolve.mockResolvedValue({ outcome });
      const response = await f.app.inject({ method: 'GET', url: route, headers: await auth() });
      expect(response.statusCode).toBe(outcome === 'session_inactive' ? 401 : 503);
      expect(f.fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it.each([404, 500, 401, 403])(
    'keeps owner HTTP %s as unavailable, without terminal/retry permission',
    async (status) => {
      const f = await fixture();
      f.fetchImplementation.mockResolvedValue(new Response('', { status }));
      const response = await f.app.inject({ method: 'GET', url: route, headers: await auth() });
      expect(response.statusCode).toBe(status === 404 ? 404 : 503);
      expect(response.body).not.toMatch(/FAILED|retryCreate|bookingId|providerClientId/);
    },
  );

  it('rejects raw receipt fields, malformed DTO and wrong operation before public response', async () => {
    const f = await fixture();
    for (const payload of [
      { ...f.response, bookingId: 'private' },
      { ...f.response, operationId: randomUUID() },
      { ...f.response, status: 'FAILED' },
      { ...f.response, asOf: 'yesterday' },
      { ...f.response, reason: 'raw provider failure' },
    ]) {
      f.fetchImplementation.mockResolvedValue(Response.json(payload));
      const response = await f.app.inject({ method: 'GET', url: route, headers: await auth() });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('private');
    }
  });

  it('ships disabled unless a dedicated read boundary is injected', async () => {
    const app = await buildAppWithActiveSession({
      config,
      pool,
      logger: createLogger('b1-test', 'silent'),
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: route, headers: await auth() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'BOOKED_OPERATION_READ_DISABLED' });
  });
});
