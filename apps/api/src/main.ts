import type { IdentityProviderKey, IdentityProviderPort } from '@phub/auth';
import { loadConfig, runtimeContourTargetFingerprint } from '@phub/config';
import {
  createAdminNotificationRepository,
  createActivityHistoryRepository,
  createBookingPreferencesRepository,
  createBookingScreenMappingRepository,
  createClientRoutingPlanRepository,
  createCupPlayerLevelProjectionRepository,
  createCommunityLogoMediaRepository,
  createDatabasePool,
  warmDatabasePool,
  createGameRepository,
  createGameResultRepository,
  createGiftCertificateCatalogRepository,
  createGiftCertificateIssuanceRepository,
  createGiftCertificateMediaRepository,
  createGiftCertificateSaleRepository,
  createGameRosterRepository,
  createHomeBaseProjectionRepository,
  createHomeDashboardProjectionRepository,
  createLegacyGameImportRepository,
  createLegacyGameRosterBridgeRepository,
  createLocationMediaRepository,
  createLocationRepository,
  createLevelEligibilityPolicyRepository,
  createPlayerLevelRepository,
  createMessagingRepository,
  createNotificationEndpointRepository,
  createNotificationInboxRepository,
  createParticipationCommandRepository,
  createProfilePrivacyRepository,
  createProfileFriendshipRepository,
  createProfileLevelHistoryRepository,
  createProfileSummaryRepository,
  createPromotionEngagementRepository,
  createRealtimeAuthorizationRepository,
  createTrainerAvatarRepository,
  createUpcomingBookingsRepository,
  createSubscriptionRuntimeActorContextRepository,
  projectHomeBaseUser,
} from '@phub/database';
import {
  LegacyGamesMongoAdapter,
  LegacyGamesPublicAdapter,
  LegacyTournamentSummaryAdapter,
} from '@phub/legacy-games-adapter';
import { createNotificationEndpointCipher } from '@phub/notifications';
import { createLogger, recordLevelEligibilityMetrics, startTelemetry } from '@phub/observability';
import { VivaIdentityProvider } from '@phub/viva-adapter';
import { ManagedSubscriptionRuntimeQuoteClient } from '@phub/subscription-runtime-adapter';
import Redis from 'ioredis';

