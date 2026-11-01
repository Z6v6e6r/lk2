import { stationStreamCursor } from './station-stream-page.js';
import { z } from 'zod';
import { stationStreamUuid, stationReadRequestSchema } from '@phub/communities';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { sendApiError } from '../http-errors.js';
import {
  StationStreamOwnerError,
  type StationStreamOwner,
  type StationStreamActor,
} from './station-stream-owner-client.js';
const empty = z.object({}).strict();
const ids = z
  .string()
  .max(1849)
  .transform((value) => value.split(','))
  .pipe(z.array(stationStreamUuid).min(1).max(50))
  .refine((value) => new Set(value).size === value.length);

export function registerStationStreamRoutes(
  app: FastifyInstance,
  options: {
    readonly owner?: StationStreamOwner;
    readonly authenticatedTenantHandlers: readonly preHandlerHookHandler[];
  },
): void {
  const routes = [
    { method: 'GET', suffix: '/station-stream-summaries', operation: 'summaries' },
    { method: 'GET', suffix: '/:communityId/station-stream', operation: 'history' },
    { method: 'POST', suffix: '/:communityId/read-requests', operation: 'read' },
    { method: 'GET', suffix: '/:communityId/read-requests/:requestId', operation: 'read-status' },
  ] as const;
  for (const route of routes)
    app.route({
      method: route.method,
      url: `/user/api/v1/:tenantKey/community-views${route.suffix}`,
      preHandler: [...options.authenticatedTenantHandlers],
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        reply.header('Referrer-Policy', 'no-referrer');
        const current = request as FastifyRequest & {
          tenantId?: string;
          padlHubClaims?: { sub?: string; sid?: string };
        };
        if (!current.tenantId || !current.padlHubClaims?.sub || !current.padlHubClaims.sid)
          return sendApiError(request, reply, 401, 'AUTH_REQUIRED', 'Требуется авторизация.');
        const params = z
          .object({
            tenantKey: z.string().min(1),
            communityId: stationStreamUuid.optional(),
            requestId: stationStreamUuid.optional(),
          })
          .strict()
          .safeParse(request.params);
        const query =
          route.operation === 'summaries'
            ? z.object({ communityIds: ids }).strict().safeParse(request.query)
            : route.operation === 'history'
              ? z
                  .object({
                    limit: z
                      .string()
                      .regex(/^[1-9][0-9]?$/)
                      .default('50')
                      .transform(Number)
                      .pipe(z.number().int().min(1).max(50)),
                    cursor: z
                      .string()
                      .min(16)
                      .max(1024)
                      .regex(/^[A-Za-z0-9_-]+$/)
                      .optional(),
                  })
                  .strict()
                  .safeParse(request.query)
              : empty.safeParse(request.query);
        const body =
          route.operation === 'read' ? stationReadRequestSchema.safeParse(request.body) : undefined;
        if (
          !params.success ||
          !query.success ||
          (route.method === 'GET' && request.body !== undefined) ||
          (route.operation !== 'summaries' && !params.data.communityId) ||
          (route.operation === 'read-status' && !params.data.requestId) ||
          (route.operation === 'read' &&
            (!body?.success || request.headers['idempotency-key'] !== body.data.requestId))
        )
          return sendApiError(
            request,
            reply,
            400,
            'STATION_STREAM_REQUEST_INVALID',
            'Проверьте запрос чата.',
          );
        if (route.operation === 'history' && 'limit' in query.data) {
          try {
            stationStreamCursor(query.data.cursor, {
              tenantId: current.tenantId,
              communityId: params.data.communityId!,
            });
          } catch {
            return sendApiError(
              request,
              reply,
              400,
              'STATION_STREAM_REQUEST_INVALID',
              'Проверьте запрос чата.',
            );
          }
        }
        if (!options.owner)
          return sendApiError(
            request,
            reply,
            503,
            'STATION_STREAM_UNAVAILABLE',
            'Чат временно недоступен.',
          );
        const actor: StationStreamActor = {
          tenantId: current.tenantId,
          tenantKey: params.data.tenantKey,
          userId: current.padlHubClaims.sub,
          sessionId: current.padlHubClaims.sid,
          correlationId: request.id,
        };
        try {
          if (route.operation === 'summaries' && 'communityIds' in query.data)
            return reply.send(await options.owner.summaries(actor, query.data.communityIds));
          const scoped = { ...actor, communityId: params.data.communityId! };
          if (route.operation === 'history' && 'limit' in query.data)
            return reply.send(
              await options.owner.history(scoped, query.data.limit, query.data.cursor),
            );
          if (body?.success) return reply.send(await options.owner.read(scoped, body.data));
          return reply.send(await options.owner.readStatus(scoped, params.data.requestId!));
        } catch (error) {
          // Stable operation/status only: no owner IDs, author data, body, token or raw exception.
          const status = error instanceof StationStreamOwnerError ? error.status : 503;
          request.log.warn(
            { stationStreamOperation: route.operation, stationStreamStatus: status },
            'station stream unavailable',
          );
          return sendApiError(
            request,
            reply,
            status,
            'STATION_STREAM_UNAVAILABLE',
            'Чат или статус прочтения пока недоступен.',
          );
        }
      },
    });
}
