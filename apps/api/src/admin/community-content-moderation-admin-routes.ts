import { createHash } from 'node:crypto';

import {
  CommunityContentModerationError,
  COMMUNITY_MEDIA_VARIANTS,
  type CommunityContentModerationFailure,
  type CommunityContentModerationService,
} from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type {
  CommunityMediaPersistenceRepository,
  CommunityMediaReplayResult,
} from '@phub/database';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import type { CommunityMediaObjectStore } from '../communities/community-media-object-store.js';
import type { CommunityMediaDeliveryAuthorizer } from '../communities/community-media-routes.js';

const listParams = z.object({ tenantKey: z.string().min(1) }).strict();
const postParams = listParams
  .extend({ communityId: z.string().uuid(), postId: z.string().uuid() })
  .strict();
const commentParams = postParams.extend({ commentId: z.string().uuid() }).strict();
const mediaVariantParams = listParams
  .extend({
    communityId: z.string().uuid(),
    mediaId: z.string().uuid(),
    variant: z.enum(COMMUNITY_MEDIA_VARIANTS),
  })
  .strict();
const mediaScanReplayParams = listParams.extend({ mediaId: z.string().uuid() }).strict();
const mediaGcReplayParams = listParams.extend({ jobId: z.string().uuid() }).strict();
const listQuery = z
  .object({
    communityId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(16).max(1024).optional(),
  })
  .strict();
const revisionBody = z.object({ expectedRevision: z.number().int().positive() }).strict();
const reasonedBody = revisionBody
  .extend({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) })
  .strict();
const replayBody = z.object({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) }).strict();

function principal(request: FastifyRequest) {
  return request.tenantId && request.padlHubClaims?.sub
    ? { tenantId: request.tenantId, actorUserId: request.padlHubClaims.sub }
    : undefined;
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: 'communities.content.moderation.read' | 'communities.content.moderation.decide',
) {
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
    'COMMUNITY_CONTENT_MODERATION_PERMISSION_REQUIRED',
    'Нет права на модерацию контента сообществ.',
  );
  return false;
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failure(
  request: FastifyRequest,
  reply: FastifyReply,
  result: CommunityContentModerationFailure,
) {
  switch (result.outcome) {
    case 'idempotency_conflict':
      return sendApiError(request, reply, 409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован.');
    case 'actor_not_active':
    case 'permission_denied':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_CONTENT_MODERATION_PERMISSION_REQUIRED',
        'Нет права на модерацию контента.',
      );
    case 'community_not_found':
      return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
    case 'post_not_found':
      return sendApiError(request, reply, 404, 'COMMUNITY_POST_NOT_FOUND', 'Пост не найден.');
    case 'comment_not_found':
      return sendApiError(
        request,
        reply,
        404,
        'COMMUNITY_COMMENT_NOT_FOUND',
        'Комментарий не найден.',
      );
    case 'invalid_state':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_CONTENT_MODERATION_STATE_CONFLICT',
        'Материал нельзя перевести из текущего состояния.',
      );
    case 'revision_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_CONTENT_REVISION_CONFLICT',
        'Материал уже изменился. Обновите очередь.',
      );
  }
}

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommunityContentModerationError) {
    if (
      error.code === 'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID' ||
      error.code === 'COMMUNITY_CONTENT_MODERATION_CURSOR_INVALID'
    ) {
      return sendApiError(request, reply, 400, error.code, 'Проверьте параметры модерации.');
    }
  }
  request.log.warn(
    { code: 'COMMUNITY_CONTENT_MODERATION_FAILED', correlationId: request.id },
    'community content moderation failed',
  );
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_CONTENT_MODERATION_UNAVAILABLE',
    'Контур модерации временно недоступен.',
  );
}

function replayFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Exclude<CommunityMediaReplayResult, { readonly outcome: 'replayed' }>,
) {
  switch (result.outcome) {
    case 'idempotency_conflict':
      return sendApiError(request, reply, 409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован.');
    case 'permission_denied':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_CONTENT_MODERATION_PERMISSION_REQUIRED',
        'Нет права на повтор медиа-операции.',
      );
    case 'not_found':
      return sendApiError(
        request,
        reply,
        404,
        'COMMUNITY_MEDIA_OPERATION_NOT_FOUND',
        'Медиа-операция не найдена.',
      );
    case 'invalid_state':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_OPERATION_STATE_CONFLICT',
        'Медиа-операция не находится в терминальном состоянии.',
      );
  }
}

export function registerCommunityContentModerationAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityContentModerationService;
    readonly mediaAuthorizer?: CommunityMediaDeliveryAuthorizer;
    readonly mediaObjectStore?: CommunityMediaObjectStore;
    readonly mediaOperationsRepository?: Pick<
      CommunityMediaPersistenceRepository,
      'replayFailedScan' | 'replayDeadGc'
    >;
    readonly mediaReadUrlTtlSeconds: number;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/community-content/pending',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!requirePermission(request, reply, 'communities.content.moderation.read')) return;
      const current = principal(request);
      const params = listParams.safeParse(request.params);
      const query = listQuery.safeParse(request.query);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return routeError(request, reply, undefined);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID',
          'Проверьте очередь.',
        );
      }
      try {
        const result = await options.service.listPending({
          ...current,
          limit: query.data.limit,
          correlationId: request.id,
          ...(query.data.communityId ? { communityId: query.data.communityId } : {}),
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        });
        if (result.outcome === 'found') return result.page;
        return failure(request, reply, result);
      } catch (error) {
        return routeError(request, reply, error);
      }
    },
  );

  for (const operation of ['scan', 'gc'] as const) {
    app.post(
      operation === 'scan'
        ? '/admin/api/v1/:tenantKey/community-media/scans/:mediaId/replay'
        : '/admin/api/v1/:tenantKey/community-media/gc-jobs/:jobId/replay',
      { preHandler: [...options.commandHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!requirePermission(request, reply, 'communities.content.moderation.decide')) return;
        const current = principal(request);
        const idempotencyKey = request.headers['idempotency-key'];
        const params =
          operation === 'scan'
            ? mediaScanReplayParams.safeParse(request.params)
            : mediaGcReplayParams.safeParse(request.params);
        const body = replayBody.safeParse(request.body);
        if (!current || typeof idempotencyKey !== 'string') {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        if (!params.success || !body.success) {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_MEDIA_REPLAY_INPUT_INVALID',
            'Проверьте идентификатор и reasonCode.',
          );
        }
        if (!options.mediaOperationsRepository) return routeError(request, reply, undefined);
        const targetId =
          operation === 'scan'
            ? mediaScanReplayParams.parse(request.params).mediaId
            : mediaGcReplayParams.parse(request.params).jobId;
        const input = {
          ...current,
          targetId,
          idempotencyKey,
          requestHash: hash({ operation, targetId, reasonCode: body.data.reasonCode }),
          reasonCode: body.data.reasonCode,
          correlationId: request.id,
        };
        try {
          const result =
            operation === 'scan'
              ? await options.mediaOperationsRepository.replayFailedScan(input)
              : await options.mediaOperationsRepository.replayDeadGc(input);
          if (result.outcome !== 'replayed') return replayFailure(request, reply, result);
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return {
            targetId: result.targetId,
            operation: operation.toUpperCase(),
            replayed: result.replayed,
          };
        } catch (error) {
          return routeError(request, reply, error);
        }
      },
    );
  }

  app.get(
    '/admin/api/v1/:tenantKey/communities/:communityId/content/media/:mediaId/variants/:variant/url',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!requirePermission(request, reply, 'communities.content.moderation.read')) return;
      const current = principal(request);
      const params = mediaVariantParams.safeParse(request.params);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID',
          'Проверьте идентификатор медиа.',
        );
      }
      if (!options.mediaAuthorizer || !options.mediaObjectStore) {
        return routeError(request, reply, undefined);
      }
      try {
        const result = await options.mediaAuthorizer.authorizeVariant({
          tenantId: current.tenantId,
          viewerUserId: current.actorUserId,
          communityId: params.data.communityId,
          mediaId: params.data.mediaId,
          variant: params.data.variant,
        });
        if (result.outcome !== 'found') {
          return sendApiError(
            request,
            reply,
            404,
            'COMMUNITY_MEDIA_NOT_FOUND',
            'Медиа не найдено.',
          );
        }
        const url = await options.mediaObjectStore.createReadUrl({
          objectKey: result.objectKey,
          versionId: result.versionId,
          expiresInSeconds: options.mediaReadUrlTtlSeconds,
        });
        return {
          url,
          expiresAt: new Date(Date.now() + options.mediaReadUrlTtlSeconds * 1_000).toISOString(),
        };
      } catch (error) {
        return routeError(request, reply, error);
      }
    },
  );

  for (const action of ['approve', 'reject', 'hide', 'restore'] as const) {
    app.post(
      `/admin/api/v1/:tenantKey/communities/:communityId/content/posts/:postId/${action}`,
      { preHandler: [...options.commandHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!requirePermission(request, reply, 'communities.content.moderation.decide')) return;
        const current = principal(request);
        const idempotencyKey = request.headers['idempotency-key'];
        const params = postParams.safeParse(request.params);
        const body = (action === 'approve' ? revisionBody : reasonedBody).safeParse(request.body);
        if (!current || typeof idempotencyKey !== 'string') {
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        }
        if (!options.service) return routeError(request, reply, undefined);
        if (!params.success || !body.success) {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID',
            'Проверьте команду.',
          );
        }
        try {
          const command = {
            ...current,
            communityId: params.data.communityId,
            postId: params.data.postId,
            expectedRevision: body.data.expectedRevision,
            idempotencyKey,
            requestHash: hash({
              action: `POST_${action.toUpperCase()}`,
              ...params.data,
              ...body.data,
            }),
            correlationId: request.id,
          };
          const reason = 'reasonCode' in body.data ? body.data.reasonCode : undefined;
          const result =
            action === 'approve'
              ? await options.service.approvePost(command)
              : action === 'reject'
                ? await options.service.rejectPost({
                    ...command,
                    reasonCode: reason as string,
                  })
                : action === 'hide'
                  ? await options.service.hidePost({
                      ...command,
                      reasonCode: reason as string,
                    })
                  : await options.service.restorePost({
                      ...command,
                      reasonCode: reason as string,
                    });
          if (!('post' in result)) return failure(request, reply, result);
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return result.post;
        } catch (error) {
          return routeError(request, reply, error);
        }
      },
    );
  }

  for (const action of ['hide', 'restore'] as const) {
    app.post(
      `/admin/api/v1/:tenantKey/communities/:communityId/content/posts/:postId/comments/:commentId/${action}`,
      { preHandler: [...options.commandHandlers] },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!requirePermission(request, reply, 'communities.content.moderation.decide')) return;
        const current = principal(request);
        const idempotencyKey = request.headers['idempotency-key'];
        const params = commentParams.safeParse(request.params);
        const body = reasonedBody.safeParse(request.body);
        if (!current || typeof idempotencyKey !== 'string')
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        if (!options.service) return routeError(request, reply, undefined);
        if (!params.success || !body.success)
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_CONTENT_MODERATION_INPUT_INVALID',
            'Проверьте команду.',
          );
        try {
          const command = {
            ...current,
            communityId: params.data.communityId,
            postId: params.data.postId,
            commentId: params.data.commentId,
            expectedRevision: body.data.expectedRevision,
            reasonCode: body.data.reasonCode,
            idempotencyKey,
            requestHash: hash({
              action: `COMMENT_${action.toUpperCase()}`,
              ...params.data,
              ...body.data,
            }),
            correlationId: request.id,
          };
          const result =
            action === 'hide'
              ? await options.service.hideComment(command)
              : await options.service.restoreComment(command);
          if (!('comment' in result)) return failure(request, reply, result);
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return result.comment;
        } catch (error) {
          return routeError(request, reply, error);
        }
      },
    );
  }
}
