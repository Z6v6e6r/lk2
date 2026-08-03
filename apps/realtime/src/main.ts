import { realtimeTicketRedisKey } from '@phub/auth';
import { loadConfig } from '@phub/config';
import { checkDatabaseReady, createDatabasePool, createMessagingRepository } from '@phub/database';
import { createLogger, startTelemetry } from '@phub/observability';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import Redis from 'ioredis';

import { buildRealtimeApp } from './app.js';
import { registerMessagingRealtimeConsumer } from './message-consumer.js';
import { rabbitReconnectDelayMs } from './rabbit-reconnect-policy.js';

const config = loadConfig();
const logger = createLogger('realtime', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'realtime',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
await redis.connect();
const pool = createDatabasePool(config.DATABASE_URL);
const messagingRepository = createMessagingRepository(pool);

let rabbitReady = false;
let shuttingDown = false;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let connecting: Promise<void> | undefined;
let activeRabbit:
  | {
      readonly connection: ChannelModel;
      readonly channel: ConfirmChannel;
      readonly generation: number;
    }
  | undefined;
let rabbitGeneration = 0;

const app = await buildRealtimeApp({
  config,
  logger,
  redis,
  messagingRepository,
  databaseReady: () => checkDatabaseReady(pool),
  rabbitReady: () => rabbitReady,
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
  logger.warn({ delayMs, reconnectAttempt }, 'RabbitMQ realtime reconnect scheduled');
}

function invalidateRabbit(runtime: NonNullable<typeof activeRabbit>, cause: string): void {
  if (activeRabbit !== runtime) return;
  rabbitReady = false;
  activeRabbit = undefined;
  logger.error({ cause, generation: runtime.generation }, 'RabbitMQ realtime consumer unavailable');
  void runtime.channel.close().catch(() => undefined);
  void runtime.connection.close().catch(() => undefined);
  scheduleReconnect();
}

async function connectRabbit(failFast: boolean): Promise<void> {
  if (shuttingDown || activeRabbit || connecting) return connecting;
  const task = (async () => {
    let connection: ChannelModel | undefined;
    let channel: ConfirmChannel | undefined;
    try {
      connection = await connect(config.RABBITMQ_URL);
      channel = await connection.createConfirmChannel();
      const runtime = { connection, channel, generation: ++rabbitGeneration };
      activeRabbit = runtime;
      connection.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ realtime connection error');
        invalidateRabbit(runtime, 'connection_error');
      });
      connection.on('close', () => invalidateRabbit(runtime, 'connection_closed'));
      channel.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ realtime channel error');
        invalidateRabbit(runtime, 'channel_error');
      });
      channel.on('close', () => invalidateRabbit(runtime, 'channel_closed'));
      await registerMessagingRealtimeConsumer({
        channel,
        logger,
        publish: (event) => app.publishMessageCreated(event),
        onConsumerFailure: (reason) => invalidateRabbit(runtime, reason),
      });
      rabbitReady = true;
      reconnectAttempt = 0;
      logger.info({ generation: runtime.generation }, 'RabbitMQ realtime consumer ready');
    } catch (err) {
      rabbitReady = false;
      activeRabbit = undefined;
      await channel?.close().catch(() => undefined);
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
  if (reconnectTimer) clearTimeout(reconnectTimer);
  logger.info({ signal }, 'shutting down');
  await app.close();
  const runtime = activeRabbit;
  activeRabbit = undefined;
  await runtime?.channel.close().catch(() => undefined);
  await runtime?.connection.close().catch(() => undefined);
  await redis.quit().catch(() => redis.disconnect());
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.REALTIME_HOST, port: config.REALTIME_PORT });
