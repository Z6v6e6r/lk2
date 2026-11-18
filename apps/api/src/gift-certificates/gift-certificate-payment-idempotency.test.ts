/**
 * QA scenario 4 — payment command idempotency (Idempotency-Key replay).
 *
 * Write path under test: `POST /user/api/v1/:tenantKey/gift-certificate-orders/:orderId/payment-intents`
 * -> `GiftCertificateSaleRepository.createPayment()` (apps/api/src/gift-certificates/
 * gift-certificate-sale-routes.ts:443-483). The route is a credential-free shell: it requires an
 * Idempotency-Key plus session-scoped access, derives a request hash from the principal and the
 * order, forwards both to the repository, and maps the repository's outcomes to 201 / 200 / 409.
 *
 * The route module is registered on a bare Fastify instance (the same style as
 * apps/api/src/residency/client-residency-routes.test.ts) instead of the full app builder, so this
 * test runs without DATABASE_URL, Redis, or the MongoDB-backed legacy adapter.
 *
 * Evidence level: UNIT-LEVEL. The fake repository implements the replay/conflict contract the real
 * repository persists (`GIFT_PAYMENT_IDEMPOTENCY_CONFLICT`, `intent.replayed`). It proves the route
 * keeps one key, never mints a second charge on replay, and never accepts a mutated payload under a
 * reused key. It does NOT prove the single durable attempt row — that needs PostgreSQL and is
 * BLOCKED in this environment (no local database).
 */
import type { GiftCertificateSaleRepository } from '@phub/database';
import type { GiftCertificatePaymentIntent } from '@phub/gift-certificates';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGiftCertificateSaleRoutes } from './gift-certificate-sale-routes.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const orderId = '55555555-5555-4555-8555-555555555555';
const paymentId = '66666666-6666-4666-8666-666666666666';
const KEY = 'gift-payment-idempotency-0001';

const intent = {
  payment: {
    id: paymentId,
    orderId,
    provider: 'PADLHUB_SANDBOX',
    status: 'PENDING',
    amountMinor: 500_000,
    currency: 'RUB',
    createdAt: '2026-11-18T09:00:00.000Z',
    confirmedAt: null,
  },
  nextAction: {
    type: 'REDIRECT',
    url: `/user/api/v1/local-padel/gift-certificate-payment-sandbox/${paymentId}`,
  },
  replayed: false,
} satisfies GiftCertificatePaymentIntent;

const instances: FastifyInstance[] = [];

function authenticated(request: FastifyRequest): Promise<void> {
  (request as unknown as { tenantId: string }).tenantId = tenantId;
  (request as unknown as { padlHubClaims: unknown }).padlHubClaims = {
    sub: userId,
    roles: [],
    permissions: [],
  };
  return Promise.resolve();
}

function repository() {
  const createPayment = vi.fn<GiftCertificateSaleRepository['createPayment']>();
  return {
    value: {
      createOrder: vi.fn<GiftCertificateSaleRepository['createOrder']>(),
      getOrder: vi.fn<GiftCertificateSaleRepository['getOrder']>(),
      createPayment,
      confirmSandboxPayment: vi.fn<GiftCertificateSaleRepository['confirmSandboxPayment']>(),
    } satisfies GiftCertificateSaleRepository,
    createPayment,
  };
}

function appWith(repositoryValue: GiftCertificateSaleRepository): FastifyInstance {
  const app = Fastify({ genReqId: () => 'qa-correlation' });
  registerGiftCertificateSaleRoutes(app, {
    repository: repositoryValue,
    artifactsEnabled: false,
    sandboxEnabled: true,
    purchaseSecret: 'qa-purchase-secret-at-least-32-characters',
    secureCookies: false,
    publicTenantHandlers: [authenticated],
    publicCommandHandlers: [authenticated],
    authenticatedTenantHandlers: [authenticated],
    authenticatedCommandHandlers: [authenticated],
  });
  instances.push(app);
  return app;
}

function payPath(order: string = orderId, tenant = 'local-padel'): string {
  return `/user/api/v1/${tenant}/gift-certificate-orders/${order}/payment-intents`;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('scenario 4: Idempotency-Key replay returns the stored result', () => {
  it('creates on the first call and replays the same intent on the second', async () => {
    const repo = repository();
    repo.createPayment
      .mockResolvedValueOnce({ outcome: 'applied', intent: { ...intent, replayed: false } })
      .mockResolvedValueOnce({ outcome: 'applied', intent: { ...intent, replayed: true } });
    const app = appWith(repo.value);

    const first = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': KEY },
    });
    const second = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': KEY },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false, payment: { id: paymentId } });
    expect(second.json()).toMatchObject({ replayed: true, payment: { id: paymentId } });
    // Same durable payment on both calls: the replay did not mint a second charge.
    const firstBody = first.json<GiftCertificatePaymentIntent>();
    const secondBody = second.json<GiftCertificatePaymentIntent>();
    expect(firstBody.payment.id).toBe(secondBody.payment.id);
    // The key reached the repository unchanged both times.
    expect(repo.createPayment.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      KEY,
      KEY,
    ]);
    // A replay and its original carry the same request hash: nothing about the command changed.
    expect(repo.createPayment.mock.calls[0]?.[0].requestHash).toBe(
      repo.createPayment.mock.calls[1]?.[0].requestHash,
    );
    // The repository — the only writer — was invoked exactly once per HTTP call, never doubled.
    expect(repo.createPayment).toHaveBeenCalledTimes(2);
  });

  it('rejects a differing payload under the same key with 409 and no second charge', async () => {
    const repo = repository();
    repo.createPayment
      .mockResolvedValueOnce({ outcome: 'applied', intent })
      .mockResolvedValueOnce({ outcome: 'idempotency_conflict' });
    const app = appWith(repo.value);

    const created = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': KEY },
    });
    const conflicting = await app.inject({
      method: 'POST',
      url: payPath('77777777-7777-4777-8777-777777777777'),
      headers: { 'idempotency-key': KEY },
    });

    expect(created.statusCode).toBe(201);
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ code: 'GIFT_PAYMENT_IDEMPOTENCY_CONFLICT' });
    // A conflicting replay performed no second write.
    expect(repo.createPayment).toHaveBeenCalledTimes(2);
    expect(conflicting.json()).not.toHaveProperty('payment');
  });

  it('refuses a payment command without an Idempotency-Key and never calls the repository', async () => {
    const repo = repository();
    const app = appWith(repo.value);
    const response = await app.inject({ method: 'POST', url: payPath() });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).not.toBe(500);
    expect(repo.createPayment).not.toHaveBeenCalled();
  });

  it('maps an unknown order and an unpayable order to stable client errors, not 500', async () => {
    const repo = repository();
    repo.createPayment
      .mockResolvedValueOnce({ outcome: 'order_not_found' })
      .mockResolvedValueOnce({ outcome: 'order_not_payable' });
    const app = appWith(repo.value);

    const missing = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': `${KEY}-a` },
    });
    const notPayable = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': `${KEY}-b` },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'GIFT_ORDER_NOT_FOUND' });
    expect(notPayable.statusCode).toBe(409);
    expect(notPayable.json()).toMatchObject({ code: 'GIFT_ORDER_NOT_PAYABLE' });
  });
});
