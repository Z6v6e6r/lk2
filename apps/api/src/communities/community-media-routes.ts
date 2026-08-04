import { createHash } from 'node:crypto';

import {
  COMMUNITY_MEDIA_CONTENT_TYPES,
  COMMUNITY_MEDIA_MAX_SOURCE_BYTES,
  COMMUNITY_MEDIA_VARIANTS,
  CommunityMediaError,
  type CommunityMediaFailure,
  type CommunityMediaService,
  type CommunityMediaVariantName,
} from '@phub/communities';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import type { CommunityMediaObjectStore } from './community-media-object-store.js';

const paramsSchema = z
  .object({ tenantKey: z.string().min(1), communityId: z.string().uuid() })
  .strict();
const mediaParamsSchema = paramsSchema.extend({ mediaId: z.string().uuid() }).strict();
const variantParamsSchema = mediaParamsSchema
  .extend({ variant: z.enum(COMMUNITY_MEDIA_VARIANTS) })
  .strict();
const issueSchema = z
  .object({
    mediaType: z.literal('IMAGE'),
    contentType: z.enum(COMMUNITY_MEDIA_CONTENT_TYPES),
    byteSize: z.number().int().min(1).max(COMMUNITY_MEDIA_MAX_SOURCE_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const finalizeSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

export type CommunityMediaDeliveryAuthorizationResult =
  | { readonly outcome: 'found'; readonly objectKey: string; readonly versionId: string }
  | { readonly outcome: 'actor_not_active' | 'access_denied' | 'not_found' };

export interface CommunityMediaDeliveryAuthorizer {
  authorizeVariant(input: {
    readonly tenantId: string;
    readonly viewerUserId: string;
    readonly communityId: string;
    readonly mediaId: string;
    readonly variant: CommunityMediaVariantName;
  }): Promise<CommunityMediaDeliveryAuthorizationResult>;
}

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  return request.tenantId && request.padlHubClaims?.sub
    ? { tenantId: request.tenantId, userId: request.padlHubClaims.sub }
    : undefined;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'COMMUNITY_MEDIA_UNAVAILABLE',
    'Медиа сообщества временно недоступны.',
  );
}

function failure(request: FastifyRequest, reply: FastifyReply, result: CommunityMediaFailure) {
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
        'COMMUNITY_MEDIA_ACTOR_INELIGIBLE',
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
    case 'media_not_found':
      return sendApiError(request, reply, 404, 'COMMUNITY_MEDIA_NOT_FOUND', 'Медиа не найдено.');
    case 'upload_expired':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_UPLOAD_EXPIRED',
        'Срок загрузки истёк. Создайте новую загрузку.',
      );
    case 'object_missing':
      return sendApiError(
        request,
        reply,
        422,
        'COMMUNITY_MEDIA_OBJECT_MISSING',
        'Загруженный объект не найден.',
      );
    case 'object_mismatch':
      return sendApiError(
        request,
        reply,
        422,
        'COMMUNITY_MEDIA_OBJECT_MISMATCH',
        'Параметры загруженного объекта не совпадают с заявленными.',
      );
    case 'invalid_state':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_STATE_INVALID',
        'Операция недоступна в текущем состоянии медиа.',
      );
    case 'revision_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'COMMUNITY_MEDIA_REVISION_CONFLICT',
        'Медиа уже изменилось. Обновите данные и повторите.',
      );
  }
}

function commandContext(request: FastifyRequest) {
  const current = principal(request);
  const idempotencyKey = request.headers['idempotency-key'];
  return current && typeof idempotencyKey === 'string' ? { ...current, idempotencyKey } : undefined;
}

function routeError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommunityMediaError && error.code === 'COMMUNITY_MEDIA_COMMAND_INVALID') {
    return sendApiError(request, reply, 400, error.code, 'Проверьте параметры медиа-команды.');
  }
  request.log.warn(
    { code: 'COMMUNITY_MEDIA_REQUEST_FAILED', correlationId: request.id },
    'community media request failed',
  );
  return unavailable(request, reply);
}

