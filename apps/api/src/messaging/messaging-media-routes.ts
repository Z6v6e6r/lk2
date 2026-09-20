import { createHash } from 'node:crypto';

import {
  MESSAGING_MEDIA_FORBIDDEN_CONTENT_TYPES,
  MESSAGING_MEDIA_IMAGE_CONTENT_TYPES,
  MESSAGING_MEDIA_MAX_BYTES,
  type MessagingMediaFailureCode,
  type MessagingMediaRepository,
  type MessagingRepository,
} from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';
import type { MessagingMediaObjectStore } from './messaging-media-object-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,100}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/;
/** Windows-style separators and traversal never reach storage: the name is display-only. */
const UNSAFE_FILE_NAME = /[\u0000-\u001f\u007f/\\]/;

const paramsSchema = z
  .object({ tenantKey: z.string().min(1), conversationId: z.string().uuid() })
  .strict();
const mediaParamsSchema = paramsSchema.extend({ mediaId: z.string().uuid() }).strict();
const issueSchema = z
  .object({
    fileName: z.string().min(1).max(500),
    contentType: z.string().min(3).max(200),
    byteSize: z.number().int().min(1).max(MESSAGING_MEDIA_MAX_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const finalizeSchema = z
  .object({ declaredByteSize: z.number().int().min(1).max(MESSAGING_MEDIA_MAX_BYTES) })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const current = request as FastifyRequest & {
    readonly tenantId?: string;
    readonly padlHubClaims?: { readonly sub?: string };
  };
  const tenantId = current.tenantId;
  const userId = current.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'MESSAGING_MEDIA_UNAVAILABLE',
    'Вложения временно недоступны.',
  );
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(request, reply, 404, 'CONVERSATION_NOT_FOUND', 'Диалог не найден.');
}

function mediaNotFound(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(request, reply, 404, 'MESSAGING_MEDIA_NOT_FOUND', 'Вложение не найдено.');
}

function rejected(request: FastifyRequest, reply: FastifyReply, code: MessagingMediaFailureCode) {
  if (code === 'MESSAGING_MEDIA_COMMAND_INVALID') {
    return sendApiError(
      request,
      reply,
      400,
      'MESSAGING_MEDIA_PAYLOAD_INVALID',
      'Проверьте формат, размер и контрольную сумму файла.',
    );
  }
  return sendApiError(request, reply, 503, code, 'Вложения временно недоступны.');
}

function quotaFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: string,
  retryAfterSeconds: number,
) {
  reply.header('Retry-After', String(retryAfterSeconds));
  const code =
    outcome === 'outstanding_upload_quota_exceeded'
      ? 'MESSAGING_MEDIA_OUTSTANDING_UPLOAD_QUOTA_EXCEEDED'
      : outcome === 'actor_pipeline_quota_exceeded'
        ? 'MESSAGING_MEDIA_ACTOR_PIPELINE_QUOTA_EXCEEDED'
        : outcome === 'daily_issue_count_quota_exceeded'
          ? 'MESSAGING_MEDIA_DAILY_ISSUE_COUNT_QUOTA_EXCEEDED'
          : outcome === 'daily_declared_bytes_quota_exceeded'
            ? 'MESSAGING_MEDIA_DAILY_DECLARED_BYTES_QUOTA_EXCEEDED'
            : 'MESSAGING_MEDIA_SCAN_BACKLOG_QUOTA_EXCEEDED';
  return sendApiError(
    request,
    reply,
    429,
    code,
    'Слишком много загрузок. Попробуйте немного позже.',
  );
}

