import { realtimeTicketRedisKey } from '@phub/auth';
import { loadConfig } from '@phub/config';
import { checkDatabaseReady, createDatabasePool, createMessagingRepository } from '@phub/database';
import { createLogger, startTelemetry } from '@phub/observability';
import { connect } from 'amqplib';
import Redis from 'ioredis';

import { buildRealtimeApp } from './app.js';
import { registerMessagingRealtimeConsumer } from './message-consumer.js';

const config = loadConfig();
const logger = createLogger('realtime', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'realtime',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
await redis.connect();
const pool = createDatabasePool(config.DATABASE_URL);
const messagingRepository = createMessagingRepository(pool);
const rabbit = await connect(config.RABBITMQ_URL);
const channel = await rabbit.createChannel();
let rabbitReady = true;
let shuttingDown = false;
rabbit.on('close', () => {
  rabbitReady = false;
  if (!shuttingDown) logger.error('RabbitMQ connection closed');
});
rabbit.on('error', (error) => {
  rabbitReady = false;
  logger.error({ error }, 'RabbitMQ connection error');
});
channel.on('close', () => {
  rabbitReady = false;
  if (!shuttingDown) logger.error('RabbitMQ realtime channel closed');
});
channel.on('error', (error) => {
  rabbitReady = false;
  logger.error({ error }, 'RabbitMQ realtime channel error');
});
const app = await buildRealtimeApp({
  config,
  logger,
  redis,
  messagingRepository,
  databaseReady: () => checkDatabaseReady(pool),
  rabbitReady: () => rabbitReady,
  ticketConsumer: {
    consume: async (ticketId) =>
      (await redis.getdel(realtimeTicketRedisKey(ticketId))) === 'issued',
  },
});
await registerMessagingRealtimeConsumer({
  channel,
  logger,
  publish: (event) => app.publishMessageCreated(event),
});

const shutdown = async (signal: string): Promise<void> => {
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  await app.close();
  await channel.close().catch(() => undefined);
  await rabbit.close().catch(() => undefined);
  await redis.quit();
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.REALTIME_HOST, port: config.REALTIME_PORT });
