import { loadConfig } from '@phub/config';
import { createLogger, startTelemetry } from '@phub/observability';
import Redis from 'ioredis';

import { buildRealtimeApp } from './app.js';

const config = loadConfig();
const logger = createLogger('realtime', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'realtime',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
await redis.connect();
const app = await buildRealtimeApp({ config, logger, redis });

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.REALTIME_HOST, port: config.REALTIME_PORT });
