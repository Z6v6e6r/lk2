import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { loadConfig, runtimeContourTargetFingerprint } from '@phub/config';
import {
  LegacyCommunityReadRepository,
  type CommunityDirectoryRepository,
} from '@phub/communities';
import {
  checkDatabaseReady,
  createCommunityLegacyBridgeRepository,
  createCommunityMemberCountProjectionRepository,
  createCommunityEventRetentionRepository,
  createCommunityMediaRepository,
  createDatabasePool,
  createGameRepository,
  createGameRosterRepository,
  createGameResultProjectionRepository,
  createGiftCertificateIssuanceRepository,
  createLocalCommunityDirectoryRepository,
  createParticipationCommandRepository,
} from '@phub/database';
import { LegacyGamesMongoAdapter, LegacyGamesPublicAdapter } from '@phub/legacy-games-adapter';
import { createNotificationEndpointCipher } from '@phub/notifications';
import { createLogger, recordLevelEligibilityMetrics, startTelemetry } from '@phub/observability';
import { connect } from 'amqplib';

import { registerHomeProjectorConsumer } from './home-projector-consumer.js';
import { isCanonicalCommunityWorkerEnabled } from './community-canonical-worker-capability.js';
import { registerCommunityMemberCountProjectorConsumer } from './community-member-count-projector-consumer.js';
import { runCommunityMemberCountReconciliationCycle } from './community-member-count-reconciler.js';
import { runCommunityEventRetentionCycle } from './community-event-retention.js';
import {
  ClamAvCommunityMediaMalwareScanner,
  MockCommunityMediaMalwareScanner,
  S3CommunityMediaWorkerObjectStore,
} from './community-media-processing.js';
import { runCommunityMediaCycle } from './community-media-worker.js';
import { registerCoreBrokerTopology } from './broker-topology.js';
import { runGameLifecycleProcessManagerCycle } from './game-lifecycle-process-manager.js';
import { runGameRosterProcessManagerCycle } from './game-roster-process-manager.js';
import { registerGamesCardProjectorConsumer } from './games-card-projector-consumer.js';
import { registerGameResultProjectorConsumer } from './game-result-projector-consumer.js';
import { registerCupRatingConsumer } from './cup-rating-consumer.js';
import { CupRatingClient } from './cup-rating-client.js';
import { S3GiftCertificateArtifactStore } from './gift-certificate-artifact-store.js';
import { runGiftCertificateSandboxDeliveryBatch } from './gift-certificate-delivery.js';
import { expireCommunityDirectInviteBatch } from './community-direct-invite-expiry.js';
import { registerGiftCertificateIssuerConsumer } from './gift-certificate-issuer-consumer.js';
import { registerLocationHomeProjectorConsumer } from './location-home-projector-consumer.js';
import { registerNotificationProjectorConsumer } from './notification-projector-consumer.js';
import { runBookingReminderSchedulerBatch } from './booking-reminder-scheduler.js';
import {
  collectWorkerOperationalSnapshot,
  createWorkerMetricRecorder,
  WORKER_OPERATIONAL_METRICS_INTERVAL_MS,
} from './operational-metrics.js';
import { publishOutboxBatch } from './outbox-publisher.js';
import { runHomeBaseSyncCycle } from './home-base-sync.js';
import { runPlatformHomeSyncCycle } from './platform-home-sync.js';
import {
  runCommunityHomeSyncCycle,
  runCommunityLogoCompatibilityBackfill,
} from './community-home-sync.js';
import { CommunityLogoSourceResilience } from './community-logo-sync.js';
import { LegacyPromotionSource, type LegacyPromotionPlacement } from './legacy-promotion-source.js';
import { publishLeasedOutboxBatch } from './leased-outbox-publisher.js';
import { S3ProfilePhotoObjectStore } from './profile-photo-sync.js';
import { runPromotionHomeSyncCycle } from './promotion-home-sync.js';
import { runLegacyGamesRosterSyncCycle } from './legacy-games-roster-sync.js';
import { runProfilePhotoMaintenanceCycle } from './viva-home-sync.js';
import { WebPushDeliveryAdapter } from './web-push-adapter.js';
import { runWebPushDeliveryBatch } from './web-push-delivery.js';
import { runWebPushTenantCycle } from './web-push-tenant-cycle.js';
import { runFairTenantCycle } from './tenant-cycle-orchestrator.js';
import {
  calculateWorkerForwardProgressMaxStaleMs,
  createRabbitFailureHandler,
  WorkerForwardProgressTracker,
} from './worker-runtime-health.js';

