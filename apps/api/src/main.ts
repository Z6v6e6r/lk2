import type { IdentityProviderKey, IdentityProviderPort } from '@phub/auth';
import { loadConfig } from '@phub/config';
import {
  createAdminNotificationRepository,
  createActivityHistoryRepository,
  createBookingPreferencesRepository,
  createBookingScreenMappingRepository,
  createClientRoutingPlanRepository,
  createDatabasePool,
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
  createLocationMediaRepository,
  createLocationRepository,
  createNotificationEndpointRepository,
  createNotificationInboxRepository,
  createProfilePrivacyRepository,
  createProfileFriendshipRepository,
  createProfileLevelHistoryRepository,
  createProfileSummaryRepository,
  createPromotionEngagementRepository,
  createTrainerAvatarRepository,
  createUpcomingBookingsRepository,
} from '@phub/database';
import {
  LegacyGamesMongoAdapter,
  LegacyGamesPublicAdapter,
  LegacyTournamentSummaryAdapter,
} from '@phub/legacy-games-adapter';
import { createNotificationEndpointCipher } from '@phub/notifications';
import { createLogger, startTelemetry } from '@phub/observability';
import {
  VivaCoachGameSummaryAdapter,
  VivaExerciseRecommendationSourceAdapter,
  VivaExerciseRosterSourceAdapter,
  VivaIdentityProvider,
} from '@phub/viva-adapter';
import Redis from 'ioredis';

import { buildApp } from './app.js';
import { ActivityHistoryProjectionCoordinator } from './bookings/activity-history-refresh.js';
import { ActivityHistoryGameBackfill } from './bookings/activity-history-game-backfill.js';
import { RedisBookingScreenReadJobStore } from './bookings/booking-screen-read-job-store.js';
import { RedisEventCatalogSnapshotStore } from './bookings/event-catalog-snapshot-store.js';
import type { EventCatalogItem } from './bookings/booking-recommendation-routes.js';
import { listViewerGameCards } from './games/game-card-queries.js';
import { S3GiftCertificateMediaStore } from './gift-certificates/gift-certificate-media-store.js';
import { S3GiftCertificateArtifactReadStore } from './gift-certificates/gift-certificate-artifact-store.js';
import { S3LocationMediaStore } from './locations/location-media-store.js';
import { S3ProfilePhotoMediaStore } from './profile/profile-photo-media-store.js';
import { AuthService } from './auth/auth-service.js';
import { RedisAuthChallengeStore } from './auth/challenge-store.js';
import { RedisVivaOAuthStateStore } from './auth/oauth-state-store.js';
import { createCommunityDirectoryRuntime } from './communities/community-runtime.js';
import { PostgresAuthRepository } from './auth/postgres-auth-repository.js';
import { LegacyPromotionEngagementSink } from './promotions/legacy-promotion-engagement-sink.js';
import { S3TrainerAvatarMediaStore } from './trainer-avatar-media-store.js';

const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL, process.env.RELEASE);
const telemetry = startTelemetry({
  serviceName: 'api',
  serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT ? { endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
});
const pool = createDatabasePool(config.DATABASE_URL);
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
  profileApiBaseUrl: config.VIVA_AUTH_PROFILE_API_URL,
  oauthScopes: config.VIVA_OAUTH_SCOPES,
  realm: config.VIVA_AUTH_REALM,
  clientId: config.VIVA_AUTH_CLIENT_ID,
  channel: config.VIVA_AUTH_CHANNEL,
  timeoutMs: config.VIVA_TIMEOUT_MS,
  devPhoneE164: config.AUTH_DEV_PHONE_E164,
  devOtpCode: config.AUTH_DEV_OTP_CODE,
  allowExistingSubjectOAuthBootstrap: config.VIVA_DIRECT_READ_ENABLED,
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
const gameReadRepository = config.GAMES_READ_ENABLED ? createGameRepository(pool) : undefined;
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
const coachGameSummarySource = config.GAMES_READ_ENABLED
  ? new VivaCoachGameSummaryAdapter({
      apiBaseUrl: config.VIVA_END_USER_API_URL,
      tenantKey: config.VIVA_AUTH_TENANT_KEY,
      timeoutMs: Math.max(config.VIVA_TIMEOUT_MS, 8_000),
      freshTtlMs: 60_000,
      staleTtlMs: 600_000,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
      onMetric: (metric) => logger.info({ metric }, 'Viva coach-game summary read'),
    })
  : undefined;
const exerciseRecommendationSource =
  config.GAMES_READ_ENABLED && (config.VIVA_MODE === 'sandbox' || config.VIVA_MODE === 'production')
    ? new VivaExerciseRecommendationSourceAdapter({
        mode: config.VIVA_MODE,
        apiBaseUrl: config.VIVA_END_USER_API_URL,
        providerTenantKey: config.VIVA_AUTH_TENANT_KEY,
        timeoutMs: config.VIVA_TIMEOUT_MS,
        maxAttempts: 2,
        circuitFailureThreshold: 3,
        circuitResetMs: 30_000,
        onMetric: (metric) => logger.info({ metric }, 'Viva exercise recommendation read'),
      })
    : undefined;
const exerciseRosterSource =
  config.GAMES_READ_ENABLED && (config.VIVA_MODE === 'sandbox' || config.VIVA_MODE === 'production')
    ? new VivaExerciseRosterSourceAdapter({
        mode: config.VIVA_MODE,
        apiBaseUrl:
          config.VIVA_API_URL && config.VIVA_API_KEY
            ? config.VIVA_API_URL
            : config.LEGACY_GAMES_PUBLIC_BASE_URL,
        transport: config.VIVA_API_URL && config.VIVA_API_KEY ? 'VIVA_ADMIN' : 'PADLHUB_PROXY',
        ...(config.VIVA_API_URL && config.VIVA_API_KEY ? { apiKey: config.VIVA_API_KEY } : {}),
        timeoutMs: Math.min(config.VIVA_TIMEOUT_MS, 4_000),
        maxAttempts: 2,
        freshTtlMs: 30_000,
        staleTtlMs: 600_000,
        circuitFailureThreshold: 3,
        circuitResetMs: 30_000,
        onMetric: (metric) => logger.info({ metric }, 'Viva exercise roster read'),
      })
    : undefined;
const profileSummaryRepository = createProfileSummaryRepository(pool);
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
const app = await buildApp({
  config,
  logger,
  pool,
  authService,
  communityDirectory: createCommunityDirectoryRuntime({ config, pool, logger }),
  homeDashboardRepository: createHomeDashboardProjectionRepository(pool),
  homeBaseRepository: createHomeBaseProjectionRepository(pool),
  clientRoutingPlanRepository,
  notificationRepository: createNotificationInboxRepository(pool),
  notificationEndpointRepository: createNotificationEndpointRepository(pool),
  adminNotificationRepository: createAdminNotificationRepository(pool),
  locationRepository: createLocationRepository(pool),
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
  ...(tournamentSummarySource ? { tournamentSummarySource } : {}),
  ...(coachGameSummarySource ? { coachGameSummarySource } : {}),
  ...(exerciseRecommendationSource ? { exerciseRecommendationSource } : {}),
  ...(exerciseRosterSource ? { exerciseRosterSource } : {}),
  ...(config.GAMES_COMMANDS_ENABLED
    ? {
        gameRosterRepository: createGameRosterRepository(pool),
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
