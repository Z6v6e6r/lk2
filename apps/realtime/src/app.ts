import { randomUUID } from 'node:crypto';

import websocket from '@fastify/websocket';
import { REALTIME_TICKET_SCOPE } from '@phub/auth';
import type { AppConfig, RuntimeContourAttestation } from '@phub/config';
import type { MessagingRepository, RealtimeAuthorizationRepository } from '@phub/database';
import Fastify from 'fastify';
import type Redis from 'ioredis';
import { jwtVerify } from 'jose';
import type { Logger } from 'pino';
import { WebSocket, type RawData } from 'ws';

import type { RealtimeMetricRecorder } from './operational-metrics.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const COMMANDS_PER_MINUTE = 60;
const SUBSCRIPTIONS_PER_MINUTE = 20;
const AUTHENTICATION_TIMEOUT_MS = 5_000;
const AUTHORITY_RECHECK_INTERVAL_MS = 15_000;

export interface RealtimeTicketConsumer {
  consume(ticketId: string, sessionId: string): Promise<boolean>;
}

export interface CommunityRealtimeEventHint {
  readonly tenantId: string;
  readonly communityId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly targetType: 'POST' | 'COMMENT' | 'REACTION';
  readonly targetId: string;
  readonly targetRevision: number;
  readonly targetStatus: string | null;
  readonly occurredAt: string;
}

export interface CommunityRealtimeFanoutTarget {
  publishCommunityEvent(event: CommunityRealtimeEventHint): Promise<void>;
}

export interface RealtimeMessageCreatedEvent {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly sequence: number;
  readonly correlationId: string;
  readonly occurredAt: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    publishCommunityEvent(event: CommunityRealtimeEventHint): Promise<void>;
    publishMessageCreated(event: RealtimeMessageCreatedEvent): Promise<number>;
  }
}

interface ConnectionContext {
  readonly socket: WebSocket;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly communitySubscriptions: Set<string>;
  readonly conversationSubscriptions: Set<string>;
  commandTail: Promise<void>;
  rateWindowStartedAt: number;
  commandCount: number;
  subscriptionCount: number;
  heartbeatAlive: boolean;
}

