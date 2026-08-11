import type { CommunityReadExperienceService } from '@phub/communities';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../http-errors.js';
import { CommunityReadExperienceError } from '@phub/communities';
import { LegacyCommunityExperienceError } from './legacy-community-experience-repository.js';
const params = z.object({ tenantKey: z.string().min(1), communityId: z.string().uuid() }).strict();
const page = (max: number) =>
  z
    .object({
      limit: z.coerce.number().int().min(1).max(max).default(20),
      cursor: z.string().min(16).max(512).optional(),
    })
    .strict();
const rating = z
  .object({
    period: z.enum(['all', '30d']).default('30d'),
    tab: z.enum(['overall', 'games', 'tournaments', 'dynamics']).default('overall'),
  })
  .strict();
function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    tenantId?: string;
    padlHubClaims?: { sub?: string };
  };
  return current.tenantId && current.padlHubClaims?.sub
    ? { tenantId: current.tenantId, userId: current.padlHubClaims.sub }
    : undefined;
}
export function registerCommunityExperienceRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityReadExperienceService;
    readonly enabled: {
      readonly detail: boolean;
      readonly feed: boolean;
      readonly chat: boolean;
      readonly rating: boolean;
    };
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const handle = (
    method: 'getDetail' | 'getFeed' | 'getChat' | 'getRating',
    suffix: string,
    query: z.ZodType,
    enabled: boolean,
  ) =>
    app.get(
      `/user/api/v1/:tenantKey/community-views/:communityId${suffix}`,
      { preHandler: [...options.authenticatedTenantHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const current = principal(request);
        const parsedParams = params.safeParse(request.params);
        const parsedQuery = query.safeParse(request.query);
        if (!current)
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        if (!parsedParams.success || !parsedQuery.success)
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_EXPERIENCE_REQUEST_INVALID',
            'Проверьте параметры просмотра сообщества.',
          );
        if (!options.service || !enabled)
          return sendApiError(
            request,
            reply,
            503,
            'COMMUNITY_EXPERIENCE_UNAVAILABLE',
            'Просмотр сообщества временно недоступен.',
          );
        try {
          const shared = {
            tenantId: current.tenantId,
            viewerUserId: current.userId,
            communityId: parsedParams.data.communityId,
            correlationId: request.id,
          };
          const value =
            method === 'getDetail'
              ? await options.service.getDetail(shared)
              : method === 'getRating'
                ? await options.service.getRating({
                    ...shared,
                    ...(parsedQuery.data as {
                      period: 'all' | '30d';
                      tab: 'overall' | 'games' | 'tournaments' | 'dynamics';
                    }),
                  })
                : await options.service[method]({
                    ...shared,
                    ...(parsedQuery.data as { limit: number; cursor?: string }),
                  });
          return reply.send(value);
        } catch (error) {
          if (error instanceof LegacyCommunityExperienceError)
            request.log.warn(
              {
                communityExperienceErrorCode: error.code,
                ...(error.diagnostic ? { communityExperienceDiagnostic: error.diagnostic } : {}),
              },
              'legacy community experience projection failed',
            );
          if (
            error instanceof LegacyCommunityExperienceError &&
            error.code === 'COMMUNITY_EXPERIENCE_VERSION_UNAVAILABLE'
          ) {
            reply.header('Retry-After', '60');
            return sendApiError(
              request,
              reply,
              503,
              'COMMUNITY_RATING_VERSION_UNAVAILABLE',
              'Рейтинг временно недоступен.',
            );
          }
          if (
            error instanceof LegacyCommunityExperienceError &&
            error.code === 'COMMUNITY_EXPERIENCE_NOT_FOUND'
          )
            return sendApiError(request, reply, 404, error.code, 'Сообщество не найдено.');
          if (
            error instanceof LegacyCommunityExperienceError &&
            error.code === 'COMMUNITY_EXPERIENCE_FORBIDDEN'
          )
            return sendApiError(
              request,
              reply,
              404,
              'COMMUNITY_EXPERIENCE_NOT_FOUND',
              'Сообщество не найдено.',
            );
          if (
            error instanceof CommunityReadExperienceError ||
            error instanceof LegacyCommunityExperienceError
          )
            return sendApiError(
              request,
              reply,
              503,
              'COMMUNITY_EXPERIENCE_UNAVAILABLE',
              'Просмотр сообщества временно недоступен.',
            );
          throw error;
        }
      },
    );
  handle('getDetail', '', z.object({}).strict(), options.enabled.detail);
  handle('getFeed', '/feed', page(20), options.enabled.feed);
  handle('getChat', '/chat', page(50), options.enabled.chat);
  handle('getRating', '/rating', rating, options.enabled.rating);
}
