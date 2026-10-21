import type { SubscriptionRuntimeActorContextRepository } from '@phub/database';
import {
  BookedOperationReadError,
  parseBookedOperationReadOutcome,
  type BookedOperationReadClient,
} from '@phub/subscription-runtime-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sendApiError } from '../http-errors.js';
import type { SubscriptionRuntimeActorDelegationIssuer } from './subscription-runtime-actor-delegation-issuer.js';

export interface BookedOperationReadRouteOptions {
  readonly actorContextRepository?: Pick<SubscriptionRuntimeActorContextRepository, 'resolve'>;
  readonly delegationIssuer?: Pick<
    SubscriptionRuntimeActorDelegationIssuer,
    'issueBookedOperationRead'
  >;
  readonly client?: Pick<BookedOperationReadClient, 'read'>;
  readonly authenticatedTenantHandlers: readonly ((
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void> | void)[];
}

export function registerBookedOperationReadRoutes(
  app: FastifyInstance,
  options: BookedOperationReadRouteOptions,
): void {
  app.get(
    '/user/api/v1/:tenantKey/booked-operations/:operationId',
    {
      preHandler: [...options.authenticatedTenantHandlers],
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { tenantKey, operationId } = request.params as {
        tenantKey: string;
        operationId: string;
      };
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          operationId,
        ) ||
        Object.keys(request.query as object).length > 0
      ) {
        sendApiError(
          request,
          reply,
          400,
          'BOOKED_OPERATION_REQUEST_INVALID',
          'Некорректный запрос статуса операции.',
        );
        return;
      }
      const claims = request.padlHubClaims;
      const tenantId = request.tenantId;
      if (!claims || !tenantId) {
        sendApiError(
          request,
          reply,
          401,
          'BOOKED_OPERATION_ACTOR_INVALID',
          'Проверенный контекст пользователя недоступен.',
        );
        return;
      }
      if (!options.actorContextRepository || !options.delegationIssuer || !options.client) {
        sendApiError(
          request,
          reply,
          503,
          'BOOKED_OPERATION_READ_DISABLED',
          'Чтение статуса операции не подключено.',
        );
        return;
      }
      try {
        const context = await options.actorContextRepository.resolve({
          tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
        });
        if (context.outcome !== 'ok') {
          const inactive = context.outcome === 'session_inactive';
          sendApiError(
            request,
            reply,
            inactive ? 401 : 503,
            inactive
              ? 'BOOKED_OPERATION_SESSION_INACTIVE'
              : 'BOOKED_OPERATION_ACTOR_MAPPING_UNAVAILABLE',
            'Проверенный контекст операции недоступен.',
          );
          return;
        }
        const actorDelegation = await options.delegationIssuer.issueBookedOperationRead({
          userId: claims.sub,
          tenantId,
          tenantKey,
          sessionId: claims.sid,
          providerClientId: context.providerClientId,
          providerMappingId: context.providerMappingId,
          operationId,
          correlationId: request.id,
        });
        const outcome = await options.client.read(operationId, {
          actorDelegation,
          correlationId: request.id,
        });
        reply.send(parseBookedOperationReadOutcome(outcome, operationId));
      } catch (error) {
        const notFound = error instanceof BookedOperationReadError && error.status === 404;
        sendApiError(
          request,
          reply,
          notFound ? 404 : 503,
          notFound ? 'BOOKED_OPERATION_NOT_FOUND' : 'BOOKED_OPERATION_READ_UNAVAILABLE',
          notFound ? 'Операция недоступна.' : 'Статус операции временно недоступен.',
        );
      }
    },
  );
}
