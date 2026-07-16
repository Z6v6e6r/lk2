import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { loadConfig } from '@phub/config';
import { checkDatabaseReady, createDatabasePool } from '@phub/database';
import { createLogger, startTelemetry } from '@phub/observability';
import { VivaHomeSourceAdapter, VivaIdentityProvider } from '@phub/viva-adapter';
import { connect } from 'amqplib';
import Redis from 'ioredis';

import { registerHomeProjectorConsumer } from './home-projector-consumer.js';
import { registerNotificationProjectorConsumer } from './notification-projector-consumer.js';
import { publishOutboxBatch } from './outbox-publisher.js';
import { S3ProfilePhotoObjectStore } from './profile-photo-sync.js';
import { runVivaHomeSyncCycle } from './viva-home-sync.js';

const config = loadConfig();
const logger = createLogger('worker', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'worker',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL);
const redis = config.HOME_VIVA_SYNC_ENABLED
  ? new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  : undefined;
const connection = await connect(config.RABBITMQ_URL);
const channel = await connection.createConfirmChannel();
const consumerChannel = await connection.createChannel();
await channel.assertExchange('phub.events', 'topic', { durable: true });
await channel.assertExchange('phub.dead-letter', 'topic', { durable: true });
await registerHomeProjectorConsumer({
  channel: consumerChannel,
  pool,
  logger,
  ttlSeconds: config.HOME_PROJECTION_TTL_SECONDS,
});
await registerNotificationProjectorConsumer({ channel: consumerChannel, pool, logger });

let shuttingDown = false;
let rabbitReady = true;

connection.on('close', () => {
  rabbitReady = false;
  logger.error('RabbitMQ connection closed');
});
connection.on('error', (error) => {
  rabbitReady = false;
  logger.error({ error }, 'RabbitMQ connection error');
});
redis?.on('ready', () => {
  logger.info('Redis connection for Viva Home sync ready');
});
redis?.on('close', () => {
  logger.error('Redis connection for Viva Home sync closed');
});
redis?.on('error', () => {
  logger.error('Redis connection for Viva Home sync failed');
});

const handleHealthRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/health/live') {
    response.statusCode = 200;
    response.end(JSON.stringify({ status: 'ok', service: 'phub-worker' }));
    return;
  }
  if (request.url === '/health/ready') {
    const [databaseReady, vivaSyncReady] = await Promise.all([
      checkDatabaseReady(pool),
      redis
        ? redis
            .ping()
            .then((result) => result === 'PONG')
            .catch(() => false)
        : Promise.resolve(true),
    ]);
    response.statusCode = databaseReady && rabbitReady && vivaSyncReady ? 200 : 503;
    response.end(JSON.stringify({ status: response.statusCode === 200 ? 'ready' : 'not_ready' }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ status: 'not_found' }));
};
const healthServer = createServer((request, response) => {
  void handleHealthRequest(request, response);
});
healthServer.listen(config.WORKER_HEALTH_PORT, '0.0.0.0');

const runCycle = async (): Promise<void> => {
  if (shuttingDown) return;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    let count = 0;
    for (const tenant of tenants.rows) {
      count += await publishOutboxBatch({ pool, channel, logger, tenantId: tenant.id });
    }
    if (count > 0) logger.info({ count }, 'outbox events published');
  } catch {
    // The event remains unpublished and will be retried by the next bounded cycle.
  } finally {
    if (!shuttingDown) setTimeout(() => void runCycle(), config.OUTBOX_POLL_INTERVAL_MS);
  }
};

const vivaIdentityProvider = new VivaIdentityProvider({
  mode: config.VIVA_MODE,
  baseUrl: config.VIVA_AUTH_BASE_URL,
  profileApiBaseUrl: config.VIVA_AUTH_PROFILE_API_URL,
  oauthScopes: config.VIVA_OAUTH_SCOPES,
  realm: config.VIVA_AUTH_REALM,
  clientId: config.VIVA_AUTH_CLIENT_ID,
  channel: config.VIVA_AUTH_CHANNEL,
  timeoutMs: config.VIVA_TIMEOUT_MS,
  devPhoneE164: config.AUTH_DEV_PHONE_E164,
  devOtpCode: config.AUTH_DEV_OTP_CODE,
  onMetric: (metric) => logger.info({ metric }, 'Viva identity operation'),
});
const vivaAdapters = new Map<string, VivaHomeSourceAdapter>();
const profilePhotoStore = config.HOME_VIVA_SYNC_ENABLED
  ? new S3ProfilePhotoObjectStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
      readUrlTtlSeconds: config.PROFILE_PHOTO_URL_TTL_SECONDS,
    })
  : undefined;
const getVivaHomeAdapter = (providerTenantKey: string): VivaHomeSourceAdapter => {
  const existing = vivaAdapters.get(providerTenantKey);
  if (existing) return existing;
  const adapter = new VivaHomeSourceAdapter({
    mode: config.VIVA_MODE,
    apiBaseUrl: config.VIVA_END_USER_API_URL,
    tenantKey: providerTenantKey,
    timeoutMs: config.VIVA_TIMEOUT_MS,
    onMetric: (metric) => logger.info({ metric, providerTenantKey }, 'Viva Home read operation'),
  });
  vivaAdapters.set(providerTenantKey, adapter);
  return adapter;
};

const runVivaSyncCycle = async (): Promise<void> => {
  if (shuttingDown || !config.HOME_VIVA_SYNC_ENABLED || !redis || !profilePhotoStore) return;
  try {
    const result = await runVivaHomeSyncCycle({
      pool,
      redis,
      config,
      logger,
      provider: vivaIdentityProvider,
      getAdapter: getVivaHomeAdapter,
      profilePhotoStore,
    });
    if (result.attempted > 0) logger.info({ result }, 'Viva Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'Viva Home sync cycle failed');
  } finally {
    if (!shuttingDown) setTimeout(() => void runVivaSyncCycle(), config.HOME_VIVA_SYNC_INTERVAL_MS);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  healthServer.close();
  await consumerChannel.close();
  await channel.close();
  await connection.close();
  await redis?.quit().catch(() => redis.disconnect());
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
void runCycle();
void runVivaSyncCycle();
