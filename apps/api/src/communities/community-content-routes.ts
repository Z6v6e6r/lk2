import { createHash } from 'node:crypto';

import {
  COMMUNITY_MEDIA_MAX_PER_POST,
  COMMUNITY_REACTIONS,
  CommunityContentError,
  type CommunityContentFailure,
  type CommunityContentService,
} from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  return current.tenantId && current.padlHubClaims?.sub
    ? { tenantId: current.tenantId, userId: current.padlHubClaims.sub }
    : undefined;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const communityParams = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();
const postParams = communityParams.extend({ postId: z.string().uuid() }).strict();
const commentParams = postParams.extend({ commentId: z.string().uuid() }).strict();
const feedQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().min(16).max(1_024).optional(),
  })
  .strict();
const mediaIds = z
  .array(z.string().uuid())
  .max(COMMUNITY_MEDIA_MAX_PER_POST)
  .refine((items) => new Set(items).size === items.length);
const postBody = z
  .object({
    body: z
      .string()
      .min(1)
      .max(10_000)
      .refine((value) => value.trim().length > 0),
    mediaIds: mediaIds.optional(),
  })
  .strict();
const commentBody = z
  .object({
    body: z
      .string()
      .min(1)
      .max(2_000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
const revisionBody = z.object({ expectedRevision: z.number().int().positive() }).strict();
const postEditBody = postBody.extend({ expectedRevision: z.number().int().positive() }).strict();
const commentEditBody = commentBody
  .extend({ expectedRevision: z.number().int().positive() })
  .strict();
const reactionBody = z.object({ reaction: z.enum(COMMUNITY_REACTIONS) }).strict();

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_CONTENT_UNAVAILABLE',
    'Лента сообщества временно недоступна.',
  );
}

function failure(request: FastifyRequest, reply: FastifyReply, result: CommunityContentFailure) {
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
        'COMMUNITY_CONTENT_ACTOR_INELIGIBLE',
        'Действие доступно только активному пользователю.',
      );
    case 'community_not_found':
      return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
    case 'membership_required':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_ACTIVE_MEMBERSHIP_REQUIRED',
        'Требуется активное участие в сообществе.',
      );
    case 'publishing_forbidden':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_PUBLISHING_FORBIDDEN',
        'Недостаточно прав для публикации.',
      );
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
    case 'not_author':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_CONTENT_AUTHOR_REQUIRED',
        'Изменить материал может только его автор.',
      );
    case 'revision_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_CONTENT_REVISION_CONFLICT',
        'Материал уже изменился. Обновите данные и повторите.',
      );
    case 'content_not_editable':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_CONTENT_NOT_EDITABLE',
        'Материал нельзя изменить в текущем состоянии.',
      );
    case 'content_not_archived':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_CONTENT_NOT_ARCHIVED',
        'Материал не находится в архиве.',
      );
    case 'restore_expired':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_CONTENT_RESTORE_EXPIRED',
        'Срок пользовательского восстановления истёк.',
      );
    case 'media_not_ready':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_NOT_READY',
        'Дождитесь завершения обработки всех изображений.',
      );
    case 'media_not_owned':
      return sendApiError(
        request,
        reply,
        403,
        'COMMUNITY_MEDIA_NOT_OWNED',
        'К посту можно прикрепить только собственные изображения.',
      );
    case 'media_already_bound':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_ALREADY_BOUND',
        'Изображение уже прикреплено к другому посту.',
      );
    case 'media_attachment_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_ATTACHMENT_CONFLICT',
        'Состав изображений уже изменился. Обновите данные и повторите.',
      );
  }
}

function commandContext(request: FastifyRequest) {
  const current = principal(request);
  const idempotencyKey = request.headers['idempotency-key'];
  return current && typeof idempotencyKey === 'string' ? { ...current, idempotencyKey } : undefined;
}

function contentError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (
    error instanceof CommunityContentError &&
    (error.code === 'COMMUNITY_CONTENT_COMMAND_INVALID' ||
      error.code === 'COMMUNITY_FEED_QUERY_INVALID' ||
      error.code === 'COMMUNITY_FEED_CURSOR_INVALID' ||
      error.code === 'COMMUNITY_COMMENT_CURSOR_INVALID')
  ) {
    return sendApiError(request, reply, 400, error.code, 'Проверьте параметры запроса.');
  }
  request.log.warn(
    { code: 'COMMUNITY_CONTENT_FAILED', correlationId: request.id },
    'community content request failed',
  );
  return unavailable(request, reply);
}

