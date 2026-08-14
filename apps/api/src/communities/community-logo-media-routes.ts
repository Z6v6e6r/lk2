import type { CommunityLogoMediaRepository } from '@phub/database';
import type { FastifyInstance } from 'fastify';

import { sendApiError } from '../http-errors.js';
import {
  ProfilePhotoMediaNotFoundError,
  type ProfilePhotoMediaStore,
} from '../profile/profile-photo-media-store.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerCommunityLogoMediaRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: CommunityLogoMediaRepository;
    readonly store?: ProfilePhotoMediaStore;
  },
): void {
  app.get('/public/api/v1/media/community-logos/:tenantId/:communityId', async (request, reply) => {
    const params = request.params as { tenantId?: string; communityId?: string };
    const tenantId = params.tenantId;
    const communityId = params.communityId;
    if (
      !tenantId ||
      !communityId ||
      !UUID_PATTERN.test(tenantId) ||
      !UUID_PATTERN.test(communityId)
    ) {
      return sendApiError(
        request,
        reply,
        404,
        'COMMUNITY_LOGO_NOT_FOUND',
        'Логотип сообщества не найден.',
      );
    }
    if (!options.repository || !options.store) {
      return sendApiError(
        request,
        reply,
        503,
        'COMMUNITY_LOGO_UNAVAILABLE',
        'Логотип сообщества временно недоступен.',
      );
    }
    try {
      const objectKey = await options.repository.getObjectKey(tenantId, communityId);
      if (!objectKey) {
        return sendApiError(
          request,
          reply,
          404,
          'COMMUNITY_LOGO_NOT_FOUND',
          'Логотип сообщества не найден.',
        );
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
        return sendApiError(
          request,
          reply,
          404,
          'COMMUNITY_LOGO_NOT_FOUND',
          'Логотип сообщества не найден.',
        );
      }
      request.log.error({ error, tenantId, communityId }, 'community logo media read failed');
      return sendApiError(
        request,
        reply,
        503,
        'COMMUNITY_LOGO_STORAGE_UNAVAILABLE',
        'Хранилище логотипов временно недоступно.',
      );
    }
  });
}
