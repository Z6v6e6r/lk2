import type { NotificationInboxPosition, NotificationInboxRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const notificationRequest = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = notificationRequest.tenantId;
  const userId = notificationRequest.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function encodeCursor(position: NotificationInboxPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

function decodeCursor(value: string): NotificationInboxPosition | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      !UUID_PATTERN.test(record.id) ||
      typeof record.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt))
    ) {
      return undefined;
    }
    return { id: record.id, createdAt: record.createdAt };
  } catch {
    return undefined;
  }
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'NOTIFICATION_STORE_UNAVAILABLE',
    'Оповещения временно недоступны.',
  );
}

async function inAppEnabled(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: Pick<NotificationInboxRepository, 'getRuntimeSettings'>,
  tenantId: string,
): Promise<boolean> {
  const settings = await repository.getRuntimeSettings(tenantId);
  if (settings.inAppEnabled) return true;
  sendApiError(request, reply, 404, 'NOTIFICATIONS_DISABLED', 'Раздел оповещений не включён.');
  return false;
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: NotificationInboxRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/notifications',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (!(await inAppEnabled(request, reply, options.repository, current.tenantId))) return;

      const query = request.query as Record<string, unknown>;
      const limitValue = query.limit === undefined ? 20 : Number(query.limit);
      const unreadOnlyValue = query.unreadOnly === undefined ? 'false' : query.unreadOnly;
      if (
        !Number.isInteger(limitValue) ||
        limitValue < 1 ||
        limitValue > 100 ||
        (unreadOnlyValue !== 'true' && unreadOnlyValue !== 'false') ||
        (query.cursor !== undefined && typeof query.cursor !== 'string')
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_QUERY_INVALID',
          'Некорректные параметры списка оповещений.',
        );
      }
      const before = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : undefined;
      if (query.cursor !== undefined && !before) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_CURSOR_INVALID',
          'Курсор оповещений недействителен.',
        );
      }

      const page = await options.repository.listInbox({
        tenantId: current.tenantId,
        userId: current.userId,
        limit: limitValue,
        unreadOnly: unreadOnlyValue === 'true',
        ...(before ? { before } : {}),
      });
      return {
        items: page.items,
        unreadCount: page.unreadCount,
        ...(page.next ? { nextCursor: encodeCursor(page.next) } : {}),
      };
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/notifications/read-cursor',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (!(await inAppEnabled(request, reply, options.repository, current.tenantId))) return;

      const body = request.body as Record<string, unknown> | null;
      const throughId = body?.throughId;
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof throughId !== 'string' ||
        !UUID_PATTERN.test(throughId)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'NOTIFICATION_READ_CURSOR_INVALID',
          'Не указано оповещение, до которого нужно отметить прочтение.',
        );
      }
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string') {
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Для этой операции требуется корректный Idempotency-Key.',
        );
      }

      const result = await options.repository.markReadThrough({
        tenantId: current.tenantId,
        userId: current.userId,
        throughItemId: throughId,
        idempotencyKey,
        correlationId: request.id,
      });
      if (result.outcome === 'not_found') {
        return sendApiError(
          request,
          reply,
          404,
          'NOTIFICATION_NOT_FOUND',
          'Оповещение не найдено.',
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
      return result;
    },
  );
}
