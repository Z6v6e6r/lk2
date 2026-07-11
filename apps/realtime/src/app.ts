import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import type { AppConfig } from '@phub/config';
import Fastify from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify } from 'jose';
import type { Logger } from 'pino';
import type { RawData, WebSocket } from 'ws';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function safeCorrelationId(header: string | readonly string[] | undefined): string {
  return typeof header === 'string' && CORRELATION_ID_PATTERN.test(header) ? header : randomUUID();
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export async function buildRealtimeApp(options: {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly redis?: Redis;
}) {
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: (request) => safeCorrelationId(request.headers['x-correlation-id']),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Correlation-ID', request.id);
  });

  app.get('/health/live', () => ({ status: 'ok', service: 'phub-realtime' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (!options.redis || (await options.redis.ping()) !== 'PONG')
        throw new Error('Redis unavailable');
      return { status: 'ready', redis: true };
    } catch {
      return reply.status(503).send({ status: 'not_ready', redis: false });
    }
  });

  app.get<{ Params: { tenantKey: string } }>(
    '/realtime/v1/:tenantKey',
    { websocket: true },
    (socket: WebSocket, request) => {
      const authenticationTimeout = setTimeout(() => socket.close(4401, 'Unauthorized'), 5_000);
      socket.once('close', () => clearTimeout(authenticationTimeout));
      socket.once('message', (rawMessage) => {
        void (async () => {
          try {
            const message = JSON.parse(rawDataToText(rawMessage)) as unknown;
            if (
              typeof message !== 'object' ||
              message === null ||
              !('type' in message) ||
              message.type !== 'authenticate' ||
              !('ticket' in message) ||
              typeof message.ticket !== 'string' ||
              message.ticket.length > 4_096
            ) {
              throw new Error('Authentication message invalid');
            }
            const { payload } = await jwtVerify(
              message.ticket,
              new TextEncoder().encode(options.config.JWT_ACCESS_SECRET),
              {
                issuer: options.config.JWT_ISSUER,
                audience: options.config.JWT_REALTIME_AUDIENCE,
              },
            );
            if (
              payload.scope !== 'realtime.connect' ||
              payload.tenantKey !== request.params.tenantKey ||
              typeof payload.sub !== 'string' ||
              !UUID_PATTERN.test(payload.sub) ||
              typeof payload.tenantId !== 'string' ||
              !UUID_PATTERN.test(payload.tenantId)
            ) {
              throw new Error('Ticket scope mismatch');
            }
            clearTimeout(authenticationTimeout);
            socket.send(
              JSON.stringify({
                type: 'connection.ready',
                correlationId: request.id,
                occurredAt: new Date().toISOString(),
              }),
            );
          } catch {
            clearTimeout(authenticationTimeout);
            socket.close(4401, 'Unauthorized');
          }
        })();
      });
    },
  );

  return app;
}
