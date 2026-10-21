import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../http-errors.js';
import {
  GameJoinConditionsError,
  readGameJoinConditions,
  type GameJoinConditionsOwner,
} from './game-join-conditions.js';

export type GameJoinConditionsRequest = FastifyRequest & {
  tenantId?: string;
  padlHubClaims?: {
    readonly sub: string;
    readonly sid: string;
    readonly tenants: readonly string[];
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
  };
};
export interface GameJoinConditionsRouteOptions {
  readonly owner?: GameJoinConditionsOwner;
  readonly authenticatedTenantHandlers: readonly ((
    request: GameJoinConditionsRequest,
    reply: FastifyReply,
  ) => Promise<void> | void)[];
}

export function registerGameJoinConditionsRoutes(
  app: FastifyInstance,
  options: GameJoinConditionsRouteOptions,
): void {
  app.get(
    '/user/api/v1/:tenantKey/games/:gameId/join-conditions',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60_000,
          hook: 'preHandler',
          keyGenerator: (request: GameJoinConditionsRequest) =>
            `join-conditions:${request.tenantId ?? 'missing'}:${request.padlHubClaims?.sub ?? request.ip}`,
        },
      },
      preHandler: [...options.authenticatedTenantHandlers],
    },
    async (request, reply) => {
      const actorRequest = request as GameJoinConditionsRequest;
      reply.header('Cache-Control', 'no-store');
      const params = z
        .object({ tenantKey: z.string().min(1), gameId: z.string().uuid() })
        .safeParse(request.params);
      const query = z
        .strictObject({
          expectedRevision: z
            .string()
            .regex(/^[1-9][0-9]{0,15}$/)
            .transform(Number)
            .refine(Number.isSafeInteger),
          subscriptionInstanceId: z.string().uuid(),
        })
        .safeParse(request.query);
      if (!params.success || !query.success) {
        sendApiError(
          request,
          reply,
          400,
          'GAME_JOIN_CONDITIONS_REQUEST_INVALID',
          'Некорректный запрос условий участия.',
        );
        return;
      }
      const claims = actorRequest.padlHubClaims;
      if (!claims || !actorRequest.tenantId) {
        sendApiError(
          request,
          reply,
          401,
          'GAME_JOIN_CONDITIONS_ACTOR_INVALID',
          'Сессия недоступна.',
        );
        return;
      }
      if (!options.owner) {
        sendApiError(
          request,
          reply,
          503,
          'GAME_JOIN_CONDITIONS_DISABLED',
          'Условия участия пока не подключены.',
        );
        return;
      }
      try {
        reply.send(
          await readGameJoinConditions(
            options.owner,
            {
              tenantKey: params.data.tenantKey,
              correlationId: request.id,
              tenantId: actorRequest.tenantId,
              userId: claims.sub,
              sessionId: claims.sid,
              gameId: params.data.gameId,
              ...query.data,
            },
            request.id,
          ),
        );
      } catch (error) {
        const known = error instanceof GameJoinConditionsError;
        request.log.info(
          { code: known ? error.code : 'GAME_JOIN_CONDITIONS_UNAVAILABLE' },
          'game join advisory refused',
        );
        sendApiError(
          request,
          reply,
          known ? error.status : 503,
          known ? error.code : 'GAME_JOIN_CONDITIONS_UNAVAILABLE',
          'Условия участия не подтверждены. Обновите проверку.',
        );
      }
    },
  );
}
