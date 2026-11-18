/**
 * QA scenario 4 — payment idempotency at the FULL application boundary.
 *
 * The app under test is the real one (`buildAppWithActiveSession` → `apps/api/src/app.ts`), so the
 * pre-handler chains are the production chains rather than test substitutes:
 *   public surface → [resolvePublicTenant, requireIdempotencyKey]
 *   user   surface → [authenticate, resolveTenant, requireIdempotencyKey]
 * `apps/api/src/app.ts` passes exactly those arrays into `registerGiftCertificateSaleRoutes`
 * (`publicCommandHandlers` / `authenticatedCommandHandlers`), and `requireIdempotencyKey`
 * (`apps/api/src/app.ts:588`) answers `400 IDEMPOTENCY_KEY_REQUIRED` for a missing or malformed key.
 *
 * Correction of the earlier QA finding D-3 ("a missing Idempotency-Key answers 404
 * GIFT_ORDER_NOT_FOUND"): that conclusion came from a module-level harness that registered the sale
 * routes on a bare Fastify instance with `[authenticated]` as the command chain. That replaced the
 * real guard, so the handler's own `!operationKey` branch answered 404. With the production chain the
 * guard rejects the request before the handler runs and neither the repository nor a provider is
 * touched. The assertions below pin the exact status and error code — never `status >= 400`.
 *
 * Write path under test: `POST /{surface}/api/v1/:tenantKey/gift-certificate-orders/:orderId/
 * payment-intents` → `GiftCertificateSaleRepository.createPayment()` (apps/api/src/gift-certificates/
 * gift-certificate-sale-routes.ts:443-483).
 *
 * Evidence level: LOCAL, application-level. The fake repository implements the replay/conflict
 * contract that the real repository persists. It proves the route keeps one key per command, never
 * mints a second charge on replay, never accepts a mutated payload under a reused key, and that the
 * key guard runs first. It does NOT prove the single durable attempt row — that needs PostgreSQL and
 * is recorded as BLOCKED for this scenario.
 */
import type { GiftCertificateSaleRepository } from '@phub/database';
import { loadConfig } from '@phub/config';
import type { GiftCertificatePaymentIntent } from '@phub/gift-certificates';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const tenantKey = 'local-padel';
const userId = '22222222-2222-4222-8222-222222222222';
const orderId = '55555555-5555-4555-8555-555555555555';
const paymentId = '66666666-6666-4666-8666-666666666666';
const KEY = 'gift-payment-idempotency-0001';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

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
    url: `/public/api/v1/${tenantKey}/gift-certificate-payment-sandbox/${paymentId}`,
  },
  replayed: false,
} satisfies GiftCertificatePaymentIntent;

function fakePool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }),
  } as unknown as Pool;
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

async function appWith(repositoryValue: GiftCertificateSaleRepository, sandbox = true) {
  const config = loadConfig({
    ...baseEnvironment,
    ...(sandbox ? { GIFT_CERTIFICATE_PAYMENT_MODE: 'sandbox' } : {}),
  });
  const app = await buildApp({
    config,
    logger: createLogger('gift-payment-idempotency-test', 'silent'),
    pool: fakePool(),
    giftCertificateSaleRepository: repositoryValue,
  });
  apps.push(app);
  return { app, config };
}

