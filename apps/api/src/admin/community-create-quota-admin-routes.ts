import { createHash } from 'node:crypto';

import { COMMUNITY_CREATE_QUOTA_SCOPES, type CommunityCreateService } from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const paramsSchema = z.object({ tenantKey: z.string().min(1), userId: z.string().uuid() }).strict();
const bodySchema = z
  .object({
    scopes: z
      .array(z.enum(COMMUNITY_CREATE_QUOTA_SCOPES))
      .min(1)
      .max(2)
      .refine((value) => new Set(value).size === value.length),
    reasonCode: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    ticketId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; actorUserId: string } | undefined {
  const tenantId = request.tenantId;
  const actorUserId = request.padlHubClaims?.sub;
  return tenantId && actorUserId ? { tenantId, actorUserId } : undefined;
}

function requireGrantPermission(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  if (
    request.padlHubClaims?.roles.includes('admin') &&
    request.padlHubClaims.permissions.includes('communities.create.quota.override')
  ) {
    return true;
  }
  sendApiError(
    request,
    reply,
    403,
    'COMMUNITY_CREATE_QUOTA_GRANT_PERMISSION_REQUIRED',
    'Нет права на исключение из лимита создания сообществ.',
  );
  return false;
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_COMMAND_UNAVAILABLE',
    'Исключения из лимита создания временно недоступны.',
  );
}

export function registerCommunityCreateQuotaAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityCreateService;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/admin/api/v1/:tenantKey/users/:userId/community-create-quota-grants',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!requireGrantPermission(request, reply)) return;
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service?.createQuotaGrant) return unavailable(request, reply);
      const params = paramsSchema.safeParse(request.params);
      const body = bodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_CREATE_QUOTA_GRANT_INVALID',
          'Проверьте пользователя, scopes, код причины и ticket ID.',
        );
      }

      try {
        const result = await options.service.createQuotaGrant({
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          subjectUserId: params.data.userId,
          capability: 'communities.create.quota.override',
          scopes: body.data.scopes,
          reasonCode: body.data.reasonCode,
          ticketId: body.data.ticketId,
          idempotencyKey,
          requestHash: requestHash({ subjectUserId: params.data.userId, ...body.data }),
          correlationId: request.id,
        });
        if (result.outcome === 'granted') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return reply.code(201).send({
            id: result.grant.id,
            subjectUserId: result.grant.subjectUserId,
            scopes: result.grant.scopes,
            status: result.grant.state,
            revision: result.grant.revision,
            expiresAt: result.grant.expiresAt,
            createdAt: result.grant.createdAt,
            updatedAt: result.grant.updatedAt,
            consumedAt: result.grant.consumedAt,
            replayed: result.replayed,
          });
        }
        if (result.outcome === 'idempotency_conflict') {
          return sendApiError(
            request,
            reply,
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key уже использован.',
          );
        }
        if (result.outcome === 'active_grant_exists') {
          return sendApiError(
            request,
            reply,
            409,
            'COMMUNITY_CREATE_QUOTA_GRANT_ACTIVE',
            'Для пользователя уже есть активное исключение.',
          );
        }
        if (result.outcome === 'subject_not_active') {
          return sendApiError(
            request,
            reply,
            409,
            'COMMUNITY_CREATE_QUOTA_GRANT_SUBJECT_INACTIVE',
            'Пользователь должен быть активным.',
          );
        }
        return sendApiError(
          request,
          reply,
          403,
          'COMMUNITY_CREATE_QUOTA_GRANT_ACTOR_INACTIVE',
          'Оператор неактивен.',
        );
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_CREATE_QUOTA_GRANT_FAILED', correlationId: request.id },
          'community create quota grant failed',
        );
        return unavailable(request, reply);
      }
    },
  );
}
