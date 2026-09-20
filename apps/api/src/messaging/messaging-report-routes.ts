import {
  MESSAGING_REPORT_REASON_CODES,
  type MessagingModerationRepository,
  type MessagingRepository,
} from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const reportParams = z
  .object({
    tenantKey: z.string().min(1),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
  })
  .strict();

const reportBody = z
  .object({
    reasonCode: z.enum(MESSAGING_REPORT_REASON_CODES),
    details: z
      .string()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .optional(),
  })
  .strict();

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
 * Player-facing report command. The reporter never learns whether an unknown or foreign message
 * exists: a non-member, a deleted message and a message in another conversation all answer
 * `CONVERSATION_NOT_FOUND`. The message body is never echoed back.
 */
export function registerMessagingReportRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: MessagingModerationRepository;
    readonly messageRepository?: MessagingRepository;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/conversations/:conversationId/messages/:messageId/report',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const params = reportParams.safeParse(request.params);
      const body = reportBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_REPORT_PAYLOAD_INVALID',
          'Укажите причину жалобы и, при необходимости, описание до 2000 символов.',
        );
      }
      const repository = options.repository;
      if (!repository) return unavailable(request, reply);
      if (options.messageRepository) {
        const settings = await options.messageRepository.getRuntimeSettings(current.tenantId);
        if (!settings.httpEnabled) {
          return sendApiError(
            request,
            reply,
            404,
            'MESSAGING_DISABLED',
            'Раздел чатов не включён.',
          );
        }
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      const details = body.data.details?.trim();
      const result = await repository.submitReport({
        tenantId: current.tenantId,
        reporterUserId: current.userId,
        conversationId: params.data.conversationId,
        messageId: params.data.messageId,
        reasonCode: body.data.reasonCode,
        details: details && details.length > 0 ? details : null,
        idempotencyKey,
        correlationId: request.id,
      });
      switch (result.outcome) {
        case 'not_found':
          return sendApiError(request, reply, 404, 'CONVERSATION_NOT_FOUND', 'Диалог не найден.');
        case 'self_report':
          return sendApiError(
            request,
            reply,
            409,
            'MESSAGING_REPORT_SELF_TARGET',
            'Нельзя пожаловаться на собственное сообщение.',
          );
        case 'duplicate':
          return sendApiError(
            request,
            reply,
            409,
            'MESSAGING_REPORT_DUPLICATE',
            'Жалоба на это сообщение с этой причиной уже отправлена.',
          );
        case 'submitted':
          if (result.replayed) {
            reply.header('X-Idempotent-Replayed', 'true');
            reply.status(200);
          } else {
            reply.status(201);
          }
          return {
            outcome: 'submitted',
            reportId: result.report.id,
            caseId: result.caseId,
            replayed: result.replayed,
          };
      }
    },
  );
}
