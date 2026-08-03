import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { loadConfig } from '@phub/config';
import {
  LegacyCommunityReadRepository,
  type CommunityDirectoryRepository,
} from '@phub/communities';
import {
  checkDatabaseReady,
  createCommunityLegacyBridgeRepository,
  createDatabasePool,
  createGameRepository,
  createGameResultProjectionRepository,
  createGiftCertificateIssuanceRepository,
  createLocalCommunityDirectoryRepository,
} from '@phub/database';
import { LegacyGamesMongoAdapter, LegacyGamesPublicAdapter } from '@phub/legacy-games-adapter';
import { createNotificationEndpointCipher } from '@phub/notifications';
import { createLogger, startTelemetry } from '@phub/observability';
import { VivaHomeSourceAdapter, VivaIdentityProvider } from '@phub/viva-adapter';
import { connect } from 'amqplib';
import Redis from 'ioredis';

import { registerHomeProjectorConsumer } from './home-projector-consumer.js';
import { registerCoreBrokerTopology } from './broker-topology.js';
import { runGameLifecycleProcessManagerCycle } from './game-lifecycle-process-manager.js';
import { registerGamesCardProjectorConsumer } from './games-card-projector-consumer.js';
import { registerGameResultProjectorConsumer } from './game-result-projector-consumer.js';
import { registerCupRatingConsumer } from './cup-rating-consumer.js';
import { CupRatingClient } from './cup-rating-client.js';
import { S3GiftCertificateArtifactStore } from './gift-certificate-artifact-store.js';
import { runGiftCertificateSandboxDeliveryBatch } from './gift-certificate-delivery.js';
import { registerGiftCertificateIssuerConsumer } from './gift-certificate-issuer-consumer.js';
import { registerLocationHomeProjectorConsumer } from './location-home-projector-consumer.js';
import { registerNotificationProjectorConsumer } from './notification-projector-consumer.js';
import {
  collectWorkerOperationalSnapshot,
  createWorkerMetricRecorder,
  WORKER_OPERATIONAL_METRICS_INTERVAL_MS,
} from './operational-metrics.js';
import { publishOutboxBatch } from './outbox-publisher.js';
import { runHomeBaseSyncCycle } from './home-base-sync.js';
import { runPlatformHomeSyncCycle } from './platform-home-sync.js';
import { runCommunityHomeSyncCycle } from './community-home-sync.js';
import { LegacyPromotionSource, type LegacyPromotionPlacement } from './legacy-promotion-source.js';
import { publishLeasedOutboxBatch } from './leased-outbox-publisher.js';
import { S3ProfilePhotoObjectStore } from './profile-photo-sync.js';
import { runPromotionHomeSyncCycle } from './promotion-home-sync.js';
import { runLegacyGamesRosterSyncCycle } from './legacy-games-roster-sync.js';
import { runVivaHomeSyncCycle } from './viva-home-sync.js';
import { WebPushDeliveryAdapter } from './web-push-adapter.js';
import { runWebPushDeliveryBatch } from './web-push-delivery.js';
import { runFairTenantCycle } from './tenant-cycle-orchestrator.js';
import {
  calculateWorkerForwardProgressMaxStaleMs,
  createRabbitFailureHandler,
  WorkerForwardProgressTracker,
} from './worker-runtime-health.js';

const config = loadConfig(process.env, { profilePhotoStorage: true });
const logger = createLogger('worker', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'worker',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL);
const gameRepository = createGameRepository(pool);
const gamesProcessManagerWorkerId = `games-process-manager-${randomUUID()}`;
const giftCertificateRuntime = config.GIFT_CERTIFICATE_ISSUANCE_ENABLED
  ? {
      repository: createGiftCertificateIssuanceRepository(pool),
      store: new S3GiftCertificateArtifactStore({
        endpoint: config.S3_ENDPOINT as string,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET as string,
        accessKey: config.S3_ACCESS_KEY as string,
        secretKey: config.S3_SECRET_KEY as string,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
        timeoutMs: config.GIFT_CERTIFICATE_ARTIFACT_STORAGE_TIMEOUT_MS,
      }),
      activationSecret: config.GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET as string,
    }
  : undefined;
