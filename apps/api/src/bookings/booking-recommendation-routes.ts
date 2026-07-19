import type { BookingPreferencesRepository, GameRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import { listBookingRecommendations } from './booking-recommendations.js';

type CardReadRepository = Pick<GameRepository, 'listRecommendationCardProjections'>;

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function limitValue(value: unknown): number | undefined {
  if (value === undefined) return 6;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'BOOKING_RECOMMENDATIONS_UNAVAILABLE',
    'Персональные рекомендации временно недоступны.',
  );
}

export function registerBookingRecommendationRoutes(
  app: FastifyInstance,
  options: {
    readonly gameRepository?: CardReadRepository;
    readonly preferencesRepository?: BookingPreferencesRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/recommendations/bookings',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const query = request.query as Record<string, unknown>;
      const limit = limitValue(query.limit);
      if (Object.keys(query).some((key) => key !== 'limit') || limit === undefined) {
        return sendApiError(
          request,
          reply,
          400,
          'BOOKING_RECOMMENDATIONS_QUERY_INVALID',
          'Некорректные параметры рекомендаций.',
        );
      }
      if (!options.gameRepository || !options.preferencesRepository) {
        return unavailable(request, reply);
      }
      try {
        const profile = await options.preferencesRepository.getRecommendationProfile(
          current.tenantId,
          current.userId,
        );
        return await listBookingRecommendations({
          repository: options.gameRepository,
          tenantId: current.tenantId,
          userId: current.userId,
          preferences: profile.preferences,
          playerLevel: profile.playerLevel,
          now: new Date().toISOString(),
          limit,
        });
      } catch {
        return unavailable(request, reply);
      }
    },
  );
}
