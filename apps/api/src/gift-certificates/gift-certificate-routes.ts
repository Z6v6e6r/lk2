import type { GiftCertificateCatalogRepository } from '@phub/database';
import { publicGiftCertificateCatalogSchema } from '@phub/gift-certificates';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'GIFT_CERTIFICATE_CATALOG_UNAVAILABLE',
    'Каталог сертификатов временно недоступен.',
  );
}

async function catalogResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: GiftCertificateCatalogRepository | undefined,
  cacheControl: string,
) {
  const tenantId = request.tenantId;
  if (!tenantId) {
    return sendApiError(
      request,
      reply,
      503,
      'TENANT_CONTEXT_UNAVAILABLE',
      'Контекст организации недоступен.',
    );
  }
  if (!repository) return unavailable(request, reply);
  const catalog = await repository.getPublic(tenantId);
  if (!catalog) {
    return sendApiError(
      request,
      reply,
      404,
      'GIFT_CERTIFICATE_CATALOG_NOT_PUBLISHED',
      'Витрина сертификатов пока недоступна.',
    );
  }
  reply.header('Cache-Control', cacheControl);
  return publicGiftCertificateCatalogSchema.parse(catalog);
}

export function registerGiftCertificateRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: GiftCertificateCatalogRepository;
    readonly publicTenantHandlers: readonly preHandlerHookHandler[];
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/public/api/v1/:tenantKey/gift-certificate-catalog',
    { preHandler: [...options.publicTenantHandlers] },
    (request, reply) =>
      catalogResponse(
        request,
        reply,
        options.repository,
        'public, max-age=60, stale-while-revalidate=120',
      ),
  );

  app.get(
    '/user/api/v1/:tenantKey/gift-certificate-catalog',
    { preHandler: [...options.authenticatedTenantHandlers] },
    (request, reply) =>
      catalogResponse(
        request,
        reply,
        options.repository,
        'private, max-age=30, stale-while-revalidate=60',
      ),
  );
}
