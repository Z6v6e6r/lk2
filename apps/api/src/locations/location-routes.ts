import type { LocationRepository } from '@phub/database';
import {
  buildLocationDetail,
  buildLocationSummary,
  locationDetailSchema,
  locationListSchema,
} from '@phub/locations';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tenantId(request: FastifyRequest): string | undefined {
  return request.tenantId;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'LOCATION_DIRECTORY_UNAVAILABLE',
    'Локации временно недоступны.',
  );
}

export function registerLocationRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: LocationRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/locations',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      const currentTenantId = tenantId(request);
      if (!currentTenantId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const locations = await options.repository.listPublished(currentTenantId, { limit: 100 });
      reply.header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
      return locationListSchema.parse({ items: locations.map(buildLocationSummary) });
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/locations/:locationId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      const currentTenantId = tenantId(request);
      const locationId = (request.params as { locationId?: string }).locationId;
      if (!currentTenantId) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!locationId || !UUID_PATTERN.test(locationId)) {
        return sendApiError(
          request,
          reply,
          400,
          'LOCATION_ID_INVALID',
          'Некорректный идентификатор локации.',
        );
      }
      if (!options.repository) return unavailable(request, reply);
      const location = await options.repository.getPublished(currentTenantId, locationId);
      if (!location) {
        return sendApiError(request, reply, 404, 'LOCATION_NOT_FOUND', 'Локация не найдена.');
      }
      reply.header('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');
      return locationDetailSchema.parse(buildLocationDetail(location));
    },
  );
}
