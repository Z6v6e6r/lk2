import { createHash } from 'node:crypto';

import type { ProfileFriendshipRepository } from '@phub/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';

import { sendApiError } from '../http-errors.js';

const targetParamsSchema = z.object({ userId: z.string().uuid() }).passthrough();
const listQuerySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(24).default(8) })
  .strict();

function principal(request: FastifyRequest): { tenantId: string; userId: string } | undefined {
  const tenantId = request.tenantId;
  const userId = request.padlHubClaims?.sub;
  return tenantId && userId ? { tenantId, userId } : undefined;
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiError(
    request,
    reply,
    503,
    'PROFILE_FRIENDSHIPS_UNAVAILABLE',
    'Друзья временно недоступны.',
  );
}

function canUseFriendships(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.padlHubClaims?.permissions.includes('profile.read')) return true;
  sendApiError(
    request,
    reply,
    403,
    'PROFILE_FRIENDSHIPS_PERMISSION_REQUIRED',
    'Нет доступа к друзьям профиля.',
  );
  return false;
}

function targetParams(request: FastifyRequest, reply: FastifyReply) {
  const parsed = targetParamsSchema.safeParse(request.params);
  if (parsed.success) return parsed.data;
  sendApiError(request, reply, 400, 'PROFILE_FRIEND_TARGET_INVALID', 'Профиль игрока не найден.');
  return undefined;
}

export function registerProfileFriendshipRoutes(
  app: FastifyInstance,
  options: {
    readonly repository?: ProfileFriendshipRepository;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
    readonly commandHandlers: readonly preHandlerHookHandler[];
  },
): void {
  app.get(
    '/user/api/v1/:tenantKey/profile/friends',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canUseFriendships(request, reply)) return;
      const current = principal(request);
      if (!current) {
        return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
      }
      if (!options.repository) return unavailable(request, reply);
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendApiError(
          request,
          reply,
          400,
          'PROFILE_FRIENDS_QUERY_INVALID',
          'Проверьте параметры списка друзей.',
        );
      }
      return options.repository.list(current.tenantId, current.userId, query.data.limit);
    },
  );

  app.get(
    '/user/api/v1/:tenantKey/profile/friends/:userId',
    { preHandler: [...options.authenticatedTenantHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canUseFriendships(request, reply)) return;
      const current = principal(request);
      const target = targetParams(request, reply);
      if (!current || !target) return;
      if (!options.repository) return unavailable(request, reply);
      return options.repository.get(current.tenantId, current.userId, target.userId);
    },
  );

  app.post(
    '/user/api/v1/:tenantKey/profile/friends/:userId',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!canUseFriendships(request, reply)) return;
      const current = principal(request);
      const target = targetParams(request, reply);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!current || !target || typeof idempotencyKey !== 'string') return;
      if (!options.repository) return unavailable(request, reply);
      const requestHash = createHash('sha256').update(target.userId).digest('hex');
      const result = await options.repository.add({
        tenantId: current.tenantId,
        actorUserId: current.userId,
        targetUserId: target.userId,
        idempotencyKey,
        requestHash,
        correlationId: request.id,
      });
      if (result.outcome === 'self_target') {
        return sendApiError(
          request,
          reply,
          409,
          'PROFILE_FRIEND_SELF_TARGET',
          'Нельзя добавить в друзья самого себя.',
        );
      }
      if (result.outcome === 'target_not_found') {
        return sendApiError(request, reply, 404, 'PROFILE_NOT_FOUND', 'Профиль игрока не найден.');
      }
      if (result.outcome === 'idempotency_conflict') {
        return sendApiError(
          request,
          reply,
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key уже использован для другой команды.',
        );
      }
      reply.header('X-Idempotent-Replayed', String(result.replayed));
      return reply.code(result.replayed ? 200 : 201).send(result.friendship);
    },
  );
}
