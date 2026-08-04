import { createHash } from 'node:crypto';

import {
  CommunityCreateError,
  CommunityDirectoryError,
  CommunityMembershipPinError,
  CommunityMembershipLifecycleError,
  CommunityReadError,
  CommunityOwnershipTransferError,
  COMMUNITY_JOIN_POLICIES,
  COMMUNITY_PUBLISHING_PRESETS,
  COMMUNITY_VISIBILITIES,
  communityMembershipPageSchema,
  type CommunityCreateService,
  type CommunityDirectoryService,
  type CommunityMembershipPinService,
  type CommunityMembershipLifecycleService,
  type CommunityOwnMembershipState,
  type CommunityReadService,
  type CommunityOwnershipTransferService,
} from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import { LegacyCommunityReadError } from './legacy-community-read-repository.js';

function principal(
  request: FastifyRequest,
): { tenantId: string; userId: string; permissions: readonly string[] } | undefined {
  const communityRequest = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: {
      readonly sub?: string;
      readonly permissions?: readonly string[];
    };
  };
  const tenantId = communityRequest.tenantId;
  const userId = communityRequest.padlHubClaims?.sub;
  return tenantId && userId
    ? { tenantId, userId, permissions: communityRequest.padlHubClaims?.permissions ?? [] }
    : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_DIRECTORY_UNAVAILABLE',
    'Сообщества временно недоступны.',
  );
}

const membershipPinParamsSchema = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();

const membershipPinBodySchema = z
  .object({
    pinned: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

const communityCreateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2_000).optional(),
    visibility: z.enum(COMMUNITY_VISIBILITIES),
    joinPolicy: z.enum(COMMUNITY_JOIN_POLICIES),
    publishingPreset: z.enum(COMMUNITY_PUBLISHING_PRESETS),
  })
  .strict();

const communityDiscoveryQuerySchema = z
  .object({
    query: z.string().min(2).max(80).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(16).max(1_024).optional(),
  })
  .strict();

const communityDetailParamsSchema = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();

const membershipLifecycleBodySchema = z
  .object({ expectedMembershipRevision: z.number().int().nonnegative() })
  .strict();

const membershipRequestParamsSchema = z
  .object({
    tenantKey: z.string().min(1),
    communityId: z.string().uuid(),
    requestId: z.string().uuid(),
  })
  .strict();

const membershipCancelBodySchema = membershipLifecycleBodySchema
  .extend({ expectedRequestRevision: z.number().int().positive() })
  .strict();

const ownershipTransferBodySchema = z
  .object({
    targetUserId: z.string().uuid(),
    expectedOwnerRevision: z.number().int().positive(),
    expectedTargetRevision: z.number().int().positive(),
  })
  .strict();

const emptyQuerySchema = z.object({}).strict();

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ownMembershipResponse(membership: CommunityOwnMembershipState) {
  const pending = membership.pendingRequest;
  return {
    communityId: membership.communityId,
    membershipStatus: membership.status === 'ABSENT' ? 'NONE' : membership.status,
    role: membership.role,
    membershipRevision: membership.revision,
    joinRequest: pending
      ? {
          id: pending.id,
          communityId: pending.communityId,
          kind: pending.originStatus === 'ABSENT' ? 'JOIN' : 'REJOIN',
          status: pending.state,
          revision: pending.revision,
          createdAt: pending.requestedAt,
          updatedAt: pending.requestedAt,
        }
      : null,
    joinAction: membership.joinAction,
    updatedAt: membership.updatedAt,
  };
}