const config = loadConfig(process.env, { profilePhotoStorage: true });
const clientMediaRollbackCapability = 'phub.client-media-rollback.v1';
const communityLogoRollbackCapability = 'phub.community-logo-rollback.v1';
const runtimeContourAttestation = config.LOCAL_RUNTIME_CONTOUR_ATTESTATION
  ? {
      database: runtimeContourTargetFingerprint(config.DATABASE_URL),
      rabbitmq: runtimeContourTargetFingerprint(config.RABBITMQ_URL),
    }
  : undefined;
const logger = createLogger('worker', config.LOG_LEVEL, process.env.RELEASE);
const communityLogoSourceResilience = new CommunityLogoSourceResilience({
  maxAttempts: 2,
  retryBaseDelayMs: 100,
  maxRetryAfterMs: 5_000,
  circuitFailureThreshold: config.COMMUNITIES_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
  circuitResetMs: config.COMMUNITIES_LEGACY_CIRCUIT_RESET_MS,
  onMetric: (metric) => logger.info({ metric }, 'legacy community logo source operation'),
});
const telemetry = startTelemetry({
  serviceName: 'worker',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const workerMetrics = createWorkerMetricRecorder({
  instanceId:
    config.OTEL_SERVICE_INSTANCE_ID?.trim() || process.env.HOSTNAME?.trim() || 'worker-singleton',
});
const pool = createDatabasePool(config.DATABASE_URL);
const gameRepository = createGameRepository(pool);
const gameRosterRepository = createGameRosterRepository(pool, {
  onEligibilityDecision: (decision) => {
    recordLevelEligibilityMetrics({
      activityType: decision.activityType,
      action: decision.action,
      mode: decision.mode,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      wouldBlock: decision.wouldBlock,
    });
    logger.info(
      {
        eligibility: {
          decisionId: decision.decisionId,
          correlationId: decision.correlationId,
          activityType: decision.activityType,
          action: decision.action,
          mode: decision.mode,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          policyVersion: decision.policyVersion,
        },
      },
      'waitlist promotion eligibility evaluated',
    );
  },
});
const participationCommandRepository = createParticipationCommandRepository(pool);
const gamesProcessManagerWorkerId = `games-process-manager-${randomUUID()}`;
const gamesRosterProcessManagerWorkerId = `games-roster-process-manager-${randomUUID()}`;
const COMMUNITY_DIRECT_INVITE_EXPIRY_INTERVAL_MS = 60_000;
const COMMUNITY_DIRECT_INVITE_EXPIRY_BATCH_SIZE = 100;
const COMMUNITY_MEMBER_COUNT_RECONCILIATION_INTERVAL_MS = 60_000;
const COMMUNITY_MEMBER_COUNT_RECONCILIATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const COMMUNITY_MEMBER_COUNT_RECONCILIATION_CANDIDATE_LIMIT = 10;
const COMMUNITY_MEMBER_COUNT_RECONCILIATION_BATCH_SIZE = 250;
const COMMUNITY_EVENT_RETENTION_INTERVAL_MS = 60_000;
const COMMUNITY_EVENT_RETENTION_CANDIDATE_BATCH_SIZE = 20;
const COMMUNITY_EVENT_RETENTION_EVENT_BATCH_SIZE = 1_000;
const COMMUNITY_EVENT_RETENTION_LEASE_MS = 60_000;
const canonicalCommunityWorkerEnabled = isCanonicalCommunityWorkerEnabled(
  config.COMMUNITIES_READ_MODE,
);
const communityMemberCountRepository = canonicalCommunityWorkerEnabled
  ? createCommunityMemberCountProjectionRepository(pool)
  : undefined;
const communityEventRetentionRepository = canonicalCommunityWorkerEnabled
  ? createCommunityEventRetentionRepository(pool)
  : undefined;
const communityMediaWorkerId = `community-media-${randomUUID()}`;
const communityMediaRuntime = config.COMMUNITY_MEDIA_ENABLED
  ? {
      repository: createCommunityMediaRepository(pool),
      store: new S3CommunityMediaWorkerObjectStore({
        endpoint: config.S3_ENDPOINT as string,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET as string,
        accessKey: config.S3_ACCESS_KEY as string,
        secretKey: config.S3_SECRET_KEY as string,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
      }),
      scanner:
        config.COMMUNITY_MEDIA_SCAN_MODE === 'clamav'
          ? new ClamAvCommunityMediaMalwareScanner({
              host: config.COMMUNITY_MEDIA_CLAMAV_HOST as string,
              port: config.COMMUNITY_MEDIA_CLAMAV_PORT,
              timeoutMs: config.COMMUNITY_MEDIA_CLAMAV_TIMEOUT_MS,
            })
          : new MockCommunityMediaMalwareScanner(),
    }
  : undefined;
const profilePhotoStore =
  config.COMMUNITY_HOME_SYNC_ENABLED ||
  config.PROFILE_PHOTO_CLIENT_SYNC_ENABLED ||
  config.PROFILE_PHOTO_MAINTENANCE_ENABLED ||
  config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED ||
  config.COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED ||
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
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : undefined;
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
    repository = createLocalCommunityDirectoryRepository(pool, {
      stableLogoDeliveryEnabled: config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED,
    });
  } else {
    repository = new LegacyCommunityReadRepository({
      baseUrl: config.COMMUNITIES_LEGACY_BASE_URL,
      timeoutMs: config.COMMUNITIES_LEGACY_TIMEOUT_MS,
      maxAttempts: config.COMMUNITIES_LEGACY_MAX_ATTEMPTS,
      circuitFailureThreshold: config.COMMUNITIES_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.COMMUNITIES_LEGACY_CIRCUIT_RESET_MS,
      cacheTtlMs: config.COMMUNITIES_LEGACY_CACHE_TTL_MS,
      bridge: createCommunityLegacyBridgeRepository(pool, {
        stableLogoDeliveryEnabled: config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED,
      }),
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
          allowedEndpointOrigins:
            config.WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS.split(',').filter(Boolean),
          onProviderOutcome: (outcome) =>
            workerMetrics.recordWebPushProviderOutcome(config.WEB_PUSH_ENVIRONMENT, outcome),
        }),
      }
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
if (communityMemberCountRepository) {
  await registerCommunityMemberCountProjectorConsumer({
    channel: consumerChannel,
    repository: communityMemberCountRepository,
    logger,
  });
}
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
const workerForwardProgress = new WorkerForwardProgressTracker(
  calculateWorkerForwardProgressMaxStaleMs({
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    confirmTimeoutMs: config.OUTBOX_CONFIRM_TIMEOUT_MS,
  }),
);
const webPushForwardProgress = webPushRuntime
  ? new WorkerForwardProgressTracker(
      calculateWorkerForwardProgressMaxStaleMs({
        pollIntervalMs: config.WEB_PUSH_POLL_INTERVAL_MS,
        confirmTimeoutMs: config.WEB_PUSH_TIMEOUT_MS,
      }),
    )
  : undefined;
const bookingReminderForwardProgress = config.BOOKING_REMINDER_SCHEDULER_ENABLED
  ? new WorkerForwardProgressTracker(
      calculateWorkerForwardProgressMaxStaleMs({
        pollIntervalMs: config.BOOKING_REMINDER_POLL_INTERVAL_MS,
        confirmTimeoutMs: config.BOOKING_REMINDER_CLAIM_TTL_MS,
      }),
    )
  : undefined;
let webPushTenantFailuresLastCycle = 0;
let webPushRoundsLastCycle = 0;
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
    const [databaseReady, communityMediaReady, profileMediaReady] = await Promise.all([
      checkDatabaseReady(pool),
      communityMediaRuntime
        ? Promise.all([
            communityMediaRuntime.store.checkReady(),
            communityMediaRuntime.scanner.checkReady?.() ?? Promise.resolve(),
          ])
            .then(() => true)
            .catch(() => false)
        : Promise.resolve(true),
      profilePhotoStore
        ? profilePhotoStore
            .checkReady()
            .then(() => true)
            .catch(() => false)
        : Promise.resolve(true),
    ]);
    const forwardProgress = workerForwardProgress.snapshot();
    const webPushProgress = webPushForwardProgress?.snapshot();
    const bookingReminderProgress = bookingReminderForwardProgress?.snapshot();
    const checks = {
      database: databaseReady,
      rabbitmq: rabbitReady,
      communityMedia: communityMediaReady,
      profileMedia: profileMediaReady,
      forwardProgress: forwardProgress.ready,
      webPushForwardProgress: webPushProgress?.ready ?? true,
      bookingReminderForwardProgress: bookingReminderProgress?.ready ?? true,
    };
    response.statusCode = Object.values(checks).every(Boolean) ? 200 : 503;
    response.end(
      JSON.stringify({
        status: response.statusCode === 200 ? 'ready' : 'not_ready',
        checks,
        coreCycle: forwardProgress,
        ...(runtimeContourAttestation ? { runtimeContour: runtimeContourAttestation } : {}),
        ...(webPushProgress
          ? {
              webPushCycle: {
                ...webPushProgress,
                degraded: webPushTenantFailuresLastCycle > 0,
                tenantFailuresLastCycle: webPushTenantFailuresLastCycle,
                roundsLastCycle: webPushRoundsLastCycle,
              },
            }
          : {}),
        ...(bookingReminderProgress
          ? {
              bookingReminderCycle: bookingReminderProgress,
            }
          : {}),
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
logger.info(
  {
    mode: config.OUTBOX_PUBLISH_MODE,
    capabilities: [clientMediaRollbackCapability, communityLogoRollbackCapability],
  },
  'outbox publisher configured',
);
let tenantCycleStartOffset = 0;
let webPushTenantCycleStartOffset = 0;
let bookingReminderTenantCycleStartOffset = 0;

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
        if (config.GAMES_COMMANDS_ENABLED) {
          await runGameRosterProcessManagerCycle({
            scheduledCommandRepository: gameRepository,
            rosterRepository: gameRosterRepository,
            tenantId: tenant.id,
            workerId: gamesRosterProcessManagerWorkerId,
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

const runCommunityDirectInviteExpiryCycle = async (): Promise<void> => {
  if (shuttingDown || !canonicalCommunityWorkerEnabled || !config.COMMUNITY_INVITES_ENABLED) return;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    for (const tenant of tenants.rows) {
      await expireCommunityDirectInviteBatch({
        pool,
        logger,
        tenantId: tenant.id,
        batchSize: COMMUNITY_DIRECT_INVITE_EXPIRY_BATCH_SIZE,
      });
    }
  } catch (error) {
    logger.error({ error }, 'community direct invite expiry cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(
        () => void runCommunityDirectInviteExpiryCycle(),
        COMMUNITY_DIRECT_INVITE_EXPIRY_INTERVAL_MS,
      );
    }
  }
};

const runParticipationCommandExpiryCycle = async (): Promise<void> => {
  if (shuttingDown || !config.PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED) return;
  let expired = 0;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true order by id',
    );
    for (const tenant of tenants.rows) {
      const result = await participationCommandRepository.expireAuthorizedBatch({
        tenantId: tenant.id,
        limit: config.PARTICIPATION_COMMAND_EXPIRY_BATCH_SIZE,
        correlationId: `participation-expiry-${randomUUID()}`,
      });
      expired += result.expired;
    }
    if (expired > 0) {
      logger.info({ expired }, 'participation command expiry cycle completed');
    }
  } catch (error) {
    logger.error({ error }, 'participation command expiry cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(
        () => void runParticipationCommandExpiryCycle(),
        config.PARTICIPATION_COMMAND_EXPIRY_INTERVAL_MS,
      );
    }
  }
};

const runCommunityMemberCountReconciliation = async (): Promise<void> => {
  if (shuttingDown || !communityMemberCountRepository) return;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    const reconcileBefore = new Date(
      Date.now() - COMMUNITY_MEMBER_COUNT_RECONCILIATION_MAX_AGE_MS,
    ).toISOString();
    for (const tenant of tenants.rows) {
      await runCommunityMemberCountReconciliationCycle({
        repository: communityMemberCountRepository,
        logger,
        tenantId: tenant.id,
        reconcileBefore,
        candidateLimit: COMMUNITY_MEMBER_COUNT_RECONCILIATION_CANDIDATE_LIMIT,
        batchSize: COMMUNITY_MEMBER_COUNT_RECONCILIATION_BATCH_SIZE,
      });
    }
  } catch (error) {
    logger.error({ error }, 'community member-count reconciliation cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(
        () => void runCommunityMemberCountReconciliation(),
        COMMUNITY_MEMBER_COUNT_RECONCILIATION_INTERVAL_MS,
      );
    }
  }
};

