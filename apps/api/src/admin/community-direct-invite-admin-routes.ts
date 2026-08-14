import { createHash } from 'node:crypto';

import type { CommunityDirectInviteService } from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const paramsSchema = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();
const bodySchema = z
  .object({
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
    request.padlHubClaims.permissions.includes('communities.invite.quota.override')
  ) {
    return true;
  }
  sendApiError(
    request,
    reply,
    403,
    'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_PERMISSION_REQUIRED',
    'Нет права на исключение из лимита приглашений.',
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
    'Приглашения временно недоступны.',
  );
}

export function registerCommunityDirectInviteAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityDirectInviteService;
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/admin/api/v1/:tenantKey/communities/:communityId/direct-invite-quota-grants',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!requireGrantPermission(request, reply)) return;
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service) return unavailable(request, reply);
      const params = paramsSchema.safeParse(request.params);
      const body = bodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_INVALID',
          'Проверьте код причины и ticket ID.',
        );
      }
      try {
        const result = await options.service.createQuotaGrant({
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          communityId: params.data.communityId,
          capability: 'communities.invite.quota.override',
          reasonCode: body.data.reasonCode,
          ticketId: body.data.ticketId,
          idempotencyKey,
          requestHash: requestHash({
            communityId: params.data.communityId,
            reasonCode: body.data.reasonCode,
            ticketId: body.data.ticketId,
          }),
          correlationId: request.id,
        });
        if (result.outcome === 'granted') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return reply.code(201).send({
            id: result.grant.id,
            communityId: result.grant.communityId,
            status: result.grant.state,
            revision: result.grant.revision,
            expiresAt: result.grant.expiresAt,
            createdAt: result.grant.createdAt,
            updatedAt: result.grant.updatedAt,
            consumedAt: result.grant.consumedAt,
            replayed: result.replayed,
          });
        }
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
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
            'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_ACTIVE',
            'Для сообщества уже есть активное исключение.',
          );
        }
        return sendApiError(
          request,
          reply,
          403,
          'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_ACTOR_INACTIVE',
          'Оператор неактивен.',
        );
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_FAILED', correlationId: request.id },
          'community direct invite quota grant failed',
        );
        return unavailable(request, reply);
      }
    },
  );
}
