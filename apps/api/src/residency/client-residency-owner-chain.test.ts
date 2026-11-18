/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// Composed server chain: real LK2 consumer client + real LK1 owner HTTP contract +
// real owner engine + real provider adapter, with a controlled synthetic Viva/CUP
// transport. It runs only when LK1_RESIDENCY_MODULES_ROOT points at a checkout of
// Z6v6e6r/lk (the owner PR), because the owner lives in the other repository.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ClientResidencyOwnerClient } from './client-residency-owner-client.js';
import { createResidencyOrderRuntime } from './client-residency-order-runtime.js';

const LK1_ROOT = process.env.LK1_RESIDENCY_MODULES_ROOT;
const PRODUCT = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
const TENANT_KEY = 'iSkq6G';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
const TXN = '00000000-0000-4000-8000-000000000003';
const SUB = '00000000-0000-4000-8000-000000000002';
const KEY = 'residency-chain-key-0001';
const NOW = Date.parse('2026-11-18T09:00:00.000Z');
const PAID_AT = '2026-11-18T09:05:00.000Z';
const ACTIVE_TO = '2026-12-18T09:05:00.000Z';
const TOKEN = 'viva-actor-chain-' + 'z'.repeat(30);

const describeChain = LK1_ROOT ? describe : describe.skip;

// The composed test reads owner answers of the other repository's contract.
type ChainJson = any;