const communityHome = (() => {
  if (config.COMMUNITIES_READ_MODE === 'mock') return undefined;
  let repository: CommunityDirectoryRepository;
  if (config.COMMUNITIES_READ_MODE === 'local') {
    repository = createLocalCommunityDirectoryRepository(pool);
  } else {
    repository = new LegacyCommunityReadRepository({
      baseUrl: config.COMMUNITIES_LEGACY_BASE_URL,
      timeoutMs: config.COMMUNITIES_LEGACY_TIMEOUT_MS,
      maxAttempts: config.COMMUNITIES_LEGACY_MAX_ATTEMPTS,
      circuitFailureThreshold: config.COMMUNITIES_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.COMMUNITIES_LEGACY_CIRCUIT_RESET_MS,
      cacheTtlMs: config.COMMUNITIES_LEGACY_CACHE_TTL_MS,
      bridge: createCommunityLegacyBridgeRepository(pool),
      onMetric: (metric) => logger.info({ metric }, 'legacy community Home read'),
    });
  }
  return {
    repository,
    sourceMode:
      config.COMMUNITIES_READ_MODE === 'legacy' ? ('LEGACY' as const) : ('LOCAL' as const),
  };
})();
const promotionSources = (() => {
  if (config.PROMOTIONS_READ_MODE !== 'legacy') return undefined;
  const createSource = (placement: LegacyPromotionPlacement): LegacyPromotionSource =>
    new LegacyPromotionSource({
      baseUrl: config.PROMOTIONS_LEGACY_BASE_URL,
      placement,
      privateHttpHosts: config.PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS.split(',')
        .map((host) => host.trim())
        .filter(Boolean),
      timeoutMs: config.PROMOTIONS_LEGACY_TIMEOUT_MS,
      maxAttempts: config.PROMOTIONS_LEGACY_MAX_ATTEMPTS,
      circuitFailureThreshold: config.PROMOTIONS_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.PROMOTIONS_LEGACY_CIRCUIT_RESET_MS,
      onMetric: (metric) => logger.info({ metric, placement }, 'legacy CUP promotion read'),
    });
  const standard = createSource(config.PROMOTIONS_STANDARD_PLACEMENT);
  const hero =
    config.PROMOTIONS_HERO_PLACEMENT === config.PROMOTIONS_STANDARD_PLACEMENT
      ? standard
      : createSource(config.PROMOTIONS_HERO_PLACEMENT);
  const recommendationStrip = createSource(config.PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT);
  const recommendationCard = createSource(config.PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT);
  return { hero, standard, recommendationStrip, recommendationCard };
})();
const createLegacyGamesRosterSource = () =>
  config.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'public'
    ? new LegacyGamesPublicAdapter({
        baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
        timeoutMs: 8_000,
        freshTtlMs: 60_000,
        staleTtlMs: 600_000,
        circuitFailureThreshold: 3,
        circuitResetMs: 30_000,
        onMetric: (metric) => logger.info({ metric }, 'legacy Games public read'),
      })
    : new LegacyGamesMongoAdapter({
        uri: config.LEGACY_GAMES_MONGODB_URI as string,
        timeoutMs: 5_000,
        maxAttempts: 2,
        onMetric: (metric) => logger.info({ metric }, 'legacy Games roster read'),
      });
const legacyGamesRosterWindowSource = config.LEGACY_GAMES_ROSTER_SYNC_ENABLED
  ? createLegacyGamesRosterSource()
  : undefined;
const vivaHomeLegacyGameBridgeSource = config.HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED
  ? (legacyGamesRosterWindowSource ?? createLegacyGamesRosterSource())
  : undefined;
const webPushRuntime =
  config.WEB_PUSH_ENABLED && config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS
    ? {
        cipher: createNotificationEndpointCipher({
          serializedKeys: config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS,
          activeKeyId: config.NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID,
        }),
        adapter: new WebPushDeliveryAdapter({
          subject: config.WEB_PUSH_VAPID_SUBJECT as string,
          publicKey: config.WEB_PUSH_VAPID_PUBLIC_KEY as string,
          privateKey: config.WEB_PUSH_VAPID_PRIVATE_KEY as string,
          ttlSeconds: config.WEB_PUSH_TTL_SECONDS,
          timeoutMs: config.WEB_PUSH_TIMEOUT_MS,
          circuitFailureThreshold: config.WEB_PUSH_CIRCUIT_FAILURE_THRESHOLD,
          circuitResetMs: config.WEB_PUSH_CIRCUIT_RESET_MS,
        }),
      }
    : undefined;
const redis = config.HOME_VIVA_SYNC_ENABLED
  ? new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
  : undefined;
