import { createHash } from 'node:crypto';

import {
  ProfilePhotoIdempotencyConflictError,
  ProfilePhotoGrantStaleError,
  type ProfileSummaryRepository,
} from '@phub/database';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { jwtVerify } from 'jose';
import sharp from 'sharp';

import { sendApiError } from '../http-errors.js';
import {
  ProfilePhotoMediaNotFoundError,
  type ProfilePhotoMediaStore,
} from './profile-photo-media-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_CONTENT_TYPES = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp']);

async function verifyProfilePhotoGrant(input: {
  readonly token: string | undefined;
  readonly tenantId: string;
  readonly userId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly secret: string;
}): Promise<{ readonly grantId: string; readonly issuedAt: string } | undefined> {
  if (!input.token) return undefined;
  try {
    const verified = await jwtVerify(input.token, new TextEncoder().encode(input.secret), {
      issuer: input.issuer,
      audience: `${input.audience}:profile-photo-sync`,
      algorithms: ['HS256'],
    });
    if (
      verified.protectedHeader.typ !== 'phub-profile-photo-grant+jwt' ||
      verified.payload.sub !== input.userId ||
      verified.payload.tenantId !== input.tenantId ||
      verified.payload.scope !== 'profile.photo.sync' ||
      typeof verified.payload.jti !== 'string' ||
      !UUID_PATTERN.test(verified.payload.jti) ||
      typeof verified.payload.iat !== 'number' ||
      typeof verified.payload.issuedAtMs !== 'number' ||
      !Number.isSafeInteger(verified.payload.issuedAtMs)
    ) {
      return undefined;
    }
    return {
      grantId: verified.payload.jti,
      issuedAt: new Date(verified.payload.issuedAtMs).toISOString(),
    };
  } catch {
    return undefined;
  }
}

function registerImageContentTypeParsers(app: FastifyInstance, maxBytes: number): void {
  for (const contentType of IMAGE_CONTENT_TYPES) {
    if (app.hasContentTypeParser(contentType)) continue;
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: maxBytes },
      (_request, body, done) => done(null, body),
    );
  }
}

export function registerProfilePhotoMediaRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: Pick<ProfileSummaryRepository, 'getPhotoObjectKey'> &
      Partial<
        Pick<ProfileSummaryRepository, 'reserveClientAssistedPhoto' | 'finalizeClientAssistedPhoto'>
      >;
    readonly store?: ProfilePhotoMediaStore;
    readonly maxBytes: number;
    readonly maxDimension: number;
    readonly webpQuality: number;
    readonly previousObjectRetentionSeconds: number;
    readonly clientSyncEnabled: boolean;
    readonly commandHandlers: readonly preHandlerHookHandler[];
    readonly grantIssuer: string;
    readonly grantAudience: string;
    readonly grantSecret: string;
  },
): void {
  registerImageContentTypeParsers(app, options.maxBytes);

  app.post(
    '/user/api/v1/:tenantKey/profile/photo',
    { preHandler: [...options.commandHandlers], bodyLimit: options.maxBytes },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const tenantId = request.tenantId;
      const userId = request.padlHubClaims?.sub;
      if (!tenantId || !userId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.clientSyncEnabled) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_PHOTO_SYNC_DISABLED',
          'Синхронизация аватара ещё не включена.',
        );
      }
      if (
        !options.repository?.reserveClientAssistedPhoto ||
        !options.repository.finalizeClientAssistedPhoto ||
        !options.store?.put
      ) {
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_PHOTO_SYNC_UNAVAILABLE',
          'Загрузка аватара временно недоступна.',
        );
      }
      const grant = await verifyProfilePhotoGrant({
        token:
          typeof request.headers['x-profile-photo-grant'] === 'string'
            ? request.headers['x-profile-photo-grant']
            : undefined,
        tenantId,
        userId,
        issuer: options.grantIssuer,
        audience: options.grantAudience,
        secret: options.grantSecret,
      });
      if (!grant) {
        return sendApiError(
          request,
          reply,
          403,
          'PROFILE_PHOTO_GRANT_REQUIRED',
          'Разрешение на синхронизацию аватара отсутствует или истекло.',
        );
      }
      const source = request.body;
      const idempotencyKey = request.headers['idempotency-key'];
      const contentType = String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.toLowerCase();
      if (Buffer.isBuffer(source) && source.byteLength > options.maxBytes) {
        return sendApiError(
          request,
          reply,
          413,
          'PROFILE_PHOTO_TOO_LARGE',
          'Размер аватара превышает допустимый предел.',
        );
      }
      if (!Buffer.isBuffer(source) || !contentType || !IMAGE_CONTENT_TYPES.has(contentType)) {
        return sendApiError(
          request,
          reply,
          415,
          'PROFILE_PHOTO_TYPE_INVALID',
          'Поддерживаются AVIF, JPEG, PNG и WebP.',
        );
      }
      let webp: Buffer;
      try {
        webp = await sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 })
          .rotate()
          .resize({
            width: options.maxDimension,
            height: options.maxDimension,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: options.webpQuality, effort: 4 })
          .toBuffer();
        if (webp.byteLength === 0 || webp.byteLength > options.maxBytes) {
          throw new Error('PROFILE_PHOTO_INVALID');
        }
      } catch (error) {
        request.log.warn({ error }, 'client-assisted profile photo preparation failed');
        return sendApiError(
          request,
          reply,
          422,
          'PROFILE_PHOTO_INVALID',
          'Аватар повреждён или превышает допустимые размеры.',
        );
      }
      const contentSha256 = createHash('sha256').update(webp).digest('hex');
      const requestSha256 = createHash('sha256').update(source).digest('hex');
      const objectKey = `profile-photos/${tenantId}/${userId}/${contentSha256}.webp`;
      const syncedAt = new Date();
      const command = {
        tenantId,
        userId,
        objectKey,
        contentSha256,
        requestSha256,
        idempotencyKey: idempotencyKey as string,
        grantId: grant.grantId,
        grantIssuedAt: grant.issuedAt,
      } as const;
      try {
        const reservation = await options.repository.reserveClientAssistedPhoto({
          ...command,
          expiresAt: new Date(
            syncedAt.getTime() + options.previousObjectRetentionSeconds * 1_000,
          ).toISOString(),
        });
        if (reservation.avatarUrl) {
          reply.status(200);
          return { avatarUrl: reservation.avatarUrl, replayed: true };
        }
        await options.store.put({ key: objectKey, body: webp, sha256: contentSha256 });
        const result = await options.repository.finalizeClientAssistedPhoto({
          ...command,
          syncedAt: syncedAt.toISOString(),
          previousObjectRetentionSeconds: options.previousObjectRetentionSeconds,
          correlationId: request.id,
        });
        reply.status(result.replayed ? 200 : 201);
        return result;
      } catch (error) {
        if (error instanceof ProfilePhotoIdempotencyConflictError) {
          return sendApiError(
            request,
            reply,
            409,
            'PROFILE_PHOTO_IDEMPOTENCY_CONFLICT',
            'Этот Idempotency-Key уже использован для другого изображения.',
          );
        }
        if (error instanceof ProfilePhotoGrantStaleError) {
          return sendApiError(
            request,
            reply,
            409,
            'PROFILE_PHOTO_GRANT_STALE',
            'Получено устаревшее разрешение на синхронизацию аватара.',
          );
        }
        request.log.error({ error, tenantId, userId }, 'client-assisted profile photo sync failed');
        return sendApiError(
          request,
          reply,
          503,
          'PROFILE_PHOTO_STORAGE_UNAVAILABLE',
          'Хранилище аватаров временно недоступно.',
        );
      }
    },
  );

  app.get('/public/api/v1/media/profile-photos/:tenantId/:deliveryId', async (request, reply) => {
    const params = request.params as { tenantId?: string; deliveryId?: string };
    const tenantId = params.tenantId;
    const deliveryId = params.deliveryId;
    if (
      !tenantId ||
      !deliveryId ||
      !UUID_PATTERN.test(tenantId) ||
      !UUID_PATTERN.test(deliveryId)
    ) {
      return sendApiError(request, reply, 404, 'PROFILE_PHOTO_NOT_FOUND', 'Аватар не найден.');
    }
    if (!options.repository || !options.store) {
      return sendApiError(
        request,
        reply,
        503,
        'PROFILE_PHOTO_UNAVAILABLE',
        'Аватар временно недоступен.',
      );
    }
    try {
      const objectKey = await options.repository.getPhotoObjectKey(tenantId, deliveryId);
      if (!objectKey) {
        return sendApiError(request, reply, 404, 'PROFILE_PHOTO_NOT_FOUND', 'Аватар не найден.');
      }
      const object = await options.store.read(objectKey);
      reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      reply.type('image/webp');
      if (object.contentLength !== undefined) reply.header('Content-Length', object.contentLength);
      if (object.etag) reply.header('ETag', object.etag);
      return reply.send(object.body);
    } catch (error) {
      if (error instanceof ProfilePhotoMediaNotFoundError) {
        return sendApiError(request, reply, 404, 'PROFILE_PHOTO_NOT_FOUND', 'Аватар не найден.');
      }
      request.log.error({ error, tenantId, deliveryId }, 'profile photo media read failed');
      return sendApiError(
        request,
        reply,
        503,
        'PROFILE_PHOTO_STORAGE_UNAVAILABLE',
        'Хранилище аватаров временно недоступно.',
      );
    }
  });
}