export function registerCommunityRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityDirectoryService;
    readonly createService?: CommunityCreateService;
    readonly membershipPinService?: CommunityMembershipPinService;
    readonly membershipLifecycleService?: CommunityMembershipLifecycleService;
    readonly readService?: CommunityReadService;
    readonly ownershipTransferService?: CommunityOwnershipTransferService;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/communities',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!current.permissions.includes('communities.create')) {
        return sendApiError(
          request,
          reply,
          403,
          'COMMUNITY_CREATE_PERMISSION_REQUIRED',
          'Нет права на создание сообщества.',
        );
      }
      if (!options.createService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Создание сообщества временно недоступно.',
        );
      }

      const body = communityCreateBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_CREATE_PAYLOAD_INVALID',
          'Проверьте параметры создаваемого сообщества.',
        );
      }

      try {
        const { description, ...requiredBody } = body.data;
        const result = await options.createService.create({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          ...requiredBody,
          ...(description === undefined ? {} : { description }),
          quotaOverride: false,
          idempotencyKey,
          requestHash: requestHash(body.data),
          correlationId: request.id,
        });
        if (result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_CREATE_ACTOR_INELIGIBLE',
            'Создавать сообщества может только активный верифицированный пользователь.',
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
        if (result.outcome === 'active_owner_quota_exceeded') {
          return sendApiError(
            request,
            reply,
            409,
            'COMMUNITY_ACTIVE_OWNER_QUOTA_EXCEEDED',
            'Достигнут лимит из трех активных сообществ во владении.',
          );
        }
        if (result.outcome === 'daily_create_quota_exceeded') {
          reply.header('Retry-After', String(result.retryAfterSeconds));
          return sendApiError(
            request,
            reply,
            429,
            'COMMUNITY_DAILY_CREATE_QUOTA_EXCEEDED',
            'Новое сообщество можно создать позже.',
          );
        }

        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return reply.code(201).send(result.community);
      } catch (error: unknown) {
        if (error instanceof CommunityCreateError) {
          return sendApiError(
            request,
            reply,
            400,
            error.code,
            'Проверьте параметры создаваемого сообщества.',
          );
        }
        request.log.warn(
          { code: 'COMMUNITY_CREATE_FAILED', correlationId: request.id },
          'community create failed',
        );
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Создание сообщества временно недоступно.',
        );
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/communities',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=30');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.readService) return unavailable(request, reply);
      const query = communityDiscoveryQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DISCOVERY_QUERY_INVALID',
          'Проверьте параметры поиска сообществ.',
        );
      }
      try {
        return await options.readService.listDiscoverable({
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          limit: query.data.limit,
          ...(query.data.query === undefined ? {} : { query: query.data.query }),
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        });
      } catch (error: unknown) {
        if (
          error instanceof CommunityReadError &&
          (error.code === 'COMMUNITY_DISCOVERY_QUERY_INVALID' ||
            error.code === 'COMMUNITY_DISCOVERY_CURSOR_INVALID')
        ) {
          return sendApiError(
            request,
            reply,
            400,
            error.code,
            'Проверьте параметры поиска сообществ.',
          );
        }
        request.log.warn(
          { code: 'COMMUNITY_DISCOVERY_FAILED', correlationId: request.id },
          'community discovery failed',
        );
        return unavailable(request, reply);
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/members/me',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.membershipLifecycleService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Участие в сообществе временно недоступно.',
        );
      }
      const params = membershipPinParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEMBERSHIP_COMMAND_INVALID',
          'Проверьте адрес сообщества.',
        );
      }
      try {
        const result = await options.membershipLifecycleService.getOwnState({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          correlationId: request.id,
        });
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        if (result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_MEMBERSHIP_ACTOR_INELIGIBLE',
            'Операция доступна только активному пользователю.',
          );
        }
        return ownMembershipResponse(result.membership);
      } catch (error: unknown) {
        const code =
          error instanceof CommunityMembershipLifecycleError
            ? error.code
            : 'COMMUNITY_MEMBERSHIP_READ_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community membership read failed');
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Участие в сообществе временно недоступно.',
        );
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/members/me/join',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.membershipLifecycleService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Вступление в сообщество временно недоступно.',
        );
      }
      const params = membershipPinParamsSchema.safeParse(request.params);
      const body = membershipLifecycleBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEMBERSHIP_COMMAND_INVALID',
          'Проверьте параметры вступления.',
        );
      }
      try {
        const result = await options.membershipLifecycleService.selfJoin({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          expectedMembershipRevision: body.data.expectedMembershipRevision,
          idempotencyKey,
          requestHash: requestHash({ communityId: params.data.communityId, ...body.data }),
          correlationId: request.id,
        });
        switch (result.outcome) {
          case 'joined':
          case 'requested':
            reply.header('X-Idempotent-Replayed', String(result.replayed));
            return ownMembershipResponse(result.membership);
          case 'idempotency_conflict':
            return sendApiError(
              request,
              reply,
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key уже использован для другой команды.',
            );
          case 'revision_conflict':
            return sendApiError(
              request,
              reply,
              409,
              'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT',
              'Участие уже изменилось. Обновите данные и повторите.',
            );
          case 'community_not_found':
            return sendApiError(
              request,
              reply,
              404,
              'COMMUNITY_NOT_FOUND',
              'Сообщество не найдено.',
            );
          case 'actor_not_active':
            return sendApiError(
              request,
              reply,
              403,
              'COMMUNITY_MEMBERSHIP_ACTOR_INELIGIBLE',
              'Операция доступна только активному пользователю.',
            );
          case 'membership_banned':
            return sendApiError(
              request,
              reply,
              403,
              'COMMUNITY_MEMBERSHIP_BANNED',
              'Вступление в сообщество недоступно.',
            );
          case 'invite_required':
            return sendApiError(
              request,
              reply,
              409,
              'COMMUNITY_INVITE_REQUIRED',
              'Для вступления требуется приглашение.',
            );
          case 'membership_already_active':
            return sendApiError(
              request,
              reply,
              409,
              'COMMUNITY_MEMBERSHIP_ALREADY_ACTIVE',
              'Вы уже состоите в сообществе.',
            );
          case 'request_already_pending':
            return sendApiError(
              request,
              reply,
              409,
              'COMMUNITY_JOIN_REQUEST_ALREADY_PENDING',
              'Заявка уже рассматривается.',
            );
        }
      } catch (error: unknown) {
        const code =
          error instanceof CommunityMembershipLifecycleError
            ? error.code
            : 'COMMUNITY_MEMBERSHIP_JOIN_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community membership join failed');
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Вступление в сообщество временно недоступно.',
        );
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/join-requests/:requestId/cancel',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.membershipLifecycleService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Изменение заявки временно недоступно.',
        );
      }
      const params = membershipRequestParamsSchema.safeParse(request.params);
      const body = membershipCancelBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEMBERSHIP_COMMAND_INVALID',
          'Проверьте параметры отмены заявки.',
        );
      }
      try {
        const result = await options.membershipLifecycleService.cancelPending({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          requestId: params.data.requestId,
          ...body.data,
          idempotencyKey,
          requestHash: requestHash({
            communityId: params.data.communityId,
            requestId: params.data.requestId,
            ...body.data,
          }),
          correlationId: request.id,
        });
        if (result.outcome === 'cancelled') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return ownMembershipResponse(result.membership);
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
        if (
          result.outcome === 'membership_revision_conflict' ||
          result.outcome === 'request_revision_conflict'
        ) {
          return sendApiError(
            request,
            reply,
            409,
            result.outcome === 'membership_revision_conflict'
              ? 'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT'
              : 'COMMUNITY_JOIN_REQUEST_REVISION_CONFLICT',
            'Заявка уже изменилась. Обновите данные и повторите.',
          );
        }
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        if (result.outcome === 'request_not_found') {
          return sendApiError(
            request,
            reply,
            404,
            'COMMUNITY_JOIN_REQUEST_NOT_FOUND',
            'Заявка не найдена.',
          );
        }
        if (result.outcome === 'actor_not_active' || result.outcome === 'membership_banned') {
          return sendApiError(
            request,
            reply,
            403,
            result.outcome === 'membership_banned'
              ? 'COMMUNITY_MEMBERSHIP_BANNED'
              : 'COMMUNITY_MEMBERSHIP_ACTOR_INELIGIBLE',
            'Изменение заявки недоступно.',
          );
        }
        return sendApiError(
          request,
          reply,
          409,
          'COMMUNITY_JOIN_REQUEST_NOT_PENDING',
          'Заявка уже обработана.',
        );
      } catch (error: unknown) {
        const code =
          error instanceof CommunityMembershipLifecycleError
            ? error.code
            : 'COMMUNITY_JOIN_CANCEL_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community join cancel failed');
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Изменение заявки временно недоступно.',
        );
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/members/me/leave',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.membershipLifecycleService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Выход из сообщества временно недоступен.',
        );
      }
      const params = membershipPinParamsSchema.safeParse(request.params);
      const body = membershipLifecycleBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEMBERSHIP_COMMAND_INVALID',
          'Проверьте параметры выхода.',
        );
      }
      try {
        const result = await options.membershipLifecycleService.leave({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          expectedMembershipRevision: body.data.expectedMembershipRevision,
          idempotencyKey,
          requestHash: requestHash({ communityId: params.data.communityId, ...body.data }),
          correlationId: request.id,
        });
        if (result.outcome === 'left') {
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return ownMembershipResponse(result.membership);
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
        if (result.outcome === 'revision_conflict') {
          return sendApiError(
            request,
            reply,
            409,
            'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT',
            'Участие уже изменилось. Обновите данные и повторите.',
          );
        }
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        if (result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_MEMBERSHIP_ACTOR_INELIGIBLE',
            'Операция доступна только активному пользователю.',
          );
        }
        return sendApiError(
          request,
          reply,
          409,
          result.outcome === 'owner_cannot_leave'
            ? 'COMMUNITY_OWNER_TRANSFER_REQUIRED'
            : 'COMMUNITY_MEMBERSHIP_NOT_ACTIVE',
          result.outcome === 'owner_cannot_leave'
            ? 'Сначала передайте владение сообществом.'
            : 'Активное участие не найдено.',
        );
      } catch (error: unknown) {
        const code =
          error instanceof CommunityMembershipLifecycleError
            ? error.code
            : 'COMMUNITY_MEMBERSHIP_LEAVE_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community membership leave failed');
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Выход из сообщества временно недоступен.',
        );
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.readService) return unavailable(request, reply);
      const params = communityDetailParamsSchema.safeParse(request.params);
      const query = emptyQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_DETAIL_QUERY_INVALID',
          'Проверьте адрес сообщества.',
        );
      }
      try {
        const result = await options.readService.getDetail({
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          communityId: params.data.communityId,
        });
        if (result.outcome === 'not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        return result.detail;
      } catch (error: unknown) {
        const code = error instanceof CommunityReadError ? error.code : 'COMMUNITY_DETAIL_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community detail failed');
        return unavailable(request, reply);
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/communities/mine',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, max-age=15, stale-while-revalidate=30');
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.service) return unavailable(request, reply);

      const query = request.query as Record<string, unknown>;
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (query.cursor !== undefined &&
          (typeof query.cursor !== 'string' || query.cursor.length > 512))
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_QUERY_INVALID',
          'Некорректные параметры списка сообществ.',
        );
      }

      try {
        const page = await options.service.listMemberships({
          tenantId: current.tenantId,
          userId: current.userId,
          correlationId: request.id,
          limit,
          ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}),
        });
        const parsed = communityMembershipPageSchema.safeParse(page);
        if (!parsed.success) return unavailable(request, reply);
        return parsed.data;
      } catch (error: unknown) {
        if (error instanceof CommunityDirectoryError && error.code === 'COMMUNITY_CURSOR_INVALID') {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_CURSOR_INVALID',
            'Курсор списка сообществ недействителен.',
          );
        }
        const code =
          error instanceof LegacyCommunityReadError || error instanceof CommunityDirectoryError
            ? error.code
            : 'COMMUNITY_DIRECTORY_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community directory read failed');
        return unavailable(request, reply);
      }
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/communities/:communityId/members/me/pin',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.membershipPinService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Изменение сообщества временно недоступно.',
        );
      }

      const params = membershipPinParamsSchema.safeParse(request.params);
      const body = membershipPinBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEMBERSHIP_PIN_PAYLOAD_INVALID',
          'Проверьте параметры закрепления сообщества.',
        );
      }

      try {
        const result = await options.membershipPinService.setPin({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          pinned: body.data.pinned,
          expectedRevision: body.data.expectedRevision,
          idempotencyKey,
          requestHash: requestHash({
            communityId: params.data.communityId,
            ...body.data,
          }),
          correlationId: request.id,
        });
        if (result.outcome === 'membership_not_found') {
          return sendApiError(
            request,
            reply,
            404,
            'COMMUNITY_ACTIVE_MEMBERSHIP_NOT_FOUND',
            'Активное участие в сообществе не найдено.',
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
        if (result.outcome === 'revision_conflict') {
          return sendApiError(
            request,
            reply,
            409,
            'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT',
            'Участие в сообществе уже изменилось. Обновите данные и повторите.',
          );
        }
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return result.membership;
      } catch (error: unknown) {
        const code =
          error instanceof CommunityMembershipPinError
            ? error.code
            : 'COMMUNITY_MEMBERSHIP_PIN_FAILED';
        request.log.warn({ code, correlationId: request.id }, 'community membership pin failed');
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Изменение сообщества временно недоступно.',
        );
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/ownership-transfers',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.ownershipTransferService) {
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Передача сообщества временно недоступна.',
        );
      }
      const params = communityDetailParamsSchema.safeParse(request.params);
      const body = ownershipTransferBodySchema.safeParse(request.body);
      if (!params.success || !body.success || body.data.targetUserId === current.userId) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_OWNERSHIP_TRANSFER_INVALID',
          'Проверьте параметры передачи сообщества.',
        );
      }

      try {
        const result = await options.ownershipTransferService.transfer({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          targetUserId: body.data.targetUserId,
          expectedOwnerRevision: body.data.expectedOwnerRevision,
          expectedTargetRevision: body.data.expectedTargetRevision,
          idempotencyKey,
          requestHash: requestHash({ communityId: params.data.communityId, ...body.data }),
          correlationId: request.id,
        });
        switch (result.outcome) {
          case 'idempotency_conflict':
            return sendApiError(
              request,
              reply,
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'Idempotency-Key уже использован для другой команды.',
            );
          case 'actor_not_active':
            return sendApiError(
              request,
              reply,
              403,
              'COMMUNITY_OWNERSHIP_ACTOR_INELIGIBLE',
              'Передать сообщество может только активный владелец.',
            );
          case 'community_not_found':
            return sendApiError(
              request,
              reply,
              404,
              'COMMUNITY_NOT_FOUND',
              'Сообщество не найдено.',
            );
          case 'actor_not_owner':
            return sendApiError(
              request,
              reply,
              403,
              'COMMUNITY_OWNER_REQUIRED',
              'Передать сообщество может только его владелец.',
            );
          case 'target_not_active':
            return sendApiError(
              request,
              reply,
              409,
              'COMMUNITY_OWNERSHIP_TARGET_NOT_ACTIVE',
              'Новый владелец должен быть активным участником сообщества.',
            );
          case 'owner_revision_conflict':
          case 'target_revision_conflict':
            return sendApiError(
              request,
              reply,
              409,
              'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT',
              'Состав или роли сообщества уже изменились. Обновите данные и повторите.',
            );
          case 'transferred':
            reply.header('X-Idempotent-Replayed', String(result.replayed));
            return result.transfer;
        }
      } catch (error: unknown) {
        const code =
          error instanceof CommunityOwnershipTransferError
            ? error.code
            : 'COMMUNITY_OWNERSHIP_TRANSFER_FAILED';
        request.log.warn(
          { code, correlationId: request.id },
          'community ownership transfer failed',
        );
        return sendApiError(
          request,
          reply,
          503,
          'COMMUNITY_COMMAND_UNAVAILABLE',
          'Передача сообщества временно недоступна.',
        );
      }
    },
  );
}
