import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import {
  ResidencyOrderError,
  toResidencyOrderError,
  type ResidencyOrderActor,
  type ResidencyOrderRuntime,
} from './client-residency-order-runtime.js';

const IDEMPOTENCY_KEY = /^[!-~]{16,128}$/;
const PREFIX = '/user/api/v1/:tenantKey/residency';

const MESSAGES: Record<string, string> = {
  RESIDENCY_ORDERS_DISABLED: 'Покупка резидентства временно недоступна.',
  RESIDENCY_OWNER_UNAVAILABLE: 'Покупка резидентства временно недоступна. Повторите позже.',
  RESIDENCY_OWNER_RESPONSE_INVALID: 'Покупка резидентства временно недоступна.',
  RESIDENCY_PRODUCT_NOT_CONFIGURED: 'Резидентство не настроено.',
  RESIDENCY_PRODUCT_CONFIG_MISMATCH: 'Резидентство временно недоступно.',
  RESIDENCY_TENANT_NOT_SUPPORTED: 'Резидентство недоступно для этого клуба.',
  RESIDENCY_REAUTH_REQUIRED: 'Нужно повторно войти в аккаунт.',
  RESIDENCY_REAUTH_UNAVAILABLE: 'Не удалось продлить сессию. Повторите позже.',
  AUTH_REQUIRED: 'Требуется авторизация.',
  AUTH_SESSION_REVOKED: 'Сессия завершена.',
  RESIDENCY_PERMISSION_REQUIRED: 'Недостаточно прав.',
  RESIDENCY_REQUEST_INVALID: 'Некорректный запрос.',
  RESIDENCY_MODE_INVALID: 'Некорректный режим покупки.',
  RESIDENCY_PRICE_CONSENT_REQUIRED: 'Подтвердите цену перед оплатой.',
  RESIDENCY_IDEMPOTENCY_KEY_REQUIRED: 'Не хватает ключа идемпотентности.',
  RESIDENCY_ORDER_NOT_FOUND: 'Заказ не найден.',
};

const messageFor = (code: string): string =>
  MESSAGES[code] ?? 'Не удалось выполнить операцию с резидентством.';

/**
 * LK2 residency order routes. They verify the tenant, user and session through the
 * shared PadlHub middleware, forward the operation to the LK1 owner with the user's
 * server-held Viva delegation and pass the owner DTO through unchanged.
 */
export function registerClientResidencyOrderRoutes(
  app: FastifyInstance,
  options: {
    readonly runtime?: ResidencyOrderRuntime | undefined;
    readonly readHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const actor = (request: FastifyRequest): ResidencyOrderActor => {
    const enriched = request as FastifyRequest & {
      tenantId?: string;
      padlHubClaims?: { sub?: string; sid?: string; roles?: readonly string[] };
    };
    const tenantId = enriched.tenantId;
    const userId = enriched.padlHubClaims?.sub;
    const sessionId = enriched.padlHubClaims?.sid;
    if (!tenantId || !userId || !sessionId) throw new ResidencyOrderError('AUTH_REQUIRED', 401);
    const tenantKey = (request.params as { tenantKey?: string }).tenantKey;
    if (!tenantKey) throw new ResidencyOrderError('AUTH_REQUIRED', 401);
    return { tenantId, tenantKey, userId, sessionId, correlationId: request.id };
  };

  const commandActor = (request: FastifyRequest): ResidencyOrderActor => {
    const value = actor(request);
    const roles = (request as FastifyRequest & { padlHubClaims?: { roles?: readonly string[] } })
      .padlHubClaims?.roles;
    if (!roles?.includes('client'))
      throw new ResidencyOrderError('RESIDENCY_PERMISSION_REQUIRED', 403);
    return value;
  };

  const runtime = (): ResidencyOrderRuntime => {
    if (!options.runtime) throw new ResidencyOrderError('RESIDENCY_ORDERS_DISABLED', 503);
    return options.runtime;
  };

  const idempotencyKey = (request: FastifyRequest): string => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))
      throw new ResidencyOrderError('RESIDENCY_IDEMPOTENCY_KEY_REQUIRED', 400);
    return key;
  };

  const headers = (reply: FastifyReply): FastifyReply =>
    reply
      .header('Cache-Control', 'private, no-store')
      .header('Pragma', 'no-cache')
      .header('Referrer-Policy', 'no-referrer');

  const fail = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    const mapped = toResidencyOrderError(error);
    headers(reply);
    return reply.status(mapped.status).send({
      code: mapped.code,
      message: messageFor(mapped.code),
      correlationId: request.id,
      ...(mapped.details === undefined ? {} : { details: mapped.details }),
    });
  };

  const onlyQuery = (request: FastifyRequest, allowed: readonly string[]): void => {
    for (const key of Object.keys(request.query as Record<string, unknown>)) {
      if (!allowed.includes(key)) throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
    }
  };

  app.get(
    PREFIX + '/catalog',
    { preHandler: [...options.readHandlers] },
    async (request, reply) => {
      headers(reply);
      try {
        onlyQuery(request, []);
        return await runtime().catalog(actor(request));
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.get(PREFIX + '/orders', { preHandler: [...options.readHandlers] }, async (request, reply) => {
    headers(reply);
    try {
      onlyQuery(request, ['state']);
      const state = (request.query as { state?: string }).state;
      if (state !== 'unresolved') throw new ResidencyOrderError('RESIDENCY_REQUEST_INVALID', 400);
      return await runtime().listUnresolved(actor(request));
    } catch (error) {
      return fail(request, reply, error);
    }
  });

  app.post(
    PREFIX + '/orders',
    { preHandler: [...options.commandHandlers], bodyLimit: 4096 },
    async (request, reply) => {
      headers(reply);
      try {
        onlyQuery(request, []);
        const key = idempotencyKey(request);
        return await runtime().create(commandActor(request), key, request.body);
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.get(
    PREFIX + '/orders/:orderId',
    { preHandler: [...options.readHandlers] },
    async (request, reply) => {
      headers(reply);
      try {
        onlyQuery(request, []);
        return await runtime().readOrder(
          actor(request),
          (request.params as { orderId: string }).orderId,
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.get(
    PREFIX + '/orders/:orderId/payment',
    { preHandler: [...options.readHandlers] },
    async (request, reply) => {
      headers(reply);
      try {
        onlyQuery(request, []);
        return await runtime().readPayment(
          actor(request),
          (request.params as { orderId: string }).orderId,
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.post(
    PREFIX + '/orders/:orderId/reconcile',
    { preHandler: [...options.commandHandlers], bodyLimit: 4096 },
    async (request, reply) => {
      headers(reply);
      try {
        onlyQuery(request, []);
        const key = idempotencyKey(request);
        return await runtime().reconcile(
          commandActor(request),
          (request.params as { orderId: string }).orderId,
          key,
          request.body,
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );

  app.post(
    PREFIX + '/orders/:orderId/cancel',
    { preHandler: [...options.commandHandlers], bodyLimit: 4096 },
    async (request, reply) => {
      headers(reply);
      try {
        onlyQuery(request, []);
        const key = idempotencyKey(request);
        return await runtime().cancel(
          commandActor(request),
          (request.params as { orderId: string }).orderId,
          key,
        );
      } catch (error) {
        return fail(request, reply, error);
      }
    },
  );
}
