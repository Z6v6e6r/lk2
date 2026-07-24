import { createHash } from 'node:crypto';

import type {
  GiftCertificateCatalogCommandResult,
  GiftCertificateCatalogRepository,
} from '@phub/database';
import {
  giftCertificateAdminCatalogStateSchema,
  giftCertificateCatalogViewSchema,
  publishGiftCertificateCatalogRequestSchema,
  saveGiftCertificateCatalogDraftRequestSchema,
} from '@phub/gift-certificates';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

import { sendApiError } from '../http-errors.js';

type PermissionMode = 'read' | 'manage' | 'publish';

function principal(request: FastifyRequest): { tenantId: string; actorUserId: string } | undefined {
  const tenantId = request.tenantId;
  const actorUserId = request.padlHubClaims?.sub;
  return tenantId && actorUserId ? { tenantId, actorUserId } : undefined;
}

function hasPermission(request: FastifyRequest, mode: PermissionMode): boolean {
  const roles = request.padlHubClaims?.roles ?? [];
  const permissions = request.padlHubClaims?.permissions ?? [];
  if (!roles.includes('admin')) return false;
  if (mode === 'manage') return permissions.includes('gift_certificates.catalog.manage');
  if (mode === 'publish') return permissions.includes('gift_certificates.catalog.publish');
  return permissions.some((permission) =>
    [
      'gift_certificates.catalog.read',
      'gift_certificates.catalog.manage',
      'gift_certificates.catalog.publish',
    ].includes(permission),
  );
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  mode: PermissionMode,
): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  if (hasPermission(request, mode)) return true;
  sendApiError(
    request,
    reply,
    403,
    'GIFT_CERTIFICATE_CATALOG_PERMISSION_REQUIRED',
    mode === 'read'
      ? 'Нет права на просмотр каталога сертификатов.'
      : mode === 'publish'
        ? 'Нет права на публикацию каталога сертификатов.'
        : 'Нет права на изменение каталога сертификатов.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'GIFT_CERTIFICATE_CATALOG_ADMIN_UNAVAILABLE',
    'Управление сертификатами временно недоступно.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

function commandResult(
  request: FastifyRequest,
  reply: FastifyReply,
  result: GiftCertificateCatalogCommandResult,
) {
  switch (result.outcome) {
    case 'applied':
      return {
        ...giftCertificateCatalogViewSchema.parse(result.catalog),
        replayed: result.replayed,
      };
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_CERTIFICATE_CATALOG_IDEMPOTENCY_CONFLICT',
        'Ключ операции уже использован с другими данными.',
      );
    case 'draft_missing':
      return sendApiError(
        request,
        reply,
        404,
        'GIFT_CERTIFICATE_CATALOG_DRAFT_NOT_FOUND',
        'Черновик каталога не найден.',
      );
    case 'version_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'GIFT_CERTIFICATE_CATALOG_VERSION_CONFLICT',
        'Черновик уже изменил другой оператор. Обновите данные.',
      );
    case 'publication_incomplete':
      return sendApiError(
        request,
        reply,
        422,
        'GIFT_CERTIFICATE_CATALOG_PUBLICATION_INCOMPLETE',
        `Для публикации заполните: ${result.missing.join(', ')}.`,
      );
  }
}

export function registerGiftCertificateAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: GiftCertificateCatalogRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/gift-certificate-catalog',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      return giftCertificateAdminCatalogStateSchema.parse(
        await options.repository.getAdminState(current.tenantId),
      );
    },
  );

  app.put(
    '/admin/api/v1/:tenantKey/gift-certificate-catalog/draft',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'manage')) return;
      const current = principal(request);
      const operationKey = idempotencyKey(request);
      if (!current || !operationKey) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const parsed = saveGiftCertificateCatalogDraftRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'GIFT_CERTIFICATE_CATALOG_PAYLOAD_INVALID',
          'Проверьте настройки каталога сертификатов.',
        );
      }
      const result = await options.repository.saveDraft({
        tenantId: current.tenantId,
        actorUserId: current.actorUserId,
        expectedRevision: parsed.data.expectedRevision,
        idempotencyKey: operationKey,
        requestHash: requestHash(parsed.data),
        correlationId: request.id,
        catalog: parsed.data.catalog,
      });
      return commandResult(request, reply, result);
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/gift-certificate-catalog/draft/publish',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'publish')) return;
      const current = principal(request);
      const operationKey = idempotencyKey(request);
      if (!current || !operationKey) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const parsed = publishGiftCertificateCatalogRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'GIFT_CERTIFICATE_CATALOG_PAYLOAD_INVALID',
          'Проверьте версию публикуемого каталога.',
        );
      }
      const result = await options.repository.publishDraft({
        tenantId: current.tenantId,
        actorUserId: current.actorUserId,
        catalogId: parsed.data.catalogId,
        expectedRevision: parsed.data.expectedRevision,
        idempotencyKey: operationKey,
        requestHash: requestHash(parsed.data),
        correlationId: request.id,
      });
      return commandResult(request, reply, result);
    },
  );
}