export function registerCommunityContentRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityContentService;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/feed',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const params = communityParams.safeParse(request.params);
      const query = feedQuery.safeParse(request.query);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_FEED_QUERY_INVALID',
          'Проверьте параметры ленты.',
        );
      }
      try {
        const result = await options.service.listFeed({
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          communityId: params.data.communityId,
          limit: query.data.limit,
          correlationId: request.id,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        });
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        if (result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_CONTENT_ACTOR_INELIGIBLE',
            'Доступ запрещён.',
          );
        }
        return result.page;
      } catch (error) {
        return contentError(request, reply, error);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/posts',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = commandContext(request);
      const params = communityParams.safeParse(request.params);
      const body = postBody.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_POST_PAYLOAD_INVALID',
          'Проверьте текст поста.',
        );
      }
      try {
        const result = await options.service.createPost({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          body: body.data.body,
          ...(body.data.mediaIds !== undefined ? { mediaIds: body.data.mediaIds } : {}),
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({
            operation: 'POST_CREATE',
            communityId: params.data.communityId,
            ...body.data,
          }),
          correlationId: request.id,
        });
        if (!('post' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return reply.code(201).send(result.post);
      } catch (error) {
        return contentError(request, reply, error);
      }
    },
  );

  app.patch(
    '/user/api/v1/:tenantKey/communities/:communityId/posts/:postId',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      const current = commandContext(request);
      const params = postParams.safeParse(request.params);
      const body = postEditBody.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_POST_PAYLOAD_INVALID',
          'Проверьте параметры поста.',
        );
      }
      try {
        const result = await options.service.editPost({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          postId: params.data.postId,
          body: body.data.body,
          ...(body.data.mediaIds !== undefined ? { mediaIds: body.data.mediaIds } : {}),
          expectedRevision: body.data.expectedRevision,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({ operation: 'POST_EDIT', ...params.data, ...body.data }),
          correlationId: request.id,
        });
        if (!('post' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return result.post;
      } catch (error) {
        return contentError(request, reply, error);
      }
    },
  );

  for (const operation of ['archive', 'restore'] as const) {
    app.post(
      `/user/api/v1/:tenantKey/communities/:communityId/posts/:postId/${operation}`,
      { preHandler: [...options.commandHandlers] },
      async (request, reply) => {
        const current = commandContext(request);
        const params = postParams.safeParse(request.params);
        const body = revisionBody.safeParse(request.body);
        if (!current)
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        if (!options.service) return unavailable(request, reply);
        if (!params.success || !body.success) {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_POST_PAYLOAD_INVALID',
            'Проверьте параметры поста.',
          );
        }
        try {
          const input = {
            tenantId: current.tenantId,
            actorUserId: current.userId,
            communityId: params.data.communityId,
            postId: params.data.postId,
            expectedRevision: body.data.expectedRevision,
            idempotencyKey: current.idempotencyKey,
            requestHash: hash({
              operation: `POST_${operation.toUpperCase()}`,
              ...params.data,
              ...body.data,
            }),
            correlationId: request.id,
          };
          const result =
            operation === 'archive'
              ? await options.service.archivePost(input)
              : await options.service.restorePost(input);
          if (!('post' in result)) return failure(request, reply, result);
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return result.post;
        } catch (error) {
          return contentError(request, reply, error);
        }
      },
    );
  }

  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/posts/:postId/comments',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const params = postParams.safeParse(request.params);
      const query = feedQuery.safeParse(request.query);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_COMMENT_QUERY_INVALID',
          'Проверьте параметры комментариев.',
        );
      }
      try {
        const result = await options.service.listComments({
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          communityId: params.data.communityId,
          postId: params.data.postId,
          limit: query.data.limit,
          correlationId: request.id,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        });
        if (result.outcome === 'community_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_NOT_FOUND', 'Сообщество не найдено.');
        }
        if (result.outcome === 'post_not_found') {
          return sendApiError(request, reply, 404, 'COMMUNITY_POST_NOT_FOUND', 'Пост не найден.');
        }
        if (result.outcome === 'actor_not_active') {
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_CONTENT_ACTOR_INELIGIBLE',
            'Доступ запрещён.',
          );
        }
        return result.page;
      } catch (error) {
        return contentError(request, reply, error);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/posts/:postId/comments',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      const current = commandContext(request);
      const params = postParams.safeParse(request.params);
      const body = commentBody.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_COMMENT_PAYLOAD_INVALID',
          'Проверьте текст комментария.',
        );
      }
      try {
        const result = await options.service.createComment({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          postId: params.data.postId,
          body: body.data.body,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({ operation: 'COMMENT_CREATE', ...params.data, ...body.data }),
          correlationId: request.id,
        });
        if (!('comment' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return reply.code(201).send(result.comment);
      } catch (error) {
        return contentError(request, reply, error);
      }
    },
  );

  app.patch(
    '/user/api/v1/:tenantKey/communities/:communityId/posts/:postId/comments/:commentId',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      const current = commandContext(request);
      const params = commentParams.safeParse(request.params);
      const body = commentEditBody.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_COMMENT_PAYLOAD_INVALID',
          'Проверьте комментарий.',
        );
      }
      try {
        const result = await options.service.editComment({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          postId: params.data.postId,
          commentId: params.data.commentId,
          body: body.data.body,
          expectedRevision: body.data.expectedRevision,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({ operation: 'COMMENT_EDIT', ...params.data, ...body.data }),
          correlationId: request.id,
        });
        if (!('comment' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return result.comment;
      } catch (error) {
        return contentError(request, reply, error);
      }
    },
  );

  for (const operation of ['archive', 'restore'] as const) {
    app.post(
      `/user/api/v1/:tenantKey/communities/:communityId/posts/:postId/comments/:commentId/${operation}`,
      { preHandler: [...options.commandHandlers] },
      async (request, reply) => {
        const current = commandContext(request);
        const params = commentParams.safeParse(request.params);
        const body = revisionBody.safeParse(request.body);
        if (!current)
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        if (!options.service) return unavailable(request, reply);
        if (!params.success || !body.success) {
          return sendApiError(
            request,
            reply,
            400,
            'COMMUNITY_COMMENT_PAYLOAD_INVALID',
            'Проверьте комментарий.',
          );
        }
        try {
          const input = {
            tenantId: current.tenantId,
            actorUserId: current.userId,
            communityId: params.data.communityId,
            postId: params.data.postId,
            commentId: params.data.commentId,
            expectedRevision: body.data.expectedRevision,
            idempotencyKey: current.idempotencyKey,
            requestHash: hash({
              operation: `COMMENT_${operation.toUpperCase()}`,
              ...params.data,
              ...body.data,
            }),
            correlationId: request.id,
          };
          const result =
            operation === 'archive'
              ? await options.service.archiveComment(input)
              : await options.service.restoreComment(input);
          if (!('comment' in result)) return failure(request, reply, result);
          reply.header('X-Idempotent-Replayed', String(result.replayed));
          return result.comment;
        } catch (error) {
          return contentError(request, reply, error);
        }
      },
    );
  }

  for (const targetType of ['POST', 'COMMENT'] as const) {
    const path =
      targetType === 'POST'
        ? '/user/api/v1/:tenantKey/communities/:communityId/posts/:targetId/reaction'
        : '/user/api/v1/:tenantKey/communities/:communityId/comments/:targetId/reaction';
    const paramsSchema = communityParams.extend({ targetId: z.string().uuid() }).strict();
    app.put(path, { preHandler: [...options.commandHandlers] }, async (request, reply) => {
      const current = commandContext(request);
      const params = paramsSchema.safeParse(request.params);
      const body = reactionBody.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_REACTION_PAYLOAD_INVALID',
          'Проверьте реакцию.',
        );
      }
      try {
        const result = await options.service.setReaction({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          targetType,
          targetId: params.data.targetId,
          reaction: body.data.reaction,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({
            operation: `${targetType}_REACTION_SET`,
            ...params.data,
            ...body.data,
          }),
          correlationId: request.id,
        });
        if (!('reaction' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return result.reaction;
      } catch (error) {
        return contentError(request, reply, error);
      }
    });
    app.delete(path, { preHandler: [...options.commandHandlers] }, async (request, reply) => {
      const current = commandContext(request);
      const params = paramsSchema.safeParse(request.params);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_REACTION_PAYLOAD_INVALID',
          'Проверьте реакцию.',
        );
      }
      try {
        const result = await options.service.removeReaction({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          targetType,
          targetId: params.data.targetId,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({ operation: `${targetType}_REACTION_REMOVE`, ...params.data }),
          correlationId: request.id,
        });
        if (!('reaction' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return result.reaction;
      } catch (error) {
        return contentError(request, reply, error);
      }
    });
  }
}
