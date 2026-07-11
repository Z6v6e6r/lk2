import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { loadConfig } from '@phub/config';
import { checkDatabaseReady, createDatabasePool } from '@phub/database';
import { createLogger, startTelemetry } from '@phub/observability';
import { connect } from 'amqplib';

import { publishOutboxBatch } from './outbox-publisher.js';

const config = loadConfig();
const logger = createLogger('worker', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'worker',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL);
const connection = await connect(config.RABBITMQ_URL);
const channel = await connection.createConfirmChannel();
await channel.assertExchange('phub.events', 'topic', { durable: true });
await channel.assertExchange('phub.dead-letter', 'topic', { durable: true });

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
    const databaseReady = await checkDatabaseReady(pool);
    response.statusCode = databaseReady && rabbitReady ? 200 : 503;
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

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  healthServer.close();
  await channel.close();
  await connection.close();
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
void runCycle();
