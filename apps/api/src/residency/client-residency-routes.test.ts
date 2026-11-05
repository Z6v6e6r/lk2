/* eslint-disable @typescript-eslint/require-await */
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

function unauthenticated(): Promise<void> {
  return Promise.resolve();
}

function build(options: {
  service?: ClientResidencyService;
  handler?: (request: FastifyRequest) => Promise<void>;
  getUserContext?: (tenantId: string, userId: string) => Promise<{ id: string } | undefined>;
}): FastifyInstance {
  const app = Fastify({
    genReqId: (request) =>
      typeof request.headers['x-correlation-id'] === 'string'
        ? request.headers['x-correlation-id']
        : 'test-correlation',
  });
  registerClientResidencyRoutes(app, {
    ...(options.service ? { service: options.service } : {}),
    ...(options.getUserContext ? { getUserContext: options.getUserContext } : {}),
    authenticatedTenantHandlers: [options.handler ?? authenticated],
  });
  instances.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('GET /user/api/v1/:tenantKey/residency', () => {
  it('answers with one normalized residency status for the verified session', async () => {
    const getClientResidency = vi.fn(async () => STATUS);
    const service = { getClientResidency } as unknown as ClientResidencyService;
    const response = await build({
      service,
      getUserContext: vi.fn(async () => ({ id: USER_ID })),
    }).inject({
      method: 'GET',
      url: `/user/api/v1/tenant/residency`,
      headers: { 'x-correlation-id': 'corr-route-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.json()).toEqual(STATUS);
    expect(getClientResidency).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      correlationId: 'corr-route-1',
    });
  });

  it('ignores client-supplied identity selectors', async () => {
    const getClientResidency = vi.fn(async () => STATUS);
    const response = await build({
      service: { getClientResidency } as unknown as ClientResidencyService,
    }).inject({
      method: 'GET',
      url: '/user/api/v1/foreign/residency?userId=99999999-9999-4999-8999-999999999999&tenantId=99999999-9999-4999-8999-999999999999',
    });
    expect(response.statusCode).toBe(200);
    expect(getClientResidency).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
      correlationId: 'test-correlation',
    });
  });

  it('rejects an unauthenticated request', async () => {
    const response = await build({ handler: unauthenticated }).inject({
      method: 'GET',
      url: '/user/api/v1/tenant/residency',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects a revoked session', async () => {
    const response = await build({
      service: { getClientResidency: vi.fn() } as unknown as ClientResidencyService,
      getUserContext: vi.fn(async () => undefined),
    }).inject({ method: 'GET', url: '/user/api/v1/tenant/residency' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
  });

  it('fails closed when the server method is not wired', async () => {
    const response = await build({}).inject({
      method: 'GET',
      url: '/user/api/v1/tenant/residency',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'RESIDENCY_SERVICE_UNAVAILABLE' });
  });
});