function safeCorrelationId(header: string | readonly string[] | undefined): string {
  return typeof header === 'string' && CORRELATION_ID_PATTERN.test(header) ? header : randomUUID();
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function send(
  socket: WebSocket,
  payload: Record<string, unknown>,
  maximumBufferedBytes: number,
  metrics?: RealtimeMetricRecorder,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > maximumBufferedBytes) {
    metrics?.recordSocketBackpressureClosure();
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
  maximumBufferedBytes: number,
  context?: { readonly communityId?: string; readonly conversationId?: string },
): void {
  send(
    socket,
    {
      type: 'error',
      code,
      correlationId,
      ...(context?.communityId ? { communityId: context.communityId } : {}),
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
    },
    maximumBufferedBytes,
  );
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
  readonly authorizationRepository?: Pick<
    RealtimeAuthorizationRepository,
    'authorizeConnection' | 'authorizeCommunitySubscription' | 'authorizeCommunityFanoutRecipients'
  >;
  readonly messagingRepository?: Pick<
    MessagingRepository,
    'authorizeRealtimeConnection' | 'authorizeRealtimeSubscription' | 'listRealtimeRecipientUserIds'
  >;
  readonly databaseReady?: () => Promise<boolean>;
  readonly rabbitReady?: () => boolean;
  readonly metrics?: RealtimeMetricRecorder;
  readonly runtimeContourAttestation?: RuntimeContourAttestation;
}) {
  const connections = new Set<ConnectionContext>();
  const deliveredSequences = new Map<string, number>();
  const communityFanoutTails = new Map<string, Promise<void>>();
  const messageFanoutTails = new Map<string, Promise<number>>();
  let pendingConnections = 0;
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: (request) => safeCorrelationId(request.headers['x-correlation-id']),
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1_024 } });

  const connectionAuthorized = async (connection: ConnectionContext): Promise<boolean> => {
    if (options.authorizationRepository) {
      const result = await options.authorizationRepository.authorizeConnection({
        tenantId: connection.tenantId,
        userId: connection.userId,
        sessionId: connection.sessionId,
      });
      return result.outcome === 'ok';
    }
    if (!options.messagingRepository) return false;
    const result = await options.messagingRepository.authorizeRealtimeConnection({
      tenantId: connection.tenantId,
      userId: connection.userId,
      sessionId: connection.sessionId,
    });
    return result.outcome === 'ok';
  };

  const messagingConnectionAuthorization = async (connection: ConnectionContext) => {
    if (!options.messagingRepository) return false;
    return options.messagingRepository.authorizeRealtimeConnection({
      tenantId: connection.tenantId,
      userId: connection.userId,
      sessionId: connection.sessionId,
    });
  };

  const deliverCommunityEvent = async (event: CommunityRealtimeEventHint): Promise<void> => {
    if (!options.config.COMMUNITIES_REALTIME_ENABLED || !options.authorizationRepository) return;
    const key = `${event.tenantId}:${event.communityId}`;
    if (event.sequence <= (deliveredSequences.get(key) ?? 0)) return;
    const subscribers = [...connections].filter(
      (connection) =>
        connection.tenantId === event.tenantId &&
        connection.communitySubscriptions.has(event.communityId),
    );
    let deliveredRecipients = 0;
    for (let offset = 0; offset < subscribers.length; offset += 500) {
      const batch = subscribers.slice(offset, offset + 500);
      const authorizedSessionIds =
        await options.authorizationRepository.authorizeCommunityFanoutRecipients({
          tenantId: event.tenantId,
          communityId: event.communityId,
          recipients: batch.map(({ userId, sessionId }) => ({ userId, sessionId })),
        });
      for (const connection of batch) {
        if (!authorizedSessionIds.has(connection.sessionId)) {
          connection.communitySubscriptions.delete(event.communityId);
          continue;
        }
        if (
          send(
            connection.socket,
            {
              type: 'community.event',
              communityId: event.communityId,
              sequence: event.sequence,
              eventType: event.eventType,
              targetType: event.targetType,
              targetId: event.targetId,
              targetRevision: event.targetRevision,
              targetStatus: event.targetStatus,
              occurredAt: event.occurredAt,
            },
            options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
            options.metrics,
          )
        ) {
          deliveredRecipients += 1;
        }
      }
    }
    options.metrics?.recordCommunityFanout(deliveredRecipients);
    deliveredSequences.set(key, event.sequence);
  };

  const publishCommunityEvent = (event: CommunityRealtimeEventHint): Promise<void> => {
    const key = `${event.tenantId}:${event.communityId}`;
    const previous = communityFanoutTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => deliverCommunityEvent(event));
    communityFanoutTails.set(key, next);
    return next.finally(() => {
      if (communityFanoutTails.get(key) === next) communityFanoutTails.delete(key);
    });
  };

  const deliverMessageCreated = async (event: RealtimeMessageCreatedEvent): Promise<number> => {
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
        !connection.conversationSubscriptions.has(event.conversationId) ||
        !recipients.has(connection.userId)
      ) {
        continue;
      }
      const authority = await messagingConnectionAuthorization(connection);
      if (!authority || authority.outcome !== 'ok') {
        connection.conversationSubscriptions.clear();
        if (authority && authority.outcome === 'revoked') {
          connections.delete(connection);
          connection.socket.close(4401, 'Session revoked');
        }
        continue;
      }
      if (
        send(
          connection.socket,
          {
            type: 'message.created',
            conversationId: event.conversationId,
            messageId: event.messageId,
            sequence: event.sequence,
            correlationId: event.correlationId,
            occurredAt: event.occurredAt,
          },
          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
          options.metrics,
        )
      ) {
        delivered += 1;
      }
    }
    return delivered;
  };

  const publishMessageCreated = (event: RealtimeMessageCreatedEvent): Promise<number> => {
    const key = `${event.tenantId}:${event.conversationId}`;
    const previous = messageFanoutTails.get(key) ?? Promise.resolve(0);
    const next = previous.catch(() => 0).then(() => deliverMessageCreated(event));
    messageFanoutTails.set(key, next);
    return next.finally(() => {
      if (messageFanoutTails.get(key) === next) messageFanoutTails.delete(key);
    });
  };

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
    const rabbitReady = options.rabbitReady?.() === true;
    if (!redisReady || !databaseReady || !rabbitReady) {
      return reply.status(503).send({
        status: 'not_ready',
        redis: redisReady,
        database: databaseReady,
        rabbit: rabbitReady,
        communities: options.config.COMMUNITIES_REALTIME_ENABLED,
        ...(options.runtimeContourAttestation
          ? { runtimeContour: options.runtimeContourAttestation }
          : {}),
      });
    }
    return {
      status: 'ready',
      redis: true,
      database: true,
      rabbit: rabbitReady,
      communities: options.config.COMMUNITIES_REALTIME_ENABLED,
      ...(options.runtimeContourAttestation
        ? { runtimeContour: options.runtimeContourAttestation }
        : {}),
    };
  });

  const heartbeatTimer = setInterval(() => {
    for (const connection of [...connections]) {
      if (!connection.heartbeatAlive) {
        connections.delete(connection);
        connection.socket.terminate();
        continue;
      }
      connection.heartbeatAlive = false;
      connection.socket.ping();
    }
  }, options.config.REALTIME_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
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
  app.addHook('onClose', () => {
    clearInterval(heartbeatTimer);
    clearInterval(authorityTimer);
    communityFanoutTails.clear();
    messageFanoutTails.clear();
    deliveredSequences.clear();
  });

  app.get<{ Params: { tenantKey: string } }>(
    '/realtime/v1/:tenantKey',
    { websocket: true },
    (socket: WebSocket, request) => {
      if (connections.size + pendingConnections >= options.config.REALTIME_MAX_CONNECTIONS) {
        options.metrics?.recordConnectionRejected('capacity');
        socket.close(1013, 'Capacity');
        return;
      }
      pendingConnections += 1;
      let pending = true;
      let closed = false;
      let registered = false;
      let connection: ConnectionContext | undefined;
      const authenticationTimeout = setTimeout(
        () => socket.close(4401, 'Unauthorized'),
        AUTHENTICATION_TIMEOUT_MS,
      );
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(authenticationTimeout);
        if (connection) connections.delete(connection);
        if (registered) options.metrics?.recordConnectionClosed();
        if (pending) {
          pending = false;
          pendingConnections = Math.max(0, pendingConnections - 1);
        }
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
              communitySubscriptions: new Set(),
              conversationSubscriptions: new Set(),
              commandTail: Promise.resolve(),
              rateWindowStartedAt: Date.now(),
              commandCount: 0,
              subscriptionCount: 0,
              heartbeatAlive: true,
            };
            connection = authenticatedConnection;
            if (!(await connectionAuthorized(authenticatedConnection))) {
              throw new Error('Session revoked');
            }
            if (closed || socket.readyState !== WebSocket.OPEN) return;
            pending = false;
            pendingConnections = Math.max(0, pendingConnections - 1);
            connections.add(authenticatedConnection);
            registered = true;
            options.metrics?.recordAuthentication('accepted');
            options.metrics?.recordConnectionOpened();
            socket.on('pong', () => {
              authenticatedConnection.heartbeatAlive = true;
            });
            clearTimeout(authenticationTimeout);
            send(
              socket,
              {
                type: 'connection.ready',
                correlationId: request.id,
                occurredAt: new Date().toISOString(),
                communitySubscriptions: options.config.COMMUNITIES_REALTIME_ENABLED,
              },
              options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
              options.metrics,
            );

            socket.on('message', (rawCommand) => {
              authenticatedConnection.commandTail = authenticatedConnection.commandTail
                .catch(() => undefined)
                .then(async () => {
                  try {
                    const command = JSON.parse(rawDataToText(rawCommand)) as unknown;
                    if (typeof command !== 'object' || command === null || !('type' in command)) {
                      throw new Error('Command invalid');
                    }
                    const subscription =
                      command.type === 'community.subscribe' ||
                      command.type === 'conversation.subscribe';
                    if (!consumeRateBudget(authenticatedConnection, subscription)) {
                      options.metrics?.recordConnectionRejected('rate_limited');
                      protocolError(
                        socket,
                        'REALTIME_RATE_LIMITED',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                      );
                      socket.close(4429, 'Rate limit');
                      return;
                    }
                    if (!(await connectionAuthorized(authenticatedConnection))) {
                      socket.close(4401, 'Session revoked');
                      return;
                    }
                    if (command.type === 'ping') {
                      authenticatedConnection.heartbeatAlive = true;
                      send(
                        socket,
                        {
                          type: 'pong',
                          correlationId: request.id,
                          occurredAt: new Date().toISOString(),
                        },
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                      );
                      return;
                    }
                    if (command.type === 'conversation.subscribe') {
                      const conversationId =
                        'conversationId' in command && typeof command.conversationId === 'string'
                          ? command.conversationId
                          : undefined;
                      const afterSequence =
                        'afterSequence' in command && typeof command.afterSequence === 'number'
                          ? command.afterSequence
                          : undefined;
                      if (
                        !conversationId ||
                        !UUID_PATTERN.test(conversationId) ||
                        afterSequence === undefined ||
                        !Number.isSafeInteger(afterSequence) ||
                        afterSequence < 0
                      ) {
                        protocolError(
                          socket,
                          'REALTIME_COMMAND_INVALID',
                          request.id,
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        );
                        return;
                      }
                      if (!options.messagingRepository) {
                        protocolError(
                          socket,
                          'REALTIME_STORE_UNAVAILABLE',
                          request.id,
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                          { conversationId },
                        );
                        return;
                      }
                      const messagingAuthority =
                        await messagingConnectionAuthorization(authenticatedConnection);
                      if (!messagingAuthority || messagingAuthority.outcome === 'disabled') {
                        authenticatedConnection.conversationSubscriptions.clear();
                        protocolError(
                          socket,
                          'REALTIME_MESSAGING_DISABLED',
                          request.id,
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                          { conversationId },
                        );
                        return;
                      }
                      if (messagingAuthority.outcome === 'revoked') {
                        socket.close(4401, 'Session revoked');
                        return;
                      }
                      if (
                        !authenticatedConnection.conversationSubscriptions.has(conversationId) &&
                        authenticatedConnection.conversationSubscriptions.size +
                          authenticatedConnection.communitySubscriptions.size >=
                          options.config.REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION
                      ) {
                        protocolError(
                          socket,
                          'REALTIME_SUBSCRIPTION_LIMIT',
                          request.id,
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                          { conversationId },
                        );
                        return;
                      }
                      const result =
                        await options.messagingRepository.authorizeRealtimeSubscription({
                          tenantId: authenticatedConnection.tenantId,
                          userId: authenticatedConnection.userId,
                          conversationId,
                        });
                      if (result.outcome === 'disabled') {
                        protocolError(
                          socket,
                          'REALTIME_MESSAGING_DISABLED',
                          request.id,
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                          { conversationId },
                        );
                        return;
                      }
                      if (result.outcome === 'not_found') {
                        protocolError(
                          socket,
                          'CONVERSATION_NOT_FOUND',
                          request.id,
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                          { conversationId },
                        );
                        return;
                      }

                      authenticatedConnection.conversationSubscriptions.add(conversationId);
                      send(
                        socket,
                        {
                          type: 'conversation.subscribed',
                          conversationId,
                          latestSequence: result.latestSequence,
                          correlationId: request.id,
                        },
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        options.metrics,
                      );
                      if (afterSequence !== result.latestSequence) {
                        send(
                          socket,
                          {
                            type: 'conversation.gap',
                            conversationId,
                            afterSequence:
                              afterSequence > result.latestSequence ? 0 : afterSequence,
                            latestSequence: result.latestSequence,
                            reset: afterSequence > result.latestSequence,
                            recovery: 'HTTP',
                            correlationId: request.id,
                          },
                          options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                          options.metrics,
                        );
                      }
                      return;
                    }
                    const communityId =
                      'communityId' in command && typeof command.communityId === 'string'
                        ? command.communityId
                        : undefined;
                    if (!communityId || !UUID_PATTERN.test(communityId)) {
                      options.metrics?.recordCommunitySubscription('invalid');
                      protocolError(
                        socket,
                        'REALTIME_COMMAND_INVALID',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                      );
                      return;
                    }
                    if (command.type === 'community.unsubscribe') {
                      authenticatedConnection.communitySubscriptions.delete(communityId);
                      send(
                        socket,
                        { type: 'community.unsubscribed', communityId, correlationId: request.id },
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        options.metrics,
                      );
                      return;
                    }
                    if (command.type !== 'community.subscribe') {
                      options.metrics?.recordCommunitySubscription('invalid');
                      protocolError(
                        socket,
                        'REALTIME_COMMAND_INVALID',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                      );
                      return;
                    }
                    if (
                      !authenticatedConnection.communitySubscriptions.has(communityId) &&
                      authenticatedConnection.communitySubscriptions.size +
                        authenticatedConnection.conversationSubscriptions.size >=
                        options.config.REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION
                    ) {
                      options.metrics?.recordCommunitySubscription('limit');
                      protocolError(
                        socket,
                        'REALTIME_SUBSCRIPTION_LIMIT',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        { communityId },
                      );
                      return;
                    }
                    if (!options.authorizationRepository) {
                      options.metrics?.recordCommunitySubscription('disabled');
                      protocolError(
                        socket,
                        'REALTIME_STORE_UNAVAILABLE',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        { communityId },
                      );
                      return;
                    }
                    const authorization =
                      await options.authorizationRepository.authorizeCommunitySubscription({
                        tenantId: authenticatedConnection.tenantId,
                        userId: authenticatedConnection.userId,
                        communityId,
                        enabled: options.config.COMMUNITIES_REALTIME_ENABLED,
                      });
                    if (authorization.outcome === 'disabled') {
                      options.metrics?.recordCommunitySubscription('disabled');
                      protocolError(
                        socket,
                        'COMMUNITIES_REALTIME_DISABLED',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        { communityId },
                      );
                      return;
                    }
                    if (authorization.outcome === 'not_found') {
                      options.metrics?.recordCommunitySubscription('not_found');
                      protocolError(
                        socket,
                        'COMMUNITY_NOT_FOUND',
                        request.id,
                        options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                        { communityId },
                      );
                      return;
                    }
                    if (authorization.outcome !== 'ok') return;
                    options.metrics?.recordCommunitySubscription('accepted');
                    authenticatedConnection.communitySubscriptions.add(communityId);
                    send(
                      socket,
                      {
                        type: 'community.subscribed',
                        communityId,
                        communityRevision: authorization.communityRevision,
                        membershipRevision: authorization.membershipRevision,
                        latestSequence: authorization.latestSequence,
                        delivery: 'DURABLE_SEQUENCE_HTTP_RECOVERY',
                        correlationId: request.id,
                      },
                      options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                      options.metrics,
                    );
                  } catch {
                    protocolError(
                      socket,
                      'REALTIME_COMMAND_INVALID',
                      request.id,
                      options.config.REALTIME_MAX_SOCKET_BUFFER_BYTES,
                    );
                  }
                });
            });
          } catch {
            options.metrics?.recordAuthentication('rejected');
            options.metrics?.recordConnectionRejected('unauthorized');
            clearTimeout(authenticationTimeout);
            socket.close(4401, 'Unauthorized');
          }
        })();
      });
    },
  );

  return Object.assign(app, { publishCommunityEvent, publishMessageCreated });
}
