/**
 * LOCAL composed chain: real screen/SDK → #684 routes/runtime/HTTP client → #443 HTTP/domain.
 * Pinned source bytes are checked in residency-owner.test-helper.ts. Fastify inject replaces
 * the physical network; credential issuance/auth middleware, store, clock, status read and
 * Viva/CUP ports are synthetic. No live provider calls. This helper is test-only.
 */
import Fastify from 'fastify';
import { ClientResidencyOwnerClient } from '../../../contracts/imported/lk2-residency-consumer/965efa79/client-residency-owner-client.js';
import { createResidencyOrderRuntime } from '../../../contracts/imported/lk2-residency-consumer/965efa79/client-residency-order-runtime.js';
import { registerClientResidencyOrderRoutes } from '../../../contracts/imported/lk2-residency-consumer/965efa79/client-residency-order-routes.js';
import { PadlHubApiClient } from '@phub/api-sdk';

import {
  RESIDENCY_PRODUCT_ID,
  createResidencyLifecycle,
} from '../../../contracts/imported/lk1-residency-lifecycle/93692e64/residency-lifecycle.mjs';
import { createResidencyLifecycleApi } from '../../../contracts/imported/lk1-residency-lifecycle/93692e64/residency-lifecycle-http.mjs';
import { moscowDay, type ResidencyGateway } from './residency-purchase.js';

export const SYNTHETIC_BASE = 'https://lk2.synthetic.test';
export const SYNTHETIC_TENANT_KEY = 'synthetic';
const OWNER_TENANT = 'synthetic-tenant';
const UNRESOLVED = [
  'PENDING_PAYMENT',
  'PAID',
  'PAID_ACTIVATION_PENDING',
  'ACTIVATION_FAILED',
  'PAID_REQUIRES_REVIEW',
];
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Row = Record<string, unknown> & {
  orderId: string;
  tenantId: string;
  userId: string;
  idempotencyKeyHash: string;
  revision: number;
  state: string;
  activeSlot?: number;
  payment: { expiresAt?: string | null };
};

/** The owner's own in-memory store semantics (lk#443 tests), incl. the active-slot guard. */
function memoryStore() {
  const orders = new Map<string, Row>();
  return {
    orders,
    findOrderByKey(tenantId: string, keyHash: string) {
      return Promise.resolve(
        [...orders.values()].find(
          (o) => o.tenantId === tenantId && o.idempotencyKeyHash === keyHash,
        ) ?? null,
      );
    },
    insertOrder(order: Row) {
      const all = [...orders.values()];
      if (
        orders.has(order.orderId) ||
        all.some(
          (o) => o.tenantId === order.tenantId && o.idempotencyKeyHash === order.idempotencyKeyHash,
        ) ||
        (order.activeSlot === 1 &&
          all.some(
            (o) => o.tenantId === order.tenantId && o.userId === order.userId && o.activeSlot === 1,
          ))
      )
        return Promise.resolve({ ok: false });
      orders.set(order.orderId, structuredClone(order));
      return Promise.resolve({ ok: true });
    },
    getOrder(tenantId: string, userId: string, orderId: string) {
      const row = orders.get(orderId);
      if (!row || row.tenantId !== tenantId || row.userId !== userId) return Promise.resolve(null);
      return Promise.resolve(structuredClone(row));
    },
    updateOrder(tenantId: string, orderId: string, expectedRevision: number, next: Row) {
      const row = orders.get(orderId);
      if (!row || row.tenantId !== tenantId || row.revision !== expectedRevision)
        return Promise.resolve({ ok: false });
      orders.set(orderId, structuredClone(next));
      return Promise.resolve({ ok: true });
    },
    findUnresolvedOrder(tenantId: string, userId: string) {
      return Promise.resolve(
        [...orders.values()].find(
          (o) => o.tenantId === tenantId && o.userId === userId && UNRESOLVED.includes(o.state),
        ) ?? null,
      );
    },
    listUnresolvedOrders(tenantId: string, userId: string) {
      return Promise.resolve(
        [...orders.values()]
          .filter((o) => o.tenantId === tenantId && o.userId === userId && o.activeSlot === 1)
          .map((o) => structuredClone(o)),
      );
    },
    listExpiredPending(tenantId: string, nowIso: string) {
      return Promise.resolve(
        [...orders.values()]
          .filter(
            (o) =>
              o.tenantId === tenantId &&
              o.state === 'PENDING_PAYMENT' &&
              typeof o.payment.expiresAt === 'string' &&
              o.payment.expiresAt <= nowIso,
          )
          .map((o) => structuredClone(o)),
      );
    },
  };
}