const connection = await connect(config.RABBITMQ_URL);
const channel = await connection.createConfirmChannel();
const consumerChannel = await connection.createChannel();
const operationalChannel = telemetry ? await connection.createChannel() : undefined;
await registerCoreBrokerTopology(channel);
await registerHomeProjectorConsumer({
  channel: consumerChannel,
  pool,
  logger,
  ttlSeconds: config.HOME_PROJECTION_TTL_SECONDS,
});
await registerLocationHomeProjectorConsumer({
  channel: consumerChannel,
  pool,
  logger,
});
await registerGamesCardProjectorConsumer({
  channel: consumerChannel,
  repository: gameRepository,
  logger,
});
const gameResultProjectionRepository = createGameResultProjectionRepository(pool);
await registerGameResultProjectorConsumer({
  channel: consumerChannel,
  repository: gameResultProjectionRepository,
  logger,
});
if (config.CUP_RATING_CONSUMER_ENABLED) {
  await registerCupRatingConsumer({
    channel: consumerChannel,
    repository: gameResultProjectionRepository,
    client: new CupRatingClient({
      baseUrl: config.CUP_RATING_API_URL as string,
      serviceToken: config.CUP_RATING_SERVICE_TOKEN as string,
      timeoutMs: config.CUP_RATING_TIMEOUT_MS,
    }),
    logger,
  });
}
await registerNotificationProjectorConsumer({
  channel: consumerChannel,
  pool,
  logger,
  ...(config.WEB_PUSH_ENABLED
    ? {
        webPush: {
          appId: config.WEB_PUSH_APP_ID,
          environment: config.WEB_PUSH_ENVIRONMENT,
        },
      }
    : {}),
});
if (giftCertificateRuntime) {
  await registerGiftCertificateIssuerConsumer({
    channel: consumerChannel,
    repository: giftCertificateRuntime.repository,
    store: giftCertificateRuntime.store,
    activationSecret: giftCertificateRuntime.activationSecret,
    logger,
  });
}

let shuttingDown = false;
let rabbitReady = true;
const workerMetrics = createWorkerMetricRecorder();
const workerForwardProgress = new WorkerForwardProgressTracker(
  calculateWorkerForwardProgressMaxStaleMs({
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    confirmTimeoutMs: config.OUTBOX_CONFIRM_TIMEOUT_MS,
  }),
);
const handleRabbitFailure = createRabbitFailureHandler({
  logger,
  isShuttingDown: () => shuttingDown,
  markUnavailable: () => {
    rabbitReady = false;
  },
  terminate: (reason) => shutdown(`RABBITMQ_${reason.toUpperCase()}`, 1),
});

connection.on('close', () => {
  handleRabbitFailure('close');
});
connection.on('error', (error) => {
  handleRabbitFailure('error', error);
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
    const forwardProgress = workerForwardProgress.snapshot();
    const checks = {
      database: databaseReady,
      rabbitmq: rabbitReady,
      vivaSync: vivaSyncReady,
      forwardProgress: forwardProgress.ready,
    };
    response.statusCode = Object.values(checks).every(Boolean) ? 200 : 503;
    response.end(
      JSON.stringify({
        status: response.statusCode === 200 ? 'ready' : 'not_ready',
        checks,
        coreCycle: forwardProgress,
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ status: 'not_found' }));
};
const healthServer = createServer((request, response) => {
  void handleHealthRequest(request, response);
});
healthServer.listen(config.WORKER_HEALTH_PORT, '0.0.0.0');
logger.info({ mode: config.OUTBOX_PUBLISH_MODE }, 'outbox publisher configured');
let tenantCycleStartOffset = 0;

const publishConfiguredOutboxBatch = (tenantId: string): Promise<number> => {
  if (config.OUTBOX_PUBLISH_MODE === 'leased') {
    return publishLeasedOutboxBatch({
      pool,
      channel,
      logger,
      tenantId,
      batchSize: config.OUTBOX_BATCH_SIZE,
      claimTtlMs: config.OUTBOX_CLAIM_TTL_MS,
      confirmTimeoutMs: config.OUTBOX_CONFIRM_TIMEOUT_MS,
      failureBackoffMs: config.OUTBOX_FAILURE_BACKOFF_MS,
    });
  }
  return publishOutboxBatch({
    pool,
    channel,
    logger,
    tenantId,
    batchSize: config.OUTBOX_BATCH_SIZE,
    confirmTimeoutMs: config.OUTBOX_CONFIRM_TIMEOUT_MS,
  });
};

const runCycle = async (): Promise<void> => {
  if (shuttingDown) return;
  const startedAt = Date.now();
  workerForwardProgress.markCycleStarted(startedAt);
  let publishedCount = 0;
  let failed = false;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true order by id',
    );
    workerForwardProgress.markProgress();
    const tenantCycle = await runFairTenantCycle({
      tenants: tenants.rows,
      startOffset: tenantCycleStartOffset,
      shouldStop: () => shuttingDown,
      runTenant: async (tenant) => {
        if (config.GAMES_READ_ENABLED) {
          await runGameLifecycleProcessManagerCycle({
            repository: gameRepository,
            tenantId: tenant.id,
            workerId: gamesProcessManagerWorkerId,
            logger,
            batchSize: config.OUTBOX_BATCH_SIZE,
          });
        }
        publishedCount += await publishConfiguredOutboxBatch(tenant.id);
      },
      onTenantFailure: (tenant, error) => {
        logger.error({ err: error, tenantId: tenant.id }, 'worker tenant cycle failed');
      },
      onProgress: () => workerForwardProgress.markProgress(),
    });
    tenantCycleStartOffset = tenantCycle.nextStartOffset;
    failed = tenantCycle.failedCount > 0 || tenantCycle.interrupted;
    if (failed) workerForwardProgress.markCycleFailed();
    else workerForwardProgress.markCycleSucceeded();
    if (publishedCount > 0) logger.info({ count: publishedCount }, 'outbox events published');
  } catch (error) {
    failed = true;
    workerForwardProgress.markCycleFailed();
    logger.error({ error }, 'worker core cycle failed');
    // The event remains unpublished and will be retried by the next bounded cycle.
  } finally {
    workerMetrics.recordOutboxPublishCycle(publishedCount, Date.now() - startedAt, failed);
    if (!shuttingDown) setTimeout(() => void runCycle(), config.OUTBOX_POLL_INTERVAL_MS);
  }
};