async function accessToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    // `authenticateForAudience` rejects a token whose roles/permissions are not string arrays
    // (apps/api/src/app.ts:622-637), so a "valid session" token must carry both claims.
    roles: [],
    permissions: [],
    sid: '77777777-7777-4777-8777-777777777777',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function payPath(surface: 'public' | 'user' = 'public', order = orderId): string {
  return `/${surface}/api/v1/${tenantKey}/gift-certificate-orders/${order}/payment-intents`;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('scenario 4: the real command chain requires a valid Idempotency-Key', () => {
  it.each(['public', 'user'] as const)(
    'rejects a %s payment command without a key with 400 IDEMPOTENCY_KEY_REQUIRED',
    async (surface) => {
      const repo = repository();
      const { app, config } = await appWith(repo.value);
      const headers: Record<string, string> =
        surface === 'user' ? { authorization: `Bearer ${await accessToken(config)}` } : {};

      const response = await app.inject({ method: 'POST', url: payPath(surface), headers });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      // The guard runs before the handler, so no durable or provider work can happen.
      expect(repo.createPayment).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['too short', 'short'],
    ['illegal characters', 'not a valid key!!'],
    ['longer than 128 characters', 'k'.repeat(129)],
  ])('rejects a key that is %s with 400 IDEMPOTENCY_KEY_REQUIRED', async (_label, key) => {
    const repo = repository();
    const { app } = await appWith(repo.value);

    const response = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': key },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(repo.createPayment).not.toHaveBeenCalled();
  });
});

describe('scenario 4: Idempotency-Key replay returns the stored result', () => {
  it('creates on the first call and replays the same intent on the second', async () => {
    const repo = repository();
    repo.createPayment
      .mockResolvedValueOnce({ outcome: 'applied', intent: { ...intent, replayed: false } })
      .mockResolvedValueOnce({ outcome: 'applied', intent: { ...intent, replayed: true } });
    const { app, config } = await appWith(repo.value);
    const authorization = `Bearer ${await accessToken(config)}`;

    const first = await app.inject({
      method: 'POST',
      url: payPath('user'),
      headers: { 'idempotency-key': KEY, authorization },
    });
    const second = await app.inject({
      method: 'POST',
      url: payPath('user'),
      headers: { 'idempotency-key': KEY, authorization },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false, payment: { id: paymentId } });
    expect(second.json()).toMatchObject({ replayed: true, payment: { id: paymentId } });
    // Same durable payment on both calls: the replay did not mint a second charge.
    expect(first.json<GiftCertificatePaymentIntent>().payment.id).toBe(
      second.json<GiftCertificatePaymentIntent>().payment.id,
    );
    // The key reached the repository unchanged on both calls.
    expect(repo.createPayment.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      KEY,
      KEY,
    ]);
    // A replay and its original carry the same request hash: nothing about the command changed.
    expect(repo.createPayment.mock.calls[0]?.[0].requestHash).toBe(
      repo.createPayment.mock.calls[1]?.[0].requestHash,
    );
    // One repository call per HTTP call, never doubled.
    expect(repo.createPayment).toHaveBeenCalledTimes(2);
  });

  it('rejects a differing payload under the same key with 409 and no second charge', async () => {
    const repo = repository();
    repo.createPayment
      .mockResolvedValueOnce({ outcome: 'applied', intent })
      .mockResolvedValueOnce({ outcome: 'idempotency_conflict' });
    const { app, config } = await appWith(repo.value);
    const authorization = `Bearer ${await accessToken(config)}`;

    const created = await app.inject({
      method: 'POST',
      url: payPath('user'),
      headers: { 'idempotency-key': KEY, authorization },
    });
    const conflicting = await app.inject({
      method: 'POST',
      url: payPath('user', '77777777-7777-4777-8777-777777777777'),
      headers: { 'idempotency-key': KEY, authorization },
    });

    expect(created.statusCode).toBe(201);
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ code: 'GIFT_PAYMENT_IDEMPOTENCY_CONFLICT' });
    expect(repo.createPayment).toHaveBeenCalledTimes(2);
    expect(conflicting.json()).not.toHaveProperty('payment');
  });

  it('maps an unknown order and an unpayable order to stable client errors, not 500', async () => {
    const repo = repository();
    repo.createPayment
      .mockResolvedValueOnce({ outcome: 'order_not_found' })
      .mockResolvedValueOnce({ outcome: 'order_not_payable' });
    const { app, config } = await appWith(repo.value);
    const authorization = `Bearer ${await accessToken(config)}`;

    const missing = await app.inject({
      method: 'POST',
      url: payPath('user'),
      headers: { 'idempotency-key': `${KEY}-a`, authorization },
    });
    const notPayable = await app.inject({
      method: 'POST',
      url: payPath('user'),
      headers: { 'idempotency-key': `${KEY}-b`, authorization },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'GIFT_ORDER_NOT_FOUND' });
    expect(notPayable.statusCode).toBe(409);
    expect(notPayable.json()).toMatchObject({ code: 'GIFT_ORDER_NOT_PAYABLE' });
  });

  it('still answers 503 GIFT_PAYMENT_SANDBOX_DISABLED for a valid key when sandbox is off', async () => {
    const repo = repository();
    const { app } = await appWith(repo.value, false);

    const response = await app.inject({
      method: 'POST',
      url: payPath(),
      headers: { 'idempotency-key': 'gift-payment-sandbox-off-0001' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'GIFT_PAYMENT_SANDBOX_DISABLED' });
    expect(repo.createPayment).not.toHaveBeenCalled();
  });
});
