/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerClientResidencyOrderRoutes } from './client-residency-order-routes.js';
import {
  ResidencyOrderError,
  type ResidencyOrderRuntime,
} from './client-residency-order-runtime.js';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const KEY = 'residency-key-0001';
const TENANT_KEY = 'iSkq6G';

const instances: FastifyInstance[] = [];

function authenticated(request: FastifyRequest): Promise<void> {
  (request as unknown as { tenantId: string }).tenantId = TENANT_ID;
  (request as unknown as { padlHubClaims: unknown }).padlHubClaims = {
    sub: USER_ID,
    sid: SESSION_ID,
    roles: ['client'],
    permissions: [],
  };
  return Promise.resolve();
}

function authenticatedWithoutClientRole(request: FastifyRequest): Promise<void> {
  return authenticated(request).then(() => {
    (request as unknown as { padlHubClaims: { roles: string[] } }).padlHubClaims.roles = [];
  });
}

function unauthenticated(): Promise<void> {
  return Promise.resolve();
}

function build(
  runtime: ResidencyOrderRuntime | undefined,
  options: { commandHandler?: (request: FastifyRequest) => Promise<void> } = {},
): FastifyInstance {
  const app = Fastify({
    genReqId: (request) =>
      typeof request.headers['x-correlation-id'] === 'string'
        ? request.headers['x-correlation-id']
        : 'corr-test-1',
  });
  registerClientResidencyOrderRoutes(app, {
    ...(runtime ? { runtime } : {}),
    readHandlers: [authenticated],
    commandHandlers: [options.commandHandler ?? authenticated],
  });
  instances.push(app);
  return app;
}

