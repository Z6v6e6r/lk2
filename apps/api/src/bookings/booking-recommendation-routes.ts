import type {
  BookingPreferencesRepository,
  GameRepository,
  ProfileSummaryRepository,
} from '@phub/database';
import type {
  VivaExerciseRecommendation,
  VivaExerciseRecommendationSourceAdapter,
} from '@phub/viva-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import { listBookingRecommendations } from './booking-recommendations.js';

type CardReadRepository = Pick<GameRepository, 'listRecommendationCardProjections'>;
type ExerciseRecommendationSource = Pick<VivaExerciseRecommendationSourceAdapter, 'readDate'>;

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

function moscowDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function recommendationDates(now: Date): readonly string[] {
  return Array.from({ length: 4 }, (_, index) =>
    moscowDate(new Date(now.getTime() + index * 24 * 60 * 60 * 1_000)),
  );
}

async function readActivities(input: {
  readonly source?: ExerciseRecommendationSource;
  readonly getAccessToken?: (input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
  }) => Promise<string>;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
  readonly now: Date;
}): Promise<readonly VivaExerciseRecommendation[]> {
  if (!input.source || !input.getAccessToken) return [];
  try {
    const source = input.source;
    const accessToken = await input.getAccessToken({
      tenantId: input.tenantId,
      userId: input.userId,
      correlationId: input.correlationId,
    });
    const pages = await Promise.allSettled(
      recommendationDates(input.now).map((date) =>
        source.readDate({
          date,
          accessToken,
          correlationId: input.correlationId,
        }),
      ),
    );
    return pages.flatMap((page) => (page.status === 'fulfilled' ? page.value : []));
  } catch {
    return [];
  }
}

export function registerBookingRecommendationRoutes(
  app: FastifyInstance,
  options: {
    readonly gameRepository?: CardReadRepository;
    readonly photoRepository?: Pick<ProfileSummaryRepository, 'getPhotoDeliveryIds'>;
    readonly preferencesRepository?: BookingPreferencesRepository;
    readonly exerciseSource?: ExerciseRecommendationSource;
    readonly getExerciseAccessToken?: (input: {
      readonly tenantId: string;
      readonly userId: string;
      readonly correlationId: string;
    }) => Promise<string>;
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
        const now = new Date();
        const [profile, activities] = await Promise.all([
          options.preferencesRepository.getRecommendationProfile(current.tenantId, current.userId),
          readActivities({
            ...(options.exerciseSource ? { source: options.exerciseSource } : {}),
            ...(options.getExerciseAccessToken
              ? { getAccessToken: options.getExerciseAccessToken }
              : {}),
            tenantId: current.tenantId,
            userId: current.userId,
            correlationId: request.id,
            now,
          }),
        ]);
        return await listBookingRecommendations({
          repository: options.gameRepository,
          ...(options.photoRepository ? { photoRepository: options.photoRepository } : {}),
          tenantId: current.tenantId,
          userId: current.userId,
          preferences: profile.preferences,
          playerLevel: profile.playerLevel,
          activities,
          now: now.toISOString(),
          limit,
        });
      } catch {
        return unavailable(request, reply);
      }
    },
  );
}
