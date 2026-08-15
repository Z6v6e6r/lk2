import type { MessagingRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';
import { RealtimeTicketStoreError, type RealtimeTicketIssuer } from './realtime-ticket-issuer.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

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
    'MESSAGING_STORE_UNAVAILABLE',
    'Чаты временно недоступны.',
  );
}

async function requireMessagingGate(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: MessagingRepository,
  tenantId: string,
  kind?: 'DIRECT' | 'CONTEXTUAL' | 'LIST',
): Promise<boolean> {
  const settings = await repository.getRuntimeSettings(tenantId);
  if (!settings.httpEnabled) {
    sendApiError(request, reply, 404, 'MESSAGING_DISABLED', 'Раздел чатов не включён.');
    return false;
  }
  if (
    (kind === 'DIRECT' && !settings.directEnabled) ||
    (kind === 'LIST' && !settings.directEnabled && !settings.contextualEnabled)
  ) {
    sendApiError(request, reply, 404, 'DIRECT_MESSAGING_DISABLED', 'Личные диалоги не включены.');
    return false;
  }
  if (kind === 'CONTEXTUAL' && !settings.contextualEnabled) {
    sendApiError(
      request,
      reply,
      404,
      'CONTEXTUAL_MESSAGING_DISABLED',
      'Контекстные чаты не включены.',
    );
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
    readonly realtimeTicketIssuer?: RealtimeTicketIssuer;
    readonly userBlockCommandsEnabled: boolean;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly directCommandHandlers: readonly preHandlerHookHandler[];
    readonly contextualCommandHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/messaging/realtime-ticket',
    {
      preHandler: [...options.authenticatedTenantHandlers],
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository || !options.realtimeTicketIssuer) return unavailable(request, reply);
      const authorization = await options.repository.authorizeRealtimeConnection({
        tenantId: current.tenantId,
        userId: current.userId,
        sessionId: current.sessionId,
      });
      if (authorization.outcome === 'disabled') {
        return sendApiError(
          request,
          reply,
          404,
          'REALTIME_MESSAGING_DISABLED',
          'Онлайн-чат не включён.',
        );
      }
      if (authorization.outcome === 'revoked') {
        return sendApiError(request, reply, 401, 'AUTH_SESSION_REVOKED', 'Сессия недействительна.');
      }
      const tenantKey = (request.params as { tenantKey: string }).tenantKey;
      let issued: Awaited<ReturnType<RealtimeTicketIssuer['issue']>>;
      try {
        issued = await options.realtimeTicketIssuer.issue({
          tenantId: current.tenantId,
          tenantKey,
          userId: current.userId,
          sessionId: current.sessionId,
        });
      } catch (error) {
        if (error instanceof RealtimeTicketStoreError) {
          return sendApiError(
            request,
            reply,
            503,
            error.code,
            'Онлайн-подключение временно недоступно.',
          );
        }
        throw error;
      }
      try {
        await options.repository.recordRealtimeTicketIssued({
          tenantId: current.tenantId,
          userId: current.userId,
          ticketId: issued.ticketId,
          expiresAt: issued.expiresAt,
          correlationId: request.id,
        });
      } catch (error) {
        await options.realtimeTicketIssuer.revoke(issued.ticketId).catch(() => undefined);
        throw error;
      }
      return { ticket: issued.ticket, expiresAt: issued.expiresAt };
    },
  );

  for (const [method, action] of [
    ['put', 'BLOCK'],
    ['delete', 'UNBLOCK'],
  ] as const) {
    app[method](
      '/user/api/v1/:tenantKey/messaging/users/:otherUserId/block',
      { preHandler: [...options.directCommandHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const current = principal(request);
        if (!current) {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        if (!options.userBlockCommandsEnabled) {
          return sendApiError(
            request,
            reply,
            404,
            'USER_BLOCK_COMMANDS_DISABLED',
            'Блокировка пользователей пока не включена.',
          );
        }
        if (!options.repository) return unavailable(request, reply);
        if (
          !(await requireMessagingGate(
            request,
            reply,
            options.repository,
            current.tenantId,
            'DIRECT',
          ))
        ) {
          return;
        }
        const otherUserId = (request.params as { otherUserId?: string }).otherUserId;
        if (!otherUserId || !UUID_PATTERN.test(otherUserId) || otherUserId === current.userId) {
          return sendApiError(
            request,
            reply,
            400,
            'USER_BLOCK_INVALID',
            'Не указан корректный пользователь.',
          );
        }
        const result = await options.repository.setUserBlock({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          otherUserId,
          action,
          idempotencyKey: request.headers['idempotency-key'] as string,
          correlationId: request.id,
        });
        if (result.outcome === 'forbidden') {
          return sendApiError(
            request,
            reply,
            403,
            'CHAT_PERMISSION_REQUIRED',
            'Нет права на операцию с чатом.',
          );
        }
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
  }

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
        !(await requireMessagingGate(request, reply, options.repository, current.tenantId, 'LIST'))
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
        !(await requireMessagingGate(
          request,
          reply,
          options.repository,
          current.tenantId,
          'DIRECT',
        ))
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

  app.post(
    '/user/api/v1/:tenantKey/conversations/game',
    { preHandler: [...options.contextualCommandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (
        !(await requireMessagingGate(
          request,
          reply,
          options.repository,
          current.tenantId,
          'CONTEXTUAL',
        ))
      ) {
        return;
      }
      const body = request.body as Record<string, unknown> | null;
      const gameId = body?.gameId;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof gameId !== 'string' ||
        !UUID_PATTERN.test(gameId)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'GAME_CONVERSATION_INVALID',
          'Не указана каноническая игра.',
        );
      }
      const result = await options.repository.getOrCreateGameConversation({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        gameId,
        idempotencyKey: request.headers['idempotency-key'] as string,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') return notFound(request, reply);
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
      if (!(await requireMessagingGate(request, reply, options.repository, current.tenantId))) {
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
      if (!(await requireMessagingGate(request, reply, options.repository, current.tenantId))) {
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
      if (!(await requireMessagingGate(request, reply, options.repository, current.tenantId))) {
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
