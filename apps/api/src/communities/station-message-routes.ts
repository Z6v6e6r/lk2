import { stationMessageRequestSchema } from '@phub/communities';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { sendApiError } from '../http-errors.js';
import {
  StationMessageOwnerError,
  type StationMessageOwner,
} from './station-message-owner-client.js';

export function registerStationMessageRoutes(
  app: FastifyInstance,
  options: {
    readonly owner?: StationMessageOwner;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  for (const method of ['POST', 'GET'] as const)
    app.route({
      method,
      url: `/user/api/v1/:tenantKey/community-views/:communityId/message-requests${method === 'GET' ? '/:requestId' : ''}`,
      preHandler: [...options.authenticatedTenantHandlers],
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const current = request as FastifyRequest & {
          tenantId?: string;
          padlHubClaims?: { sub?: string; sid?: string };
        };
        const claims = current.padlHubClaims;
        if (!current.tenantId || !claims?.sub || !claims.sid)
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        const params = z
          .object({
            tenantKey: z.string().min(1),
            communityId: z.string().uuid(),
            requestId: z.string().uuid().optional(),
          })
          .strict()
          .safeParse(request.params);
        const body =
          method === 'POST' ? stationMessageRequestSchema.safeParse(request.body) : undefined;
        if (
          !params.success ||
          !z.object({}).strict().safeParse(request.query).success ||
          (method === 'GET' && (request.body !== undefined || !params.data?.requestId)) ||
          (method === 'POST' &&
            (!body?.success || request.headers['idempotency-key'] !== body.data.requestId))
        )
          return sendApiError(
            request,
            reply,
            400,
            'STATION_MESSAGE_REQUEST_INVALID',
            'Проверьте сообщение.',
          );
        if (!options.owner)
          return sendApiError(
            request,
            reply,
            503,
            'STATION_MESSAGE_UNAVAILABLE',
            'Отправка временно недоступна.',
          );
        const actor = {
          tenantKey: params.data.tenantKey,
          tenantId: current.tenantId,
          userId: claims.sub,
          sessionId: claims.sid,
          correlationId: request.id,
          communityId: params.data.communityId,
        };
        try {
          const receipt = body?.success
            ? await options.owner.send(actor, body.data)
            : await options.owner.status(actor, params.data.requestId!);
          request.log.info(
            {
              stationMessageOperation: method === 'POST' ? 'send' : 'status',
              stationMessageOutcome: receipt.outcome,
              communityId: actor.communityId,
              requestId: receipt.requestId,
            },
            'station message request audit',
          );
          return reply.send(receipt);
        } catch (error) {
          const status = error instanceof StationMessageOwnerError ? error.status : 503;
          // No provider identifiers, tokens, body or raw exception enter diagnostics.
          request.log.warn(
            {
              stationMessageOperation: method === 'POST' ? 'send' : 'status',
              stationMessageOutcome: 'unavailable',
              communityId: actor.communityId,
              requestId: body?.success ? body.data.requestId : params.data.requestId,
            },
            'station message owner unavailable',
          );
          return sendApiError(
            request,
            reply,
            status,
            'STATION_MESSAGE_UNAVAILABLE',
            'Статус сообщения пока неизвестен.',
          );
        }
      },
    });
}
