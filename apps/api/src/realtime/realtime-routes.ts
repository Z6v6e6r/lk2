import type { RealtimeAuthorizationRepository } from '@phub/database';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import {
  RealtimeTicketStoreError,
  type RealtimeTicketIssuer,
} from '../messaging/realtime-ticket-issuer.js';

function principal(
  request: FastifyRequest,
): { tenantId: string; userId: string; sessionId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string; readonly sid?: string };
  };
  const tenantId = current.tenantId;
  const userId = current.padlHubClaims?.sub;
  const sessionId = current.padlHubClaims?.sid;
  return tenantId && userId && sessionId ? { tenantId, userId, sessionId } : undefined;
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  options: {
    readonly enabled: boolean;
    readonly repository?: RealtimeAuthorizationRepository;
    readonly ticketIssuer?: RealtimeTicketIssuer;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/realtime/tickets',
    {
      preHandler: [...options.authenticatedTenantHandlers],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      if (!options.enabled) {
        return sendApiError(
          request,
          reply,
          404,
          'COMMUNITIES_REALTIME_DISABLED',
          'Онлайн-обновления сообществ не включены.',
        );
      }
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository || !options.ticketIssuer) {
        return sendApiError(
          request,
          reply,
          503,
          'REALTIME_STORE_UNAVAILABLE',
          'Онлайн-обновления временно недоступны.',
        );
      }
      const authorization = await options.repository.authorizeConnection(current);
      if (authorization.outcome === 'revoked') {
        return sendApiError(request, reply, 401, 'AUTH_SESSION_REVOKED', 'Сессия недействительна.');
      }

      const tenantKey = (request.params as { tenantKey: string }).tenantKey;
      try {
        const issued = await options.ticketIssuer.issue({ ...current, tenantKey });
        try {
          await options.repository.recordTicketIssued({
            tenantId: current.tenantId,
            userId: current.userId,
            ticketId: issued.ticketId,
            expiresAt: issued.expiresAt,
            correlationId: request.id,
          });
        } catch (error) {
          await options.ticketIssuer.revoke(issued.ticketId).catch(() => undefined);
          throw error;
        }
        return { ticket: issued.ticket, expiresAt: issued.expiresAt };
      } catch (error) {
        if (error instanceof RealtimeTicketStoreError) {
          return sendApiError(
            request,
            reply,
            503,
            error.code,
            'Не удалось подготовить безопасное подключение.',
          );
        }
        throw error;
      }
    },
  );
}
