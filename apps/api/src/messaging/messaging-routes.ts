import type { MessagingRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = current.tenantId;
  const userId = current.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'MESSAGING_STORE_UNAVAILABLE',
    'Чаты временно недоступны.',
  );
}

async function requireMessagingGate(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: MessagingRepository,
  tenantId: string,
  direct = false,
): Promise<boolean> {
  const settings = await repository.getRuntimeSettings(tenantId);
  if (!settings.httpEnabled) {
    sendApiError(request, reply, 404, 'MESSAGING_DISABLED', 'Раздел чатов не включён.');
    return false;
  }
  if (direct && !settings.directEnabled) {
    sendApiError(request, reply, 404, 'DIRECT_MESSAGING_DISABLED', 'Личные диалоги не включены.');
    return false;
  }
  return true;
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(request, reply, 404, 'CONVERSATION_NOT_FOUND', 'Диалог не найден.');
}

function conflict(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'Idempotency-Key уже использован для другой команды.',
  );
}

export function registerMessagingRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: MessagingRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly directCommandHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/conversations',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (
        !(await requireMessagingGate(request, reply, options.repository, current.tenantId, true))
      ) {
        return;
      }
      const query = request.query as Record<string, unknown>;
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendApiError(
          request,
          reply,
          400,
          'CONVERSATION_QUERY_INVALID',
          'Некорректные параметры списка диалогов.',
        );
      }
      return {
        items: await options.repository.listConversations({
          tenantId: current.tenantId,
          userId: current.userId,
          limit,
        }),
      };
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/conversations/direct',
    { preHandler: [...options.directCommandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (
        !(await requireMessagingGate(request, reply, options.repository, current.tenantId, true))
      ) {
        return;
      }
      const body = request.body as Record<string, unknown> | null;
      const otherUserId = body?.otherUserId;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof otherUserId !== 'string' ||
        !UUID_PATTERN.test(otherUserId) ||
        otherUserId === current.userId
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'DIRECT_CONVERSATION_INVALID',
          'Не указан корректный участник диалога.',
        );
      }
      const result = await options.repository.createDirectConversation({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        otherUserId,
        idempotencyKey: request.headers['idempotency-key'] as string,
        correlationId: request.id,
      });
      if (result.outcome === 'target_not_found') {
        return sendApiError(
          request,
          reply,
          404,
          'CHAT_PARTICIPANT_NOT_FOUND',
          'Участник диалога не найден.',
        );
      }
      if (result.outcome === 'idempotency_conflict') return conflict(request, reply);
      return result;
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/conversations/:conversationId/messages',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (
        !(await requireMessagingGate(request, reply, options.repository, current.tenantId, true))
      ) {
        return;
      }
      const conversationId = (request.params as { conversationId?: string }).conversationId;
      const query = request.query as Record<string, unknown>;
      const afterSequence = query.afterSequence === undefined ? 0 : Number(query.afterSequence);
      const limit = query.limit === undefined ? 50 : Number(query.limit);
      if (
        !conversationId ||
        !UUID_PATTERN.test(conversationId) ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGE_QUERY_INVALID',
          'Некорректные параметры истории сообщений.',
        );
      }
      const result = await options.repository.listMessages({
        tenantId: current.tenantId,
        userId: current.userId,
        conversationId,
        afterSequence,
        limit,
      });
      if (result.outcome === 'not_found') return notFound(request, reply);
      return result.page;
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/conversations/:conversationId/messages',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (
        !(await requireMessagingGate(request, reply, options.repository, current.tenantId, true))
      ) {
        return;
      }
      const conversationId = (request.params as { conversationId?: string }).conversationId;
      const body = request.body as Record<string, unknown> | null;
      const clientMessageId = body?.clientMessageId;
      const text = body?.body;
      const normalizedBody = typeof text === 'string' ? text.trim() : '';
      if (
        !conversationId ||
        !UUID_PATTERN.test(conversationId) ||
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'clientMessageId' && key !== 'body') ||
        Object.keys(body).length !== 2 ||
        typeof clientMessageId !== 'string' ||
        !CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId) ||
        normalizedBody.length < 1 ||
        normalizedBody.length > 8_000
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGE_INVALID',
          'Сообщение не прошло проверку.',
        );
      }
      const result = await options.repository.sendMessage({
        tenantId: current.tenantId,
        userId: current.userId,
        conversationId,
        clientMessageId,
        idempotencyKey: request.headers['idempotency-key'] as string,
        body: normalizedBody,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') return notFound(request, reply);
      if (result.outcome === 'idempotency_conflict') return conflict(request, reply);
      return result;
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/conversations/:conversationId/read-cursor',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (
        !(await requireMessagingGate(request, reply, options.repository, current.tenantId, true))
      ) {
        return;
      }
      const conversationId = (request.params as { conversationId?: string }).conversationId;
      const body = request.body as Record<string, unknown> | null;
      const throughSequence = body?.throughSequence;
      if (
        !conversationId ||
        !UUID_PATTERN.test(conversationId) ||
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof throughSequence !== 'number' ||
        !Number.isSafeInteger(throughSequence) ||
        throughSequence < 0
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'READ_CURSOR_INVALID',
          'Не указана корректная позиция прочтения.',
        );
      }
      const result = await options.repository.markRead({
        tenantId: current.tenantId,
        userId: current.userId,
        conversationId,
        throughSequence,
        idempotencyKey: request.headers['idempotency-key'] as string,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') return notFound(request, reply);
      if (result.outcome === 'sequence_invalid') {
        return sendApiError(
          request,
          reply,
          400,
          'READ_CURSOR_SEQUENCE_INVALID',
          'Позиция прочтения выходит за границы диалога.',
        );
      }
      if (result.outcome === 'idempotency_conflict') return conflict(request, reply);
      return result;
    },
  );
}
