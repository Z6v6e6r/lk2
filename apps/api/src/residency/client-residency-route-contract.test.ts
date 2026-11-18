/* eslint-disable @typescript-eslint/require-await */
/**
 * QA scenario 3 — residency route contract, and the `/lk/residency/passes` verdict.
 *
 * Verdict (evidence-backed, see the PR body):
 *   `/lk/residency/passes` is NOT an LK2 endpoint. The only client residency route LK2 registers is
 *   `GET /user/api/v1/:tenantKey/residency` (client-residency-routes.ts:26), and the SDK mirrors it
 *   as `getClientResidency()` -> '/residency' (packages/api-sdk/src/index.ts:1029).
 *   In the deployed topology `GET /lk/residency/passes` answers 200 text/html because Caddy's SPA
 *   fallback returns index.html for unknown paths, and POST/OPTIONS answer 405 — i.e. the path is
 *   served by the static host, never by the API. The web bundle currently deployed on
 *   lk2.padlhub.su contains no occurrence of "residency" at all, so no shipped client calls it.
 *
 * This file pins the contract that does exist and pins the absence of the paths a client could
 * mistake for it, so a future client-side regression is caught here instead of in production as a
 * 200-with-HTML or a 404.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClientResidencyService } from './client-residency-service.js';
import { registerClientResidencyRoutes } from './client-residency-routes.js';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const STATUS = {
  state: 'ACTIVE',
  validFrom: '2026-09-01',
  validUntil: '2027-09-01',
  checkedAt: '2026-11-05T09:00:00.000Z',
  unavailableReason: null,
  holder: { displayName: 'Иван', avatarUrl: null },
} as const;

const instances: FastifyInstance[] = [];

function authenticated(request: FastifyRequest): Promise<void> {
  (request as unknown as { tenantId: string }).tenantId = TENANT_ID;
  (request as unknown as { padlHubClaims: unknown }).padlHubClaims = {
    sub: USER_ID,
    roles: [],
    permissions: [],
  };
  return Promise.resolve();
}

function build(options: {
  service?: ClientResidencyService;
  handler?: (request: FastifyRequest) => Promise<void>;
}): FastifyInstance {
  const app = Fastify({ genReqId: () => 'qa-correlation' });
  registerClientResidencyRoutes(app, {
    ...(options.service ? { service: options.service } : {}),
    authenticatedTenantHandlers: [options.handler ?? authenticated],
  });
  instances.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('scenario 3: the residency contract that exists', () => {
  it('returns the normalized status for the verified session with no-store caching', async () => {
    const getClientResidency = vi.fn(async () => STATUS);
    const response = await build({
      service: { getClientResidency } as unknown as ClientResidencyService,
    }).inject({ method: 'GET', url: '/user/api/v1/tenant/residency' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toEqual(STATUS);
  });

  it('answers 401 AUTH_REQUIRED without a verified session', async () => {
    const response = await build({
      service: { getClientResidency: vi.fn() } as unknown as ClientResidencyService,
      handler: () => Promise.resolve(),
    }).inject({ method: 'GET', url: '/user/api/v1/tenant/residency' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('answers 503 RESIDENCY_SERVICE_UNAVAILABLE when the service is not wired', async () => {
    const response = await build({}).inject({
      method: 'GET',
      url: '/user/api/v1/tenant/residency',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'RESIDENCY_SERVICE_UNAVAILABLE' });
  });

  it('registers exactly one residency path — no /residency/passes variant exists', () => {
    const routes = build({
      service: { getClientResidency: vi.fn() } as unknown as ClientResidencyService,
    }).printRoutes({ commonPrefix: false });
    expect(routes).toContain('/user/api/v1/:tenantKey/residency');
    expect(routes).not.toMatch(/residency\/(passes|pass)/);
    expect(routes).not.toContain('lk/residency');
    expect(routes).not.toContain('residency-purchase-operations');
  });
});

describe('scenario 3: paths a client may wrongly expect are absent, not HTML', () => {
  const absent = [
    // The path reported as 404/HTML in production. It is Caddy's SPA fallback, not an API route.
    ['GET', '/lk/residency/passes'],
    ['POST', '/lk/residency/passes'],
    // The plausible "under the real prefix" variants.
    ['GET', '/user/api/v1/tenant/residency/passes'],
    ['GET', '/user/api/v1/tenant/residency/passes/'],
    // The provisional purchase-operation contract used by the open residency-UI Draft PR (#682).
    // It is not registered on main, so a client built against that branch 404s against main.
    ['GET', '/user/api/v1/tenant/residency-purchase-operations/capability'],
    ['POST', '/user/api/v1/tenant/residency-purchase-operations'],
    ['GET', '/user/api/v1/tenant/residency-purchase-operations/by-key'],
  ] as const;

  it.each(absent)(
    '%s %s is not an LK2 route (404 from the API, never a JSON 404 body lie)',
    async (method, url) => {
      const response = await build({
        service: {
          getClientResidency: vi.fn(async () => STATUS),
        } as unknown as ClientResidencyService,
      }).inject({ method, url });
      // Fastify answers 404 for an unregistered path. In the deployed topology the same request is
      // intercepted earlier by Caddy's SPA fallback and returns index.html with 200 — which is why a
      // browser XHR to /lk/residency/passes can never yield JSON.
      expect(response.statusCode).toBe(404);
    },
  );

  it('does not answer a trailing-slash variant of the real route as success', async () => {
    const response = await build({
      service: {
        getClientResidency: vi.fn(async () => STATUS),
      } as unknown as ClientResidencyService,
    }).inject({ method: 'GET', url: '/user/api/v1/tenant/residency/' });
    expect([200, 404]).toContain(response.statusCode);
    if (response.statusCode === 200) expect(response.json()).toEqual(STATUS);
  });
});
