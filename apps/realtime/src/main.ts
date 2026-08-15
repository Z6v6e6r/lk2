import { realtimeTicketRedisKey } from '@phub/auth';
import { loadRealtimeConfig, runtimeContourTargetFingerprint } from '@phub/config';
import {
  checkDatabaseReady,
  createDatabasePool,
  createMessagingRepository,
  createRealtimeAuthorizationRepository,
  warmDatabasePool,
} from '@phub/database';
import { createLogger, startTelemetry } from '@phub/observability';
import { connect, type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import Redis from 'ioredis';

import { buildRealtimeApp } from './app.js';
import { registerCommunityEventConsumer } from './community-event-consumer.js';
import {
  createRealtimeEventDeduplicator,
  registerMessagingRealtimeConsumer,
} from './message-consumer.js';
import { createRealtimeMetricRecorder as createCommunityRealtimeMetricRecorder } from './operational-metrics.js';
import { rabbitReconnectDelayMs } from './rabbit-reconnect-policy.js';
import { registerRabbitConsumersAtomically } from './rabbit-registration.js';
import { createRealtimeMetricRecorder as createMessagingRealtimeMetricRecorder } from './realtime-metrics.js';

const config = loadRealtimeConfig();
const runtimeContourAttestation = config.LOCAL_RUNTIME_CONTOUR_ATTESTATION
  ? {
      database: runtimeContourTargetFingerprint(config.DATABASE_URL),
      redis: runtimeContourTargetFingerprint(config.REDIS_URL),
      rabbitmq: runtimeContourTargetFingerprint(config.RABBITMQ_URL),
    }
  : undefined;
const logger = createLogger('realtime', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'realtime',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const realtimeInstanceId =
  config.OTEL_SERVICE_INSTANCE_ID?.trim() || process.env.HOSTNAME?.trim() || 'realtime-singleton';
const realtimeMetrics = createMessagingRealtimeMetricRecorder({
  instanceId: realtimeInstanceId,
  expectedReplicas: config.REALTIME_EXPECTED_REPLICAS,
});
realtimeMetrics.recordHeartbeat();
realtimeMetrics.recordConsumerReady(false);
const heartbeatTimer = setInterval(() => realtimeMetrics.recordHeartbeat(), 15_000);
heartbeatTimer.unref();
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
await redis.connect();
const pool = createDatabasePool(config.DATABASE_URL, { max: config.REALTIME_DATABASE_POOL_MAX });
await warmDatabasePool(
  pool,
  config.REALTIME_DATABASE_POOL_WARM_CONNECTIONS,
  config.REALTIME_DATABASE_POOL_MAX,
);
const messagingRepository = createMessagingRepository(pool);
const authorizationRepository = createRealtimeAuthorizationRepository(pool);
const metrics = createCommunityRealtimeMetricRecorder({ instanceId: realtimeInstanceId });

let rabbitReady = false;
let shuttingDown = false;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let connecting: Promise<void> | undefined;
let activeRabbit:
  | {
      readonly connection: ChannelModel;
      readonly messagingChannel: ConfirmChannel;
      readonly communityChannel?: Channel;
      readonly generation: number;
    }
  | undefined;
let rabbitGeneration = 0;
const realtimeEventDeduplicator = createRealtimeEventDeduplicator();

const app = await buildRealtimeApp({
  config,
  logger,
  redis,
  messagingRepository,
  authorizationRepository,
  metrics,
  databaseReady: () => checkDatabaseReady(pool),
  rabbitReady: () => rabbitReady,
  ...(runtimeContourAttestation ? { runtimeContourAttestation } : {}),
  ticketConsumer: {
    consume: async (ticketId, sessionId) =>
      (await redis.getdel(realtimeTicketRedisKey(ticketId))) === sessionId,
  },
});

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer || connecting) return;
  const delayMs = rabbitReconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectRabbit(false);
  }, delayMs);
  reconnectTimer.unref();
  realtimeMetrics.recordRabbitReconnect();
  logger.warn({ delayMs, reconnectAttempt }, 'RabbitMQ realtime reconnect scheduled');
}