import { buildApp } from './app.js';
import { ActivityHistoryProjectionCoordinator } from './bookings/activity-history-refresh.js';
import { ActivityHistoryGameBackfill } from './bookings/activity-history-game-backfill.js';
import { RedisBookingScreenReadJobStore } from './bookings/booking-screen-read-job-store.js';
import { RedisEventCatalogSnapshotStore } from './bookings/event-catalog-snapshot-store.js';
import { RedisRealtimeTicketIssuer } from './messaging/realtime-ticket-issuer.js';
import type { EventCatalogItem } from './bookings/booking-recommendation-routes.js';
import { listViewerGameCards } from './games/game-card-queries.js';
import { CupLegacyLkIdentityVerifier } from './games/legacy-lk-identity-verifier.js';
import { S3GiftCertificateMediaStore } from './gift-certificates/gift-certificate-media-store.js';
import { S3GiftCertificateArtifactReadStore } from './gift-certificates/gift-certificate-artifact-store.js';
import { S3LocationMediaStore } from './locations/location-media-store.js';
import { S3ProfilePhotoMediaStore } from './profile/profile-photo-media-store.js';
import { S3CommunityMediaObjectStore } from './communities/community-media-object-store.js';
import { AuthService } from './auth/auth-service.js';
import { RedisAuthChallengeStore } from './auth/challenge-store.js';
import { RedisVivaOAuthStateStore } from './auth/oauth-state-store.js';
import {
  createCommunityContentModerationRuntime,
  createCommunityContentRuntime,
  createCommunityCreateRuntime,
  createCommunityDirectInviteRuntime,
  createCommunityDirectoryRuntime,
  createCommunityEventRecoveryRuntime,
  createCommunityMediaRuntime,
  createCommunityMembershipLifecycleRuntime,
  createCommunityMembershipPinRuntime,
  createCommunityOwnershipTransferRuntime,
  createCommunityReadExperienceRuntime,
  createCommunityReadRuntime,
} from './communities/community-runtime.js';
import { PostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { LegacyPromotionEngagementSink } from './promotions/legacy-promotion-engagement-sink.js';
import { S3TrainerAvatarMediaStore } from './trainer-avatar-media-store.js';
import { SubscriptionRuntimeActorDelegationIssuer } from './subscriptions/subscription-runtime-actor-delegation-issuer.js';

const config = loadConfig();
const runtimeContourAttestation = config.LOCAL_RUNTIME_CONTOUR_ATTESTATION
  ? {
      database: runtimeContourTargetFingerprint(config.DATABASE_URL),
      redis: runtimeContourTargetFingerprint(config.REDIS_URL),
    }
  : undefined;
const logger = createLogger('api', config.LOG_LEVEL, process.env.RELEASE);
const clientMediaRollbackCapability = 'phub.client-media-rollback.v1';
const communityLogoRollbackCapability = 'phub.community-logo-rollback.v1';
logger.info(
  { capabilities: [clientMediaRollbackCapability, communityLogoRollbackCapability] },
  'API capabilities configured',
);
const telemetry = startTelemetry({
  serviceName: 'api',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL, { max: config.DATABASE_POOL_MAX });
await warmDatabasePool(pool, config.DATABASE_POOL_WARM_CONNECTIONS, config.DATABASE_POOL_MAX);
logger.info(
  {
    databasePoolMax: config.DATABASE_POOL_MAX,
    databasePoolWarmConnections: config.DATABASE_POOL_WARM_CONNECTIONS,
  },
  'database pool warmed before API readiness',
);
const clientRoutingPlanRepository = createClientRoutingPlanRepository(pool);
const notificationEndpointCipher =
  config.WEB_PUSH_ENABLED && config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS
    ? createNotificationEndpointCipher({
        serializedKeys: config.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS,
        activeKeyId: config.NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID,
      })
    : undefined;
const redis = new Redis(config.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
const vivaIdentityProvider = new VivaIdentityProvider({
  mode: config.VIVA_MODE,
  baseUrl: config.VIVA_AUTH_BASE_URL,
  oauthScopes: config.VIVA_OAUTH_SCOPES,
  realm: config.VIVA_AUTH_REALM,
  clientId: config.VIVA_AUTH_CLIENT_ID,
  channel: config.VIVA_AUTH_CHANNEL,
  timeoutMs: config.VIVA_TIMEOUT_MS,
  devPhoneE164: config.AUTH_DEV_PHONE_E164,
  devOtpCode: config.AUTH_DEV_OTP_CODE,
  allowExistingSubjectOAuthBootstrap: config.VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED,
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
const activityHistoryRepository = config.ACTIVITY_HISTORY_ENABLED
  ? createActivityHistoryRepository(pool)
  : undefined;
const gameRepository =
  config.GAMES_READ_ENABLED || config.GAMES_COMMANDS_ENABLED
    ? createGameRepository(pool)
    : undefined;
const gameReadRepository = config.GAMES_READ_ENABLED ? gameRepository : undefined;
const gameCommandRepository = config.GAMES_COMMANDS_ENABLED ? gameRepository : undefined;
const tournamentSummarySource = config.GAMES_READ_ENABLED
  ? new LegacyTournamentSummaryAdapter({
      baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
      timeoutMs: Math.max(config.VIVA_TIMEOUT_MS, 8_000),
      freshTtlMs: 60_000,
      staleTtlMs: 600_000,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      onMetric: (metric) => logger.info({ metric }, 'legacy tournament summary read'),
    })
  : undefined;
const profileSummaryRepository = createProfileSummaryRepository(pool);
const gameRosterRepository = config.GAMES_COMMANDS_ENABLED
  ? createGameRosterRepository(pool, {
      onEligibilityDecision: (decision) => {
        recordLevelEligibilityMetrics({
          tenant: decision.tenantId,
          sport: decision.sportId,
          activityType: decision.activityType,
          mode: decision.mode,
          outcome: decision.outcome,
          reasonCode: decision.reasonCode,
          constraintSource: decision.constraintSource,
          action: decision.action,
        });
        logger.info({ eligibility: decision }, 'participation eligibility evaluated');
      },
    })
  : undefined;
const participationCommandRepository = createParticipationCommandRepository(pool, {
  onDecision: (decision) => {
    recordLevelEligibilityMetrics({
      tenant: decision.tenantId,
      sport: decision.sportId,
      activityType: decision.activityType,
      mode: decision.mode,
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      constraintSource: decision.constraintSource,
      action: decision.action,
    });
    logger.info({ eligibility: decision }, 'participation command eligibility evaluated');
  },
});
const legacyLkIdentityVerifier = config.LEGACY_GAME_COMMAND_BRIDGE_ENABLED
  ? new CupLegacyLkIdentityVerifier({
      url: config.LEGACY_GAME_IDENTITY_VERIFY_URL as string,
      integrationToken: config.LEGACY_GAME_IDENTITY_VERIFY_TOKEN as string,
      timeoutMs: config.LEGACY_GAME_IDENTITY_VERIFY_TIMEOUT_MS,
    })
  : undefined;
const promotionEngagementSink = config.PROMOTIONS_ENGAGEMENT_SECRET
  ? new LegacyPromotionEngagementSink({
      baseUrl: config.PROMOTIONS_LEGACY_BASE_URL,
      secret: config.PROMOTIONS_ENGAGEMENT_SECRET,
      timeoutMs: config.PROMOTIONS_LEGACY_TIMEOUT_MS,
      maxAttempts: config.PROMOTIONS_LEGACY_MAX_ATTEMPTS,
      circuitFailureThreshold: config.PROMOTIONS_LEGACY_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.PROMOTIONS_LEGACY_CIRCUIT_RESET_MS,
      onMetric: (metric) => logger.info({ metric }, 'promotion engagement delivery'),
    })
  : undefined;
const activityHistoryGameBackfillSource = !config.ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED
  ? undefined
  : config.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'public'
    ? new LegacyGamesPublicAdapter({
        baseUrl: config.LEGACY_GAMES_PUBLIC_BASE_URL,
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : new LegacyGamesMongoAdapter({
        uri: config.LEGACY_GAMES_MONGODB_URI as string,
        timeoutMs: config.VIVA_TIMEOUT_MS,
        maxAttempts: 2,
        onMetric: (metric) => logger.info({ metric }, 'historical CUP Games read operation'),
      });
const activityHistoryGameBackfill =
  activityHistoryGameBackfillSource && gameReadRepository
    ? new ActivityHistoryGameBackfill({
        tenantKey: config.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY as string,
        source: activityHistoryGameBackfillSource,
        repository: createLegacyGameImportRepository(pool),
        projectGameCard: (input) => gameReadRepository.projectCardEvent(input),
      })
    : undefined;
const readAllLocalGameHistory = gameReadRepository
  ? async (input: { readonly tenantId: string; readonly userId: string }) => {
      const items: Awaited<ReturnType<typeof listViewerGameCards>>['items'][number][] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page = await listViewerGameCards({
          repository: gameReadRepository,
          photoRepository: profileSummaryRepository,
          tenantId: input.tenantId,
          viewerUserId: input.userId,
          scope: 'HISTORY',
          now: new Date().toISOString(),
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...page.items);
        if (!page.nextCursor) return items;
        cursor = page.nextCursor;
      }
      throw new Error('ACTIVITY_HISTORY_LOCAL_GAMES_LIMIT_EXCEEDED');
    }
  : undefined;
const activityHistoryProjector =
  activityHistoryRepository && config.ACTIVITY_HISTORY_SYNC_ENABLED
    ? new ActivityHistoryProjectionCoordinator({
        repository: activityHistoryRepository,
        freshSeconds: config.ACTIVITY_HISTORY_FRESH_SECONDS,
        ...(activityHistoryGameBackfill
          ? {
              backfillGames: async (input) => {
                const result = await activityHistoryGameBackfill.run(input);
                if (result.matched > 0) {
                  logger.info(
                    {
                      tenantId: input.tenantId,
                      userId: input.userId,
                      correlationId: input.correlationId,
                      ...result,
                    },
                    'historical Games backfill completed before activity projection',
                  );
                }
                return result;
              },
            }
          : {}),
        ...(readAllLocalGameHistory ? { readLocalGames: readAllLocalGameHistory } : {}),
      })
    : undefined;
const giftCertificateMediaStore = config.GIFT_CERTIFICATE_MEDIA_ENABLED
  ? new S3GiftCertificateMediaStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
      readUrlTtlSeconds: config.GIFT_CERTIFICATE_MEDIA_URL_TTL_SECONDS,
      timeoutMs: config.GIFT_CERTIFICATE_MEDIA_STORAGE_TIMEOUT_MS,
    })
  : undefined;
const locationMediaStore = config.LOCATION_MEDIA_ENABLED
  ? new S3LocationMediaStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
      readUrlTtlSeconds: config.LOCATION_MEDIA_URL_TTL_SECONDS,
      timeoutMs: config.LOCATION_MEDIA_STORAGE_TIMEOUT_MS,
    })
  : undefined;
const profilePhotoMediaStore =
  config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET_KEY
    ? new S3ProfilePhotoMediaStore({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : undefined;
const trainerAvatarMediaStore =
  config.S3_ENDPOINT && config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET_KEY
    ? new S3TrainerAvatarMediaStore({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        timeoutMs: config.VIVA_TIMEOUT_MS,
      })
    : undefined;
const giftCertificateArtifactStore = config.GIFT_CERTIFICATE_ISSUANCE_ENABLED
  ? new S3GiftCertificateArtifactReadStore({
      endpoint: config.S3_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      timeoutMs: config.GIFT_CERTIFICATE_ARTIFACT_STORAGE_TIMEOUT_MS,
    })
  : undefined;
const communityReadExperienceService = createCommunityReadExperienceRuntime({
  config,
  pool,
  logger,
});
const communityMembershipPinService = createCommunityMembershipPinRuntime({ config, pool });
const communityMembershipLifecycleService = createCommunityMembershipLifecycleRuntime({
  config,
  pool,
});
const communityCreateService = createCommunityCreateRuntime({ config, pool });
const communityReadService = createCommunityReadRuntime({ config, pool });
const communityDirectInviteService = createCommunityDirectInviteRuntime({ config, pool });
const communityOwnershipTransferService = createCommunityOwnershipTransferRuntime({ config, pool });
const communityContentService = createCommunityContentRuntime({ config, pool });
const communityContentModerationService = createCommunityContentModerationRuntime({ config, pool });
const communityEventRecoveryService = createCommunityEventRecoveryRuntime({ config, pool });
const communityMediaObjectStore = config.COMMUNITY_MEDIA_ENABLED
  ? new S3CommunityMediaObjectStore({
      endpoint: config.S3_ENDPOINT as string,
      publicEndpoint: config.S3_PUBLIC_ENDPOINT as string,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET as string,
      accessKey: config.S3_ACCESS_KEY as string,
      secretKey: config.S3_SECRET_KEY as string,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      autoCreateBucket: config.S3_AUTO_CREATE_BUCKET,
    })
  : undefined;
const communityMediaRuntime = communityMediaObjectStore
  ? createCommunityMediaRuntime({ config, pool, objectStore: communityMediaObjectStore })
  : undefined;
const subscriptionRuntimeWarnBoundary = (() => {
  if (config.SUBSCRIPTION_RUNTIME_WARN_MODE !== 'WARN') return undefined;
  const privateKeys = JSON.parse(
    config.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS as string,
  ) as Record<string, string>;
  const activeKeyId = config.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID as string;
  return {
    actorContextRepository: createSubscriptionRuntimeActorContextRepository(pool),
    delegationIssuer: new SubscriptionRuntimeActorDelegationIssuer({
      privateKeyPem: privateKeys[activeKeyId] as string,
      keyId: activeKeyId,
      issuer: config.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER as string,
      audience: config.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE as string,
      ttlSeconds: config.SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS,
    }),
    quoteClient: new ManagedSubscriptionRuntimeQuoteClient({
      enabled: true,
      baseUrl: config.SUBSCRIPTION_RUNTIME_BASE_URL as string,
      integrationToken: config.SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN as string,
      timeoutMs: config.SUBSCRIPTION_RUNTIME_TIMEOUT_MS,
      circuitFailureThreshold: config.SUBSCRIPTION_RUNTIME_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: config.SUBSCRIPTION_RUNTIME_CIRCUIT_RESET_MS,
      environment: config.APP_ENV === 'local' ? 'development' : 'production',
      onMetric: (metric) =>
        logger.info({ metric }, 'subscription runtime quote boundary operation'),
    }),
  };
})();
const app = await buildApp({
  config,
  logger,
  pool,
  ...(runtimeContourAttestation ? { runtimeContourAttestation } : {}),
  authService,
  ...(subscriptionRuntimeWarnBoundary
    ? {
        subscriptionRuntimeActorContextRepository:
          subscriptionRuntimeWarnBoundary.actorContextRepository,
        subscriptionRuntimeDelegationIssuer: subscriptionRuntimeWarnBoundary.delegationIssuer,
        subscriptionRuntimeQuoteClient: subscriptionRuntimeWarnBoundary.quoteClient,
      }
    : {}),
  communityDirectory: createCommunityDirectoryRuntime({ config, pool, logger }),
  ...(communityReadExperienceService ? { communityReadExperienceService } : {}),
  ...(communityCreateService ? { communityCreateService } : {}),
  ...(communityMembershipPinService ? { communityMembershipPinService } : {}),
  ...(communityMembershipLifecycleService ? { communityMembershipLifecycleService } : {}),
  ...(communityReadService ? { communityReadService } : {}),
  ...(communityDirectInviteService ? { communityDirectInviteService } : {}),
  ...(communityOwnershipTransferService ? { communityOwnershipTransferService } : {}),
  ...(communityContentService ? { communityContentService } : {}),
  ...(communityContentModerationService ? { communityContentModerationService } : {}),
  ...(communityEventRecoveryService ? { communityEventRecoveryService } : {}),
  ...(communityMediaRuntime && communityMediaObjectStore
    ? {
        communityMediaService: communityMediaRuntime.service,
        communityMediaDeliveryAuthorizer: communityMediaRuntime.deliveryAuthorizer,
        communityMediaModerationAuthorizer: communityMediaRuntime.moderationAuthorizer,
        communityMediaObjectStore,
        communityMediaOperationsRepository: communityMediaRuntime.operationsRepository,
      }
    : {}),
  realtimeAuthorizationRepository: createRealtimeAuthorizationRepository(pool),
  homeDashboardRepository: createHomeDashboardProjectionRepository(pool),
  homeBaseRepository: createHomeBaseProjectionRepository(pool),
  ...(config.HOME_BASE_SYNC_ENABLED
    ? {
        homeBaseProjector: (input: { tenantId: string; userId: string; correlationId: string }) =>
          projectHomeBaseUser({
            pool,
            ...input,
            ttlSeconds: config.HOME_PROJECTION_TTL_SECONDS,
          }),
      }
    : {}),
  clientRoutingPlanRepository,
  notificationRepository: createNotificationInboxRepository(pool),
  messagingRepository: createMessagingRepository(pool),
  realtimeTicketIssuer: new RedisRealtimeTicketIssuer(redis, config),
  notificationEndpointRepository: createNotificationEndpointRepository(pool),
  adminNotificationRepository: createAdminNotificationRepository(pool),
  locationRepository: createLocationRepository(pool),
  levelEligibilityPolicyRepository: createLevelEligibilityPolicyRepository(pool),
  playerLevelRepository: createPlayerLevelRepository(pool),
  cupPlayerLevelProjectionRepository: createCupPlayerLevelProjectionRepository(pool),
  participationCommandRepository,
  locationMediaRepository: createLocationMediaRepository(pool),
  giftCertificateCatalogRepository: createGiftCertificateCatalogRepository(pool),
  giftCertificateMediaRepository: createGiftCertificateMediaRepository(pool),
  giftCertificateSaleRepository: createGiftCertificateSaleRepository(pool),
  ...(config.GIFT_CERTIFICATE_ISSUANCE_ENABLED
    ? { giftCertificateIssuanceRepository: createGiftCertificateIssuanceRepository(pool) }
    : {}),
  ...(giftCertificateMediaStore ? { giftCertificateMediaStore } : {}),
  ...(locationMediaStore ? { locationMediaStore } : {}),
  profilePhotoMediaRepository: profileSummaryRepository,
  communityLogoMediaRepository: createCommunityLogoMediaRepository(pool),
  ...(profilePhotoMediaStore ? { profilePhotoMediaStore } : {}),
  ...(trainerAvatarMediaStore
    ? {
        trainerAvatarRepository: createTrainerAvatarRepository(pool),
        trainerAvatarMediaStore,
      }
    : {}),
  ...(giftCertificateArtifactStore ? { giftCertificateArtifactStore } : {}),
  profilePrivacyRepository: createProfilePrivacyRepository(pool),
  profileFriendshipRepository: createProfileFriendshipRepository(pool),
  profileLevelHistoryRepository: createProfileLevelHistoryRepository(pool),
  profileSummaryRepository,
  ...(promotionEngagementSink
    ? {
        promotionEngagementRepository: createPromotionEngagementRepository(pool),
        promotionEngagementSink,
      }
    : {}),
  bookingPreferencesRepository: createBookingPreferencesRepository(pool),
  upcomingBookingsRepository: createUpcomingBookingsRepository(pool),
  ...(config.VIVA_DIRECT_READ_ENABLED || config.GAMES_READ_ENABLED
    ? {
        bookingScreenReadJobStore: new RedisBookingScreenReadJobStore(redis),
        eventCatalogSnapshotStore: new RedisEventCatalogSnapshotStore<EventCatalogItem>(redis),
        bookingScreenMappingRepository: createBookingScreenMappingRepository(pool),
      }
    : {}),
  ...(activityHistoryRepository ? { activityHistoryRepository } : {}),
  ...(activityHistoryProjector ? { activityHistoryProjector } : {}),
  ...(gameReadRepository ? { gameReadRepository } : {}),
  ...(gameCommandRepository ? { gameCommandRepository } : {}),
  ...(tournamentSummarySource ? { tournamentSummarySource } : {}),
  ...(gameRosterRepository
    ? {
        gameRosterRepository,
        ...(config.LEGACY_GAME_COMMAND_BRIDGE_ENABLED && legacyLkIdentityVerifier
          ? {
              legacyGameRosterBridgeRepository: createLegacyGameRosterBridgeRepository(pool),
              legacyLkIdentityVerifier,
            }
          : {}),
        ...(config.GAMES_RESULTS_WRITE_MODE === 'local_primary'
          ? { gameResultRepository: createGameResultRepository(pool) }
          : {}),
      }
    : {}),
  ...(notificationEndpointCipher ? { notificationEndpointCipher } : {}),
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
