import { createHash, createHmac, randomBytes } from 'node:crypto';

import type {
  GiftCertificateOrderCommandResult,
  GiftCertificatePaymentCommandResult,
  GiftCertificatePaymentConfirmationResult,
  GiftCertificateSaleAccess,
  GiftCertificateSaleRepository,
} from '@phub/database';
import {
  createGiftCertificateOrderRequestSchema,
  giftCertificateOrderDetailSchema,
  giftCertificateOrderViewSchema,
  giftCertificatePaymentConfirmationSchema,
  giftCertificatePaymentIntentSchema,
} from '@phub/gift-certificates';
import type { GiftCertificateIssuanceRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import type { GiftCertificateArtifactReadStore } from './gift-certificate-artifact-store.js';

const PURCHASE_COOKIE = 'phub_gift_purchase';
const PURCHASE_SESSION_TTL_SECONDS = 30 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURCHASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestHash(principal: string, value: unknown): string {
  return hash(`${principal}:${JSON.stringify(value)}`);
}

function orderNumber(): string {
  return `GC-${randomBytes(12)
    .toString('base64url')
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, 'X')
    .slice(0, 12)}`;
}

function purchaseToken(request: FastifyRequest, secret: string, operationKey: string): string {
  const existing = request.cookies[PURCHASE_COOKIE];
  if (existing && PURCHASE_TOKEN_PATTERN.test(existing)) return existing;
  return createHmac('sha256', secret)
    .update(`${request.tenantId}:${operationKey}`)
    .digest('base64url');
}

function publicAccess(request: FastifyRequest): GiftCertificateSaleAccess | undefined {
  const token = request.cookies[PURCHASE_COOKIE];
  return token && PURCHASE_TOKEN_PATTERN.test(token)
    ? { purchaseSessionHash: hash(token) }
    : undefined;
}

function userAccess(
  request: FastifyRequest,
): { readonly buyerUserId: string; readonly purchaseSessionHash?: never } | undefined {
  const buyerUserId = request.padlHubClaims?.sub;
  return buyerUserId ? { buyerUserId } : undefined;
}

function orderCommandResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  result: GiftCertificateOrderCommandResult,
) {
  switch (result.outcome) {
    case 'applied':
      reply.status(result.replayed ? 200 : 201);
      return { ...giftCertificateOrderViewSchema.parse(result.order), replayed: result.replayed };
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_ORDER_IDEMPOTENCY_CONFLICT',
        'Ключ операции уже использован.',
      );
    case 'catalog_stale':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_CATALOG_VERSION_STALE',
        'Каталог изменился. Обновите витрину.',
      );
    case 'design_unavailable':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_DESIGN_UNAVAILABLE',
        'Выбранный дизайн больше недоступен.',
      );
    case 'denomination_unavailable':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_DENOMINATION_UNAVAILABLE',
        'Выбранный номинал больше недоступен.',
      );
    case 'scheduled_delivery_unavailable':
      return sendApiError(
        request,
        reply,
        422,
        'GIFT_SCHEDULED_DELIVERY_UNAVAILABLE',
        'Выбранное время доставки недоступно.',
      );
  }
}

function paymentCommandResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  result: GiftCertificatePaymentCommandResult,
) {
  switch (result.outcome) {
    case 'applied':
      reply.status(result.intent.replayed ? 200 : 201);
      return giftCertificatePaymentIntentSchema.parse(result.intent);
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_PAYMENT_IDEMPOTENCY_CONFLICT',
        'Ключ операции уже использован.',
      );
    case 'order_not_found':
      return sendApiError(request, reply, 404, 'GIFT_ORDER_NOT_FOUND', 'Заказ не найден.');
    case 'order_not_payable':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_ORDER_NOT_PAYABLE',
        'Заказ уже нельзя оплатить.',
      );
  }
}

function confirmationResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  result: GiftCertificatePaymentConfirmationResult,
) {
  switch (result.outcome) {
    case 'applied':
      return giftCertificatePaymentConfirmationSchema.parse(result.confirmation);
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_PAYMENT_IDEMPOTENCY_CONFLICT',
        'Ключ операции уже использован.',
      );
    case 'payment_not_found':
      return sendApiError(request, reply, 404, 'GIFT_PAYMENT_NOT_FOUND', 'Платёж не найден.');
    case 'payment_amount_mismatch':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_PAYMENT_AMOUNT_MISMATCH',
        'Сумма платежа не совпадает с заказом.',
      );
  }
}

function sandboxUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'GIFT_PAYMENT_SANDBOX_DISABLED',
    'Тестовая оплата выключена.',
  );
}

function hostedSandboxPage(input: {
  readonly tenantKey: string;
  readonly paymentId: string;
  readonly surface: 'public' | 'user';
}): string {
  const apiPrefix = `/${input.surface}/api/v1/${input.tenantKey}`;
  const confirmationPath = `${apiPrefix}/gift-certificate-payments/${input.paymentId}/sandbox-confirm`;
  const refreshPath = `${apiPrefix}/auth/session/refresh`;
  const needsRefresh = input.surface === 'user';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>PadlHub Sandbox Payment</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#102117;color:#eef8f0;font:16px system-ui}
main{width:min(420px,calc(100% - 32px));padding:30px;border:1px solid #31523a;border-radius:24px;background:#173522}
button{width:100%;min-height:48px;border:0;border-radius:12px;background:#79dc84;color:#102117;font-weight:800}
small{color:#9fbaa5}pre{white-space:pre-wrap;font-size:12px}</style></head>
<body><main><small>PADLHUB · LOCAL SANDBOX</small><h1>Тестовая оплата</h1>
<p>Деньги не списываются. Команда только подтверждает локальную платёжную операцию.</p>
<button id="confirm">Подтвердить оплату</button><a id="return" hidden>Вернуться к сертификату</a><pre id="result"></pre></main>
<script type="module">
const button=document.querySelector('#confirm');const result=document.querySelector('#result');const back=document.querySelector('#return');
button.addEventListener('click',async()=>{button.disabled=true;try{
let token;${needsRefresh ? `const refresh=await fetch('${refreshPath}',{method:'POST',credentials:'include',headers:{'Accept':'application/json','X-App-Platform':'web','X-App-Version':'0.1.0','X-Session-Intent':'refresh','X-Correlation-ID':crypto.randomUUID(),'Idempotency-Key':crypto.randomUUID()}});if(!refresh.ok)throw new Error('Авторизация недоступна');token=(await refresh.json()).accessToken;` : ''}
const response=await fetch('${confirmationPath}',{method:'POST',credentials:'include',headers:{'Accept':'application/json','Content-Type':'application/json','X-App-Platform':'web','X-App-Version':'0.1.0','X-Correlation-ID':crypto.randomUUID(),'Idempotency-Key':crypto.randomUUID()${needsRefresh ? `,'Authorization':'Bearer '+token` : ''}},body:'{}'});
const body=await response.json();if(!response.ok)throw new Error(body.message||'Ошибка оплаты');
result.textContent='Оплата подтверждена. Выпускаем сертификат…';button.textContent='Готово';back.hidden=false;back.href='${input.surface === 'user' ? '/gift-certificates' : '/giftcard'}?orderId='+encodeURIComponent(body.order.id);
}catch(error){result.textContent=error instanceof Error?error.message:'Ошибка';button.disabled=false;}});
</script></body></html>`;
}

export function registerGiftCertificateSaleRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: GiftCertificateSaleRepository;
    readonly issuanceRepository?: Pick<
      GiftCertificateIssuanceRepository,
      'getFulfillment' | 'getArtifactForOwnedOrder'
    >;
    readonly artifactStore?: GiftCertificateArtifactReadStore;
    readonly artifactsEnabled: boolean;
    readonly sandboxEnabled: boolean;
    readonly purchaseSecret: string;
    readonly secureCookies: boolean;
    readonly publicTenantHandlers: readonly preHandlerHookHandler[];
    readonly publicCommandHandlers: readonly preHandlerHookHandler[];
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly authenticatedCommandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/public/api/v1/:tenantKey/gift-certificate-orders',
    { preHandler: [...options.publicCommandHandlers] },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const operationKey = idempotencyKey(request);
      const parsed = createGiftCertificateOrderRequestSchema.safeParse(request.body);
      if (!tenantId || !operationKey)
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Нужен ключ операции.',
        );
      if (!parsed.success)
        return sendApiError(
          request,
          reply,
          400,
          'GIFT_ORDER_PAYLOAD_INVALID',
          'Проверьте данные заказа.',
        );
      if (!options.repository)
        return sendApiError(
          request,
          reply,
          503,
          'GIFT_SALE_UNAVAILABLE',
          'Продажа сертификатов недоступна.',
        );
      const token = purchaseToken(request, options.purchaseSecret, operationKey);
      const access = { purchaseSessionHash: hash(token) } as const;
      reply.setCookie(PURCHASE_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: options.secureCookies,
        path: `/public/api/v1/${(request.params as { tenantKey: string }).tenantKey}`,
        maxAge: PURCHASE_SESSION_TTL_SECONDS,
      });
      return orderCommandResponse(
        request,
        reply,
        await options.repository.createOrder({
          tenantId,
          salesChannel: 'PUBLIC_WEB',
          access,
          purchaseSessionExpiresAt: new Date(
            Date.now() + PURCHASE_SESSION_TTL_SECONDS * 1_000,
          ).toISOString(),
          orderNumber: orderNumber(),
          idempotencyKey: operationKey,
          requestHash: requestHash(access.purchaseSessionHash, parsed.data),
          correlationId: request.id,
          order: parsed.data,
        }),
      );
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/gift-certificate-orders',
    { preHandler: [...options.authenticatedCommandHandlers] },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const operationKey = idempotencyKey(request);
      const access = userAccess(request);
      const parsed = createGiftCertificateOrderRequestSchema.safeParse(request.body);
      if (!tenantId || !operationKey || !access)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!parsed.success)
        return sendApiError(
          request,
          reply,
          400,
          'GIFT_ORDER_PAYLOAD_INVALID',
          'Проверьте данные заказа.',
        );
      if (!options.repository)
        return sendApiError(
          request,
          reply,
          503,
          'GIFT_SALE_UNAVAILABLE',
          'Продажа сертификатов недоступна.',
        );
      return orderCommandResponse(
        request,
        reply,
        await options.repository.createOrder({
          tenantId,
          salesChannel: 'LK',
          access,
          orderNumber: orderNumber(),
          idempotencyKey: operationKey,
          requestHash: requestHash(access.buyerUserId, parsed.data),
          correlationId: request.id,
          order: parsed.data,
        }),
      );
    },
  );

  for (const surface of ['public', 'user'] as const) {
    const authenticated = surface === 'user';
    const readHandlers = authenticated
      ? options.authenticatedTenantHandlers
      : options.publicTenantHandlers;
    const commandHandlers = authenticated
      ? options.authenticatedCommandHandlers
      : options.publicCommandHandlers;

    app.get(
      `/${surface}/api/v1/:tenantKey/gift-certificate-orders/:orderId`,
      { preHandler: [...readHandlers] },
      async (request, reply) => {
        const tenantId = request.tenantId;
        const orderId = (request.params as { orderId?: string }).orderId;
        const access = authenticated ? userAccess(request) : publicAccess(request);
        if (
          !tenantId ||
          !orderId ||
          !UUID_PATTERN.test(orderId) ||
          !access ||
          !options.repository
        ) {
          return sendApiError(request, reply, 404, 'GIFT_ORDER_NOT_FOUND', 'Заказ не найден.');
        }
        const order = await options.repository.getOrder(tenantId, orderId, access);
        const fulfillment = options.issuanceRepository
          ? await options.issuanceRepository.getFulfillment(tenantId, orderId, access)
          : undefined;
        return order
          ? giftCertificateOrderDetailSchema.parse({ ...order, fulfillment: fulfillment ?? null })
          : sendApiError(request, reply, 404, 'GIFT_ORDER_NOT_FOUND', 'Заказ не найден.');
      },
    );

    app.get(
      `/${surface}/api/v1/:tenantKey/gift-certificate-orders/:orderId/certificate.pdf`,
      { preHandler: [...readHandlers] },
      async (request, reply) => {
        const tenantId = request.tenantId;
        const orderId = (request.params as { orderId?: string }).orderId;
        const access = authenticated ? userAccess(request) : publicAccess(request);
        if (
          !tenantId ||
          !orderId ||
          !UUID_PATTERN.test(orderId) ||
          !access ||
          !options.artifactsEnabled ||
          !options.issuanceRepository ||
          !options.artifactStore
        ) {
          return sendApiError(
            request,
            reply,
            404,
            'GIFT_CERTIFICATE_ARTIFACT_NOT_READY',
            'Сертификат ещё не готов.',
          );
        }
        const artifact = await options.issuanceRepository.getArtifactForOwnedOrder(
          tenantId,
          orderId,
          access,
        );
        if (!artifact) {
          return sendApiError(
            request,
            reply,
            404,
            'GIFT_CERTIFICATE_ARTIFACT_NOT_READY',
            'Сертификат ещё не готов.',
          );
        }
        try {
          const pdf = await options.artifactStore.readPdf(artifact.objectKey, 8 * 1_024 * 1_024);
          return reply
            .header('Cache-Control', 'private, no-store')
            .header(
              'Content-Disposition',
              `attachment; filename="${artifact.certificateNumber}.pdf"`,
            )
            .type('application/pdf')
            .send(pdf);
        } catch (error) {
          request.log.error(
            { error, certificateId: artifact.certificateId },
            'gift certificate artifact read failed',
          );
          return sendApiError(
            request,
            reply,
            503,
            'GIFT_CERTIFICATE_ARTIFACT_UNAVAILABLE',
            'Скачивание временно недоступно.',
          );
        }
      },
    );

    app.post(
      `/${surface}/api/v1/:tenantKey/gift-certificate-orders/:orderId/payment-intents`,
      { preHandler: [...commandHandlers] },
      async (request, reply) => {
        if (!options.sandboxEnabled) return sandboxUnavailable(request, reply);
        const tenantId = request.tenantId;
        const tenantKey = (request.params as { tenantKey?: string }).tenantKey;
        const orderId = (request.params as { orderId?: string }).orderId;
        const operationKey = idempotencyKey(request);
        const access = authenticated ? userAccess(request) : publicAccess(request);
        if (
          !tenantId ||
          !tenantKey ||
          !orderId ||
          !UUID_PATTERN.test(orderId) ||
          !operationKey ||
          !access
        ) {
          return sendApiError(request, reply, 404, 'GIFT_ORDER_NOT_FOUND', 'Заказ не найден.');
        }
        if (!options.repository)
          return sendApiError(
            request,
            reply,
            503,
            'GIFT_SALE_UNAVAILABLE',
            'Продажа сертификатов недоступна.',
          );
        const principal = access.buyerUserId ?? access.purchaseSessionHash;
        return paymentCommandResponse(
          request,
          reply,
          await options.repository.createPayment({
            tenantId,
            orderId,
            access,
            idempotencyKey: operationKey,
            requestHash: requestHash(principal, { orderId }),
            correlationId: request.id,
            nextActionUrl: (paymentId) =>
              `/${surface}/api/v1/${tenantKey}/gift-certificate-payment-sandbox/${paymentId}`,
          }),
        );
      },
    );

    app.get(
      `/${surface}/api/v1/:tenantKey/gift-certificate-payment-sandbox/:paymentId`,
      { preHandler: [...options.publicTenantHandlers] },
      (request, reply) => {
        if (!options.sandboxEnabled) return sandboxUnavailable(request, reply);
        const tenantKey = (request.params as { tenantKey?: string }).tenantKey;
        const paymentId = (request.params as { paymentId?: string }).paymentId;
        if (!tenantKey || !paymentId || !UUID_PATTERN.test(paymentId)) {
          return sendApiError(request, reply, 404, 'GIFT_PAYMENT_NOT_FOUND', 'Платёж не найден.');
        }
        return reply
          .type('text/html; charset=utf-8')
          .send(hostedSandboxPage({ tenantKey, paymentId, surface }));
      },
    );

    app.post(
      `/${surface}/api/v1/:tenantKey/gift-certificate-payments/:paymentId/sandbox-confirm`,
      { preHandler: [...commandHandlers] },
      async (request, reply) => {
        if (!options.sandboxEnabled) return sandboxUnavailable(request, reply);
        const tenantId = request.tenantId;
        const paymentId = (request.params as { paymentId?: string }).paymentId;
        const operationKey = idempotencyKey(request);
        const access = authenticated ? userAccess(request) : publicAccess(request);
        if (!tenantId || !paymentId || !UUID_PATTERN.test(paymentId) || !operationKey || !access) {
          return sendApiError(request, reply, 404, 'GIFT_PAYMENT_NOT_FOUND', 'Платёж не найден.');
        }
        if (!options.repository)
          return sendApiError(
            request,
            reply,
            503,
            'GIFT_SALE_UNAVAILABLE',
            'Продажа сертификатов недоступна.',
          );
        const principal = access.buyerUserId ?? access.purchaseSessionHash;
        return confirmationResponse(
          request,
          reply,
          await options.repository.confirmSandboxPayment({
            tenantId,
            paymentId,
            access,
            idempotencyKey: operationKey,
            requestHash: requestHash(principal, { paymentId, outcome: 'CONFIRMED' }),
            correlationId: request.id,
          }),
        );
      },
    );
  }
}
