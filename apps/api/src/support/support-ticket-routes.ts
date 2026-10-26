import { createHash } from 'node:crypto';
import {
  decodeSupportTicketCursor,
  SupportTicketPermissionError,
  type SupportMutationResult,
  type SupportTicketRepository,
} from '@phub/database/support-tickets';
import {
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
} from '@phub/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../http-errors.js';

const cursor = z
  .string()
  .min(8)
  .max(512)
  .refine((value) => decodeSupportTicketCursor(value) !== undefined);
const ticketParams = z
  .object({ tenantKey: z.string().min(1), ticketId: z.string().uuid() })
  .strict();
const listQuery = z
  .object({
    cursor: cursor.optional(),
    status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
    category: z.enum(SUPPORT_TICKET_CATEGORIES).optional(),
    priority: z.enum(SUPPORT_TICKET_PRIORITIES).optional(),
    query: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const detailQuery = z.object({ before: cursor.optional() }).strict();
const createBody = z
  .object({
    subject: z.string().trim().min(1).max(300),
    category: z.enum(SUPPORT_TICKET_CATEGORIES),
    body: z.string().trim().min(1).max(8000),
  })
  .strict();
const userMessageBody = z
  .object({
    body: z.string().trim().min(1).max(8000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
const adminMessageBody = userMessageBody.extend({ internal: z.boolean().default(false) }).strict();
const updateBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
    priority: z.enum(SUPPORT_TICKET_PRIORITIES).optional(),
    category: z.enum(SUPPORT_TICKET_CATEGORIES).optional(),
    assignedTo: z.string().uuid().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'));

/** Hash parsed command semantics, including operation and target, in a stable field order. */
export function supportCommandHash(
  operation: 'CREATE' | 'USER_MESSAGE' | 'ADMIN_MESSAGE' | 'UPDATE',
  ticketId: string | null,
  body: Readonly<Record<string, unknown>>,
): string {
  const canonical = Object.fromEntries(
    Object.entries(body)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256')
    .update(JSON.stringify({ operation, ticketId, body: canonical }))
    .digest('hex');
}
function current(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  return request.tenantId && request.padlHubClaims?.sub
    ? { tenantId: request.tenantId, userId: request.padlHubClaims.sub }
    : undefined;
}
function allowAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: 'support.read' | 'support.manage',
): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  const claims = request.padlHubClaims;
  if (
    claims?.roles.includes('admin') &&
    (claims.permissions.includes(permission) ||
      (permission === 'support.read' && claims.permissions.includes('support.manage')))
  )
    return true;
  sendApiError(
    request,
    reply,
    403,
    'SUPPORT_PERMISSION_REQUIRED',
    'Нет права на обращения поддержки.',
  );
  return false;
}
function mutationResult(
  request: FastifyRequest,
  reply: FastifyReply,
  result: SupportMutationResult,
) {
  if (result.outcome === 'applied') {
    reply.header('X-Idempotent-Replayed', String(result.replayed));
    return result.ticket;
  }
  const status =
    result.outcome === 'receipt_expired'
      ? 410
      : result.outcome === 'rate_limited'
        ? 429
        : result.outcome === 'not_found'
          ? 404
          : result.outcome === 'forbidden'
            ? 403
            : 409;
  const code =
    result.outcome === 'conversation_archived'
      ? 'SUPPORT_CONVERSATION_ARCHIVED'
      : result.outcome === 'receipt_expired'
        ? 'SUPPORT_COMMAND_EXPIRED'
        : result.outcome === 'rate_limited'
          ? 'SUPPORT_RATE_LIMITED'
          : result.outcome === 'ticket_limit'
            ? 'SUPPORT_TICKET_LIMIT'
            : result.outcome === 'content_limit'
              ? 'SUPPORT_TICKET_CONTENT_LIMIT'
              : result.outcome === 'version_conflict'
                ? 'SUPPORT_TICKET_VERSION_CONFLICT'
                : result.outcome === 'idempotency_conflict'
                  ? 'IDEMPOTENCY_KEY_REUSED'
                  : result.outcome === 'forbidden'
                    ? 'SUPPORT_PERMISSION_REQUIRED'
                    : 'SUPPORT_TICKET_NOT_FOUND';
  return sendApiError(request, reply, status, code, 'Не удалось изменить обращение.');
}
export function registerSupportTicketRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: SupportTicketRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
    readonly adminAuthenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly adminCommandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const unavailable = (request: FastifyRequest, reply: FastifyReply) =>
    sendApiError(request, reply, 503, 'SUPPORT_UNAVAILABLE', 'Поддержка временно недоступна.');
  const queryInvalid = (request: FastifyRequest, reply: FastifyReply) =>
    sendApiError(request, reply, 400, 'SUPPORT_QUERY_INVALID', 'Проверьте параметры.');
  const authRequired = (request: FastifyRequest, reply: FastifyReply) =>
    sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.includes('/support/tickets')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const userBase = '/user/api/v1/:tenantKey/support/tickets';
  const adminBase = '/admin/api/v1/:tenantKey/support/tickets';
  for (const admin of [false, true]) {
    const base = admin ? adminBase : userBase;
    const readHandlers = admin
      ? options.adminAuthenticatedTenantHandlers
      : options.authenticatedTenantHandlers;
    const commandHandlers = admin ? options.adminCommandHandlers : options.commandHandlers;
    app.get(base, { preHandler: [...readHandlers] }, async (request, reply) => {
      const actor = current(request);
      if (!actor) return authRequired(request, reply);
      if (admin && !allowAdmin(request, reply, 'support.read')) return;
      if (!options.repository) return unavailable(request, reply);
      const query = listQuery.safeParse(request.query);
      if (!query.success) return queryInvalid(request, reply);
      try {
        return await options.repository.list({
          tenantId: actor.tenantId,
          ...(admin ? { adminActorId: actor.userId } : { ownerUserId: actor.userId }),
          limit: query.data.limit,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
          ...(query.data.status ? { status: query.data.status } : {}),
          ...(query.data.category ? { category: query.data.category } : {}),
          ...(query.data.priority ? { priority: query.data.priority } : {}),
          ...(query.data.query ? { query: query.data.query } : {}),
        });
      } catch (error) {
        if (error instanceof SupportTicketPermissionError)
          return sendApiError(
            request,
            reply,
            403,
            'SUPPORT_PERMISSION_REQUIRED',
            'Нет права на обращения поддержки.',
          );
        throw error;
      }
    });
    app.get(`${base}/:ticketId`, { preHandler: [...readHandlers] }, async (request, reply) => {
      const actor = current(request);
      if (!actor) return authRequired(request, reply);
      if (admin && !allowAdmin(request, reply, 'support.read')) return;
      if (!options.repository) return unavailable(request, reply);
      const params = ticketParams.safeParse(request.params);
      const query = detailQuery.safeParse(request.query);
      if (!params.success || !query.success) return queryInvalid(request, reply);
      try {
        const ticket = await options.repository.get({
          tenantId: actor.tenantId,
          ticketId: params.data.ticketId,
          admin,
          ...(admin ? { adminActorId: actor.userId } : { ownerUserId: actor.userId }),
          ...(query.data.before ? { before: query.data.before } : {}),
        });
        return (
          ticket ??
          sendApiError(request, reply, 404, 'SUPPORT_TICKET_NOT_FOUND', 'Обращение не найдено.')
        );
      } catch (error) {
        if (error instanceof SupportTicketPermissionError)
          return sendApiError(
            request,
            reply,
            403,
            'SUPPORT_PERMISSION_REQUIRED',
            'Нет права на обращения поддержки.',
          );
        throw error;
      }
    });
    app.post(
      `${base}/:ticketId/messages`,
      { preHandler: [...commandHandlers] },
      async (request, reply) => {
        const actor = current(request);
        if (!actor) return authRequired(request, reply);
        if (admin && !allowAdmin(request, reply, 'support.manage')) return;
        if (!options.repository) return unavailable(request, reply);
        const params = ticketParams.safeParse(request.params);
        const body = (admin ? adminMessageBody : userMessageBody).safeParse(request.body);
        const key = request.headers['idempotency-key'];
        if (!params.success || !body.success)
          return sendApiError(
            request,
            reply,
            400,
            'SUPPORT_MESSAGE_INVALID',
            'Проверьте сообщение.',
          );
        if (typeof key !== 'string' || key.length < 16 || key.length > 128)
          return sendApiError(
            request,
            reply,
            400,
            'IDEMPOTENCY_KEY_REQUIRED',
            'Требуется ключ операции.',
          );
        return mutationResult(
          request,
          reply,
          await options.repository.message({
            tenantId: actor.tenantId,
            ticketId: params.data.ticketId,
            actorId: actor.userId,
            body: body.data.body,
            expectedVersion: body.data.expectedVersion,
            admin,
            ...(admin && 'internal' in body.data && typeof body.data.internal === 'boolean'
              ? { internal: body.data.internal }
              : {}),
            idempotencyKey: key,
            requestHash: supportCommandHash(
              admin ? 'ADMIN_MESSAGE' : 'USER_MESSAGE',
              params.data.ticketId,
              body.data,
            ),
            correlationId: request.id,
          }),
        );
      },
    );
  }
  app.post(userBase, { preHandler: [...options.commandHandlers] }, async (request, reply) => {
    const actor = current(request);
    if (!actor) return authRequired(request, reply);
    if (!options.repository) return unavailable(request, reply);
    const body = createBody.safeParse(request.body);
    const key = request.headers['idempotency-key'];
    if (!body.success)
      return sendApiError(request, reply, 400, 'SUPPORT_TICKET_INVALID', 'Проверьте обращение.');
    if (typeof key !== 'string' || key.length < 16 || key.length > 128)
      return sendApiError(
        request,
        reply,
        400,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Требуется ключ операции.',
      );
    return mutationResult(
      request,
      reply,
      await options.repository.create({
        ...body.data,
        tenantId: actor.tenantId,
        ownerUserId: actor.userId,
        idempotencyKey: key,
        requestHash: supportCommandHash('CREATE', null, body.data),
        correlationId: request.id,
      }),
    );
  });
  app.patch(
    `${adminBase}/:ticketId`,
    { preHandler: [...options.adminCommandHandlers] },
    async (request, reply) => {
      const actor = current(request);
      if (!actor) return authRequired(request, reply);
      if (!allowAdmin(request, reply, 'support.manage')) return;
      if (!options.repository) return unavailable(request, reply);
      const params = ticketParams.safeParse(request.params);
      const body = updateBody.safeParse(request.body);
      const key = request.headers['idempotency-key'];
      if (!params.success || !body.success)
        return sendApiError(request, reply, 400, 'SUPPORT_TICKET_INVALID', 'Проверьте обращение.');
      if (typeof key !== 'string' || key.length < 16 || key.length > 128)
        return sendApiError(
          request,
          reply,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Требуется ключ операции.',
        );
      return mutationResult(
        request,
        reply,
        await options.repository.update({
          tenantId: actor.tenantId,
          ticketId: params.data.ticketId,
          actorId: actor.userId,
          expectedVersion: body.data.expectedVersion,
          ...(body.data.status ? { status: body.data.status } : {}),
          ...(body.data.priority ? { priority: body.data.priority } : {}),
          ...(body.data.category ? { category: body.data.category } : {}),
          ...(body.data.assignedTo !== undefined ? { assignedTo: body.data.assignedTo } : {}),
          ...(body.data.tags ? { tags: body.data.tags } : {}),
          idempotencyKey: key,
          requestHash: supportCommandHash('UPDATE', params.data.ticketId, body.data),
          correlationId: request.id,
        }),
      );
    },
  );
}
