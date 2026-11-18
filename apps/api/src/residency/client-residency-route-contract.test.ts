/* eslint-disable @typescript-eslint/require-await */
/**
 * QA scenario 3 — residency route contract, and the `/lk/residency/passes` verdict.
 *
 * Depends on consumer PR #684, pinned at 965efa7959d9ff4b402b4312a89b908bc6ca5707.
 * The existing GET /residency status read remains separate from catalog/order routes. These tests
 * exercise the full app, real consumer runtime and real HTTP client with a synthetic owner
 * transport. They prove route/JSON compatibility, not durable owner activation or provider writes.
 *
 * PRODUCTION observation (read-only probes of https://lk2.padlhub.su, recorded 2026-11-18):
 *   - `GET /lk/residency/passes` answered `200` with `content-type: text/html` and the SPA index
 *     body; `POST` and `OPTIONS` answered `405`. Caddy routes `/lk/*` to the web host and the SPA
 *     fallback that answers unknown paths with index.html is nginx's; canonical `/user/api/*`
 *     requests are routed to the API. The path is therefore not an API route: the 200 is a static
 *     shell answer and can never be a JSON success.
 *   - the web bundle served at that moment (`/assets/app-ryYAkSkC.js`) contained no `residency`
 *     string at all, so no shipped client called the path.
 *
 * Legacy paths stay absent at the API boundary; the public SPA fallback is not changed. The old
 * printRoutes substring assertions could pass even with registered siblings because Fastify prints
 * a compressed radix tree. Exact registration and actual injected requests are checked instead.
 */
import { PadlHubApiClient } from '@phub/api-sdk';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
import type { ClientResidencyService } from './client-residency-service.js';
import {
  createResidencyOrderRuntime,
  type ResidencyOrderRuntime,
} from './client-residency-order-runtime.js';
import { ClientResidencyOwnerClient } from './client-residency-owner-client.js';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_KEY = 'local-padel';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const STATUS = {
  state: 'ACTIVE',
  validFrom: '2026-09-01',
  validUntil: '2027-09-01',
  checkedAt: '2026-11-05T09:00:00.000Z',
  unavailableReason: null,
  holder: { displayName: 'Иван', avatarUrl: null },
} as const;

const baseEnvironment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:***@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:***@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: TENANT_ID }] }),
  } as unknown as Pool;
}

async function buildFullApp(service?: ClientResidencyService, orders?: ResidencyOrderRuntime) {
  const config = loadConfig(baseEnvironment);
  const app = await buildApp({
    config,
    logger: createLogger('residency-route-contract-test', 'silent'),
    pool: fakePool(),
    ...(service ? { clientResidencyService: service } : {}),
    ...(orders ? { residencyOrders: orders } : {}),
  });
  apps.push(app);
  return { app, config };
}

