import Fastify, { type FastifyRequest } from 'fastify';
import { it, expect, vi } from 'vitest';
import { registerMonthlyPurchaseRoutes } from './monthly-purchase-routes.js';
import type { MonthlyPurchaseRuntime } from './monthly-purchase-runtime.js';
import {
  monthlyActor,
  monthlyConsent,
  monthlyQuote,
} from '../../../../packages/domain/src/subscription-purchase.test-fixture.js';
const prefix = '/user/api/v1/iSkq6G/subscription-purchase-operations',
  key = 'fixture-original-key';
function setup(enabled = true) {
  const app = Fastify();
  const runtime = {
    capability: vi.fn(
      async () => await Promise.resolve({ contractVersion: 1, available: true, offers: [] }),
    ),
    quote: vi.fn(async () => await Promise.resolve({ operationId: monthlyQuote().operationId })),
    purchase: vi.fn(async () => await Promise.resolve({ status: 'UNKNOWN' })),
    read: vi.fn(async () => await Promise.resolve(null)),
    reconcile: vi.fn(async () => await Promise.resolve({ status: 'UNKNOWN' })),
    launch: vi.fn(async () => await Promise.resolve({})),
    consumeLaunch: vi.fn(async () => await Promise.resolve('https://bank.example.com/pay')),
  };
  const auth = async (r: FastifyRequest) => {
    const x = r as FastifyRequest & { tenantId: string; padlHubClaims: unknown };
    if (r.headers.authorization === 'Bearer fixture') {
      x.tenantId = monthlyActor.tenantId;
      x.padlHubClaims = {
        sub: monthlyActor.userId,
        sid: monthlyActor.sessionId,
        tenants: [monthlyActor.tenantId],
        permissions: [],
        roles: r.headers['x-fixture-role'] === 'admin' ? ['admin'] : ['client'],
      };
    }
    await Promise.resolve();
  };
  registerMonthlyPurchaseRoutes(app, {
    ...(enabled ? { runtime: runtime as unknown as MonthlyPurchaseRuntime } : {}),
    readHandlers: [auth],
    commandHandlers: [auth],
  });
  return { app, runtime };
}
it('default-off capability and client-role authorization fail closed without owner calls', async () => {
  const { app, runtime } = setup(false);
  try {
    expect((await app.inject({ url: prefix + '/capability' })).statusCode).toBe(401);
    const off = await app.inject({
      url: prefix + '/capability',
      headers: { authorization: 'Bearer fixture' },
    });
    expect(off.json()).toEqual({ contractVersion: 1, available: false, offers: [] });
    expect(off.headers['cache-control']).toBe('no-store');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: prefix,
          headers: {
            authorization: 'Bearer fixture',
            'idempotency-key': key,
            'x-fixture-role': 'admin',
          },
          payload: monthlyConsent(),
        })
      ).statusCode,
    ).toBe(403);
    expect(runtime.purchase).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('closed purchase body, key and query reject manipulation; valid original consent reaches one owner call', async () => {
  const { app, runtime } = setup();
  const headers = { authorization: 'Bearer fixture', 'idempotency-key': key };
  try {
    for (const patch of [
      { payload: { ...monthlyConsent(), providerClientId: 'foreign' } },
      { payload: { ...monthlyConsent(), amountMinor: 0 } },
      { headers: { authorization: 'Bearer fixture' } },
      { url: prefix + '?price=1' },
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: prefix,
        headers,
        payload: monthlyConsent(),
        ...patch,
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(runtime.purchase).not.toHaveBeenCalled();
    const good = await app.inject({
      method: 'POST',
      url: prefix,
      headers,
      payload: monthlyConsent(),
    });
    expect(good.statusCode).toBe(200);
    expect(runtime.purchase).toHaveBeenCalledTimes(1);
    expect(runtime.purchase.mock.calls[0]).toMatchObject([
      expect.objectContaining({ userId: monthlyActor.userId, sessionId: monthlyActor.sessionId }),
      key,
      monthlyConsent(),
    ]);
    expect((await app.inject({ url: prefix + '/by-key', headers })).statusCode).toBe(404);
    expect(runtime.reconcile).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
it('bank return cannot confirm payment; launch has nonce CSP and consumes only a same-origin opaque capability', async () => {
  const { app, runtime } = setup();
  try {
    const back = await app.inject(
      '/user/api/v1/subscription-payment-return?paid=true&summerPaymentRef=forged',
    );
    expect(back.statusCode).toBe(200);
    expect(back.body).not.toContain('forged');
    expect(runtime.purchase).not.toHaveBeenCalled();
    expect(runtime.reconcile).not.toHaveBeenCalled();
    const landing = await app.inject('/user/api/v1/subscription-payment-launch');
    expect(landing.headers['content-security-policy']).toContain("default-src 'none'");
    expect(landing.headers['content-security-policy']).toMatch(/script-src 'nonce-[a-f0-9]{32}'/);
    expect(landing.body).toContain("history.replaceState(null,'',location.pathname)");
    expect(landing.headers['referrer-policy']).toBe('no-referrer');
    const payload = {
        operationId: monthlyQuote().operationId,
        launchCode: monthlyActor.tenantId + '.' + 'a'.repeat(64),
      },
      url = '/user/api/v1/subscription-payment-launch/consume';
    for (const origin of ['https://foreign.invalid', 'null', 'https://lk.nano.padlhub.su'])
      expect(
        (await app.inject({ method: 'POST', url, headers: { origin }, payload })).statusCode,
      ).toBe(404);
    expect(runtime.consumeLaunch).not.toHaveBeenCalled();
    const good = await app.inject({
      method: 'POST',
      url,
      headers: { origin: 'https://lk2.padlhub.su' },
      payload,
    });
    expect(good.statusCode).toBe(200);
    expect(runtime.consumeLaunch).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