function forbiddenContentType(contentType: string): boolean {
  if ((MESSAGING_MEDIA_FORBIDDEN_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return true;
  }
  // Only three image formats are recognised as images. Any other image/* would be stored as a file
  // and served as an attachment, which contradicts what the client asked for.
  return contentType.startsWith('image/')
    ? !(MESSAGING_MEDIA_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)
    : false;
}

export function registerMessagingMediaRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: MessagingMediaRepository;
    /** Message-bound media reads stay in the messaging repository, next to membership and blocks. */
    readonly messageRepository?: MessagingRepository;
    readonly objectStore?: MessagingMediaObjectStore;
    readonly enabled: boolean;
    readonly readUrlTtlSeconds: number;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  function disabled(request: FastifyRequest, reply: FastifyReply) {
    return sendApiError(
      request,
      reply,
      404,
      'MESSAGING_MEDIA_DISABLED',
      'Вложения в чате пока не включены.',
    );
  }

  app.post(
    '/user/api/v1/:tenantKey/conversations/:conversationId/media/uploads',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!options.enabled) return disabled(request, reply);
      const current = principal(request);
      const params = paramsSchema.safeParse(request.params);
      const body = issueSchema.safeParse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository || !options.objectStore) return unavailable(request, reply);
      if (
        !params.success ||
        !body.success ||
        typeof idempotencyKey !== 'string' ||
        UNSAFE_FILE_NAME.test(body.data.fileName) ||
        body.data.fileName.trim().length < 1 ||
        !CONTENT_TYPE_PATTERN.test(body.data.contentType) ||
        forbiddenContentType(body.data.contentType)
      ) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_MEDIA_PAYLOAD_INVALID',
          'Проверьте формат, размер и контрольную сумму файла.',
        );
      }
      const issued = await options.repository.issueUpload({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        conversationId: params.data.conversationId,
        fileName: body.data.fileName.trim(),
        contentType: body.data.contentType,
        byteSize: body.data.byteSize,
        sha256: body.data.sha256,
        idempotencyKey,
        requestHash: hash({
          operation: 'MESSAGING_MEDIA_ISSUE_UPLOAD',
          ...params.data,
          ...body.data,
        }),
        correlationId: request.id,
      });
      if (issued.outcome === 'not_found') return notFound(request, reply);
      if (issued.outcome === 'state_invalid') return mediaNotFound(request, reply);
      if (issued.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (issued.outcome !== 'issued') {
        return quotaFailure(request, reply, issued.outcome, issued.retryAfterSeconds);
      }
      try {
        const grant = await options.objectStore.createUploadGrant({
          objectKey: issued.intent.objectKey,
          contentType: issued.intent.declaredContentType,
          byteSize: issued.intent.declaredByteSize,
          sha256: issued.intent.declaredSha256,
          mediaId: issued.intent.id,
          expiresAt: issued.intent.uploadExpiresAt,
        });
        reply.header('X-Idempotent-Replayed', String(issued.replayed));
        return reply.code(issued.replayed ? 200 : 201).send({
          media: {
            id: issued.intent.id,
            conversationId: issued.intent.conversationId,
            mediaType: issued.intent.mediaType,
            fileName: body.data.fileName.trim(),
            contentType: issued.intent.declaredContentType,
            byteSize: issued.intent.declaredByteSize,
            sha256: issued.intent.declaredSha256,
            state: 'UPLOADING',
            revision: issued.intent.revision,
          },
          upload: {
            method: grant.method,
            url: grant.url,
            requiredHeaders: grant.requiredHeaders,
            expiresAt: grant.expiresAt,
          },
        });
      } catch (error) {
        request.log.warn(
          { code: 'MESSAGING_MEDIA_UPLOAD_GRANT_FAILED', correlationId: request.id },
          'chat media upload grant failed',
        );
        void error;
        return unavailable(request, reply);
      }
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/conversations/:conversationId/media/:mediaId/finalize',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!options.enabled) return disabled(request, reply);
      const current = principal(request);
      const params = mediaParamsSchema.safeParse(request.params);
      const body = finalizeSchema.safeParse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository || !options.objectStore) return unavailable(request, reply);
      if (!params.success || !body.success || typeof idempotencyKey !== 'string') {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_MEDIA_PAYLOAD_INVALID',
          'Проверьте параметры завершения загрузки.',
        );
      }
      const target = await options.repository.getFinalizeTarget({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        mediaId: params.data.mediaId,
        idempotencyKey,
        requestHash: hash({
          operation: 'MESSAGING_MEDIA_FINALIZE_UPLOAD',
          ...params.data,
          ...body.data,
        }),
      });
      if (target.outcome === 'finalized') {
        reply.header('X-Idempotent-Replayed', 'true');
        return reply.code(200).send(target.media);
      }
      if (target.outcome === 'upload_expired') {
        return sendApiError(
          request,
          reply,
          409,
          'MESSAGING_MEDIA_UPLOAD_EXPIRED',
          'Срок загрузки истёк. Создайте новую загрузку.',
        );
      }
      if (target.outcome === 'state_invalid') {
        return sendApiError(
          request,
          reply,
          409,
          'MESSAGING_MEDIA_STATE_INVALID',
          'Операция недоступна в текущем состоянии вложения.',
        );
      }
      if (target.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (target.outcome !== 'inspect') return mediaNotFound(request, reply);

      let observed: Awaited<ReturnType<MessagingMediaObjectStore['inspectCurrentVersion']>>;
      try {
        observed = await options.objectStore.inspectCurrentVersion(target.objectKey);
      } catch (error) {
        request.log.warn(
          { code: 'MESSAGING_MEDIA_OBJECT_INSPECTION_FAILED', correlationId: request.id },
          'chat media object inspection failed',
        );
        void error;
        return unavailable(request, reply);
      }
      if (!observed) {
        return sendApiError(
          request,
          reply,
          422,
          'MESSAGING_MEDIA_OBJECT_MISSING',
          'Загруженный файл не найден. Повторите загрузку.',
        );
      }
      const finalized = await options.repository.finalizeUpload({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        mediaId: params.data.mediaId,
        idempotencyKey,
        requestHash: hash({
          operation: 'MESSAGING_MEDIA_FINALIZE_UPLOAD',
          ...params.data,
          ...body.data,
        }),
        correlationId: request.id,
        observed: {
          objectKey: target.objectKey,
          objectVersion: observed.versionId,
          etag: observed.etag,
          byteSize: observed.byteSize,
          contentType: observed.contentType,
          checksumSha256: observed.checksumSha256,
        },
      });
      if (finalized.outcome === 'finalized') {
        reply.header('X-Idempotent-Replayed', String(finalized.replayed));
        return reply.code(finalized.replayed ? 200 : 202).send(finalized.media);
      }
      if (finalized.outcome === 'object_missing') {
        return sendApiError(
          request,
          reply,
          422,
          'MESSAGING_MEDIA_OBJECT_MISSING',
          'Загруженный файл не найден. Повторите загрузку.',
        );
      }
      if (finalized.outcome === 'object_mismatch') {
        return sendApiError(
          request,
          reply,
          422,
          'MESSAGING_MEDIA_OBJECT_MISMATCH',
          'Параметры загруженного файла не совпадают с заявленными.',
        );
      }
      if (finalized.outcome === 'upload_expired') {
        return sendApiError(
          request,
          reply,
          409,
          'MESSAGING_MEDIA_UPLOAD_EXPIRED',
          'Срок загрузки истёк. Создайте новую загрузку.',
        );
      }
      if (finalized.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (finalized.outcome === 'state_invalid') {
        return sendApiError(
          request,
          reply,
          409,
          'MESSAGING_MEDIA_STATE_INVALID',
          'Операция недоступна в текущем состоянии вложения.',
        );
      }
      return mediaNotFound(request, reply);
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/conversations/:conversationId/media/:mediaId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!options.enabled) return disabled(request, reply);
      const current = principal(request);
      const params = mediaParamsSchema.safeParse(request.params);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_MEDIA_PAYLOAD_INVALID',
          'Проверьте идентификатор вложения.',
        );
      }
      const result = await options.repository.getMedia({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        mediaId: params.data.mediaId,
      });
      if (result.outcome !== 'ok' || result.media.conversationId !== params.data.conversationId) {
        return mediaNotFound(request, reply);
      }
      return result.media;
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/conversations/:conversationId/media/:mediaId/content',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!options.enabled) return disabled(request, reply);
      const current = principal(request);
      const params = mediaParamsSchema.safeParse(request.params);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.messageRepository || !options.objectStore) return unavailable(request, reply);
      if (!params.success) {
        return sendApiError(
          request,
          reply,
          400,
          'MESSAGING_MEDIA_PAYLOAD_INVALID',
          'Проверьте идентификатор вложения.',
        );
      }
      const result = await options.messageRepository.getMessageMediaForViewer({
        tenantId: current.tenantId,
        userId: current.userId,
        mediaId: params.data.mediaId,
      });
      if (result.outcome !== 'ok' || result.media.conversationId !== params.data.conversationId) {
        return mediaNotFound(request, reply);
      }
      try {
        const url = await options.objectStore.createDeliveryUrl({
          delivery: {
            objectKey: result.media.objectKey,
            objectVersion: result.media.objectVersion,
            fileName: result.media.fileName,
            contentType: result.media.contentType,
            inline: result.media.mediaType === 'IMAGE',
          },
          expiresInSeconds: options.readUrlTtlSeconds,
        });
        return reply.code(302).header('Location', url).send();
      } catch (error) {
        request.log.warn(
          { code: 'MESSAGING_MEDIA_DELIVERY_URL_FAILED', correlationId: request.id },
          'chat media delivery url failed',
        );
        void error;
        return unavailable(request, reply);
      }
    },
  );
}

