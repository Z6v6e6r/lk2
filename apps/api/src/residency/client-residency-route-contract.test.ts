/* eslint-disable @typescript-eslint/require-await */
/**
 * QA scenario 3 — residency route contract, and the `/lk/residency/passes` verdict.
 *
 * SOURCE evidence (executable, this file):
 *   - the only residency route LK2 registers is `GET /user/api/v1/:tenantKey/residency`
 *     (`apps/api/src/residency/client-residency-routes.ts:26`), mirrored by the SDK as
 *     `getClientResidency()` -> `'/residency'` (`packages/api-sdk/src/index.ts:1028-1030`);
 *   - the FULL application (`buildApp` from `apps/api/src/app.ts`) registers no other residency
 *     route — the assertions below read the real route table instead of the composition of one
 *     module mounted on a bare Fastify instance;
 *   - the residency-UI contract of PR #682 (verified client head
 *     `e78de6d5a1dde7096c4ca7fa11efed159fb1e6d7`) has NO server consumer on `main`: the client calls
 *     `/residency/catalog`, `/residency/orders`, `/residency/orders/{id}`, `.../payment`,
 *     `.../reconcile` and `.../cancel`, and none of them is registered. That missing server-side
 *     consumer — not the retired `residency-purchase-operations` paths — is the real blocker.
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
 * The assertions pin the contract that exists, the absence of the paths a client could mistake for
 * it, and the client-side rule that an HTML body is never read as success.
 */
import { PadlHubApiClient } from '@phub/api-sdk';
import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
import type { ClientResidencyService } from './client-residency-service.js';

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

async function buildFullApp(service?: ClientResidencyService) {
  const config = loadConfig(baseEnvironment);
  const app = await buildApp({
    config,
    logger: createLogger('residency-route-contract-test', 'silent'),
    pool: fakePool(),
    ...(service ? { clientResidencyService: service } : {}),
  });
  apps.push(app);
  return { app, config };
}

async function accessToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  return new SignJWT({
    tenants: [TENANT_ID],
    // `authenticateForAudience` rejects a token whose roles/permissions are not string arrays
    // (apps/api/src/app.ts:622-637), so a valid-session token must carry both claims.
    roles: [],
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

describe('scenario 3: the full route table proves what is absent', () => {
  it('registers exactly one residency route in the whole application', async () => {
    const { app } = await buildFullApp({
      getClientResidency: vi.fn(),
    } as unknown as ClientResidencyService);
    const routes = app.printRoutes({ commonPrefix: false });

    expect(routes).toContain('/user/api/v1/:tenantKey/residency');
    // No passes variant in any spelling, no LK1-shaped path, and none of the retired
    // purchase-operation paths.
    expect(routes).not.toMatch(/residency[/-]passes?/);
    expect(routes).not.toMatch(/lk\/residency/);
    expect(routes).not.toContain('residency-purchase-operations');
  });

  it('has no server consumer for the current residency-UI contract of PR #682', async () => {
    const { app } = await buildFullApp({
      getClientResidency: vi.fn(),
    } as unknown as ClientResidencyService);
    const routes = app.printRoutes({ commonPrefix: false });

    // The verified client head calls these sibling paths under the user API root. None exists on
    // main, so the UI cannot ship before the server consumer lands — blocker D-1.
    expect(routes).not.toMatch(/residency\/catalog/);
    expect(routes).not.toMatch(/residency\/orders/);
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
