import { createHash } from 'node:crypto';

import type { LocationRepository } from '@phub/database';
import {
  locationAdminListSchema,
  locationAdminViewSchema,
  locationProfileInputSchema,
} from '@phub/locations';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updateRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    profile: locationProfileInputSchema,
  })
  .strict();

function principal(
  request: FastifyRequest,
): { tenantId: string; actorUserId: string; permissions: readonly string[] } | undefined {
  const tenantId = request.tenantId;
  const actorUserId = request.padlHubClaims?.sub;
  return tenantId && actorUserId
    ? { tenantId, actorUserId, permissions: request.padlHubClaims?.permissions ?? [] }
    : undefined;
}

function hasLocationPermission(
  request: FastifyRequest,
  mode: 'read' | 'manage' | 'publish',
): boolean {
  const roles = request.padlHubClaims?.roles ?? [];
  const permissions = request.padlHubClaims?.permissions ?? [];
  if (!roles.includes('admin')) return false;
  if (mode === 'manage') return permissions.includes('locations.manage');
  if (mode === 'publish') return permissions.includes('locations.publish');
  return permissions.some((permission) =>
    ['locations.read', 'locations.manage', 'locations.publish'].includes(permission),
  );
}

function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  mode: 'read' | 'manage' | 'publish',
): boolean {
  if (request.headers['x-app-platform'] !== 'cup-admin') {
    sendApiError(request, reply, 403, 'ADMIN_CLIENT_REQUIRED', 'Операция доступна только из ЦУП.');
    return false;
  }
  if (hasLocationPermission(request, mode)) return true;
  sendApiError(
    request,
    reply,
    403,
    'LOCATION_ADMIN_PERMISSION_REQUIRED',
    mode === 'read'
      ? 'Нет права на просмотр локаций.'
      : mode === 'publish'
        ? 'Нет права на публикацию локаций.'
        : 'Нет права на изменение локаций.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'LOCATION_ADMIN_UNAVAILABLE',
    'Управление локациями временно недоступно.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}

function commandResult(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Awaited<ReturnType<LocationRepository['update']>>,
  successStatus: 200 | 201,
) {
  switch (result.outcome) {
    case 'applied':
      reply.status(successStatus);
      return { ...locationAdminViewSchema.parse(result.location), replayed: result.replayed };
    case 'idempotency_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'LOCATION_IDEMPOTENCY_CONFLICT',
        'Ключ операции уже использован с другими данными.',
      );
    case 'not_found':
      return sendApiError(request, reply, 404, 'LOCATION_NOT_FOUND', 'Локация не найдена.');
    case 'version_conflict':
      return sendApiError(
        request,
        reply,
        409,
        'LOCATION_VERSION_CONFLICT',
        'Локацию уже изменил другой оператор. Обновите данные.',
      );
    case 'publication_incomplete':
      return sendApiError(
        request,
        reply,
        422,
        'LOCATION_PUBLICATION_INCOMPLETE',
        `Для публикации заполните: ${result.missingFields.join(', ')}.`,
      );
  }
}

export function registerLocationAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: LocationRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/admin/api/v1/:tenantKey/locations',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const items = await options.repository.listAdmin(current.tenantId);
      return locationAdminListSchema.parse({ items });
    },
  );

  app.get(
    '/admin/api/v1/:tenantKey/locations/:locationId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'read')) return;
      const current = principal(request);
      const locationId = (request.params as { locationId?: string }).locationId;
      if (!current) {
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
      const location = await options.repository.getAdmin(current.tenantId, locationId);
      if (!location) {
        return sendApiError(request, reply, 404, 'LOCATION_NOT_FOUND', 'Локация не найдена.');
      }
      return locationAdminViewSchema.parse(location);
    },
  );

  app.post(
    '/admin/api/v1/:tenantKey/locations',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'manage')) return;
      const current = principal(request);
      const operationKey = idempotencyKey(request);
      if (!current || !operationKey) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const parsed = locationProfileInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'LOCATION_PAYLOAD_INVALID',
          'Проверьте поля локации.',
        );
      }
      if (
        parsed.data.publicationStatus === 'PUBLISHED' &&
        !requirePermission(request, reply, 'publish')
      ) {
        return;
      }
      try {
        const result = await options.repository.create({
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          idempotencyKey: operationKey,
          requestHash: requestHash(parsed.data),
          correlationId: request.id,
          profile: parsed.data,
        });
        return commandResult(request, reply, result, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return sendApiError(
            request,
            reply,
            409,
            'LOCATION_SLUG_CONFLICT',
            'Такой адрес карточки уже используется.',
          );
        }
        throw error;
      }
    },
  );

  app.patch(
    '/admin/api/v1/:tenantKey/locations/:locationId',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      if (!requirePermission(request, reply, 'manage')) return;
      const current = principal(request);
      const operationKey = idempotencyKey(request);
      const locationId = (request.params as { locationId?: string }).locationId;
      if (!current || !operationKey) {
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
      const parsed = updateRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'LOCATION_PAYLOAD_INVALID',
          'Проверьте поля локации.',
        );
      }
      if (
        parsed.data.profile.publicationStatus === 'PUBLISHED' &&
        !requirePermission(request, reply, 'publish')
      ) {
        return;
      }
      try {
        const result = await options.repository.update({
          tenantId: current.tenantId,
          actorUserId: current.actorUserId,
          locationId,
          expectedVersion: parsed.data.expectedVersion,
          idempotencyKey: operationKey,
          requestHash: requestHash({ locationId, ...parsed.data }),
          correlationId: request.id,
          profile: parsed.data.profile,
        });
        return commandResult(request, reply, result, 200);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return sendApiError(
            request,
            reply,
            409,
            'LOCATION_SLUG_CONFLICT',
            'Такой адрес карточки уже используется.',
          );
        }
        throw error;
      }
    },
  );
}