const runOperationalMetricsCycle = async (): Promise<void> => {
  if (shuttingDown || !operationalChannel) return;
  const startedAt = Date.now();
  try {
    const snapshot = await collectWorkerOperationalSnapshot({ pool, channel: operationalChannel });
    workerMetrics.recordOperationalSnapshot(snapshot, Date.now() - startedAt);
  } catch (error) {
    workerMetrics.recordOperationalCollectionFailure(Date.now() - startedAt);
    logger.error({ error }, 'worker operational metrics collection failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runOperationalMetricsCycle(), WORKER_OPERATIONAL_METRICS_INTERVAL_MS);
    }
  }
};

const runWebPushCycle = async (): Promise<void> => {
  if (shuttingDown || !webPushRuntime) return;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    for (const tenant of tenants.rows) {
      await runWebPushDeliveryBatch({
        pool,
        logger,
        tenantId: tenant.id,
        appId: config.WEB_PUSH_APP_ID,
        environment: config.WEB_PUSH_ENVIRONMENT,
        cipher: webPushRuntime.cipher,
        adapter: webPushRuntime.adapter,
        maxAttempts: config.WEB_PUSH_MAX_ATTEMPTS,
        retryBaseMs: config.WEB_PUSH_RETRY_BASE_MS,
      });
    }
  } catch (error) {
    logger.error({ error }, 'Web Push delivery cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runWebPushCycle(), config.WEB_PUSH_POLL_INTERVAL_MS);
    }
  }
};

const runGiftCertificateDeliveryCycle = async (): Promise<void> => {
  if (
    shuttingDown ||
    !giftCertificateRuntime ||
    config.GIFT_CERTIFICATE_DELIVERY_MODE !== 'sandbox'
  ) {
    return;
  }
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    for (const tenant of tenants.rows) {
      await runGiftCertificateSandboxDeliveryBatch({
        repository: giftCertificateRuntime.repository,
        logger,
        tenantId: tenant.id,
        batchSize: config.GIFT_CERTIFICATE_DELIVERY_BATCH_SIZE,
        maxAttempts: config.GIFT_CERTIFICATE_DELIVERY_MAX_ATTEMPTS,
        retryBaseMs: config.GIFT_CERTIFICATE_DELIVERY_RETRY_BASE_MS,
      });
    }
  } catch (error) {
    logger.error({ error }, 'gift certificate delivery cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(
        () => void runGiftCertificateDeliveryCycle(),
        config.GIFT_CERTIFICATE_DELIVERY_POLL_INTERVAL_MS,
      );
    }
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
const profilePhotoStore =
  config.HOME_VIVA_SYNC_ENABLED ||
  config.PROMOTIONS_READ_MODE === 'legacy' ||
  config.LEGACY_GAMES_ROSTER_SYNC_ENABLED
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
      ...(vivaHomeLegacyGameBridgeSource
        ? {
            legacyGameRosterBridge: {
              tenantKey: config.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY as string,
              source: vivaHomeLegacyGameBridgeSource,
            },
          }
        : {}),
    });
    if (result.attempted > 0) logger.info({ result }, 'Viva Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'Viva Home sync cycle failed');
  } finally {
    if (!shuttingDown) setTimeout(() => void runVivaSyncCycle(), config.HOME_VIVA_SYNC_INTERVAL_MS);
  }
};