function fakeRuntime(overrides: Partial<Record<keyof ResidencyOrderRuntime, unknown>> = {}) {
  return {
    catalog: vi.fn(async () => ({ schemaVersion: 1, product: { productId: 'p' } })),
    listUnresolved: vi.fn(async () => ({ schemaVersion: 1, orders: [], count: 0 })),
    readOrder: vi.fn(async () => ({ schemaVersion: 1, orderId: ORDER_ID })),
    readPayment: vi.fn(async () => ({ schemaVersion: 1, orderId: ORDER_ID })),
    create: vi.fn(async () => ({ schemaVersion: 1, order: { orderId: ORDER_ID } })),
    reconcile: vi.fn(async () => ({ schemaVersion: 1, order: { orderId: ORDER_ID } })),
    cancel: vi.fn(async () => ({ schemaVersion: 1, order: { orderId: ORDER_ID } })),
    capability: vi.fn(async () => ({ enabled: true, productId: 'p' })),
    ...overrides,
  } as unknown as ResidencyOrderRuntime;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('residency order routes', () => {
  it('serves the catalog for the verified session and never caches it', async () => {
    const runtime = fakeRuntime();
    const response = await build(runtime).inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/catalog',
      headers: { 'x-correlation-id': 'corr-route-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(runtime.catalog).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      tenantKey: TENANT_KEY,
      userId: USER_ID,
      sessionId: SESSION_ID,
      correlationId: 'corr-route-1',
    });
  });

  it('refuses an unauthenticated caller before the owner is reached', async () => {
    const runtime = fakeRuntime();
    const app = Fastify({
      genReqId: (request) =>
        typeof request.headers['x-correlation-id'] === 'string'
          ? request.headers['x-correlation-id']
          : 'corr-test-1',
    });
    registerClientResidencyOrderRoutes(app, {
      runtime,
      readHandlers: [unauthenticated],
      commandHandlers: [unauthenticated],
    });
    instances.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/catalog',
      headers: { 'x-correlation-id': 'corr-route-1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED', correlationId: 'corr-route-1' });
    expect(runtime.catalog).not.toHaveBeenCalled();
  });

  it('requires an idempotency key and the client role for commands', async () => {
    const runtime = fakeRuntime();
    const noKey = await build(runtime).inject({
      method: 'POST',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders',
      payload: { mode: 'NEW', expectedTotalMinor: 79000 },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().code).toBe('RESIDENCY_IDEMPOTENCY_KEY_REQUIRED');

    const readOnly = await build(runtime, {
      commandHandler: authenticatedWithoutClientRole,
    }).inject({
      method: 'POST',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders',
      headers: { 'idempotency-key': KEY },
      payload: { mode: 'NEW', expectedTotalMinor: 79000 },
    });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe('RESIDENCY_PERMISSION_REQUIRED');
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it('forwards a create with the exact body and key', async () => {
    const runtime = fakeRuntime();
    const response = await build(runtime).inject({
      method: 'POST',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders',
      headers: { 'idempotency-key': KEY, 'x-correlation-id': 'corr-route-2' },
      payload: { mode: 'RENEWAL', expectedTotalMinor: 79000 },
    });
    expect(response.statusCode).toBe(200);
    expect(runtime.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantKey: TENANT_KEY, correlationId: 'corr-route-2' }),
      KEY,
      { mode: 'RENEWAL', expectedTotalMinor: 79000 },
    );
  });

  it('accepts only the unresolved lookup and no unknown query', async () => {
    const runtime = fakeRuntime();
    const app = build(runtime);
    const bad = await app.inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders?state=paid',
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders?state=unresolved&tenantId=x',
    });
    expect(unknown.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders?state=unresolved',
    });
    expect(ok.statusCode).toBe(200);
    expect(runtime.listUnresolved).toHaveBeenCalled();
  });

  it('passes a structured owner refusal through with its details and correlation id', async () => {
    const runtime = fakeRuntime({
      create: async () => {
        throw new ResidencyOrderError('RESIDENCY_RENEWAL_TOO_EARLY', 409, {
          eligibleAt: '2026-11-23T09:05:00.000Z',
          reason: 'REMAINING_DAYS_NOT_TRANSFERABLE',
        });
      },
    });
    const response = await build(runtime).inject({
      method: 'POST',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders',
      headers: { 'idempotency-key': KEY, 'x-correlation-id': 'corr-route-3' },
      payload: { mode: 'RENEWAL', expectedTotalMinor: 79000 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'RESIDENCY_RENEWAL_TOO_EARLY',
      message: expect.any(String),
      correlationId: 'corr-route-3',
      details: {
        eligibleAt: '2026-11-23T09:05:00.000Z',
        reason: 'REMAINING_DAYS_NOT_TRANSFERABLE',
      },
    });
  });

  it('stays closed when the consumer is not wired', async () => {
    const response = await build(undefined).inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/catalog',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('RESIDENCY_ORDERS_DISABLED');
  });

  it('routes read, payment, reconcile and cancel by order id', async () => {
    const runtime = fakeRuntime();
    const app = build(runtime);
    const payment = await app.inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders/' + ORDER_ID + '/payment',
    });
    expect(payment.statusCode).toBe(200);
    expect(runtime.readPayment).toHaveBeenCalledWith(expect.any(Object), ORDER_ID);
    const reconcile = await app.inject({
      method: 'POST',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders/' + ORDER_ID + '/reconcile',
      headers: { 'idempotency-key': KEY },
      payload: { eventId: 'evt-1' },
    });
    expect(reconcile.statusCode).toBe(200);
    expect(runtime.reconcile).toHaveBeenCalledWith(expect.any(Object), ORDER_ID, KEY, {
      eventId: 'evt-1',
    });
    const cancel = await app.inject({
      method: 'POST',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders/' + ORDER_ID + '/cancel',
      headers: { 'idempotency-key': KEY },
    });
    expect(cancel.statusCode).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledWith(expect.any(Object), ORDER_ID, KEY);
    const order = await app.inject({
      method: 'GET',
      url: '/user/api/v1/' + TENANT_KEY + '/residency/orders/' + ORDER_ID,
    });
    expect(order.statusCode).toBe(200);
    expect(runtime.readOrder).toHaveBeenCalledWith(expect.any(Object), ORDER_ID);
  });
});