const runCommunityEventRetention = async (): Promise<void> => {
  if (shuttingDown || !communityEventRetentionRepository) return;
  const startedAt = Date.now();
  let purged = 0;
  let claimLost = 0;
  let failures = 0;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    for (const tenant of tenants.rows) {
      const result = await runCommunityEventRetentionCycle({
        repository: communityEventRetentionRepository,
        logger,
        tenantId: tenant.id,
        candidateBatchSize: COMMUNITY_EVENT_RETENTION_CANDIDATE_BATCH_SIZE,
        eventBatchSize: COMMUNITY_EVENT_RETENTION_EVENT_BATCH_SIZE,
        leaseMs: COMMUNITY_EVENT_RETENTION_LEASE_MS,
      });
      purged += result.purged;
      claimLost += result.claimLost;
      failures += result.failures;
    }
  } catch (error) {
    failures += 1;
    logger.error({ error }, 'community event retention cycle failed');
  } finally {
    workerMetrics.recordCommunityEventRetentionCycle(
      purged,
      claimLost,
      failures,
      Date.now() - startedAt,
    );
    if (!shuttingDown) {
      setTimeout(() => void runCommunityEventRetention(), COMMUNITY_EVENT_RETENTION_INTERVAL_MS);
    }
  }
};

const runCommunityMedia = async (): Promise<void> => {
  if (shuttingDown || !communityMediaRuntime) return;
  const startedAt = Date.now();
  const aggregate = {
    expired: 0,
    scanned: 0,
    rejected: 0,
    scanRetried: 0,
    scanFailed: 0,
    gcCompleted: 0,
    gcRetried: 0,
    gcDead: 0,
  };
  let failures = 0;
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true',
    );
    for (const tenant of tenants.rows) {
      const result = await runCommunityMediaCycle({
        repository: communityMediaRuntime.repository,
        store: communityMediaRuntime.store,
        scanner: communityMediaRuntime.scanner,
        logger,
        tenantId: tenant.id,
        workerId: communityMediaWorkerId,
        batchSize: config.COMMUNITY_MEDIA_BATCH_SIZE,
        scanMaxAttempts: config.COMMUNITY_MEDIA_SCAN_MAX_ATTEMPTS,
        gcMaxAttempts: config.COMMUNITY_MEDIA_GC_MAX_ATTEMPTS,
      });
      if (Object.values(result).some((value) => value > 0)) {
        logger.info({ tenantId: tenant.id, result }, 'community media cycle completed');
      }
      aggregate.expired += result.expired;
      aggregate.scanned += result.scanned;
      aggregate.rejected += result.rejected;
      aggregate.scanRetried += result.scanRetried;
      aggregate.scanFailed += result.scanFailed;
      aggregate.gcCompleted += result.gcCompleted;
      aggregate.gcRetried += result.gcRetried;
      aggregate.gcDead += result.gcDead;
    }
  } catch (error) {
    failures += 1;
    logger.error({ error }, 'community media cycle failed');
  } finally {
    workerMetrics.recordCommunityMediaCycle(aggregate, failures, Date.now() - startedAt);
    if (!shuttingDown) {
      setTimeout(() => void runCommunityMedia(), config.COMMUNITY_MEDIA_POLL_INTERVAL_MS);
    }
  }
};

