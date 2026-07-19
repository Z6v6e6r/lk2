import { createHash } from 'node:crypto';

import type { BookingPreferencesRepository } from '@phub/database';
import { BOOKING_PREFERENCE_WEEKDAYS } from '@phub/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeWindowSchema = z
  .object({
    weekday: z.enum(BOOKING_PREFERENCE_WEEKDAYS),
    startsAt: time,
    endsAt: time,
  })
  .strict()
  .refine((window) => window.startsAt < window.endsAt, {
    message: 'preferred time window must end after it starts',
  });

const updateSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    favoriteStationIds: z.array(z.string().uuid()).max(3),
    preferredTimeWindows: z.array(timeWindowSchema).max(14),
    useHistory: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.favoriteStationIds).size !== value.favoriteStationIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['favoriteStationIds'],
        message: 'favorite stations must be unique',
      });
    }
    const windows = value.preferredTimeWindows.map(
      (window) => `${window.weekday}:${window.startsAt}:${window.endsAt}`,
    );
    if (new Set(windows).size !== windows.length) {
      context.addIssue({
        code: 'custom',
        path: ['preferredTimeWindows'],
        message: 'preferred time windows must be unique',
      });
    }
  });

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function canManagePreferences(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.padlHubClaims?.permissions.includes('profile.read')) return true;
  sendApiError(
    request,
    reply,
    403,
    'BOOKING_PREFERENCES_PERMISSION_REQUIRED',
    'Нет доступа к настройкам рекомендаций.',
  );
  return false;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'BOOKING_PREFERENCES_UNAVAILABLE',
    'Настройки рекомендаций временно недоступны.',
  );
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function registerBookingPreferenceRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: BookingPreferencesRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/profile/booking-preferences',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!canManagePreferences(request, reply)) return;
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      return options.repository.get(current.tenantId, current.userId);
    },
  );

  app.put(
    '/user/api/v1/:tenantKey/profile/booking-preferences',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!canManagePreferences(request, reply)) return;
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
          'BOOKING_PREFERENCES_PAYLOAD_INVALID',
          'Проверьте любимые станции и удобное время.',
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
          'BOOKING_PREFERENCES_VERSION_CONFLICT',
          'Настройки уже изменились. Обновите профиль и повторите.',
        );
      }
      reply.header('X-Idempotent-Replayed', String(result.replayed));
      return result.settings;
    },
  );
}
