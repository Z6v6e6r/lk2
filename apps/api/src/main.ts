import type { IdentityProviderKey, IdentityProviderPort } from '@phub/auth';
import { loadConfig } from '@phub/config';
import {
  createClientRoutingPlanRepository,
  createDatabasePool,
  createHomeDashboardProjectionRepository,
  createNotificationInboxRepository,
} from '@phub/database';
import { createLogger, startTelemetry } from '@phub/observability';
import { VivaIdentityProvider } from '@phub/viva-adapter';
import Redis from 'ioredis';

import { buildApp } from './app.js';
import { AuthService } from './auth/auth-service.js';
import { RedisAuthChallengeStore } from './auth/challenge-store.js';
import { RedisVivaOAuthStateStore } from './auth/oauth-state-store.js';
import { PostgresAuthRepository } from './auth/postgres-auth-repository.js';

const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'api',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL);
const clientRoutingPlanRepository = createClientRoutingPlanRepository(pool);
const redis = new Redis(config.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
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
  onMetric: (metric) => logger.info({ metric }, 'identity provider operation'),
});
const providers = new Map<IdentityProviderKey, IdentityProviderPort>([
  [vivaIdentityProvider.key, vivaIdentityProvider],
]);
const authService = new AuthService({
  config,
  repository: new PostgresAuthRepository(pool),
  challengeStore: new RedisAuthChallengeStore(redis),
  vivaOAuthProvider: vivaIdentityProvider,
  vivaOAuthStateStore: new RedisVivaOAuthStateStore(redis),
  providers,
});
const app = await buildApp({
  config,
  logger,
  pool,
  authService,
  homeDashboardRepository: createHomeDashboardProjectionRepository(pool),
  clientRoutingPlanRepository,
  notificationRepository: createNotificationInboxRepository(pool),
  authDependencyReady: async () => (await redis.ping()) === 'PONG',
  rateLimitRedis: redis,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await redis.quit().catch(() => redis.disconnect());
  await pool.end();
  await telemetry?.shutdown();
  process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