const runBookingReminderCycle = async (): Promise<void> => {
  if (shuttingDown || !config.BOOKING_REMINDER_SCHEDULER_ENABLED) return;
  const startedAt = Date.now();
  let emitted = 0;
  let missed = 0;
  let failed = false;
  bookingReminderForwardProgress?.markCycleStarted(startedAt);
  try {
    const tenants = await pool.query<{ id: string }>(
      'select id from identity.tenants where active = true order by id',
    );
    bookingReminderForwardProgress?.markProgress();
    const tenantCycle = await runFairTenantCycle({
      tenants: tenants.rows,
      startOffset: bookingReminderTenantCycleStartOffset,
      shouldStop: () => shuttingDown,
      runTenant: async (tenant) => {
        const result = await runBookingReminderSchedulerBatch({
          pool,
          tenantId: tenant.id,
          batchSize: config.BOOKING_REMINDER_BATCH_SIZE,
          claimTtlMs: config.BOOKING_REMINDER_CLAIM_TTL_MS,
          databaseTimeoutMs: config.BOOKING_REMINDER_DATABASE_TIMEOUT_MS,
          maxHours24LatenessMs: config.BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS,
          maxHours2LatenessMs: config.BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS,
        });
        emitted += result.emitted;
        missed += result.missed;
      },
      onTenantFailure: (tenant, error) => {
        logger.error(
          { err: error, tenantId: tenant.id },
          'booking reminder scheduler tenant cycle failed',
        );
      },
      onProgress: () => bookingReminderForwardProgress?.markProgress(),
    });
    bookingReminderTenantCycleStartOffset = tenantCycle.nextStartOffset;
    failed = tenantCycle.failedCount > 0 || tenantCycle.interrupted;
    if (failed) bookingReminderForwardProgress?.markCycleFailed();
    else bookingReminderForwardProgress?.markCycleSucceeded();
    if (emitted > 0 || missed > 0) {
      logger.info({ emitted, missed }, 'booking reminder scheduler cycle completed');
    }
  } catch (error) {
    failed = true;
    bookingReminderForwardProgress?.markCycleFailed();
    logger.error({ error }, 'booking reminder scheduler cycle failed');
  } finally {
    workerMetrics.recordBookingReminderSchedulerCycle(
      emitted,
      missed,
      Date.now() - startedAt,
      failed,
    );
    if (!shuttingDown) {
      setTimeout(() => void runBookingReminderCycle(), config.BOOKING_REMINDER_POLL_INTERVAL_MS);
    }
  }
};

