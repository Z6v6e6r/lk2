import {
  CommunityDirectoryError,
  communityMembershipPageSchema,
  type CommunityDirectoryService,
} from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import { LegacyCommunityReadError } from './legacy-community-read-repository.js';

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const communityRequest = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = communityRequest.tenantId;
  const userId = communityRequest.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_DIRECTORY_UNAVAILABLE',
    'Сообщества временно недоступны.',
  );
}

export function registerCommunityRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityDirectoryService;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/communities/mine',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=30');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service) return unavailable(request, reply);

      const query = request.query as Record<string, unknown>;
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (query.cursor !== undefined &&
          (typeof query.cursor !== 'string' || query.cursor.length > 512))
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_QUERY_INVALID',
          'Некорректные параметры списка сообществ.',
        );
      }

      try {
        const page = await options.service.listMemberships({
          tenantId: current.tenantId,
          userId: current.userId,
          correlationId: request.id,
          limit,
          ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
        });
        const parsed = communityMembershipPageSchema.safeParse(page);
        if (!parsed.success) return unavailable(request, reply);
        return parsed.data;
      } catch (error: unknown) {
        if (error instanceof CommunityDirectoryError && error.code === 'COMMUNITY_CURSOR_INVALID') {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_CURSOR_INVALID',
            'Курсор списка сообществ недействителен.',
          );
        }
        const code =
          error instanceof LegacyCommunityReadError || error instanceof CommunityDirectoryError
            ? error.code
            : 'COMMUNITY_DIRECTORY_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community directory read failed');
        return unavailable(request, reply);
      }
    },
  );
}
