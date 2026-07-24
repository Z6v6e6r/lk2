import type { ProfileSummaryRepository } from '@phub/database';
import type { FastifyInstance } from 'fastify';

import { sendApiError } from '../http-errors.js';
import {
  ProfilePhotoMediaNotFoundError,
  type ProfilePhotoMediaStore,
} from './profile-photo-media-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerProfilePhotoMediaRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: Pick<ProfileSummaryRepository, 'getPhotoObjectKey'>;
    readonly store?: ProfilePhotoMediaStore;
  },
): void {
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
    const objectKey = await options.repository.getPhotoObjectKey(tenantId, deliveryId);
    if (!objectKey) {
      return sendApiError(request, reply, 404, 'PROFILE_PHOTO_NOT_FOUND', 'Аватар не найден.');
    }
    try {
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
