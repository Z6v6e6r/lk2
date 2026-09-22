import { type MessagingModerationRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const listParams = z.object({ tenantKey: z.string().min(1) }).strict();
const decisionParams = listParams.extend({ reportId: z.string().uuid() }).strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    afterId: z.string().uuid().optional(),
  })
  .strict();
const decisionBody = z
  .object({
    action: z.enum(['HIDE_MESSAGE', 'RESTORE_MESSAGE', 'DISMISS']),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  })
  .strict();

function principal(request: FastifyRequest) {
  return request.tenantId && request.padlHubClaims?.sub
    ? { tenantId: request.tenantId, actorUserId: request.padlHubClaims.sub }
    : undefined;
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: 'chat.moderation.read' | 'chat.moderation.decide',
) {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  if (
    request.padlHubClaims?.roles.includes('admin') &&
    request.padlHubClaims.permissions.includes(permission)
  ) {
    return true;
  }
  sendApiError(
    request,
    reply,
    403,
    'CHAT_MODERATION_PERMISSION_REQUIRED',
    'Нет права на модерацию чатов.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'MESSAGING_MODERATION_UNAVAILABLE',
    'Модерация чатов временно недоступна.',
  );
}

/**
 * CUP moderation surface for reported chat messages. Reads require `chat.moderation.read`, decisions
 * require `chat.moderation.decide`; both are admin-only permissions and only ride a phub-admin token.
 * The queue returns the reported body because a moderator decides on the real content.
 */
export function registerMessagingModerationAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: MessagingModerationRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/messaging/moderation/reports',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!requirePermission(request, reply, 'chat.moderation.read')) return;
      const current = principal(request);
      const params = listParams.safeParse(request.params);
      const query = listQuery.safeParse(request.query);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.repository) return unavailable(request, reply);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_MODERATION_QUERY_INVALID',
          'Проверьте параметры очереди жалоб.',
        );
      }
      return {
        items: await options.repository.listReportQueue({
          tenantId: current.tenantId,
          limit: query.data.limit,
          ...(query.data.afterId ? { afterId: query.data.afterId } : {}),
        }),
      };
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/messaging/moderation/reports/:reportId/decision',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!requirePermission(request, reply, 'chat.moderation.decide')) return;
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      const params = decisionParams.safeParse(request.params);
      const body = decisionBody.safeParse(request.body);
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_MODERATION_DECISION_INVALID',
          'Проверьте действие и reasonCode.',
        );
      }
      const result = await options.repository.decideReport({
        tenantId: current.tenantId,
        moderatorUserId: current.actorUserId,
        reportId: params.data.reportId,
        action: body.data.action,
        reasonCode: body.data.reasonCode,
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') {
        return sendApiError(
          request,
          reply,
          404,
          'MESSAGING_REPORT_NOT_FOUND',
          'Жалоба не найдена.',
        );
      }
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      reply.header('X-Idempotent-Replayed', String(result.replayed));
      return {
        outcome: 'decided',
        action: result.action,
        hidden: result.hidden,
        replayed: result.replayed,
      };
    },
  );
}