function memoryStore() {
  const orders = new Map<string, Record<string, unknown>>();
  const unresolved = (row: Record<string, unknown>) =>
    [
      'PENDING_PAYMENT',
      'PAID',
      'PAID_ACTIVATION_PENDING',
      'ACTIVATION_FAILED',
      'PAID_REQUIRES_REVIEW',
    ].includes(String(row.state));
  return {
    orders,
    async findOrderByKey(tenantId: string, keyHash: string) {
      return structuredClone(
        [...orders.values()].find(
          (row) => row.tenantId === tenantId && row.idempotencyKeyHash === keyHash,
        ) ?? null,
      );
    },
    async insertOrder(order: Record<string, unknown>) {
      if (orders.has(String(order.orderId))) return { ok: false };
      if (
        [...orders.values()].some(
          (row) =>
            (row.tenantId === order.tenantId &&
              row.idempotencyKeyHash === order.idempotencyKeyHash) ||
            (order.activeSlot === 1 &&
              row.tenantId === order.tenantId &&
              row.userId === order.userId &&
              row.activeSlot === 1),
        )
      )
        return { ok: false };
      orders.set(String(order.orderId), structuredClone(order));
      return { ok: true };
    },
    async getOrder(tenantId: string, userId: string, orderId: string) {
      const row = orders.get(orderId);
      if (!row || row.tenantId !== tenantId || row.userId !== userId) return null;
      return structuredClone(row);
    },
    async updateOrder(
      tenantId: string,
      orderId: string,
      revision: number,
      next: Record<string, unknown>,
    ) {
      const row = orders.get(orderId);
      if (!row || row.tenantId !== tenantId || row.revision !== revision) return { ok: false };
      orders.set(orderId, structuredClone(next));
      return { ok: true };
    },
    async findUnresolvedOrder(tenantId: string, userId: string) {
      return structuredClone(
        [...orders.values()].find(
          (row) => row.tenantId === tenantId && row.userId === userId && unresolved(row),
        ) ?? null,
      );
    },
    async listUnresolvedOrders(tenantId: string, userId: string, limit: number) {
      return [...orders.values()]
        .filter((row) => row.tenantId === tenantId && row.userId === userId && unresolved(row))
        .slice(0, limit)
        .map((row) => structuredClone(row));
    },
    async listExpiredPending() {
      return [];
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

interface ChainState {
  now: number;
  paid: boolean;
  createCalls: number;
  cupCalls: number;
  createMode: 'pending' | 'throw' | 'unconfirmed';
  failOwner: boolean;
  lastCreateBody: Record<string, unknown> | null;
}

async function chain() {
  const [lifecycleModule, httpModule, providerModule] = await Promise.all([
    import(
      pathToFileURL(
        join(
          LK1_ROOT!,
          'node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle.mjs',
        ),
      ).href
    ),
    import(
      pathToFileURL(
        join(
          LK1_ROOT!,
          'node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-http.mjs',
        ),
      ).href
    ),
    import(
      pathToFileURL(
        join(
          LK1_ROOT!,
          'node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-provider.mjs',
        ),
      ).href
    ),
  ]);
  const state: ChainState = {
    now: NOW,
    paid: false,
    createCalls: 0,
    cupCalls: 0,
    createMode: 'pending',
    failOwner: false,
    lastCreateBody: null,
  };
  const vivaFetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/profile')) return response({ id: CLIENT_ID, phone: '+15550000000' });
    if (url.includes('/products/subscriptions/'))
      return response({
        id: PRODUCT,
        title: 'Резидентство ПадлхАБ',
        cost: 79000,
        discountPrice: 79000,
        validityDays: 30,
        visits: 30,
        activationDays: 0,
        type: 'GROUP',
        variant: 'BY_VISITS',
        appliesTo: 'BOOKING',
        hasStudioLimitation: false,
        hasDirectionLimitation: false,
        hasTypeLimitation: true,
        availableTypes: [{ id: 2572 }],
        hasDayLimitation: false,
        hasTimeRangeLimitation: false,
        hasDayTimeLimitation: false,
      });
    if (url.endsWith('/transactions') && !url.includes('/api/v1/transactions/')) {
      state.createCalls += 1;
      state.lastCreateBody = JSON.parse(
        typeof init?.body === 'string' ? init.body : 'null',
      );
      if (state.createMode === 'throw') throw new Error('socket hang up');
      if (state.createMode === 'unconfirmed')
        return response({ paid: true, toPay: 79000, id: TXN });
      return response({
        id: TXN,
        paymentUrl: 'https://bank.example/pay/chain',
        toPay: 79000,
        paymentDueDate: new Date(NOW + 20 * 60_000).toISOString(),
      });
    }
    if (url.includes('/api/v1/transactions/')) {
      if (state.createMode === 'unconfirmed')
        return response({ code: 'RESIDENCY_UPSTREAM_UNAVAILABLE' }, 503);
      return response({
        id: TXN,
        status: state.paid ? 'PAID' : 'UNPAID',
        toPay: 79000,
        paymentDate: PAID_AT,
        client: { id: CLIENT_ID },
        products: [{ id: PRODUCT, type: 'SUBSCRIPTION', count: 1 }],
        refundSum: 0,
        transactionRefunds: [],
        cardPaymentInfo: { paymentUrl: 'https://bank.example/pay/chain' },
        paymentDueDate: new Date(NOW + 20 * 60_000).toISOString(),
      });
    }
    if (url.includes('/subscriptions?')) {
      if (!state.paid) return response([]);
      return response([
        {
          subscriptionId: SUB,
          productId: PRODUCT,
          clientId: CLIENT_ID,
          status: 'ACTIVE',
          purchaseDate: PAID_AT,
          activationDate: PAID_AT,
        },
      ]);
    }
    if (url.includes('/residency-booking-refresh') || url.includes('/residency-booking-context')) {
      state.cupCalls += 1;
      return response({
        providerProductId: PRODUCT,
        purchasedAt: PAID_AT,
        observedAt: PAID_AT,
        context: { instance: { state: 'ACTIVE', activeFrom: PAID_AT, activeTo: ACTIVE_TO } },
      });
    }
    return response({ code: 'UNEXPECTED' }, 404);
  };
  const store = memoryStore();
  const engineConfig = {
    returnTargets: {
      widget: { successUrl: 'https://lk.online/return', failUrl: 'https://lk.online/fail' },
      lk2: {
        successUrl: 'https://lk2.padlhub.su/residency',
        failUrl: 'https://lk2.padlhub.su/residency?failed=1',
      },
    },
    defaultReturnTarget: 'widget',
    dispatchLeaseMs: 120_000,
  };
  const ownerApi = httpModule.createResidencyLifecycleApi({
    createLifecycle: (actor: { tenantId: string; userId: string; actorToken: string }) => {
      const ports = providerModule.createVivaCupResidencyPorts({
        fetch: vivaFetch,
        config: {
          vivaBaseUrl: 'https://api.vivacrm.ru',
          cupBaseUrl: 'https://cup.example/api',
          tenantKey: TENANT_KEY,
          productId: PRODUCT,
          cupIntegrationToken: 't'.repeat(40),
          successUrl: 'https://lk.online/return',
          failUrl: 'https://lk.online/fail',
        },
        actorToken: actor.actorToken,
        getAdminToken: () => 's'.repeat(32),
        now: () => new Date(state.now),
      });
      return lifecycleModule.createResidencyLifecycle({
        clock: { now: () => state.now },
        ids: {
          orderId: (tenantId: string, keyHash: string) =>
            '00000000-0000-4000-8000-' +
            createHash('sha256')
              .update(tenantId + keyHash)
              .digest('hex')
              .slice(0, 12),
          eventId: () => 'event-1',
        },
        sha256: (value: string) => createHash('sha256').update(value).digest('hex'),
        store,
        catalog: ports.catalog,
        payments: ports.payments,
        activation: ports.activation,
        discounts: ports.discounts,
        status: ports.status,
        config: engineConfig,
      });
    },
  });
  // The LK2 transport bridge: HTTP-shaped request into the real owner contract.
  const bridge: typeof fetch = async (input, init) => {
    if (state.failOwner) throw new Error('ECONNREFUSED');
    const target = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    const url = new URL(target);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const authorization = headers.authorization ?? '';
    if (!authorization.startsWith('Bearer '))
      return response({ code: 'RESIDENCY_AUTH_REQUIRED' }, 401);
    const result = await ownerApi.handle({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      actor: {
        tenantId: TENANT_ID,
        userId: USER_ID,
        actorToken: authorization.slice('Bearer '.length),
      },
    });
    return new Response(result.body === null ? '' : JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  const client = new ClientResidencyOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 2_000,
    fetchImplementation: bridge,
  });
  const runtime = (productId = PRODUCT) =>
    createResidencyOrderRuntime({
      enabled: true,
      productId,
      tenantKey: TENANT_KEY,
      client,
      token: async () => ({ token: TOKEN, expiresAt: new Date(state.now + 300_000).toISOString() }),
    });
  const actor = {
    tenantId: TENANT_ID,
    tenantKey: TENANT_KEY,
    userId: USER_ID,
    sessionId: SESSION_ID,
    correlationId: 'corr-chain-1',
  };
  return { state, ownerApi, bridge, client, runtime, actor, store };
}

describeChain('composed residency chain (LK1 owner + LK2 consumer)', () => {
  it('runs catalog, purchase, confirmation and activation through real modules', async () => {
    const { state, runtime, actor } = await chain();
    const api = runtime();

    const catalog: ChainJson = await api.catalog(actor);
    expect(catalog.product.productId).toBe(PRODUCT);
    expect(catalog.renewal.eligible).toBe(false);
    expect(catalog.renewal.reason).toBe('NOT_ACTIVE');

    const created: ChainJson = await api.create(actor, KEY, {
      mode: 'NEW',
      expectedTotalMinor: 79000,
    });
    expect(created.order.state).toBe('PENDING_PAYMENT');
    expect(created.order.payment.status).toBe('PENDING');
    expect(created.order.payment.paymentUrl).toBe('https://bank.example/pay/chain');
    expect(created.order.recovery.state).toBe('AWAITING_PAYMENT');
    expect(state.createCalls).toBe(1);
    // The LK2 return target reached the provider, not an arbitrary redirect.
    expect(state.lastCreateBody?.successUrl).toBe('https://lk2.padlhub.su/residency');
    expect(state.lastCreateBody?.failUrl).toBe('https://lk2.padlhub.su/residency?failed=1');

    const replay: ChainJson = await api.create(actor, KEY, {
      mode: 'NEW',
      expectedTotalMinor: 79000,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(state.createCalls).toBe(1);
    await expect(
      api.create(actor, KEY + '-b', { mode: 'NEW', expectedTotalMinor: 79000 }),
    ).rejects.toMatchObject({
      code: 'RESIDENCY_ORDER_ALREADY_PENDING',
      status: 409,
    });
    expect(state.createCalls).toBe(1);

    const pending: ChainJson = await api.reconcile(actor, created.order.orderId, KEY + '-r', {});
    expect(pending.order.state).toBe('PENDING_PAYMENT');

    state.paid = true;
    const paid: ChainJson = await api.reconcile(actor, created.order.orderId, KEY + '-p', {
      eventId: 'evt-paid',
    });
    expect(paid.order.state).toBe('ACTIVE');
    expect(paid.order.residency.validUntil).toBe(ACTIVE_TO);
    expect(paid.order.recovery.state).toBe('NONE');

    const duplicate: ChainJson = await api.reconcile(actor, created.order.orderId, KEY + '-d', {
      eventId: 'evt-paid',
    });
    expect(duplicate.idempotentReplay).toBe(true);
    expect(state.cupCalls).toBe(1);

    // The unresolved lookup finds nothing once the order is active.
    const unresolved: ChainJson = await api.listUnresolved(actor);
    expect(unresolved.count).toBe(0);

    // An early renewal is refused before the transaction, with the eligibility exposed.
    const beforePayment = state.createCalls;
    await expect(
      api.create(actor, KEY + '-e', { mode: 'RENEWAL', expectedTotalMinor: 79000 }),
    ).rejects.toMatchObject({
      code: 'RESIDENCY_RENEWAL_TOO_EARLY',
      status: 409,
      details: { eligibleAt: ACTIVE_TO },
    });
    expect(state.createCalls).toBe(beforePayment);
    const afterCatalog: ChainJson = await api.catalog(actor);
    expect(afterCatalog.renewal.eligible).toBe(false);
    expect(afterCatalog.renewal.eligibleAt).toBe(ACTIVE_TO);
  });

  it('keeps an unknown create outcome unresolved and surfaces recovery', async () => {
    const { state, runtime, actor } = await chain();
    const api = runtime();
    state.createMode = 'throw';
    const created: ChainJson = await api.create(actor, KEY, {
      mode: 'NEW',
      expectedTotalMinor: 79000,
    });
    expect(created.order.state).toBe('PENDING_PAYMENT');
    expect(created.order.payment.status).toBe('UNKNOWN');
    expect(created.order.recovery.state).toBe('UNKNOWN_OUTCOME');
    expect(created.recoveryRequired).toBe(true);
    await expect(
      api.create(actor, KEY + '-b', { mode: 'NEW', expectedTotalMinor: 79000 }),
    ).rejects.toMatchObject({
      code: 'RESIDENCY_ORDER_ALREADY_PENDING',
    });
    const unresolved: ChainJson = await api.listUnresolved(actor);
    expect(unresolved.count).toBe(1);
    expect(unresolved.orders[0].orderId).toBe(created.order.orderId);
    const payment: ChainJson = await api.readPayment(actor, created.order.orderId);
    expect(payment.paymentStatus).toBe('UNKNOWN');
    expect(payment.recovery.state).toBe('UNKNOWN_OUTCOME');
  });

  it('keeps a paid create whose Admin read fails recoverable, then activates the late result', async () => {
    const { state, runtime, actor } = await chain();
    const api = runtime();
    state.createMode = 'unconfirmed';
    const created: ChainJson = await api.create(actor, KEY, {
      mode: 'NEW',
      expectedTotalMinor: 79000,
    });
    expect(created.order.payment.status).toBe('UNKNOWN');
    expect(created.order.recovery.state).toBe('UNKNOWN_OUTCOME');
    state.createMode = 'pending';
    state.paid = true;
    const paid: ChainJson = await api.reconcile(actor, created.order.orderId, KEY + '-r', {});
    expect(paid.order.state).toBe('ACTIVE');
  });

  it('fails closed on an expired delegation, an unavailable owner and a product mismatch', async () => {
    const { state, runtime, actor } = await chain();
    const expired = createResidencyOrderRuntime({
      enabled: true,
      productId: PRODUCT,
      tenantKey: TENANT_KEY,
      client: new ClientResidencyOwnerClient({
        baseUrl: 'https://padlhub.su/',
        environment: 'production',
        timeoutMs: 1_000,
      }),
      token: async () => ({ token: TOKEN, expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    });
    await expect(expired.catalog(actor)).rejects.toMatchObject({
      code: 'RESIDENCY_REAUTH_REQUIRED',
      status: 409,
    });

    state.failOwner = true;
    await expect(runtime().catalog(actor)).rejects.toMatchObject({
      code: 'RESIDENCY_OWNER_UNAVAILABLE',
      status: 503,
    });
    state.failOwner = false;

    await expect(
      runtime('11111111-1111-4111-8111-111111111111').catalog(actor),
    ).rejects.toMatchObject({
      code: 'RESIDENCY_PRODUCT_CONFIG_MISMATCH',
      status: 503,
    });
  });

  it('rejects a tenant the owner does not serve without calling it', async () => {
    const { runtime, actor } = await chain();
    const other = { ...actor, tenantKey: 'othertenant' };
    await expect(runtime().catalog(other)).rejects.toMatchObject({
      code: 'RESIDENCY_TENANT_NOT_SUPPORTED',
      status: 503,
    });
  });
});