function invalidateRabbit(runtime: NonNullable<typeof activeRabbit>, cause: string): void {
  if (activeRabbit !== runtime) return;
  rabbitReady = false;
  realtimeMetrics.recordConsumerReady(false);
  realtimeMetrics.recordConsumerFailure();
  activeRabbit = undefined;
  logger.error({ cause, generation: runtime.generation }, 'RabbitMQ realtime consumer unavailable');
  void runtime.communityChannel?.close().catch(() => undefined);
  void runtime.messagingChannel.close().catch(() => undefined);
  void runtime.connection.close().catch(() => undefined);
  scheduleReconnect();
}

async function connectRabbit(failFast: boolean): Promise<void> {
  if (shuttingDown || activeRabbit || connecting) return connecting;
  const task = (async () => {
    let connection: ChannelModel | undefined;
    let messagingChannel: ConfirmChannel | undefined;
    let communityChannel: Channel | undefined;
    try {
      connection = await connect(config.RABBITMQ_URL);
      messagingChannel = await connection.createConfirmChannel();
      if (config.COMMUNITIES_REALTIME_ENABLED) {
        communityChannel = await connection.createChannel();
      }
      const registeredMessagingChannel = messagingChannel;
      const registeredCommunityChannel = communityChannel;
      const runtime = {
        connection,
        messagingChannel: registeredMessagingChannel,
        ...(registeredCommunityChannel ? { communityChannel: registeredCommunityChannel } : {}),
        generation: ++rabbitGeneration,
      };
      activeRabbit = runtime;
      connection.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ realtime connection error');
        invalidateRabbit(runtime, 'connection_error');
      });
      connection.on('close', () => invalidateRabbit(runtime, 'connection_closed'));
      messagingChannel.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ messaging realtime channel error');
        invalidateRabbit(runtime, 'messaging_channel_error');
      });
      messagingChannel.on('close', () => invalidateRabbit(runtime, 'messaging_channel_closed'));
      communityChannel?.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ Communities realtime channel error');
        invalidateRabbit(runtime, 'community_channel_error');
      });
      communityChannel?.on('close', () => invalidateRabbit(runtime, 'community_channel_closed'));
      await registerRabbitConsumersAtomically({
        registerMessaging: () =>
          registerMessagingRealtimeConsumer({
            channel: registeredMessagingChannel,
            logger,
            publish: (event) => app.publishMessageCreated(event),
            onConsumerFailure: (reason) => invalidateRabbit(runtime, reason),
            onProjected: (delivered) => realtimeMetrics.recordProjectedEvent(delivered),
            onQuarantined: () => realtimeMetrics.recordQuarantinedEvent(),
            deduplicator: realtimeEventDeduplicator,
          }),
        ...(registeredCommunityChannel
          ? {
              registerCommunity: () =>
                registerCommunityEventConsumer({
                  channel: registeredCommunityChannel,
                  target: app,
                  logger,
                  metrics,
                  onConsumerFailure: (reason) => invalidateRabbit(runtime, reason),
                }),
            }
          : {}),
        isGenerationActive: () => activeRabbit === runtime,
        markReady: () => {
          rabbitReady = true;
          realtimeMetrics.recordConsumerReady(true);
          reconnectAttempt = 0;
          logger.info({ generation: runtime.generation }, 'RabbitMQ realtime consumer ready');
        },
      });
    } catch (err) {
      rabbitReady = false;
      realtimeMetrics.recordConsumerReady(false);
      realtimeMetrics.recordConsumerFailure();
      activeRabbit = undefined;
      await communityChannel?.close().catch(() => undefined);
      await messagingChannel?.close().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      logger.error({ err }, 'RabbitMQ realtime connection failed');
      if (failFast) throw err;
    }
  })();
  connecting = task;
  try {
    await task;
  } finally {
    connecting = undefined;
    if (!failFast && !activeRabbit && !shuttingDown) scheduleReconnect();
  }
}

await connectRabbit(true);

const shutdown = async (signal: string): Promise<void> => {
  shuttingDown = true;
  rabbitReady = false;
  clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  logger.info({ signal }, 'shutting down');
  await app.close();
  const runtime = activeRabbit;
  activeRabbit = undefined;
  await runtime?.communityChannel?.close().catch(() => undefined);
  await runtime?.messagingChannel.close().catch(() => undefined);
  await runtime?.connection.close().catch(() => undefined);
  await redis.quit().catch(() => redis.disconnect());
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.REALTIME_HOST, port: config.REALTIME_PORT });
