import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import { REALTIME_TICKET_SCOPE } from '@phub/auth';
import type { AppConfig } from '@phub/config';
import type { MessagingRepository } from '@phub/database';
import Fastify from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify } from 'jose';
import type { Logger } from 'pino';
import type { RawData, WebSocket } from 'ws';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 100;
const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;

export interface RealtimeTicketConsumer {
  consume(ticketId: string): Promise<boolean>;
}

export interface RealtimeMessageCreatedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly correlationId: string;
  readonly occurredAt: string;
}

interface ConnectionContext {
  readonly socket: WebSocket;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly subscriptions: Set<string>;
}

declare module 'fastify' {
  interface FastifyInstance {
    publishMessageCreated(event: RealtimeMessageCreatedEvent): Promise<number>;
  }
}

function safeCorrelationId(header: string | readonly string[] | undefined): string {
  return typeof header === 'string' && CORRELATION_ID_PATTERN.test(header) ? header : randomUUID();
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== 1) return;
  if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
    socket.close(1013, 'Backpressure');
    return;
  }
  socket.send(JSON.stringify(payload));
}

function protocolError(
  socket: WebSocket,
  code: string,
  correlationId: string,
  conversationId?: string,
): void {
  send(socket, {
    type: 'error',
    code,
    correlationId,
    ...(conversationId ? { conversationId } : {}),
  });
}

export async function buildRealtimeApp(options: {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly redis?: Pick<Redis, 'ping'>;
  readonly ticketConsumer?: RealtimeTicketConsumer;
  readonly messagingRepository?: Pick<
    MessagingRepository,
    'authorizeRealtimeSubscription' | 'listRealtimeRecipientUserIds'
  >;
  readonly databaseReady?: () => Promise<boolean>;
  readonly rabbitReady?: () => boolean;
}) {
  const connections = new Set<ConnectionContext>();
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: (request) => safeCorrelationId(request.headers['x-correlation-id']),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.decorate(
    'publishMessageCreated',
    async (event: RealtimeMessageCreatedEvent): Promise<number> => {
      if (!options.messagingRepository) return 0;
      const recipients = new Set(
        await options.messagingRepository.listRealtimeRecipientUserIds({
          tenantId: event.tenantId,
          conversationId: event.conversationId,
          messageId: event.messageId,
          sequence: event.sequence,
        }),
      );
      let delivered = 0;
      for (const connection of connections) {
        if (
          connection.tenantId !== event.tenantId ||
          !connection.subscriptions.has(event.conversationId) ||
          !recipients.has(connection.userId)
        ) {
          continue;
        }
        send(connection.socket, {
          type: 'message.created',
          conversationId: event.conversationId,
          messageId: event.messageId,
          sequence: event.sequence,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt,
        });
        delivered += 1;
      }
      return delivered;
    },
  );

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Correlation-ID', request.id);
  });

  app.get('/health/live', () => ({ status: 'ok', service: 'phub-realtime' }));
  app.get('/health/ready', async (_request, reply) => {
    const [redisReady, databaseReady] = await Promise.all([
      options.redis
        ? options.redis
            .ping()
            .then((result) => result === 'PONG')
            .catch(() => false)
        : Promise.resolve(false),
      options.databaseReady?.().catch(() => false) ?? Promise.resolve(false),
    ]);
    const rabbitReady = options.rabbitReady?.() ?? false;
    if (!redisReady || !databaseReady || !rabbitReady) {
      return reply.status(503).send({
        status: 'not_ready',
        redis: redisReady,
        database: databaseReady,
        rabbit: rabbitReady,
      });
    }
    return { status: 'ready', redis: true, database: true, rabbit: true };
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
              payload.scope !== REALTIME_TICKET_SCOPE ||
              payload.tenantKey !== request.params.tenantKey ||
              typeof payload.sub !== 'string' ||
              !UUID_PATTERN.test(payload.sub) ||
              typeof payload.tenantId !== 'string' ||
              !UUID_PATTERN.test(payload.tenantId) ||
              typeof payload.jti !== 'string' ||
              !UUID_PATTERN.test(payload.jti) ||
              !options.ticketConsumer ||
              !(await options.ticketConsumer.consume(payload.jti))
            ) {
              throw new Error('Ticket scope mismatch');
            }

            const connection: ConnectionContext = {
              socket,
              tenantId: payload.tenantId,
              tenantKey: request.params.tenantKey,
              userId: payload.sub,
              subscriptions: new Set(),
            };
            connections.add(connection);
            socket.once('close', () => connections.delete(connection));
            clearTimeout(authenticationTimeout);
            send(socket, {
              type: 'connection.ready',
              correlationId: request.id,
              occurredAt: new Date().toISOString(),
            });

            socket.on('message', (rawCommand) => {
              void (async () => {
                try {
                  const command = JSON.parse(rawDataToText(rawCommand)) as unknown;
                  if (typeof command !== 'object' || command === null || !('type' in command)) {
                    throw new Error('Command invalid');
                  }
                  if (command.type === 'ping') {
                    send(socket, {
                      type: 'pong',
                      correlationId: request.id,
                      occurredAt: new Date().toISOString(),
                    });
                    return;
                  }
                  if (
                    command.type !== 'conversation.subscribe' ||
                    !('conversationId' in command) ||
                    typeof command.conversationId !== 'string' ||
                    !UUID_PATTERN.test(command.conversationId) ||
                    !('afterSequence' in command) ||
                    typeof command.afterSequence !== 'number' ||
                    !Number.isSafeInteger(command.afterSequence) ||
                    command.afterSequence < 0
                  ) {
                    protocolError(socket, 'REALTIME_COMMAND_INVALID', request.id);
                    return;
                  }
                  if (
                    !connection.subscriptions.has(command.conversationId) &&
                    connection.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
                  ) {
                    protocolError(
                      socket,
                      'REALTIME_SUBSCRIPTION_LIMIT',
                      request.id,
                      command.conversationId,
                    );
                    return;
                  }
                  if (!options.messagingRepository) {
                    protocolError(
                      socket,
                      'REALTIME_STORE_UNAVAILABLE',
                      request.id,
                      command.conversationId,
                    );
                    return;
                  }
                  const result = await options.messagingRepository.authorizeRealtimeSubscription({
                    tenantId: connection.tenantId,
                    userId: connection.userId,
                    conversationId: command.conversationId,
                  });
                  if (result.outcome === 'disabled') {
                    protocolError(
                      socket,
                      'REALTIME_MESSAGING_DISABLED',
                      request.id,
                      command.conversationId,
                    );
                    return;
                  }
                  if (result.outcome === 'not_found') {
                    protocolError(
                      socket,
                      'CONVERSATION_NOT_FOUND',
                      request.id,
                      command.conversationId,
                    );
                    return;
                  }

                  connection.subscriptions.add(command.conversationId);
                  send(socket, {
                    type: 'conversation.subscribed',
                    conversationId: command.conversationId,
                    latestSequence: result.latestSequence,
                    correlationId: request.id,
                  });
                  if (command.afterSequence !== result.latestSequence) {
                    send(socket, {
                      type: 'conversation.gap',
                      conversationId: command.conversationId,
                      afterSequence:
                        command.afterSequence > result.latestSequence ? 0 : command.afterSequence,
                      latestSequence: result.latestSequence,
                      reset: command.afterSequence > result.latestSequence,
                      recovery: 'HTTP',
                      correlationId: request.id,
                    });
                  }
                } catch {
                  protocolError(socket, 'REALTIME_COMMAND_INVALID', request.id);
                }
              })();
            });
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
