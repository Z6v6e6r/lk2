import type { ProfileLevelHistoryRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const listQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'PROFILE_LEVEL_HISTORY_UNAVAILABLE',
    'История уровня временно недоступна.',
  );
}

export function registerProfileLevelHistoryRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: ProfileLevelHistoryRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/profile/level-history',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!request.padlHubClaims?.permissions.includes('profile.read')) {
        return sendApiError(
          request,
          reply,
          403,
          'PROFILE_LEVEL_HISTORY_PERMISSION_REQUIRED',
          'Нет доступа к истории уровня.',
        );
      }
      if (!options.repository) return unavailable(request, reply);
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'PROFILE_LEVEL_HISTORY_QUERY_INVALID',
          'Проверьте параметры истории уровня.',
        );
      }
      try {
        return await options.repository.list(current.tenantId, current.userId, query.data.limit);
      } catch {
        request.log.warn({ correlationId: request.id }, 'profile level history read failed');
        return unavailable(request, reply);
      }
    },
  );
}