const runWebPushCycle = async (): Promise<void> => {
  if (shuttingDown || !webPushRuntime) return;
  const startedAt = Date.now();
  let failed = false;
  webPushForwardProgress?.markCycleStarted();
  try {
    const tenantCycle = await runWebPushTenantCycle({
      pool,
      startOffset: webPushTenantCycleStartOffset,
      maxDeliveriesPerTenant: config.WEB_PUSH_BATCH_SIZE,
      shouldStop: () => shuttingDown,
      runTenant: async (tenantId) => {
        const batch = await runWebPushDeliveryBatch({
          pool,
          logger,
          tenantId,
          appId: config.WEB_PUSH_APP_ID,
          environment: config.WEB_PUSH_ENVIRONMENT,
          cipher: webPushRuntime.cipher,
          adapter: webPushRuntime.adapter,
          maxAttempts: config.WEB_PUSH_MAX_ATTEMPTS,
          retryBaseMs: config.WEB_PUSH_RETRY_BASE_MS,
          circuitOpenRetryMs: config.WEB_PUSH_CIRCUIT_RESET_MS,
          batchSize: 1,
        });
        return batch.claimed;
      },
      onTenantFailure: (tenantId, error) => {
        logger.error({ err: error, tenantId }, 'Web Push tenant delivery failed');
      },
      onProgress: () => webPushForwardProgress?.markProgress(),
    });
    webPushTenantCycleStartOffset = tenantCycle.nextStartOffset;
    webPushTenantFailuresLastCycle = tenantCycle.failedCount;
    webPushRoundsLastCycle = tenantCycle.rounds;
    if (tenantCycle.interrupted) {
      failed = true;
      webPushForwardProgress?.markCycleFailed();
    } else {
      webPushForwardProgress?.markCycleSucceeded();
    }
  } catch (error) {
    failed = true;
    webPushTenantFailuresLastCycle = 0;
    webPushRoundsLastCycle = 0;
    webPushForwardProgress?.markCycleFailed();
    logger.error({ error }, 'Web Push delivery cycle failed');
  } finally {
    workerMetrics.recordWebPushCycle(
      webPushTenantFailuresLastCycle,
      webPushRoundsLastCycle,
      Date.now() - startedAt,
      failed,
    );
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

const runProfilePhotoMaintenance = async (): Promise<void> => {
  if (shuttingDown || !profilePhotoStore || !config.PROFILE_PHOTO_MAINTENANCE_ENABLED) {
    return;
  }
  try {
    const result = await runProfilePhotoMaintenanceCycle({
      pool,
      config,
      logger,
      profilePhotoStore,
    });
    if (result.deleted > 0 || result.deferred > 0 || result.commandsDeleted > 0) {
      logger.info({ result }, 'profile photo maintenance cycle completed');
    }
  } catch (error) {
    logger.error({ error }, 'profile photo maintenance cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runProfilePhotoMaintenance(), config.HOME_VIVA_SYNC_INTERVAL_MS);
    }
  }
};

const runCommunitySyncCycle = async (): Promise<void> => {
  if (shuttingDown || !config.COMMUNITY_HOME_SYNC_ENABLED || !profilePhotoStore || !communityHome) {
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
      sourceResilience: communityLogoSourceResilience,
    });
    if (result.attempted > 0) logger.info({ result }, 'community Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'community Home sync cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runCommunitySyncCycle(), config.COMMUNITY_HOME_SYNC_INTERVAL_MS);
    }
  }
};

