/**
 * Test-only harness: the real LK1 residency lifecycle owner (lk#443 @ adc9c644, imported
 * byte-identical under contracts/imported) behind a synthetic LK2 consumer transport, driven
 * through the real `@phub/api-sdk` client.
 *
 * - Owner code: the real state machine and HTTP contract (routing, Idempotency-Key, error codes).
 * - Synthetic: in-memory order store, Viva/CUP ports, clock, and the LK2 consumer transport. The
 *   LK2 consumer is not implemented yet (DeepSeek); this transport only maps
 *   `/user/api/v1/{tenant}/residency/...` to the owner's `/lk/residency/...` 1:1 as the agreed
 *   contract says, plus the ADR 0027 status read.
 *
 * Nothing here is shipped or contacts a provider. Every value is synthetic.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PadlHubApiClient } from '@phub/api-sdk';

import {
  RESIDENCY_PRODUCT_ID,
  createResidencyLifecycle,
} from '../../../contracts/imported/lk1-residency-lifecycle/adc9c644/residency-lifecycle.mjs';
import { createResidencyLifecycleApi } from '../../../contracts/imported/lk1-residency-lifecycle/adc9c644/residency-lifecycle-http.mjs';
import { moscowDay, type ResidencyGateway } from './residency-purchase.js';

const SNAPSHOT = resolve(process.cwd(), 'contracts/imported/lk1-residency-lifecycle/adc9c644');
/** Fails if the imported owner files differ from the recorded SHA-256 of the reviewed commit. */
export function verifyOwnerSnapshot(): readonly string[] {
  const lines = readFileSync(resolve(SNAPSHOT, 'SOURCE.sha256'), 'utf8').trim().split('\n');
  return lines.map((line) => {
    const [digest, name] = line.split(/\s+/);
    const actual = createHash('sha256')
      .update(readFileSync(resolve(SNAPSHOT, name!)))
      .digest('hex');
    if (actual !== digest) throw new Error('OWNER_SNAPSHOT_CHANGED:' + name);
    return name!;
  });
}

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
export type ConsumerMode = 'ok' | 'absent' | 'disabled' | 'html' | 'forbidden' | 'unauthorized';
type Match = (method: string, path: string) => boolean;

export interface TransportLog {
  readonly method: string;
  readonly path: string;
  readonly key: string | null;
  readonly status: number | 'network';
}

/** A synthetic world: the owner, its ports and the LK2 transport for any number of users. */
export function createOwnerWorld(
  init: { readonly now?: number; readonly priceMinor?: number } = {},
) {
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
    store: memoryStore(),
  };
  let txnSeq = 0;
  const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

  const setResidency = (userId: string, r: Residency) => {
    world.residency.set(userId, r);
    if (!world.lk2ReadLags) world.lk2Read.set(userId, r);
  };

  const lifecycleFor = () =>
    createResidencyLifecycle({
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
          const current = world.residency.get(userId);
          // CUP extends from the current end when a residency is active (the owner's renewal
          // guard), otherwise the window starts at the payment.
          const from =
            current?.state === 'ACTIVE' && current.validUntil
              ? Date.parse(current.validUntil)
              : paidAt;
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
    const record = (status: number | 'network') => world.log.push({ method, path, key, status });
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
    const response = await owner.handle({
      method,
      path: '/lk' + path,
      headers,
      body: typeof initArg?.body === 'string' ? initArg.body : undefined,
      actor: { tenantId: OWNER_TENANT, userId },
    });
    if (world.dropResponse?.(method, path)) {
      // The owner committed the command; only the response is lost on the way back.
      record('network');
      throw new TypeError('Failed to fetch');
    }
    record(response.statusCode);
    const body =
      response.statusCode >= 400
        ? { ...(response.body as object), correlationId: 'corr-synthetic' }
        : response.body;
    return json(response.statusCode, body);
  };

  return {
    world,
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
        createResidencyOrder: (mode, key) => client.createResidencyOrder(mode, key),
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
