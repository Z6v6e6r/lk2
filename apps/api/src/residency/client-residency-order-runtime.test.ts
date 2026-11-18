/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import {
  ResidencyOrderError,
  createResidencyOrderRuntime,
} from './client-residency-order-runtime.js';

const PRODUCT = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_KEY = 'iSkq6G';
const KEY = 'residency-key-0001';

const order = {
  schemaVersion: 1,
  orderId: ORDER_ID,
  mode: 'NEW',
  state: 'PENDING_PAYMENT',
  terminal: false,
  terminalReason: null,
  product: { productId: PRODUCT, title: 'Резидентство', termDays: 30, currency: 'RUB' },
  pricing: { baseAmountMinor: 79000, discountLines: [], totalMinor: 79000, currency: 'RUB' },
  consent: {
    expectedTotalMinor: 79000,
    productId: PRODUCT,
    acceptedAt: '2026-11-18T09:00:00.000Z',
  },
  renewal: null,
  payment: {
    status: 'PENDING',
    paymentUrl: 'https://bank.example/pay/1',
    expiresAt: '2026-11-18T09:20:00.000Z',
    overdue: false,
    instruction: 'pay',
  },
  recovery: {
    state: 'AWAITING_PAYMENT',
    required: false,
    reason: null,
    action: 'PAY',
    retryable: true,
    since: '2026-11-18T09:00:00.000Z',
  },
  activation: { state: 'NOT_STARTED', attempts: 0, lastErrorCode: null },
  residency: null,
  createdAt: '2026-11-18T09:00:00.000Z',
  updatedAt: '2026-11-18T09:00:00.000Z',
  revision: 1,
};
const envelope = { schemaVersion: 1, order, idempotentReplay: false };
const catalog = { schemaVersion: 1, product: { productId: PRODUCT }, renewal: { eligible: false } };
const actor = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  tenantKey: TENANT_KEY,
  userId: '44444444-4444-4444-8444-444444444444',
  sessionId: '55555555-5555-4555-8555-555555555555',
  correlationId: 'corr-12345678',
};
const credential = {
  token: 'v'.repeat(40),
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

function build(overrides: Record<string, unknown> = {}) {
  const client = {
    catalog: vi.fn(async () => catalog),
    createOrder: vi.fn(async () => envelope),
    listOrders: vi.fn(async () => ({ schemaVersion: 1, orders: [order], count: 1 })),
    readOrder: vi.fn(async () => order),
    readPayment: vi.fn(async () => ({
      schemaVersion: 1,
      orderId: ORDER_ID,
      state: 'PENDING_PAYMENT',
      paymentStatus: 'PENDING',
      paymentUrl: 'https://bank.example/pay/1',
      expiresAt: '2026-11-18T09:20:00.000Z',
      overdue: false,
      instruction: 'pay',
      recovery: order.recovery,
      terminal: false,
      terminalReason: null,
    })),
    reconcileOrder: vi.fn(async () => envelope),
    cancelOrder: vi.fn(async () => ({
      ...envelope,
      order: {
        ...order,
        state: 'CANCELLED',
        terminal: true,
        payment: { ...order.payment, paymentUrl: null },
      },
    })),
  };
  const token = vi.fn(async () => credential);
  const runtime = createResidencyOrderRuntime({
    enabled: true,
    productId: PRODUCT,
    tenantKey: TENANT_KEY,
    client,
    token,
    ...overrides,
  });
  return { runtime, client, token };
}

describe('residency order runtime', () => {
  it('is closed unless it is enabled, configured and bound to the owner tenant', async () => {
    for (const [overrides, code] of [
      [{ enabled: false }, 'RESIDENCY_ORDERS_DISABLED'],
      [{ productId: '' }, 'RESIDENCY_PRODUCT_NOT_CONFIGURED'],
      [{ tenantKey: 'other' }, 'RESIDENCY_TENANT_NOT_SUPPORTED'],
      [{ client: undefined }, 'RESIDENCY_OWNER_UNAVAILABLE'],
      [{ token: undefined }, 'RESIDENCY_OWNER_UNAVAILABLE'],
    ] as const) {
      const { runtime } = build(overrides);
      await expect(runtime.catalog(actor)).rejects.toMatchObject({ code });
    }
  });

  it('maps a missing or expired Viva delegation to an explicit re-auth', async () => {
    const reauth = build({
      token: async () => {
        throw Object.assign(new Error('x'), { code: 'VIVA_REAUTH_REQUIRED' });
      },
    });
    await expect(reauth.runtime.catalog(actor)).rejects.toMatchObject({
      code: 'RESIDENCY_REAUTH_REQUIRED',
      status: 409,
    });
    const expired = build({
      token: async () => ({
        token: credential.token,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    await expect(expired.runtime.catalog(actor)).rejects.toMatchObject({
      code: 'RESIDENCY_REAUTH_REQUIRED',
    });
    const revoked = build({
      token: async () => {
        throw Object.assign(new Error('x'), { code: 'AUTH_SESSION_REVOKED' });
      },
    });
    await expect(revoked.runtime.catalog(actor)).rejects.toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
      status: 401,
    });
  });

  it('passes the owner DTO through and forwards the exact create body', async () => {
    const { runtime, client } = build();
    await expect(
      runtime.create(actor, KEY, { mode: 'RENEWAL', expectedTotalMinor: 79000 }),
    ).resolves.toEqual(envelope);
    expect(client.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: KEY, correlationId: actor.correlationId }),
      { mode: 'RENEWAL', expectedTotalMinor: 79000 },
    );
    await expect(runtime.catalog(actor)).resolves.toEqual(catalog);
    await expect(runtime.readOrder(actor, ORDER_ID)).resolves.toEqual(order);
    await expect(runtime.listUnresolved(actor)).resolves.toMatchObject({ count: 1 });
  });

  it('rejects an unsatisfied price consent and unknown fields before the owner call', async () => {
    const { runtime, client } = build();
    for (const body of [
      { mode: 'NEW' },
      { mode: 'NEW', expectedTotalMinor: 0 },
      { mode: 'NEW', expectedTotalMinor: 79000, extra: 1 },
      { mode: 'OTHER', expectedTotalMinor: 79000 },
    ]) {
      await expect(runtime.create(actor, KEY, body)).rejects.toBeInstanceOf(ResidencyOrderError);
    }
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for every command', async () => {
    const { runtime, client } = build();
    for (const key of ['', 'short', 'has space 000000000000']) {
      await expect(runtime.create(actor, key, { expectedTotalMinor: 79000 })).rejects.toMatchObject(
        {
          code: 'RESIDENCY_IDEMPOTENCY_KEY_REQUIRED',
          status: 400,
        },
      );
      await expect(runtime.cancel(actor, ORDER_ID, key)).rejects.toMatchObject({
        code: 'RESIDENCY_IDEMPOTENCY_KEY_REQUIRED',
      });
    }
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it('never forwards an unknown order id and never accepts another product', async () => {
    const { runtime, client } = build();
    await expect(runtime.readOrder(actor, 'not-an-order')).rejects.toMatchObject({
      code: 'RESIDENCY_ORDER_NOT_FOUND',
      status: 404,
    });
    expect(client.readOrder).not.toHaveBeenCalled();
    const mismatch = build({
      client: {
        ...client,
        readOrder: async () => ({
          ...order,
          product: { ...order.product, productId: '11111111-1111-4111-8111-111111111111' },
        }),
      },
    });
    await expect(mismatch.runtime.readOrder(actor, ORDER_ID)).rejects.toMatchObject({
      code: 'RESIDENCY_PRODUCT_CONFIG_MISMATCH',
      status: 503,
    });
  });

  it('fails closed on an unexpected owner shape instead of proxying it', async () => {
    const broken = build({
      client: {
        catalog: async () => ({
          schemaVersion: 1,
          product: { productId: '11111111-1111-4111-8111-111111111111' },
        }),
        readOrder: async () => ({ ...order, state: 'DISPATCHING' }),
        readPayment: async () => ({
          schemaVersion: 1,
          orderId: '11111111-1111-4111-8111-111111111111',
        }),
        listOrders: async () => ({ schemaVersion: 1, orders: [order], count: 2 }),
      },
    });
    await expect(broken.runtime.catalog(actor)).rejects.toMatchObject({
      code: 'RESIDENCY_PRODUCT_CONFIG_MISMATCH',
    });
    await expect(broken.runtime.readOrder(actor, ORDER_ID)).rejects.toMatchObject({
      code: 'RESIDENCY_OWNER_RESPONSE_INVALID',
    });
    await expect(broken.runtime.readPayment(actor, ORDER_ID)).rejects.toMatchObject({
      code: 'RESIDENCY_OWNER_RESPONSE_INVALID',
    });
    await expect(broken.runtime.listUnresolved(actor)).rejects.toMatchObject({
      code: 'RESIDENCY_OWNER_RESPONSE_INVALID',
    });
  });

  it('reports its own capability without exposing any credential', async () => {
    const { runtime } = build();
    expect(runtime.capability()).toMatchObject({ enabled: true, productId: PRODUCT });
    const disabled = build({ enabled: false });
    expect(disabled.runtime.capability()).toMatchObject({ enabled: false });
  });
});