const runCommunityLogoCompatibilityCycle = async (): Promise<void> => {
  if (
    shuttingDown ||
    !profilePhotoStore ||
    config.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED ||
    config.COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED !== true
  ) {
    return;
  }
  try {
    const result = await runCommunityLogoCompatibilityBackfill({
      pool,
      config,
      logger,
      store: profilePhotoStore,
    });
    if (result.logos > 0 || result.homes > 0 || result.failed > 0) {
      logger.info({ result }, 'community logo compatibility backfill cycle completed');
    }
  } catch (error) {
    logger.error({ error }, 'community logo compatibility backfill cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(
        () => void runCommunityLogoCompatibilityCycle(),
        config.HOME_VIVA_SYNC_INTERVAL_MS,
      );
    }
  }
};

const runPlatformSyncCycle = async (): Promise<void> => {
  if (shuttingDown || !config.PLATFORM_HOME_SYNC_ENABLED) return;
  try {
    const result = await runPlatformHomeSyncCycle({ pool, config, logger });
    if (result.attempted > 0) logger.info({ result }, 'platform Home sync cycle completed');
  } catch (error) {
    logger.error({ error }, 'platform Home sync cycle failed');
  } finally {
    if (!shuttingDown) {
      setTimeout(() => void runPlatformSyncCycle(), config.PLATFORM_HOME_SYNC_INTERVAL_MS);
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
void runBookingReminderCycle();
if (telemetry) void runOperationalMetricsCycle();
void runProfilePhotoMaintenance();
void runCommunitySyncCycle();
void runCommunityLogoCompatibilityCycle();
void runPlatformSyncCycle();
void runHomeBaseCycle();
void runPromotionSyncCycle();
void runLegacyGamesRosterSync();
void runWebPushCycle();
void runGiftCertificateDeliveryCycle();
void runCommunityDirectInviteExpiryCycle();
void runParticipationCommandExpiryCycle();
if (canonicalCommunityWorkerEnabled) {
  void runCommunityMemberCountReconciliation();
  void runCommunityEventRetention();
}
void runCommunityMedia();