const runCommunitySyncCycle = async (): Promise<void> => {
  if (shuttingDown || !config.HOME_VIVA_SYNC_ENABLED || !profilePhotoStore || !communityHome) {
    return;
  }
  try {
    const result = await runCommunityHomeSyncCycle({
      pool,
      config,
      logger,
      repository: communityHome.repository,
      sourceMode: communityHome.sourceMode,
      store: profilePhotoStore,
    });
    if (result.attempted > 0) logger.info({ result }, 'community Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'community Home sync cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runCommunitySyncCycle(), config.HOME_VIVA_SYNC_INTERVAL_MS);
    }
  }
};

const runPlatformSyncCycle = async (): Promise<void> => {
  if (shuttingDown || !config.HOME_VIVA_SYNC_ENABLED) return;
  try {
    const result = await runPlatformHomeSyncCycle({ pool, config, logger });
    if (result.attempted > 0) logger.info({ result }, 'platform Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'platform Home sync cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runPlatformSyncCycle(), config.HOME_VIVA_SYNC_INTERVAL_MS);
    }
  }
};

const runHomeBaseCycle = async (): Promise<void> => {
  if (shuttingDown || !config.HOME_BASE_SYNC_ENABLED) return;
  try {
    const result = await runHomeBaseSyncCycle({ pool, config, logger });
    if (result.attempted > 0) logger.info({ result }, 'HomeBase sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'HomeBase sync cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runHomeBaseCycle(), config.HOME_BASE_SYNC_INTERVAL_MS);
    }
  }
};

const runPromotionSyncCycle = async (): Promise<void> => {
  if (shuttingDown || !promotionSources || !profilePhotoStore) return;
  try {
    const result = await runPromotionHomeSyncCycle({
      pool,
      config,
      logger,
      source: promotionSources,
      store: profilePhotoStore,
    });
    if (result.attempted > 0) logger.info({ result }, 'promotion Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'promotion Home sync cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runPromotionSyncCycle(), config.PROMOTIONS_SYNC_INTERVAL_MS);
    }
  }
};

const runLegacyGamesRosterSync = async (): Promise<void> => {
  if (shuttingDown || !legacyGamesRosterWindowSource || !profilePhotoStore) return;
  try {
    await runLegacyGamesRosterSyncCycle({
      pool,
      config,
      logger,
      source: legacyGamesRosterWindowSource,
      profilePhotoStore,
    });
  } catch (error) {
    logger.error({ error }, 'legacy Games roster synchronization deferred');
  } finally {
    if (!shuttingDown) {
      setTimeout(
        () => void runLegacyGamesRosterSync(),
        config.LEGACY_GAMES_ROSTER_SYNC_INTERVAL_MS,
      );
    }
  }
};

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  rabbitReady = false;
  logger.info({ signal, exitCode }, 'shutting down');
  healthServer.close();
  const forcedExit = setTimeout(() => process.exit(exitCode), 5_000);
  forcedExit.unref();
  const results = await Promise.allSettled([
    operationalChannel?.close(),
    consumerChannel.close(),
    channel.close(),
    connection.close(),
    redis?.quit().catch(() => redis.disconnect()),
    pool.end(),
    telemetry?.shutdown(),
  ]);
  const failedClosures = results.filter((result) => result.status === 'rejected').length;
  if (failedClosures > 0) {
    logger.error({ failedClosures, signal }, 'worker shutdown completed with cleanup failures');
  }
  clearTimeout(forcedExit);
  process.exit(exitCode);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
void runCycle();
if (telemetry) void runOperationalMetricsCycle();
void runVivaSyncCycle();
void runCommunitySyncCycle();
void runPlatformSyncCycle();
void runHomeBaseCycle();
void runPromotionSyncCycle();
void runLegacyGamesRosterSync();
void runWebPushCycle();
void runGiftCertificateDeliveryCycle();
