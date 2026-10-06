import type {
  BookedOperationAdmissionTargetRepository,
  SubscriptionRuntimeActorContextRepository,
} from '@phub/database';
import {
  BookedOperationAdmissionError,
  bookedOperationAdmissionId,
  parseBookedOperationAdmissionRequest,
  type BookedOperationAdmissionClient,
} from '@phub/subscription-runtime-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendApiError } from '../http-errors.js';
import {
  subscriptionRuntimeIdempotencyKeySha256,
  type SubscriptionRuntimeActorDelegationIssuer,
} from './subscription-runtime-actor-delegation-issuer.js';

export interface BookedOperationAdmissionRouteOptions {
  readonly actorContextRepository?: Pick<SubscriptionRuntimeActorContextRepository, 'resolve'>;
  readonly targetRepository?: BookedOperationAdmissionTargetRepository;
  readonly delegationIssuer?: Pick<
    SubscriptionRuntimeActorDelegationIssuer,
    'issueBookedOperationAdmission'
  >;
  readonly client?: Pick<BookedOperationAdmissionClient, 'admit'>;
  readonly commandHandlers: readonly ((
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void> | void)[];
}
export function registerBookedOperationAdmissionRoutes(
  app: FastifyInstance,
  options: BookedOperationAdmissionRouteOptions,
): void {
  app.post(
    '/user/api/v1/:tenantKey/booked-operation-admissions',
    { preHandler: [...options.commandHandlers] },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const body = parseBookedOperationAdmissionRequest(request.body);
        const key = request.headers['idempotency-key'];
        if (
          Object.keys(request.query as object).length ||
          typeof key !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)
        )
          throw new BookedOperationAdmissionError(400);
        if (
          !options.actorContextRepository ||
          !options.targetRepository ||
          !options.delegationIssuer ||
          !options.client
        ) {
          sendApiError(
            request,
            reply,
            503,
            'BOOKED_OPERATION_ADMISSION_DISABLED',
            'Приём операции не подключён.',
          );
          return;
        }
        const claims = request.padlHubClaims;
        const tenantId = request.tenantId;
        if (!claims || !tenantId) throw new BookedOperationAdmissionError(401);
        const context = await options.actorContextRepository.resolve({
          tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
        });
        if (context.outcome !== 'ok')
          throw new BookedOperationAdmissionError(
            context.outcome === 'session_inactive' ? 401 : 503,
          );
        const target = await options.targetRepository.resolve({
          tenantId,
          targetId: body.target.id,
          expectedRevision: body.target.expectedRevision,
        });
        if (!target) throw new BookedOperationAdmissionError(409);
        const operationId = bookedOperationAdmissionId(
          tenantId,
          claims.sub,
          subscriptionRuntimeIdempotencyKeySha256(key),
        );
        const actorDelegation = await options.delegationIssuer.issueBookedOperationAdmission({
          tenantId,
          tenantKey: (request.params as { tenantKey: string }).tenantKey,
          userId: claims.sub,
          sessionId: claims.sid,
          ...context,
          ...target,
          operationId,
          request: body,
          idempotencyKey: key,
          correlationId: request.id,
        });
        const result = await options.client.admit(body, {
          operationId,
          actorDelegation,
          correlationId: request.id,
        });
        reply.code(202).send(result);
      } catch (e) {
        const status = e instanceof BookedOperationAdmissionError ? e.status : 503;
        sendApiError(
          request,
          reply,
          status,
          status === 409
            ? 'BOOKED_OPERATION_ADMISSION_CONFLICT'
            : status === 400
              ? 'BOOKED_OPERATION_ADMISSION_REQUEST_INVALID'
              : status === 401
                ? 'BOOKED_OPERATION_SESSION_INACTIVE'
                : 'BOOKED_OPERATION_ADMISSION_UNAVAILABLE',
          'Операция не принята.',
        );
      }
    },
  );
}