/** Exported for the send route, which reports the same stable attachment refusals. */
export function messagingAttachmentFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: string,
) {
  if (reason === 'NOT_FOUND') return mediaNotFound(request, reply);
  if (reason === 'LIMIT') {
    return sendApiError(
      request,
      reply,
      400,
      'MESSAGING_MEDIA_LIMIT_EXCEEDED',
      'К сообщению можно приложить не больше четырёх файлов.',
    );
  }
  if (reason === 'DUPLICATE') {
    return sendApiError(
      request,
      reply,
      400,
      'MESSAGING_MEDIA_DUPLICATE',
      'Один и тот же файл нельзя приложить дважды.',
    );
  }
  if (reason === 'ALREADY_BOUND') {
    return sendApiError(
      request,
      reply,
      409,
      'MESSAGING_MEDIA_ALREADY_ATTACHED',
      'Этот файл уже отправлен в сообщении.',
    );
  }
  if (reason === 'NOT_READY') {
    return sendApiError(
      request,
      reply,
      409,
      'MESSAGING_MEDIA_NOT_READY',
      'Файл ещё проверяется. Отправьте сообщение после проверки.',
    );
  }
  if (reason === 'FORBIDDEN') {
    return sendApiError(
      request,
      reply,
      403,
      'MESSAGING_MEDIA_FORBIDDEN',
      'Это вложение загружено другим пользователем.',
    );
  }
  return rejected(request, reply, 'MESSAGING_MEDIA_STATE_INVALID');
}
