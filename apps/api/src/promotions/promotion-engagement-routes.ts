import type { PromotionEngagementRepository } from '@phub/database';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import type { PromotionEngagementSink } from './legacy-promotion-engagement-sink.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

export function registerPromotionEngagementRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: PromotionEngagementRepository;
    readonly sink?: PromotionEngagementSink;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/promotions/:promotionId/engagements',
    {
      preHandler: [...options.commandHandlers],
      config: { rateLimit: { max: 120, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const { promotionId } = request.params as { promotionId?: string };
      const body = request.body as { kind?: unknown } | undefined;
      if (
        !promotionId ||
        !UUID_PATTERN.test(promotionId) ||
        !body ||
        !['IMPRESSION', 'CLICK'].includes(String(body.kind)) ||
        Object.keys(body).some((key) => key !== 'kind')
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'PROMOTION_ENGAGEMENT_INVALID',
          'Некорректное событие рекламы.',
        );
      }
      if (!options.repository || !options.sink) {
        return sendApiError(
          request,
          reply,
          503,
          'PROMOTION_ENGAGEMENT_UNAVAILABLE',
          'Статистика рекламы временно недоступна.',
        );
      }
      try {
        const context = await options.repository.resolveContext(
          current.tenantId,
          current.userId,
          promotionId,
        );
        if (!context) {
          return sendApiError(
            request,
            reply,
            404,
            'PROMOTION_NOT_FOUND',
            'Рекламная карточка не найдена.',
          );
        }
        await options.sink.record({
          eventId: String(request.headers['idempotency-key']),
          placement: context.placement,
          adId: context.externalAdId,
          kind: String(body.kind) as 'IMPRESSION' | 'CLICK',
          ...(body.kind === 'CLICK' && context.phoneE164 ? { phoneE164: context.phoneE164 } : {}),
          occurredAt: new Date().toISOString(),
          correlationId: request.id,
        });
        reply.status(202);
        return { accepted: true };
      } catch {
        return sendApiError(
          request,
          reply,
          503,
          'PROMOTION_ENGAGEMENT_UNAVAILABLE',
          'Статистика рекламы временно недоступна.',
        );
      }
    },
  );
}
