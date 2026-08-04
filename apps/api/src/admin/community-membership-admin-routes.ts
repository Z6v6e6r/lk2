import { createHash } from 'node:crypto';

import {
  CommunityMembershipLifecycleError,
  type CommunityApproveJoinResult,
  type CommunityMembershipLifecycleService,
  type CommunityRejectJoinResult,
} from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const listParamsSchema = z.object({ tenantKey: z.string().min(1) }).strict();
const decisionParamsSchema = listParamsSchema.extend({ requestId: z.string().uuid() }).strict();
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    communityId: z.string().uuid().optional(),
    cursor: z.string().min(16).max(512).optional(),
  })
  .strict();
const decisionBodySchema = z
  .object({
    expectedMembershipRevision: z.number().int().nonnegative(),
    expectedRequestRevision: z.number().int().positive(),
  })
  .strict();
const rejectBodySchema = decisionBodySchema
  .extend({
    reasonCode: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; actorUserId: string } | undefined {
  const tenantId = request.tenantId;
  const actorUserId = request.padlHubClaims?.sub;
  return tenantId && actorUserId ? { tenantId, actorUserId } : undefined;
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: 'communities.moderation.read' | 'communities.join.decide',
): boolean {
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
    'COMMUNITY_MODERATION_PERMISSION_REQUIRED',
    'Нет права на обработку заявок сообществ.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_MODERATION_UNAVAILABLE',
    'Очередь заявок временно недоступна.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function decisionResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  result: CommunityApproveJoinResult | CommunityRejectJoinResult,
) {
  if (result.outcome === 'approved' || result.outcome === 'rejected') {
    reply.header('X-Idempotent-Replayed', String(result.replayed));
    return {
      outcome: result.outcome === 'approved' ? 'APPROVED' : 'REJECTED',
      requestId: result.request.id,
      communityId: result.request.communityId,
      requesterUserId: result.request.userId,
      requestStatus: result.request.state,
      requestRevision: result.request.revision,
      membershipStatus: result.membership.status === 'ABSENT' ? 'NONE' : result.membership.status,
      membershipRevision: result.membership.revision,
      reasonCode: result.request.reasonCode ?? null,
      decidedAt: result.request.decidedAt,
      replayed: result.replayed,
    };
  }
  switch (result.outcome) {
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key уже использован для другой команды.',
      );
    case 'membership_revision_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT',
        'Участие уже изменилось. Обновите очередь.',
      );
    case 'request_revision_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_JOIN_REQUEST_REVISION_CONFLICT',
        'Заявка уже изменилась. Обновите очередь.',
      );
    case 'community_not_found':
      return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
    case 'request_not_found':
      return sendApiError(
        request,
        reply,
        404,
        'COMMUNITY_JOIN_REQUEST_NOT_FOUND',
        'Заявка не найдена.',
      );
    case 'request_not_pending':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_JOIN_REQUEST_NOT_PENDING',
        'Заявка уже обработана.',
      );
    case 'membership_banned':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEMBERSHIP_BANNED',
        'Заблокированного пользователя нельзя одобрить.',
      );
    case 'actor_not_active':
    case 'permission_denied':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_MODERATION_PERMISSION_REQUIRED',
        'Нет права на обработку заявки.',
      );
  }
}

export function registerCommunityMembershipAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityMembershipLifecycleService;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/community-join-requests/pending',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!requirePermission(request, reply, 'communities.moderation.read')) return;
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service) return unavailable(request, reply);
      const params = listParamsSchema.safeParse(request.params);
      const query = listQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MODERATION_QUERY_INVALID',
          'Проверьте параметры очереди.',
        );
      }
      try {
        const result = await options.service.listPending({
          ...current,
          limit: query.data.limit,
          ...(query.data.communityId === undefined ? {} : { communityId: query.data.communityId }),
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
          correlationId: request.id,
        });
        if (result.outcome === 'found') {
          return {
            items: result.items.map(({ request: item, membershipRevision }) => ({
              requestId: item.id,
              communityId: item.communityId,
              requesterUserId: item.userId,
              kind: item.originStatus === 'ABSENT' ? 'JOIN' : 'REJOIN',
              status: item.state,
              membershipStatus: 'PENDING',
              membershipRevision,
              requestRevision: item.revision,
              requestedAt: item.requestedAt,
            })),
            ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
          };
        }
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        return sendApiError(
          request,
          reply,
          403,
          'COMMUNITY_MODERATION_PERMISSION_REQUIRED',
          'Нет права на просмотр заявок.',
        );
      } catch (error: unknown) {
        const code =
          error instanceof CommunityMembershipLifecycleError
            ? error.code
            : 'COMMUNITY_MODERATION_LIST_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community join request list failed');
        return unavailable(request, reply);
      }
    },
  );

  for (const decision of ['approve', 'reject'] as const) {
    app.post(
      `/admin/api/v1/:tenantKey/community-join-requests/:requestId/${decision}`,
      { preHandler: [...options.commandHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!requirePermission(request, reply, 'communities.join.decide')) return;
        const current = principal(request);
        const idempotencyKey = request.headers['idempotency-key'];
        if (!current || typeof idempotencyKey !== 'string') {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        if (!options.service) return unavailable(request, reply);
        const params = decisionParamsSchema.safeParse(request.params);
        const body =
          decision === 'approve'
            ? decisionBodySchema.safeParse(request.body)
            : rejectBodySchema.safeParse(request.body);
        if (!params.success || !body.success) {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_MODERATION_COMMAND_INVALID',
            'Проверьте параметры решения.',
          );
        }
        const command = {
          ...current,
          requestId: params.data.requestId,
          expectedMembershipRevision: body.data.expectedMembershipRevision,
          expectedRequestRevision: body.data.expectedRequestRevision,
          idempotencyKey,
          requestHash: requestHash({
            decision,
            requestId: params.data.requestId,
            ...body.data,
          }),
          correlationId: request.id,
        };
        try {
          const result =
            decision === 'approve'
              ? await options.service.approve(command)
              : await options.service.reject({
                  ...command,
                  reasonCode: rejectBodySchema.parse(request.body).reasonCode,
                });
          return decisionResponse(request, reply, result);
        } catch (error: unknown) {
          const code =
            error instanceof CommunityMembershipLifecycleError
              ? error.code
              : 'COMMUNITY_MODERATION_DECISION_FAILED';
          request.log.warn({ code, correlationId: request.id }, 'community join decision failed');
          return unavailable(request, reply);
        }
      },
    );
  }
}
