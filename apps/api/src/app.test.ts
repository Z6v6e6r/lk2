import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp, requireIdempotencyKey, sanitizeRequestLogUrl } from './app.js';
import { buildMockHomeDashboard } from './home/home-dashboard.js';

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
  it('removes OAuth and other query parameters from request logs', () => {
    expect(
      sanitizeRequestLogUrl(
        '/user/api/v1/local-padel/auth/viva/callback?state=secret&code=one-time-code',
      ),
    ).toBe('/user/api/v1/local-padel/auth/viva/callback');
    expect(sanitizeRequestLogUrl('/health/ready')).toBe('/health/ready');
  });

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

  it('returns the effective server-owned routing plan for the authenticated client', async () => {
    const app = await buildApp({
      config: { ...config, VIVA_DIRECT_READ_ENABLED: true },
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      clientRoutingPlanRepository: {
        get: () =>
          Promise.resolve({
            mode: 'MIXED_END_USER_READS',
            revision: '3',
            validForSeconds: 60,
            directOperations: ['profile.read'],
            providerTenantKey: 'iSkq6G',
            delegationReady: true,
          }),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/routing-plan',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'web',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, max-age=30');
    expect(response.json()).toMatchObject({
      revision: '3',
      mode: 'MIXED_END_USER_READS',
      directViva: {
        providerTenantKey: 'iSkq6G',
        allowedRequestHeaders: ['Authorization'],
      },
    });
  });

  it('fails closed for administrative clients even when the tenant is mixed', async () => {
    const app = await buildApp({
      config: { ...config, VIVA_DIRECT_READ_ENABLED: true },
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      clientRoutingPlanRepository: {
        get: () =>
          Promise.resolve({
            mode: 'MIXED_END_USER_READS',
            revision: '3',
            validForSeconds: 60,
            directOperations: ['profile.read'],
            providerTenantKey: 'iSkq6G',
            delegationReady: true,
          }),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/routing-plan',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ mode: 'PADLHUB_ONLY' });
    expect(response.json()).not.toHaveProperty('directViva');
  });

  it('stops delegated Viva token issuance when the effective plan is PadlHub-only', async () => {
    const issueVivaAccessToken = vi.fn().mockResolvedValue({
      accessToken: 'must-not-be-issued',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      authService: { issueVivaAccessToken } as never,
      clientRoutingPlanRepository: {
        get: () =>
          Promise.resolve({
            mode: 'PADLHUB_ONLY',
            revision: '4',
            validForSeconds: 60,
            directOperations: [],
            delegationReady: true,
          }),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/auth/viva/access',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'x-app-platform': 'web',
        'idempotency-key': 'viva-access-disabled-test-0001',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'DIRECT_VIVA_DISABLED' });
    expect(issueVivaAccessToken).not.toHaveBeenCalled();
  });

  it('returns one normalized PadlHub profile aggregate', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/profile',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
      displayName: 'Игрок ПадлХАБ',
      currency: 'RUB',
      level: { assessmentRequired: false },
    });
  });

  it('returns upcoming bookings with PadlHub UUIDs from one projection version', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/bookings/upcoming',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('private');
    const body = response.json<{
      version: string;
      generatedAt: string;
      staleAt: string;
      items: { id: string; route: string }[];
    }>();
    expect(body.version).toBeTruthy();
    expect(body.generatedAt).toBeTruthy();
    expect(body.staleAt).toBeTruthy();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.items[0]?.route).toMatch(/^\/(?:bookings|games)\//);
    expect(body.items[0]?.route).toContain(body.items[0]?.id);
    expect(JSON.stringify(body)).not.toContain('externalId');
  });

  it('returns the complete home dashboard as one protected snapshot', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/home',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('private');
    const body = response.json<{
      snapshot: { source: string };
      profile: { userId: string };
      counters: { unreadChats: number };
      capabilities: { canViewCommunities: boolean };
      quickActions: unknown[];
      communities: unknown[];
    }>();
    expect(body).toMatchObject({
      snapshot: { source: 'LOCAL_MOCK' },
      profile: { userId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca' },
      counters: { unreadChats: 3 },
      capabilities: { canViewCommunities: true },
    });
    expect(body.quickActions).toHaveLength(4);
    expect(body.communities).toHaveLength(3);
  });

  it('serves a validated persisted Home projection independently of Viva mode', async () => {
    const projectionConfig = {
      ...config,
      HOME_READ_MODE: 'projection' as const,
      VIVA_MODE: 'sandbox' as const,
    };
    const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
    const generatedAt = new Date();
    const dashboard = buildMockHomeDashboard({
      tenantId,
      userId,
      displayName: 'Алексей',
      phoneLast4: '3190',
      roles: ['client'],
      permissions: ['profile.read'],
      now: generatedAt,
    });
    const payload = {
      ...dashboard,
      snapshot: { ...dashboard.snapshot, source: 'LOCAL_PROJECTION' as const },
    };
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: {
        get: () =>
          Promise.resolve({
            tenantId,
            userId,
            sourceRevision: '1',
            sourceEventId: '55555555-5555-4555-8555-555555555555',
            producer: 'HOME_IMPORT',
            snapshotVersion: payload.snapshot.version,
            payload,
            payloadChecksum: 'a'.repeat(64),
            generatedAt: payload.snapshot.generatedAt,
            staleAt: payload.snapshot.staleAt,
            updatedAt: payload.snapshot.generatedAt,
          }),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/home',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      snapshot: { source: 'LOCAL_PROJECTION' },
      profile: { userId, displayName: 'Алексей' },
    });
  });

  it('does not fall back to mock data when a real Home projection is absent', async () => {
    const projectionConfig = {
      ...config,
      HOME_READ_MODE: 'projection' as const,
      VIVA_MODE: 'sandbox' as const,
    };
    const app = await buildApp({
      config: projectionConfig,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      homeDashboardRepository: { get: () => Promise.resolve(undefined) },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/home',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'HOME_PROJECTION_NOT_READY' });
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
