import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sendApiError } from '../http-errors.js';
import type { ClientResidencyService } from './client-residency-service.js';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

export interface ClientResidencyRouteOptions {
  readonly service?: ClientResidencyService;
  readonly authenticatedTenantHandlers: readonly Handler[];
  readonly getUserContext?: (
    tenantId: string,
    userId: string,
  ) => Promise<{ readonly id: string } | undefined>;
}

/**
 * Returns the normalized residency status for the verified session. Identity,
 * tenant and station context are taken only from the route parameters and
 * verified claims; the request accepts no user, tenant or provider selector.
 */
export function registerClientResidencyRoutes(
  app: FastifyInstance,
  options: ClientResidencyRouteOptions,
): void {
  app.get(
    '/user/api/v1/:tenantKey/residency',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Pragma', 'no-cache');
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      if (!tenantId || !userId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service) {
        return sendApiError(
          request,
          reply,
          503,
          'RESIDENCY_SERVICE_UNAVAILABLE',
          'Статус резидентства временно недоступен.',
        );
      }
      let user: { readonly id: string } | undefined;
      if (options.getUserContext) {
        try {
          user = await options.getUserContext(tenantId, userId);
        } catch {
          return sendApiError(
            request,
            reply,
            503,
            'RESIDENCY_AUTH_CONTEXT_UNAVAILABLE',
            'Не удалось подтвердить сессию.',
          );
        }
        if (!user) {
          return sendApiError(request, reply, 401, 'AUTH_SESSION_REVOKED', 'Сессия завершена.');
        }
      }
      return options.service.getClientResidency({
        tenantId,
        userId,
        correlationId: request.id,
      });
    },
  );
}
