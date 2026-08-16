import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import { REALTIME_TICKET_SCOPE } from '@phub/auth';
import type { AppConfig } from '@phub/config';
import type { MessagingRepository } from '@phub/database';
import Fastify from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify } from 'jose';
import type { Logger } from 'pino';
import { WebSocket, type RawData } from 'ws';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 100;
const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;
const COMMANDS_PER_MINUTE = 60;
const SUBSCRIPTIONS_PER_MINUTE = 20;
const AUTHORITY_RECHECK_INTERVAL_MS = 15_000;

export interface RealtimeTicketConsumer {
  consume(ticketId: string, sessionId: string): Promise<boolean>;
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
  readonly sessionId: string;
  readonly subscriptions: Set<string>;
  commandTail: Promise<void>;
  rateWindowStartedAt: number;
  commandCount: number;
  subscriptionCount: number;
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

function send(socket: WebSocket, payload: Record<string, unknown>): boolean {
  if (socket.readyState !== 1) return false;
  if (socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
    socket.close(1013, 'Backpressure');
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
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

function consumeRateBudget(connection: ConnectionContext, subscription: boolean): boolean {
  const now = Date.now();
  if (now - connection.rateWindowStartedAt >= 60_000) {
    connection.rateWindowStartedAt = now;
    connection.commandCount = 0;
    connection.subscriptionCount = 0;
  }
  connection.commandCount += 1;
  if (subscription) connection.subscriptionCount += 1;
  return (
    connection.commandCount <= COMMANDS_PER_MINUTE &&
    connection.subscriptionCount <= SUBSCRIPTIONS_PER_MINUTE
  );
}

export async function buildRealtimeApp(options: {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly redis?: Pick<Redis, 'ping'>;
  readonly ticketConsumer?: RealtimeTicketConsumer;
  readonly messagingRepository?: Pick<
    MessagingRepository,
    'authorizeRealtimeConnection' | 'authorizeRealtimeSubscription' | 'listRealtimeRecipientUserIds'
  >;
  readonly databaseReady?: () => Promise<boolean>;
  readonly rabbitReady?: () => boolean;
}) {
  const connections = new Set<ConnectionContext>();
  const fanoutTails = new Map<string, Promise<number>>();
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: (request) => safeCorrelationId(request.headers['x-correlation-id']),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const connectionAuthorized = async (connection: ConnectionContext): Promise<boolean> => {
    if (!options.messagingRepository) return false;
    const result = await options.messagingRepository.authorizeRealtimeConnection({
      tenantId: connection.tenantId,
      userId: connection.userId,
      sessionId: connection.sessionId,
    });
    return result.outcome === 'ok';
  };

  const publish = async (event: RealtimeMessageCreatedEvent): Promise<number> => {
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
    for (const connection of [...connections]) {
      if (
        connection.tenantId !== event.tenantId ||
        !connection.subscriptions.has(event.conversationId) ||
        !recipients.has(connection.userId)
      ) {
        continue;
      }
      if (!(await connectionAuthorized(connection))) {
        connections.delete(connection);
        connection.socket.close(4401, 'Session revoked');
        continue;
      }
      if (
        send(connection.socket, {
          type: 'message.created',
          conversationId: event.conversationId,
          messageId: event.messageId,
          sequence: event.sequence,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt,
        })
      ) {
        delivered += 1;
      }
    }
    return delivered;
  };

  app.decorate('publishMessageCreated', (event: RealtimeMessageCreatedEvent): Promise<number> => {
    const key = `${event.tenantId}:${event.conversationId}`;
    const previous = fanoutTails.get(key) ?? Promise.resolve(0);
    const current = previous.catch(() => 0).then(() => publish(event));
    fanoutTails.set(key, current);
    void current.then(
      () => {
        if (fanoutTails.get(key) === current) fanoutTails.delete(key);
      },
      () => {
        if (fanoutTails.get(key) === current) fanoutTails.delete(key);
      },
    );
    return current;
  });

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

  const authorityTimer = setInterval(() => {
    for (const connection of [...connections]) {
      void connectionAuthorized(connection)
        .then((authorized) => {
          if (!authorized) {
            connections.delete(connection);
            connection.socket.close(4401, 'Session revoked');
          }
        })
        .catch(() => {
          connections.delete(connection);
          connection.socket.close(1013, 'Authorization unavailable');
        });
    }
  }, AUTHORITY_RECHECK_INTERVAL_MS);
  authorityTimer.unref();
  app.addHook('onClose', () => clearInterval(authorityTimer));

  app.get<{ Params: { tenantKey: string } }>(
    '/realtime/v1/:tenantKey',
    { websocket: true },
    (socket: WebSocket, request) => {
      let closed = false;
      let connection: ConnectionContext | undefined;
      const authenticationTimeout = setTimeout(() => socket.close(4401, 'Unauthorized'), 5_000);
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(authenticationTimeout);
        if (connection) connections.delete(connection);
      };
      socket.once('close', cleanup);
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
            const realtimeSecret = options.config.JWT_REALTIME_SECRET;
            if (!realtimeSecret) throw new Error('Realtime signing key unavailable');
            const { payload } = await jwtVerify(
              message.ticket,
              new TextEncoder().encode(realtimeSecret),
              {
                issuer: options.config.JWT_ISSUER,
                audience: options.config.JWT_REALTIME_AUDIENCE,
                algorithms: ['HS256'],
              },
            );
            if (
              payload.scope !== REALTIME_TICKET_SCOPE ||
              payload.tenantKey !== request.params.tenantKey ||
              typeof payload.sub !== 'string' ||
              !UUID_PATTERN.test(payload.sub) ||
              typeof payload.tenantId !== 'string' ||
              !UUID_PATTERN.test(payload.tenantId) ||
              typeof payload.sid !== 'string' ||
              !UUID_PATTERN.test(payload.sid) ||
              typeof payload.jti !== 'string' ||
              !UUID_PATTERN.test(payload.jti) ||
              !options.ticketConsumer ||
              !(await options.ticketConsumer.consume(payload.jti, payload.sid))
            ) {
              throw new Error('Ticket scope mismatch');
            }

            const authenticatedConnection: ConnectionContext = {
              socket,
              tenantId: payload.tenantId,
              tenantKey: request.params.tenantKey,
              userId: payload.sub,
              sessionId: payload.sid,
              subscriptions: new Set(),
              commandTail: Promise.resolve(),
              rateWindowStartedAt: Date.now(),
              commandCount: 0,
              subscriptionCount: 0,
            };
            connection = authenticatedConnection;
            if (!(await connectionAuthorized(authenticatedConnection))) {
              throw new Error('Session revoked');
            }
            if (closed || socket.readyState !== WebSocket.OPEN) return;
            connections.add(authenticatedConnection);
            clearTimeout(authenticationTimeout);
            send(socket, {
              type: 'connection.ready',
              correlationId: request.id,
              occurredAt: new Date().toISOString(),
            });

            socket.on('message', (rawCommand) => {
              authenticatedConnection.commandTail = authenticatedConnection.commandTail
                .catch(() => undefined)
                .then(async () => {
                  try {
                    const command = JSON.parse(rawDataToText(rawCommand)) as unknown;
                    if (typeof command !== 'object' || command === null || !('type' in command)) {
                      throw new Error('Command invalid');
                    }
                    const subscription = command.type === 'conversation.subscribe';
                    if (!consumeRateBudget(authenticatedConnection, subscription)) {
                      protocolError(socket, 'REALTIME_RATE_LIMITED', request.id);
                      socket.close(4429, 'Rate limit');
                      return;
                    }
                    if (!(await connectionAuthorized(authenticatedConnection))) {
                      socket.close(4401, 'Session revoked');
                      return;
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
                      !authenticatedConnection.subscriptions.has(command.conversationId) &&
                      authenticatedConnection.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
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
                      tenantId: authenticatedConnection.tenantId,
                      userId: authenticatedConnection.userId,
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

                    authenticatedConnection.subscriptions.add(command.conversationId);
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
                });
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
