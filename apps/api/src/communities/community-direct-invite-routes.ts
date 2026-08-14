import { createHash } from 'node:crypto';

import type { CommunityDirectInviteService, CommunityDirectInviteView } from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const communityParams = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();
const inviteParams = z
  .object({ tenantKey: z.string().min(1), inviteId: z.string().uuid() })
  .strict();
const createBody = z
  .object({ expectedIssuerMembershipRevision: z.number().int().nonnegative() })
  .strict();
const tokenBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) }).strict();
const redeemBody = tokenBody
  .extend({
    expectedInviteRevision: z.number().int().positive(),
    expectedMembershipRevision: z.number().int().nonnegative(),
  })
  .strict();
const revokeBody = z.object({ expectedInviteRevision: z.number().int().positive() }).strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(16).max(1_024).optional(),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  return current.tenantId && current.padlHubClaims?.sub
    ? { tenantId: current.tenantId, userId: current.padlHubClaims.sub }
    : undefined;
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function state(invite: CommunityDirectInviteView) {
  return {
    id: invite.id,
    communityId: invite.communityId,
    status: invite.state,
    revision: invite.revision,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    updatedAt: invite.updatedAt,
  };
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

export function registerCommunityDirectInviteRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityDirectInviteService;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/direct-invites',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется вход.');
      if (!options.service) return unavailable(request, reply);
      const params = communityParams.safeParse(request.params);
      const query = listQuery.safeParse(request.query);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DIRECT_INVITE_LIST_INVALID',
          'Проверьте параметры списка.',
        );
      }
      try {
        const result = await options.service.listActive({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          limit: query.data.limit,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
          correlationId: request.id,
        });
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        if (result.outcome !== 'found') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_DIRECT_INVITE_LIST_FORBIDDEN',
            'Нет права на просмотр приглашений.',
          );
        }
        return {
          items: result.items.map(state),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_DIRECT_INVITE_LIST_FAILED', correlationId: request.id },
          'community direct invite list failed',
        );
        return unavailable(request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/direct-invites',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется вход.');
      }
      if (!options.service) return unavailable(request, reply);
      const params = communityParams.safeParse(request.params);
      const body = createBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DIRECT_INVITE_CREATE_INVALID',
          'Неверная команда.',
        );
      }
      try {
        const result = await options.service.issue({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          expectedIssuerMembershipRevision: body.data.expectedIssuerMembershipRevision,
          idempotencyKey,
          requestHash: requestHash({ communityId: params.data.communityId, ...body.data }),
          correlationId: request.id,
        });
        if (result.outcome === 'issued') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return reply.code(201).send({ ...state(result.invite), token: result.token });
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
        if (result.outcome === 'issuer_membership_revision_conflict') {
          return sendApiError(
            request,
            reply,
            409,
            'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT',
            'Права уже изменились. Обновите данные.',
          );
        }
        if (
          result.outcome === 'active_limit_exceeded' ||
          result.outcome === 'daily_limit_exceeded'
        ) {
          reply.header('Retry-After', String(result.retryAfterSeconds));
          return sendApiError(
            request,
            reply,
            429,
            result.outcome === 'active_limit_exceeded'
              ? 'COMMUNITY_DIRECT_INVITE_ACTIVE_LIMIT_EXCEEDED'
              : 'COMMUNITY_DIRECT_INVITE_DAILY_LIMIT_EXCEEDED',
            result.outcome === 'active_limit_exceeded'
              ? 'Отзовите одну из пяти активных ссылок или повторите позже.'
              : 'За последние 24 часа создано 20 приглашений.',
          );
        }
        return sendApiError(
          request,
          reply,
          403,
          'COMMUNITY_DIRECT_INVITE_CREATE_FORBIDDEN',
          'Нет права на создание приглашения.',
        );
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_DIRECT_INVITE_CREATE_FAILED', correlationId: request.id },
          'community direct invite create failed',
        );
        return unavailable(request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/community-direct-invites/preview',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      if (!current) return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется вход.');
      if (!options.service) return unavailable(request, reply);
      const body = tokenBody.safeParse(request.body);
      if (!body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DIRECT_INVITE_TOKEN_INVALID',
          'Ссылка повреждена.',
        );
      }
      try {
        const result = await options.service.preview({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          token: body.data.token,
          correlationId: request.id,
        });
        if (result.outcome === 'found') {
          return {
            inviteId: result.preview.inviteId,
            inviteRevision: result.preview.inviteRevision,
            community: {
              id: result.preview.communityId,
              title: result.preview.title,
              logoUrl: result.preview.logoUrl,
              isVerified: result.preview.isVerified,
              visibility: result.preview.visibility,
            },
            expiresAt: result.preview.expiresAt,
            membershipRevision: result.preview.membershipRevision,
            redeemAction: result.preview.redeemAction,
          };
        }
        if (result.outcome === 'membership_banned' || result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_DIRECT_INVITE_REDEEM_FORBIDDEN',
            'Вступление по ссылке недоступно.',
          );
        }
        return sendApiError(
          request,
          reply,
          404,
          'COMMUNITY_DIRECT_INVITE_NOT_FOUND',
          'Приглашение недействительно.',
        );
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_DIRECT_INVITE_PREVIEW_FAILED', correlationId: request.id },
          'community direct invite preview failed',
        );
        return unavailable(request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/community-direct-invites/redeem',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется вход.');
      }
      if (!options.service) return unavailable(request, reply);
      const body = redeemBody.safeParse(request.body);
      if (!body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DIRECT_INVITE_REDEEM_INVALID',
          'Неверная команда.',
        );
      }
      try {
        const result = await options.service.redeem({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          token: body.data.token,
          confirmed: true,
          expectedInviteRevision: body.data.expectedInviteRevision,
          expectedMembershipRevision: body.data.expectedMembershipRevision,
          idempotencyKey,
          requestHash: requestHash(body.data),
          correlationId: request.id,
        });
        if (result.outcome === 'redeemed') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return {
            communityId: result.membership.communityId,
            membershipStatus: 'ACTIVE',
            role: 'MEMBER',
            membershipRevision: result.membership.revision,
            joinRequest: null,
            joinAction: 'OPEN_COMMUNITY',
            updatedAt: result.membership.updatedAt,
          };
        }
        if (result.outcome === 'invalid_invite') {
          return sendApiError(
            request,
            reply,
            404,
            'COMMUNITY_DIRECT_INVITE_NOT_FOUND',
            'Приглашение недействительно.',
          );
        }
        if (result.outcome === 'membership_banned' || result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_DIRECT_INVITE_REDEEM_FORBIDDEN',
            'Вступление по ссылке недоступно.',
          );
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
        if (result.outcome === 'confirmation_required') {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_DIRECT_INVITE_CONFIRMATION_REQUIRED',
            'Нужно явное подтверждение.',
          );
        }
        const code =
          result.outcome === 'invite_revision_conflict'
            ? 'COMMUNITY_DIRECT_INVITE_REVISION_CONFLICT'
            : result.outcome === 'request_pending'
              ? 'COMMUNITY_DIRECT_INVITE_REQUEST_PENDING'
              : 'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT';
        return sendApiError(request, reply, 409, code, 'Состояние вступления изменилось.');
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_DIRECT_INVITE_REDEEM_FAILED', correlationId: request.id },
          'community direct invite redeem failed',
        );
        return unavailable(request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/community-direct-invites/:inviteId/revoke',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется вход.');
      }
      if (!options.service) return unavailable(request, reply);
      const params = inviteParams.safeParse(request.params);
      const body = revokeBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DIRECT_INVITE_REVOKE_INVALID',
          'Неверная команда.',
        );
      }
      try {
        const result = await options.service.revoke({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          inviteId: params.data.inviteId,
          expectedInviteRevision: body.data.expectedInviteRevision,
          idempotencyKey,
          requestHash: requestHash({ inviteId: params.data.inviteId, ...body.data }),
          correlationId: request.id,
        });
        if (result.outcome === 'revoked') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return state(result.invite);
        }
        if (result.outcome === 'invite_not_found') {
          return sendApiError(
            request,
            reply,
            404,
            'COMMUNITY_DIRECT_INVITE_NOT_FOUND',
            'Приглашение не найдено.',
          );
        }
        if (result.outcome === 'actor_not_active' || result.outcome === 'permission_denied') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_DIRECT_INVITE_REVOKE_FORBIDDEN',
            'Нет права на отзыв приглашения.',
          );
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
        return sendApiError(
          request,
          reply,
          409,
          'COMMUNITY_DIRECT_INVITE_REVISION_CONFLICT',
          'Приглашение уже изменилось.',
        );
      } catch {
        request.log.warn(
          { code: 'COMMUNITY_DIRECT_INVITE_REVOKE_FAILED', correlationId: request.id },
          'community direct invite revoke failed',
        );
        return unavailable(request, reply);
      }
    },
  );
}
