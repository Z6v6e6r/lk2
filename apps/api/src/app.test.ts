import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, requireIdempotencyKey } from './app.js';

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

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('select 1 as ready')) return Promise.resolve({ rows: [{ ready: 1 }] });
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(tenants: readonly string[] = [tenantId]): Promise<string> {
  return new SignJWT({
    tenants,
    roles: ['client'],
    permissions: ['profile.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject('49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('health endpoints', () => {
  it('returns liveness and propagates a correlation ID', async () => {
    const app = await buildApp({ config, logger: createLogger('api-test', 'silent') });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-correlation-id': 'test-correlation-123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-correlation-id']).toBe('test-correlation-123');
    expect(response.json()).toMatchObject({ status: 'ok', service: 'phub-api' });
  });

  it('does not claim readiness without its database dependency', async () => {
    const app = await buildApp({ config, logger: createLogger('api-test', 'silent') });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
  });

  it('reports readiness when PostgreSQL responds', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
  });

  it('requires a PadlHub token before tenant resolution', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/user/api/v1/local-padel/context' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('resolves tenant context only from matching PadlHub claims', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/context',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenantId, roles: ['client'] });
  });

  it('rejects a token that does not contain the resolved tenant', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/context',
      headers: { authorization: `Bearer ${await accessToken([])}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
  });

  it('rejects a malformed tenant key before database resolution', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/INVALID_KEY/context',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'TENANT_KEY_INVALID' });
  });

  it('enforces idempotency keys on critical command handlers', async () => {
    const app = await buildApp({ config, logger: createLogger('api-test', 'silent') });
    apps.push(app);
    app.post('/test-command', { preHandler: requireIdempotencyKey }, () => ({ accepted: true }));

    const rejected = await app.inject({ method: 'POST', url: '/test-command' });
    const accepted = await app.inject({
      method: 'POST',
      url: '/test-command',
      headers: { 'idempotency-key': 'test-command-key-123456' },
    });

    expect(rejected.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(200);
  });

  it('uses the standardized error envelope', async () => {
    const app = await buildApp({ config, logger: createLogger('api-test', 'silent') });
    apps.push(app);
    app.get('/explode', () => {
      throw new Error('sensitive internal detail');
    });

    const response = await app.inject({ method: 'GET', url: '/explode' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(response.body).not.toContain('sensitive internal detail');
  });
});
