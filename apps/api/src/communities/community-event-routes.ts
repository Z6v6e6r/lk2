import {
  CommunityEventRecoveryError,
  communityEventGapExpiredResponseSchema,
  type CommunityEventRecoveryService,
} from '@phub/communities';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const paramsSchema = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();
const querySchema = z
  .object({
    afterSequence: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  return request.tenantId && request.padlHubClaims?.sub
    ? { tenantId: request.tenantId, userId: request.padlHubClaims.sub }
    : undefined;
}

export function registerCommunityEventRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityEventRecoveryService;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/events',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_EVENT_RECOVERY_UNAVAILABLE',
          'Восстановление событий временно недоступно.',
        );
      }
      const params = paramsSchema.safeParse(request.params);
      const query = querySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_EVENT_RECOVERY_QUERY_INVALID',
          'Проверьте позицию восстановления.',
        );
      }
      try {
        const result = await options.service.listEvents({
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          communityId: params.data.communityId,
          afterSequence: query.data.afterSequence,
          limit: query.data.limit,
          correlationId: request.id,
        });
        if (result.outcome === 'found') return result.page;
        if (result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_EVENT_ACCESS_DENIED',
            'Доступ запрещён.',
          );
        }
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        reply.header('X-Community-Latest-Sequence', String(result.latestSequence));
        if (result.outcome === 'gap_expired') {
          reply.header('X-Community-Retained-From-Sequence', String(result.retainedFromSequence));
          return reply.status(409).send(
            communityEventGapExpiredResponseSchema.parse({
              code: 'COMMUNITY_EVENT_GAP_EXPIRED',
              message: 'История для этой позиции больше не хранится. Обновите каноническую ленту.',
              correlationId: request.id,
              recoveryAction: 'FULL_CANONICAL_RELOAD',
              latestSequence: result.latestSequence,
              retainedFromSequence: result.retainedFromSequence,
            }),
          );
        }
        return sendApiError(
          request,
          reply,
          409,
          'COMMUNITY_EVENT_CURSOR_AHEAD',
          'Позиция восстановления новее текущей истории.',
        );
      } catch (error) {
        if (
          error instanceof CommunityEventRecoveryError &&
          error.code === 'COMMUNITY_EVENT_RECOVERY_QUERY_INVALID'
        ) {
          return sendApiError(request, reply, 400, error.code, 'Проверьте позицию восстановления.');
        }
        request.log.warn(
          { code: 'COMMUNITY_EVENT_RECOVERY_FAILED', correlationId: request.id },
          'community event recovery failed',
        );
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_EVENT_RECOVERY_UNAVAILABLE',
          'Восстановление событий временно недоступно.',
        );
      }
    },
  );
}
