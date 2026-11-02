import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import {
  MonthlyPurchaseError,
  mpExact,
  mpOfferId,
  mpUuid,
  parsePurchaseConsent,
} from '@phub/domain/subscription-purchase';
import type { MonthlyPurchaseRuntime } from './monthly-purchase-runtime.js';
const launchPath = '/user/api/v1/subscription-payment-launch';
export function registerMonthlyPurchaseRoutes(
  app: FastifyInstance,
  o: {
    runtime?: MonthlyPurchaseRuntime;
    readHandlers: readonly preHandlerHookHandler[];
    commandHandlers: readonly preHandlerHookHandler[];
    allowDebugOrigin?: boolean;
  },
) {
  const actor = (r: FastifyRequest) => {
    const x = r as FastifyRequest & {
      tenantId?: string;
      padlHubClaims?: { sub?: string; sid?: string; roles?: readonly string[] };
    };
    if (!x.tenantId || !x.padlHubClaims?.sub || !x.padlHubClaims.sid)
      throw new MonthlyPurchaseError('AUTH_REQUIRED', 401);
    if (!x.padlHubClaims.roles?.includes('client'))
      throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_PERMISSION_REQUIRED', 403);
    return {
      tenantId: x.tenantId,
      tenantKey: (r.params as { tenantKey: string }).tenantKey,
      userId: x.padlHubClaims.sub,
      sessionId: x.padlHubClaims.sid,
      correlationId: r.id,
    };
  };
  const key = (r: FastifyRequest) => {
    const k = r.headers['idempotency-key'];
    if (typeof k !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$(?![\s\S])/.test(k))
      throw new MonthlyPurchaseError('INVALID_REQUEST', 400);
    return k;
  };
  const runtime = () => {
    if (!o.runtime) throw new MonthlyPurchaseError();
    return o.runtime;
  };
  const emptyQuery = (r: FastifyRequest) => {
    if (Object.keys(r.query as object).length)
      throw new MonthlyPurchaseError('INVALID_REQUEST', 400);
  };
  const prefix = '/user/api/v1/:tenantKey/subscription-purchase-operations';
  app.get(prefix + '/capability', { preHandler: [...o.readHandlers] }, async (r, p) => {
    p.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    try {
      actor(r);
      emptyQuery(r);
      return o.runtime
        ? o.runtime.capability()
        : { contractVersion: 1, available: false, offers: [] };
    } catch (e) {
      const error = e instanceof MonthlyPurchaseError ? e : new MonthlyPurchaseError();
      return p.code(error.status).send({ code: error.code, message: 'Покупка пока недоступна.' });
    }
  });
  app.get(prefix + '/by-key', { preHandler: [...o.readHandlers] }, async (r, p) => {
    p.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    try {
      emptyQuery(r);
      const result = await runtime().read(actor(r), key(r));
      if (!result) throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_NOT_FOUND', 404);
      return result;
    } catch (e) {
      const error = e instanceof MonthlyPurchaseError ? e : new MonthlyPurchaseError();
      return p
        .code(error.status)
        .send({ code: error.code, message: 'Статус покупки пока недоступен.' });
    }
  });
  for (const mode of ['quote', 'purchase', 'reconcile', 'launch'] as const) {
    const suffix =
      mode === 'purchase'
        ? ''
        : mode === 'quote'
          ? '/quote'
          : mode === 'reconcile'
            ? '/:operationId/reconcile'
            : '/:operationId/payment-launch';
    app.post(
      prefix + suffix,
      { preHandler: [...o.commandHandlers], bodyLimit: 4096 },
      async (r, p) => {
        p.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
        try {
          emptyQuery(r);
          const a = actor(r),
            k = key(r);
          if (mode === 'quote') {
            const b = mpExact(r.body, 'offerId');
            if (b.offerId !== mpOfferId) throw new MonthlyPurchaseError('INVALID_REQUEST', 400);
            return await runtime().quote(a, k);
          }
          if (mode === 'purchase')
            return await runtime().purchase(a, k, parsePurchaseConsent(r.body));
          mpExact(r.body, '');
          const id = (r.params as { operationId: string }).operationId;
          if (!mpUuid(id)) throw new MonthlyPurchaseError('INVALID_REQUEST', 400);
          return mode === 'reconcile'
            ? await runtime().reconcile(a, k, id)
            : await runtime().launch(a, k, id);
        } catch (e) {
          const error = e instanceof MonthlyPurchaseError ? e : new MonthlyPurchaseError();
          return p
            .code(error.status)
            .send({ code: error.code, message: 'Покупка пока не завершена. Проверьте её статус.' });
        }
      },
    );
  }
  app.get(launchPath, async (_r, p) => {
    const nonce = randomBytes(16).toString('hex');
    p.header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      );
    return p.type('text/html; charset=utf-8')
      .send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата абонемента</title><body><main><h1>Оплата абонемента</h1><p id="status" role="status">Открываем страницу оплаты…</p></main><script nonce="${nonce}">
(async()=>{const params=new URLSearchParams(location.hash.slice(1)),operationId=params.get('operationId'),launchCode=params.get('launchCode');history.replaceState(null,'',location.pathname);
try{if(!operationId||!launchCode)throw Error();const response=await fetch('${launchPath}/consume',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId,launchCode})});if(!response.ok)throw Error();const result=await response.json();const url=new URL(result.url);if(url.protocol!=='https:'||url.username||url.password)throw Error();location.replace(url.href);}catch{document.getElementById('status').textContent='Ссылка недоступна или истекла. Вернитесь в приложение и откройте оплату снова.';}})();
</script></body></html>`);
  });
  app.post(
    launchPath + '/consume',
    { bodyLimit: 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (r, p) => {
      p.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      try {
        const allowed = [
          'https://lk2.padlhub.su',
          ...(o.allowDebugOrigin ? ['https://lk.nano.padlhub.su'] : []),
        ];
        if (typeof r.headers.origin !== 'string' || !allowed.includes(r.headers.origin))
          throw new MonthlyPurchaseError();
        emptyQuery(r);
        const b = mpExact(r.body, 'operationId,launchCode');
        if (
          !mpUuid(b.operationId) ||
          typeof b.launchCode !== 'string' ||
          b.launchCode.length !== 101
        )
          throw new MonthlyPurchaseError();
        return { url: await runtime().consumeLaunch(b.operationId, b.launchCode) };
      } catch {
        return p
          .code(404)
          .send({ code: 'SUBSCRIPTION_PAYMENT_LINK_UNAVAILABLE', message: 'Ссылка недоступна.' });
      }
    },
  );
  app.get('/user/api/v1/subscription-payment-return', async (_r, p) => {
    p.header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
    // Ignore all bank query fields. They never update or prove a purchase.
    return p
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вернуться в PadlHub</title><body><main><h1>Вернитесь в PadlHub</h1><p>Проверьте статус покупки в приложении PadlHub.</p></main></body></html>',
      );
  });
}
