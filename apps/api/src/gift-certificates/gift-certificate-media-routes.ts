import { createHash, randomUUID } from 'node:crypto';

import type { GiftCertificateMediaRepository } from '@phub/database';
import { giftCertificateMediaAssetSchema } from '@phub/gift-certificates';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import sharp from 'sharp';

import { sendApiError } from '../http-errors.js';
import type { GiftCertificateMediaStore } from './gift-certificate-media-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function requireManagePermission(request: FastifyRequest, reply: FastifyReply): boolean {
  const roles = request.padlHubClaims?.roles ?? [];
  const permissions = request.padlHubClaims?.permissions ?? [];
  if (
    request.headers['x-app-platform'] === 'cup-admin' &&
    roles.includes('admin') &&
    permissions.includes('gift_certificates.catalog.manage')
  ) {
    return true;
  }
  sendApiError(
    request,
    reply,
    403,
    'GIFT_CERTIFICATE_MEDIA_PERMISSION_REQUIRED',
    'Нет права на загрузку изображений сертификатов.',
  );
  return false;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

export function registerGiftCertificateMediaRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: GiftCertificateMediaRepository;
    readonly store?: GiftCertificateMediaStore;
    readonly enabled: boolean;
    readonly maxBytes: number;
    readonly maxDimension: number;
    readonly webpQuality: number;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
    readonly publicTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  for (const contentType of IMAGE_CONTENT_TYPES) {
    if (app.hasContentTypeParser(contentType)) continue;
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: options.maxBytes },
      (_request, body, done) => done(null, body),
    );
  }

  app.post(
    '/admin/api/v1/:tenantKey/gift-certificate-media',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requireManagePermission(request, reply)) return;
      const tenantId = request.tenantId;
      const actorUserId = request.padlHubClaims?.sub;
      const operationKey = idempotencyKey(request);
      const tenantKey = (request.params as { tenantKey?: string }).tenantKey;
      if (!tenantId || !actorUserId || !operationKey || !tenantKey) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.enabled || !options.repository || !options.store) {
        return sendApiError(
          request,
          reply,
          503,
          'GIFT_CERTIFICATE_MEDIA_UNAVAILABLE',
          'Загрузка изображений сертификатов выключена.',
        );
      }
      const source = request.body;
      const contentType = String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.toLowerCase();
      if (Buffer.isBuffer(source) && source.byteLength > options.maxBytes) {
        return sendApiError(
          request,
          reply,
          413,
          'GIFT_CERTIFICATE_MEDIA_TOO_LARGE',
          'Размер исходного изображения превышает допустимый предел.',
        );
      }
      if (!Buffer.isBuffer(source) || !contentType || !IMAGE_CONTENT_TYPES.has(contentType)) {
        return sendApiError(
          request,
          reply,
          415,
          'GIFT_CERTIFICATE_MEDIA_TYPE_INVALID',
          'Поддерживаются JPEG, PNG и WebP.',
        );
      }
      let prepared: Awaited<ReturnType<ReturnType<typeof sharp>['toBuffer']>>;
      try {
        prepared = await sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 })
          .rotate()
          .resize({
            width: options.maxDimension,
            height: options.maxDimension,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: options.webpQuality, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        if (
          !prepared.info.width ||
          !prepared.info.height ||
          prepared.data.byteLength > options.maxBytes
        ) {
          throw new Error('GIFT_CERTIFICATE_MEDIA_INVALID');
        }
      } catch (error) {
        request.log.warn({ error }, 'gift certificate media preparation failed');
        return sendApiError(
          request,
          reply,
          422,
          'GIFT_CERTIFICATE_MEDIA_INVALID',
          'Изображение повреждено или превышает допустимые размеры.',
        );
      }
      const sha256 = createHash('sha256').update(prepared.data).digest('hex');
      const sourceSha256 = createHash('sha256').update(source).digest('hex');
      const assetId = randomUUID();
      const objectKey = `gift-certificate-media/${tenantId}/${sha256}.webp`;
      try {
        await options.store.putPreparedImage({ key: objectKey, body: prepared.data, sha256 });
      } catch (error) {
        request.log.error({ error }, 'gift certificate media storage failed');
        return sendApiError(
          request,
          reply,
          503,
          'GIFT_CERTIFICATE_MEDIA_STORAGE_UNAVAILABLE',
          'Хранилище изображений временно недоступно.',
        );
      }
      const result = await options.repository.saveReady({
        tenantId,
        actorUserId,
        tenantKey,
        assetId,
        objectKey,
        sha256,
        bytes: prepared.data.byteLength,
        width: prepared.info.width,
        height: prepared.info.height,
        idempotencyKey: operationKey,
        requestHash: createHash('sha256')
          .update(`${actorUserId}:${contentType}:${sourceSha256}`)
          .digest('hex'),
        correlationId: request.id,
      });
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'GIFT_CERTIFICATE_MEDIA_IDEMPOTENCY_CONFLICT',
          'Ключ загрузки уже использован для другого изображения.',
        );
      }
      reply.status(result.replayed ? 200 : 201);
      return {
        ...giftCertificateMediaAssetSchema.parse(result.asset),
        replayed: result.replayed,
      };
    },
  );

  app.get(
    '/public/api/v1/:tenantKey/gift-certificate-media/:assetId',
    { preHandler: [...options.publicTenantHandlers] },
    async (request, reply) => {
      const tenantId = request.tenantId;
      const assetId = (request.params as { assetId?: string }).assetId;
      if (!tenantId || !assetId || !UUID_PATTERN.test(assetId)) {
        return sendApiError(
          request,
          reply,
          404,
          'GIFT_CERTIFICATE_MEDIA_NOT_FOUND',
          'Изображение не найдено.',
        );
      }
      if (!options.enabled || !options.repository || !options.store) {
        return sendApiError(
          request,
          reply,
          503,
          'GIFT_CERTIFICATE_MEDIA_UNAVAILABLE',
          'Изображения сертификатов временно недоступны.',
        );
      }
      const stored = await options.repository.getReady(tenantId, assetId);
      if (!stored) {
        return sendApiError(
          request,
          reply,
          404,
          'GIFT_CERTIFICATE_MEDIA_NOT_FOUND',
          'Изображение не найдено.',
        );
      }
      const readUrl = await options.store.createReadUrl(stored.objectKey);
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      return reply.redirect(readUrl, 302);
    },
  );
}