export interface Residency {
  state: 'NONE' | 'ACTIVE' | 'UNAVAILABLE';
  validFrom?: string;
  validUntil?: string;
}
export type ConsumerMode =
  'ok' | 'absent' | 'disabled' | 'html' | 'forbidden' | 'unauthorized' | 'reauth';
type Match = (method: string, path: string) => boolean;

export interface TransportLog {
  readonly method: string;
  readonly path: string;
  readonly key: string | null;
  readonly body: unknown;
  readonly status: number | 'network';
}

/** A synthetic world: the owner, its ports and the LK2 transport for any number of users. */
export function createOwnerWorld(init: {
  readonly now?: number;
  readonly priceMinor?: number;
  /** Synchronous SHA-256 hex (Node `crypto` in tests; any deterministic digest in QA). */
  readonly sha256: (value: string) => string;
}) {
  const world = {
    now: init.now ?? Date.parse('2026-11-18T09:00:00.000Z'),
    priceMinor: init.priceMinor ?? 79_000,
    termDays: 30,
    /** Provider truth per transaction. */
    bank: new Map<string, { status: 'PENDING' | 'PAID' | 'FAILED'; paidAt?: string }>(),
    /** The provider create never answers: the owner cannot know whether a payment exists. */
    providerCreateLost: false,
    /** CUP refuses activation of a paid order (owner moves it to ACTIVATION_FAILED). */
    activationRejects: false,
    /** Residency truth at CUP per user, and the LK2 read (which may lag behind it). */
    residency: new Map<string, Residency>(),
    lk2Read: new Map<string, Residency>(),
    lk2ReadLags: false,
    consumer: 'ok' as ConsumerMode,
    dropResponse: null as Match | null,
    failBeforeOwner: null as Match | null,
    gate: null as ((method: string, path: string) => Promise<void>) | null,
    log: [] as TransportLog[],
    providerCreates: 0,
    reauthorizations: 0,
    store: memoryStore(),
  };
  let txnSeq = 0;
  const sha256 = init.sha256;

  const setResidency = (userId: string, r: Residency) => {
    world.residency.set(userId, r);
    if (!world.lk2ReadLags) world.lk2Read.set(userId, r);
  };

  const lifecycleFor = () =>
    createResidencyLifecycle({
      config: {
        returnTargets: {
          widget: {
            successUrl: 'https://widget.example.test/',
            failUrl: 'https://widget.example.test/',
          },
          lk2: {
            successUrl: 'https://lk2.synthetic.test/residency',
            failUrl: 'https://lk2.synthetic.test/residency',
          },
        },
      },
      clock: { now: () => world.now },
      ids: {
        orderId: (tenantId: string, keyHash: string) => {
          const h = sha256(tenantId + keyHash);
          return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
        },
        eventId: () => 'event-' + String(++txnSeq),
      },
      sha256,
      store: world.store,
      catalog: {
        read: () =>
          Promise.resolve({
            productId: RESIDENCY_PRODUCT_ID,
            title: 'Резидентство (синтетика)',
            termDays: world.termDays,
            priceMinor: world.priceMinor,
            currency: 'RUB',
            benefits: [{ code: 'GAME', percent: 30 }],
            renewalEligible: false,
            checkedAt: iso(world.now - 60_000),
          }),
      },
      discounts: {
        quote: ({ baseAmountMinor }: { baseAmountMinor: number }) =>
          Promise.resolve({ discountLines: [], totalMinor: baseAmountMinor }),
      },
      status: {
        read: ({ userId }: { userId: string }) => {
          const r = world.residency.get(userId) ?? { state: 'NONE' };
          if (r.state === 'UNAVAILABLE') return Promise.reject(new Error('CUP down'));
          return Promise.resolve({
            ...r,
            source: 'CUP_RESIDENCY_POLICY',
            observedAt: iso(world.now),
          });
        },
      },
      payments: {
        create: ({ amountMinor }: { amountMinor: number }) => {
          world.providerCreates += 1;
          if (world.providerCreateLost) return Promise.reject(new Error('provider timeout'));
          const id = 'txn-' + String(++txnSeq);
          world.bank.set(id, { status: 'PENDING' });
          return Promise.resolve({
            status: 'PENDING',
            providerTransactionId: id,
            paymentUrl: 'https://bank.example.test/pay/' + id,
            amountMinor,
            expiresAt: iso(world.now + 20 * 60_000),
          });
        },
        read: ({
          providerTransactionId,
          amountMinor,
        }: {
          providerTransactionId: string;
          amountMinor: number;
        }) => {
          const t = world.bank.get(providerTransactionId);
          if (!t) return Promise.resolve({ status: 'UNKNOWN' });
          return Promise.resolve({
            status: t.status,
            amountMinor,
            providerTransactionId,
            ...(t.paidAt ? { paidAt: t.paidAt } : {}),
            ...(t.status === 'PENDING'
              ? {
                  paymentUrl: 'https://bank.example.test/pay/' + providerTransactionId,
                  expiresAt: iso(world.now + 20 * 60_000),
                }
              : {}),
          });
        },
      },
      activation: {
        findInstance: ({ providerTransactionId }: { providerTransactionId: string }) => {
          const t = world.bank.get(providerTransactionId);
          return Promise.resolve(
            t?.status === 'PAID'
              ? { clientSubscriptionId: 'sub-' + providerTransactionId, purchasedAt: t.paidAt }
              : null,
          );
        },
        activate: ({
          userId,
          providerTransactionId,
        }: {
          userId: string;
          providerTransactionId: string;
        }) => {
          if (world.activationRejects)
            return Promise.resolve({ state: 'REJECTED', reason: 'SYNTHETIC_REJECTED' });
          const paidAt = Date.parse(
            world.bank.get(providerTransactionId)?.paidAt ?? iso(world.now),
          );
          const from = paidAt;
          const until = from + world.termDays * DAY_MS;
          setResidency(userId, { state: 'ACTIVE', validFrom: iso(from), validUntil: iso(until) });
          return Promise.resolve({
            state: 'ACTIVE',
            validFrom: iso(from),
            validUntil: iso(until),
            source: 'CUP_RESIDENCY_POLICY',
            observedAt: iso(world.now),
          });
        },
      },
    });

  const owner = createResidencyLifecycleApi({ createLifecycle: lifecycleFor, allowOrigin: '*' });

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  // Actual #684 HTTP routes, runtime validation, delegation boundary and owner HTTP client.
  // Only credential issuance/auth middleware and the physical network are synthetic.
  const consumerClient = new ClientResidencyOwnerClient({
    baseUrl: 'https://owner.synthetic.test/',
    environment: 'development',
    timeoutMs: 10000,
    fetchImplementation: async (input, request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const headers = Object.fromEntries(new Headers(request?.headers).entries());
      const userId = headers.authorization!.slice('Bearer synthetic-owner-token:'.length);
      const response = await owner.handle({
        method: request?.method ?? 'GET',
        path: url.pathname + url.search,
        headers,
        body: request?.body,
        actor: { tenantId: OWNER_TENANT, userId },
      });
      return json(response.statusCode, response.body);
    },
  });
  const app = Fastify();
  const runtime = createResidencyOrderRuntime({
    enabled: true,
    productId: RESIDENCY_PRODUCT_ID,
    tenantKey: SYNTHETIC_TENANT_KEY,
    client: consumerClient,
    token: (actor) =>
      world.consumer === 'reauth'
        ? Promise.reject(Object.assign(new Error('expired'), { code: 'VIVA_REAUTH_REQUIRED' }))
        : Promise.resolve({
            token: 'synthetic-owner-token:' + actor.userId,
            expiresAt: iso(Date.now() + 3600000),
          }),
  });
  registerClientResidencyOrderRoutes(app, { runtime, readHandlers: [], commandHandlers: [] });
  app.addHook('onRequest', (request, _reply, done) => {
    Object.assign(request, {
      tenantId: OWNER_TENANT,
      padlHubClaims: {
        sub: request.headers.authorization?.slice('Bearer synthetic-token:'.length),
        sid: 'synthetic-session',
        roles: ['client'],
      },
    });
    done();
  });

  /** LK2 status read (ADR 0027): calendar days, complete-read timestamp, no Viva payload. */
  const lk2Status = (userId: string) => {
    const r = world.lk2Read.get(userId) ?? { state: 'NONE' };
    if (r.state === 'UNAVAILABLE')
      return {
        state: 'UNAVAILABLE',
        validFrom: null,
        validUntil: null,
        checkedAt: null,
        unavailableReason: 'SOURCE_TIMEOUT',
        holder: null,
      };
    return {
      state: r.state,
      validFrom: r.validFrom ? moscowDay(r.validFrom) : null,
      validUntil: r.validUntil ? moscowDay(r.validUntil) : null,
      checkedAt: iso(world.now),
      unavailableReason: null,
      holder: null,
    };
  };

  const fetchImplementation: typeof fetch = async (input, initArg) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (initArg?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((initArg?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const root = `/user/api/v1/${SYNTHETIC_TENANT_KEY}`;
    const path = url.pathname.startsWith(root) ? url.pathname.slice(root.length) : url.pathname;
    const key = headers['idempotency-key'] ?? null;
    const record = (status: number | 'network') =>
      world.log.push({
        method,
        path,
        key,
        status,
        body: typeof initArg?.body === 'string' ? (JSON.parse(initArg.body) as unknown) : null,
      });
    const bearer = /^Bearer synthetic-token:(.+)$/.exec(headers.authorization ?? '');
    if (!bearer || world.consumer === 'unauthorized') {
      record(401);
      return json(401, { code: 'AUTH_REQUIRED', message: 'auth', correlationId: 'corr-synthetic' });
    }
    const userId = bearer[1]!;
    if (world.consumer === 'html') {
      // A wrong path served by the Web SPA fallback: 200 with an HTML shell, not JSON.
      record(200);
      return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (method === 'GET' && path === '/residency') {
      record(200);
      return json(200, lk2Status(userId));
    }
    if (!path.startsWith('/residency/')) {
      record(404);
      return json(404, { code: 'NOT_FOUND', message: 'route', correlationId: 'corr-synthetic' });
    }
    const refusal: Partial<Record<ConsumerMode, [number, string]>> = {
      absent: [404, 'NOT_FOUND'],
      disabled: [503, 'RESIDENCY_ORDERS_DISABLED'],
      forbidden: [403, 'FORBIDDEN'],
    };
    const refused = refusal[world.consumer];
    if (refused) {
      record(refused[0]);
      return json(refused[0], {
        code: refused[1],
        message: 'consumer',
        correlationId: 'corr-synthetic',
      });
    }
    if (world.failBeforeOwner?.(method, path)) {
      record('network');
      throw new TypeError('Failed to fetch');
    }
    if (world.gate) await world.gate(method, path);
    const response = await app.inject({
      method: method as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers,
      ...(typeof initArg?.body === 'string' ? { payload: initArg.body } : {}),
    });
    if (world.dropResponse?.(method, path)) {
      // The owner committed the command; only the response is lost on the way back.
      record('network');
      throw new TypeError('Failed to fetch');
    }
    record(response.statusCode);
    const body =
      response.statusCode >= 400
        ? { ...response.json<Record<string, unknown>>(), correlationId: 'corr-synthetic' }
        : response.json<unknown>();
    return json(response.statusCode, body);
  };

  return {
    world,
    close: () => app.close(),
    setResidency,
    /** Lets the LK2 read catch up with CUP. */
    syncLk2Read(userId: string) {
      const r = world.residency.get(userId);
      if (r) world.lk2Read.set(userId, r);
    },
    /** The bank confirms (or declines) the latest transaction. */
    bankSettles(status: 'PAID' | 'FAILED') {
      const last = [...world.bank.keys()].at(-1);
      if (!last) throw new Error('no transaction');
      world.bank.set(last, { status, ...(status === 'PAID' ? { paidAt: iso(world.now) } : {}) });
    },
    ordersOf(userId: string) {
      return [...world.store.orders.values()].filter((o) => o.userId === userId);
    },
    fetchImplementation,
    /** The real SDK client with the real auth header shape for one synthetic user. */
    gateway(userId: string, principal: () => string | null = () => 'epoch:' + userId) {
      const client = new PadlHubApiClient({
        baseUrl: SYNTHETIC_BASE,
        tenantKey: SYNTHETIC_TENANT_KEY,
        initialAccessToken: 'synthetic-token:' + userId,
        platform: 'web',
        appVersion: 'test',
        sessionMode: 'memory',
        fetchImplementation,
      });
      const opened: string[] = [];
      const gateway: ResidencyGateway = {
        residencyPrincipal: principal,
        getClientResidency: () => client.getClientResidency(),
        getResidencyCatalog: () => client.getResidencyCatalog(),
        createResidencyOrder: (input, key) => client.createResidencyOrder(input, key),
        listUnresolvedResidencyOrders: () => client.listUnresolvedResidencyOrders(),
        reauthorizeResidency: () => {
          world.reauthorizations += 1;
          return Promise.resolve();
        },
        getResidencyOrder: (id) => client.getResidencyOrder(id),
        getResidencyOrderPayment: (id) => client.getResidencyOrderPayment(id),
        reconcileResidencyOrder: (id, key) => client.reconcileResidencyOrder(id, key),
        cancelResidencyOrder: (id, key) => client.cancelResidencyOrder(id, key),
        openResidencyPayment: (url) => {
          opened.push(url);
        },
      };
      return { gateway, opened, client };
    },
  };
}
export type OwnerHarness = ReturnType<typeof createOwnerWorld>;