async function accessToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  return new SignJWT({
    tenants: [TENANT_ID],
    // `authenticateForAudience` rejects a token whose roles/permissions are not string arrays
    // (apps/api/src/app.ts:622-637), so a valid-session token must carry both claims.
    roles: ['client'],
    permissions: [],
    sid: '66666666-6666-4666-8666-666666666666',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(USER_ID)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

const RESIDENCY_URL = `/user/api/v1/${TENANT_KEY}/residency`;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('scenario 3: the residency contract that exists, at the full-application boundary', () => {
  it('answers 401 AUTH_REQUIRED without a verified session', async () => {
    const { app } = await buildFullApp({
      getClientResidency: vi.fn(async () => STATUS),
    } as unknown as ClientResidencyService);

    const response = await app.inject({ method: 'GET', url: RESIDENCY_URL });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('answers 503 RESIDENCY_SERVICE_UNAVAILABLE when the service is not wired', async () => {
    const { app, config } = await buildFullApp();

    const response = await app.inject({
      method: 'GET',
      url: RESIDENCY_URL,
      headers: { authorization: `Bearer ${await accessToken(config)}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'RESIDENCY_SERVICE_UNAVAILABLE' });
  });

  it('returns the normalized status as JSON with no-store caching', async () => {
    const getClientResidency = vi.fn(async () => STATUS);
    const { app, config } = await buildFullApp({
      getClientResidency,
    } as unknown as ClientResidencyService);

    const response = await app.inject({
      method: 'GET',
      url: RESIDENCY_URL,
      headers: { authorization: `Bearer ${await accessToken(config)}` },
    });

    expect(response.statusCode).toBe(200);
    // A JSON contract, not an HTML shell: the client must be able to parse this response.
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual(STATUS);
    expect(getClientResidency).toHaveBeenCalledTimes(1);
  });
});

describe('scenario 3: legacy paths are not LK2 API endpoints', () => {
  it('keeps the canonical status read while refusing legacy spellings', async () => {
    const { app } = await buildFullApp({
      getClientResidency: vi.fn(),
    } as unknown as ClientResidencyService);
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/user/api/v1/:tenantKey/residency' })).toBe(true);
    for (const url of [
      '/lk/residency/passes',
      '/residency/catalog',
      `/user/api/v1/${TENANT_KEY}/residency/passes`,
      `/user/api/v1/${TENANT_KEY}/residency-passes`,
      `/user/api/v1/${TENANT_KEY}/residency-purchase-operations`,
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
    }
  });
});

const ORDER_ID = '77777777-7777-4777-8777-777777777777';
const PRODUCT_ID = '88888888-8888-4888-8888-888888888888';
const CORRELATION_ID = 'qa-residency-route-contract';
const IDEMPOTENCY_KEY = 'qa-residency-idempotency-0001';
const order = {
  schemaVersion: 1,
  orderId: ORDER_ID,
  state: 'PENDING_PAYMENT',
  product: { productId: PRODUCT_ID },
  pricing: { totalMinor: 79000 },
  payment: { status: 'PENDING' },
  recovery: { state: 'WAITING_PAYMENT' },
};
const envelope = { schemaVersion: 1, idempotentReplay: false, order };
const consumerCases = [
  { method: 'GET', suffix: '/catalog', body: { schemaVersion: 1, product: order.product } },
  {
    method: 'GET',
    suffix: '/orders?state=unresolved',
    body: { schemaVersion: 1, orders: [order], count: 1 },
  },
  {
    method: 'POST',
    suffix: '/orders',
    payload: { mode: 'NEW', expectedTotalMinor: 79000 },
    body: envelope,
  },
  { method: 'GET', suffix: `/orders/${ORDER_ID}`, body: order },
  {
    method: 'GET',
    suffix: `/orders/${ORDER_ID}/payment`,
    body: {
      schemaVersion: 1,
      orderId: ORDER_ID,
      state: order.state,
      paymentStatus: 'PENDING',
      recovery: order.recovery,
    },
  },
  { method: 'POST', suffix: `/orders/${ORDER_ID}/reconcile`, payload: {}, body: envelope },
  { method: 'POST', suffix: `/orders/${ORDER_ID}/cancel`, payload: {}, body: envelope },
] as const;

function consumerFixture(enabled = true, html = false) {
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: string | undefined;
  }> = [];
  const token = vi.fn(async () => ({
    token: 'synthetic-viva-delegation-not-a-real-credential',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  }));
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    requests.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: init?.body as string | undefined,
    });
    if (html) return new Response('<html>SPA</html>', { headers: { 'content-type': 'text/html' } });
    const match = consumerCases.find(
      (item) => item.method === method && url === `https://padlhub.su/lk/residency${item.suffix}`,
    );
    if (!match) throw new Error('UNEXPECTED_SYNTHETIC_OWNER_REQUEST');
    return new Response(JSON.stringify(match.body), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const runtime = createResidencyOrderRuntime({
    enabled,
    productId: PRODUCT_ID,
    tenantKey: TENANT_KEY,
    token,
    client: new ClientResidencyOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 1000,
      fetchImplementation,
    }),
  });
  return { runtime, requests, token };
}

describe('scenario 3: compatibility with the real consumer from PR #684', () => {
  it.each(consumerCases)(
    'serves $method $suffix under the user API prefix as JSON',
    async (item) => {
      const fixture = consumerFixture();
      const { app, config } = await buildFullApp(undefined, fixture.runtime);
      await app.ready();
      expect(
        app.hasRoute({
          method: item.method,
          url:
            '/user/api/v1/:tenantKey/residency' +
            item.suffix.split('?')[0]!.replace(ORDER_ID, ':orderId'),
        }),
      ).toBe(true);
      const jwt = await accessToken(config);
      const response = await app.inject({
        method: item.method,
        url: RESIDENCY_URL + item.suffix,
        headers: {
          authorization: `Bearer ${jwt}`,
          'x-correlation-id': CORRELATION_ID,
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        ...('payload' in item ? { payload: item.payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-correlation-id']).toBe(CORRELATION_ID);
      expect(response.json()).toEqual(item.body);
      expect(fixture.requests).toHaveLength(1);
      const request = fixture.requests[0]!;
      expect(request.url).toBe('https://padlhub.su/lk/residency' + item.suffix);
      expect(request.method).toBe(item.method);
      expect(request.headers.get('authorization')).toBe(
        'Bearer synthetic-viva-delegation-not-a-real-credential',
      );
      expect(request.headers.get('authorization')).not.toContain(jwt);
      expect(request.headers.get('x-correlation-id')).toBe(CORRELATION_ID);
      if (item.method === 'POST') {
        expect(request.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
        expect(JSON.parse(request.body!)).toEqual(item.payload);
      }
    },
  );

  describe.each(['unwired', 'disabled'] as const)('%s consumer stays closed', (mode) => {
    it.each(consumerCases)('returns a JSON disabled error for $method $suffix', async (item) => {
      const fixture = consumerFixture(false);
      const { app, config } = await buildFullApp(
        undefined,
        mode === 'disabled' ? fixture.runtime : undefined,
      );
      const response = await app.inject({
        method: item.method,
        url: RESIDENCY_URL + item.suffix,
        headers: {
          authorization: `Bearer ${await accessToken(config)}`,
          'idempotency-key': IDEMPOTENCY_KEY,
          'x-correlation-id': CORRELATION_ID,
        },
        ...('payload' in item ? { payload: item.payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-correlation-id']).toBe(CORRELATION_ID);
      expect(response.json()).toMatchObject({
        code: 'RESIDENCY_ORDERS_DISABLED',
        correlationId: CORRELATION_ID,
      });
      expect(fixture.token).not.toHaveBeenCalled();
      expect(fixture.requests).toHaveLength(0);
    });
  });

  it('refuses an owner HTML 200 as a JSON availability error at the full-app boundary', async () => {
    const fixture = consumerFixture(true, true);
    const { app, config } = await buildFullApp(undefined, fixture.runtime);
    const response = await app.inject({
      method: 'GET',
      url: RESIDENCY_URL + '/catalog',
      headers: { authorization: `Bearer ${await accessToken(config)}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ code: 'RESIDENCY_OWNER_UNAVAILABLE' });
    expect(fixture.requests).toHaveLength(1);
  });
});

describe('scenario 3: an HTML 200 is never a client-side success', () => {
  it('rejects instead of resolving when the response body is an HTML shell', async () => {
    const requests: Array<{ url: string; accept: string | null }> = [];
    const client = new PadlHubApiClient({
      baseUrl: 'https://lk2.padlhub.test',
      tenantKey: TENANT_KEY,
      platform: 'web',
      appVersion: '0.0.0-qa',
      initialAccessToken: 'qa-access-token',
      fetchImplementation: (input, init) => {
        // Keep the init: the SDK passes its headers there, so rebuilding from the URL alone would
        // hide the Accept header this assertion is about.
        const request = new Request(input, init);
        requests.push({ url: request.url, accept: request.headers.get('accept') });
        return Promise.resolve(
          new Response('<!doctype html><html lang="ru"><body>SPA</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
        );
      },
    });

    await expect(client.getClientResidency()).rejects.toThrow();
    // The client asked for JSON; an HTML shell answered far below that contract and must surface as
    // a failure rather than as a parsed residency status.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain(`/user/api/v1/${TENANT_KEY}/residency`);
    expect(requests[0]?.accept).toContain('application/json');
  });
});
