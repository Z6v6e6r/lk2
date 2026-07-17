import { createHash } from 'node:crypto';

import type { ProfilePrivacyRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const updateSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    contactPolicy: z.enum(['AUTHORIZED', 'NOBODY']),
    chatPolicy: z.enum(['AUTHORIZED', 'NOBODY']),
  })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function canManageOwnPrivacy(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.padlHubClaims?.permissions.includes('profile.read')) return true;
  sendApiError(
    request,
    reply,
    403,
    'PROFILE_PRIVACY_PERMISSION_REQUIRED',
    'Нет доступа к настройкам приватности профиля.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'PROFILE_PRIVACY_UNAVAILABLE',
    'Настройки приватности временно недоступны.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function registerProfilePrivacyRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: ProfilePrivacyRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/profile/privacy',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canManageOwnPrivacy(request, reply)) return;
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      return options.repository.get(current.tenantId, current.userId);
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/profile/privacy',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canManageOwnPrivacy(request, reply)) return;
      const current = principal(request);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || typeof idempotencyKey !== 'string') {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const parsed = updateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'PROFILE_PRIVACY_PAYLOAD_INVALID',
          'Проверьте настройки приватности.',
        );
      }
      const result = await options.repository.update({
        tenantId: current.tenantId,
        userId: current.userId,
        actorUserId: current.userId,
        idempotencyKey,
        requestHash: requestHash(parsed.data),
        correlationId: request.id,
        ...parsed.data,
      });
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      if (result.outcome === 'version_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'PROFILE_PRIVACY_VERSION_CONFLICT',
          'Настройки уже изменились. Обновите профиль и повторите.',
        );
      }
      reply.header('X-Idempotent-Replayed', String(result.replayed));
      return result.settings;
    },
  );
}
