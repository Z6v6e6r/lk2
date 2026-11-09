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
  if (!options.repository || !options.sink) {
    // The command answers a stable 503 while the CUP delivery backend is not configured, so the
    // process must say so once at startup: a silent 503 leaves an operator with no clue whether the
    // route, the secret or the CUP itself is missing. Per-request logging is deliberately absent
    // here because a rotating ad block calls this command repeatedly.
    app.log.warn(
      { code: 'PROMOTION_ENGAGEMENT_BACKEND_MISSING' },
      'promotion engagement backend is not configured; ad engagement statistics stay disabled',
    );
  }
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
      } catch (error: unknown) {
        // Only a fixed engagement code may reach the log: the sink and the repository can throw
        // messages that carry caller or profile data, so anything else stays behind a stable code.
        const failure = error instanceof Error ? error.message : '';
        const code = /^PROMOTION_ENGAGEMENT_[A-Z0-9_]{1,40}$/u.test(failure)
          ? failure
          : 'PROMOTION_ENGAGEMENT_RECORD_FAILED';
        request.log.warn(
          { code, correlationId: request.id },
          'promotion engagement recording failed',
        );
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