export function registerCommunityMediaRoutes(
  app: FastifyInstance,
  options: {
    readonly service?: CommunityMediaService;
    readonly deliveryAuthorizer?: CommunityMediaDeliveryAuthorizer;
    readonly objectStore?: CommunityMediaObjectStore;
    readonly readUrlTtlSeconds: number;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/media/uploads',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = commandContext(request);
      const params = paramsSchema.safeParse(request.params);
      const body = issueSchema.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEDIA_PAYLOAD_INVALID',
          'Проверьте формат, размер и контрольную сумму изображения.',
        );
      }
      try {
        const result = await options.service.issueUpload({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          contentType: body.data.contentType,
          byteSize: body.data.byteSize,
          sha256: body.data.sha256,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({
            operation: 'COMMUNITY_MEDIA_ISSUE_UPLOAD',
            ...params.data,
            ...body.data,
          }),
          correlationId: request.id,
        });
        if (!('media' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return reply.code(result.replayed ? 200 : 201).send(result.media);
      } catch (error) {
        return routeError(request, reply, error);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/communities/:communityId/media/:mediaId/finalize',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const current = commandContext(request);
      const params = mediaParamsSchema.safeParse(request.params);
      const body = finalizeSchema.safeParse(request.body);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success || !body.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEDIA_PAYLOAD_INVALID',
          'Проверьте параметры завершения загрузки.',
        );
      }
      try {
        const result = await options.service.finalizeUpload({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          mediaId: params.data.mediaId,
          expectedRevision: body.data.expectedRevision,
          idempotencyKey: current.idempotencyKey,
          requestHash: hash({
            operation: 'COMMUNITY_MEDIA_FINALIZE_UPLOAD',
            ...params.data,
            ...body.data,
          }),
          correlationId: request.id,
        });
        if (!('media' in result)) return failure(request, reply, result);
        reply.header('X-Idempotent-Replayed', String(result.replayed));
        return reply.code(result.replayed ? 200 : 202).send(result.media);
      } catch (error) {
        return routeError(request, reply, error);
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/media/:mediaId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const params = mediaParamsSchema.safeParse(request.params);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.service) return unavailable(request, reply);
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEDIA_QUERY_INVALID',
          'Проверьте идентификатор медиа.',
        );
      }
      try {
        const result = await options.service.getMedia({
          tenantId: current.tenantId,
          actorUserId: current.userId,
          communityId: params.data.communityId,
          mediaId: params.data.mediaId,
          correlationId: request.id,
        });
        if (!('media' in result)) return failure(request, reply, result);
        return result.media;
      } catch (error) {
        return routeError(request, reply, error);
      }
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/communities/:communityId/media/:mediaId/variants/:variant',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const current = principal(request);
      const params = variantParamsSchema.safeParse(request.params);
      if (!current)
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      if (!options.deliveryAuthorizer || !options.objectStore) return unavailable(request, reply);
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'COMMUNITY_MEDIA_QUERY_INVALID',
          'Проверьте вариант медиа.',
        );
      }
      try {
        const result = await options.deliveryAuthorizer.authorizeVariant({
          tenantId: current.tenantId,
          viewerUserId: current.userId,
          communityId: params.data.communityId,
          mediaId: params.data.mediaId,
          variant: params.data.variant,
        });
        if (result.outcome !== 'found') {
          if (result.outcome === 'not_found') {
            return sendApiError(
              request,
              reply,
              404,
              'COMMUNITY_MEDIA_NOT_FOUND',
              'Медиа не найдено.',
            );
          }
          return sendApiError(
            request,
            reply,
            403,
            'COMMUNITY_MEDIA_ACCESS_DENIED',
            'Доступ к медиа запрещён.',
          );
        }
        const url = await options.objectStore.createReadUrl({
          objectKey: result.objectKey,
          versionId: result.versionId,
          expiresInSeconds: options.readUrlTtlSeconds,
        });
        return reply.code(302).header('Location', url).send();
      } catch (error) {
        return routeError(request, reply, error);
      }
    },
  );
}
