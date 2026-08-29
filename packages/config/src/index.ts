import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import { z } from 'zod';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const booleanFromEnvironmentDefaultTrue = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');
const pkcs8PrivateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

const environmentSchema = z.object({
  APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  REALTIME_HOST: z.string().default('0.0.0.0'),
  REALTIME_PORT: z.coerce.number().int().positive().default(3001),
  REALTIME_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REALTIME_DATABASE_POOL_WARM_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(2),
  REALTIME_MAX_CONNECTIONS: z.coerce.number().int().min(100).max(100_000).default(10_000),
  REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION: z.coerce.number().int().min(1).max(500).default(100),
  REALTIME_MAX_SOCKET_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(8 * 1_024 * 1_024)
    .default(512 * 1_024),
  REALTIME_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(60_000).default(1000),
  OUTBOX_PUBLISH_MODE: z.enum(['transactional', 'leased']).default('transactional'),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_CLAIM_TTL_MS: z.coerce.number().int().min(10_000).max(300_000).default(60_000),
  OUTBOX_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  OUTBOX_FAILURE_BACKOFF_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  BOOKING_REMINDER_SCHEDULER_ENABLED: booleanFromEnvironment,
  BOOKING_REMINDER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  BOOKING_REMINDER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  BOOKING_REMINDER_CLAIM_TTL_MS: z.coerce.number().int().min(10_000).max(300_000).default(60_000),
  BOOKING_REMINDER_DATABASE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(21_600_000),
  BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(7_200_000)
    .default(1_800_000),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DATABASE_POOL_WARM_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(1),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .optional(),
  S3_ACCESS_KEY: z.string().min(1).optional(),
  S3_SECRET_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: booleanFromEnvironmentDefaultTrue,
  S3_AUTO_CREATE_BUCKET: booleanFromEnvironment,
  PROFILE_PHOTO_ALLOWED_HOSTS: z.string().min(1).default('.selcdn.ru,.selstorage.ru'),
  PROFILE_PHOTO_CLIENT_SYNC_ENABLED: booleanFromEnvironment,
  PROFILE_PHOTO_MAINTENANCE_ENABLED: booleanFromEnvironment,
  PROFILE_PHOTO_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(20 * 1_024 * 1_024)
    .default(8 * 1_024 * 1_024),
  PROFILE_PHOTO_MAX_DIMENSION: z.coerce.number().int().min(128).max(2_048).default(1_024),
  PROFILE_PHOTO_WEBP_QUALITY: z.coerce.number().int().min(40).max(95).default(82),
  PROFILE_PHOTO_URL_TTL_SECONDS: z.coerce.number().int().min(600).max(86_400).default(3_600),
  PROFILE_PHOTO_GC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWT_ADMIN_AUDIENCE: z.string().min(1).default('phub-admin'),
  JWT_REALTIME_AUDIENCE: z.string().min(1).default('phub-realtime'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REALTIME_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32),
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).max(5_184_000).default(2_592_000),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  AUTH_CHALLENGE_RESEND_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
  AUTH_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  AUTH_COOKIE_SECURE: booleanFromEnvironment,
  AUTH_DEV_PHONE_E164: z
    .string()
    .regex(/^\+7\d{10}$/)
    .default('+79990000001'),
  AUTH_DEV_OTP_CODE: z
    .string()
    .regex(/^\d{4}$/)
    .default('0000'),
  CUP_DEV_AUTH_ENABLED: booleanFromEnvironment,
  CUP_DEV_AUTH_PHONE_E164: z
    .string()
    .regex(/^\+7\d{10}$/)
    .optional(),
  CUP_DEV_AUTH_OTP_CODE: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  VIVA_MODE: z.enum(['mock', 'sandbox', 'production', 'disabled']).default('mock'),
  HOME_READ_MODE: z.enum(['mock', 'projection']).default('mock'),
  GAMES_READ_ENABLED: booleanFromEnvironment,
  GAMES_COMMANDS_ENABLED: booleanFromEnvironment,
  SUBSCRIPTION_RUNTIME_WARN_MODE: z.enum(['OFF', 'WARN']).default('OFF'),
  SUBSCRIPTION_RUNTIME_BASE_URL: z.string().url().optional(),
  SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN: z.string().min(32).optional(),
  SUBSCRIPTION_RUNTIME_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(3_000),
  SUBSCRIPTION_RUNTIME_CIRCUIT_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(3),
  SUBSCRIPTION_RUNTIME_CIRCUIT_RESET_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(30_000),
  SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS: z.string().min(1).optional(),
  SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{3,64}$/)
    .optional(),
  SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER: z.string().min(1).max(512).optional(),
  SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE: z.string().min(1).max(256).optional(),
  SUBSCRIPTION_RUNTIME_DELEGATION_TTL_SECONDS: z.coerce.number().int().min(10).max(60).default(30),
  MESSAGING_USER_BLOCK_COMMANDS_ENABLED: booleanFromEnvironment,
  GAMES_RESULTS_WRITE_MODE: z
    .enum(['disabled', 'shadow_compare', 'local_primary'])
    .default('disabled'),
  CUP_RATING_CONSUMER_ENABLED: booleanFromEnvironment,
  CUP_RATING_API_URL: z.string().url().optional(),
  CUP_RATING_SERVICE_TOKEN: z.string().min(32).optional(),
  CUP_RATING_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  CUP_PLAYER_LEVEL_PROJECTION_ENABLED: booleanFromEnvironment,
  CUP_PLAYER_LEVEL_PROJECTION_TOKEN: z.string().min(32).optional(),
  CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .optional(),
  PARTICIPATION_COMMANDS_ENABLED: booleanFromEnvironment,
  PARTICIPATION_COMMAND_TOKEN: z.string().min(32).optional(),
  PARTICIPATION_COMMAND_TENANT_KEY: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .optional(),
  PARTICIPATION_COMMAND_PRINCIPAL_KEY: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/)
    .optional(),
  PARTICIPATION_COMMAND_AUTHORIZATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(900)
    .default(300),
  PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED: booleanFromEnvironment,
  PARTICIPATION_COMMAND_EXPIRY_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(60_000),
  PARTICIPATION_COMMAND_EXPIRY_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  ACTIVITY_HISTORY_ENABLED: booleanFromEnvironment,
  ACTIVITY_HISTORY_SYNC_ENABLED: booleanFromEnvironment,
  ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: booleanFromEnvironment,
  ACTIVITY_HISTORY_FRESH_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  ACTIVITY_HISTORY_PROVIDER_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  // The old LK can supply roster changes through either a safe local public clone or the staged
  // Mongo migration mirror. Source selection is process-only and is never exposed to clients.
  LEGACY_GAMES_ROSTER_SYNC_ENABLED: booleanFromEnvironment,
  LEGACY_GAME_COMMAND_BRIDGE_ENABLED: booleanFromEnvironment,
  LEGACY_GAME_COMMAND_BRIDGE_TOKEN: z.string().min(32).optional(),
  LEGACY_GAME_IDENTITY_VERIFY_URL: z.string().url().optional(),
  LEGACY_GAME_IDENTITY_VERIFY_TOKEN: z.string().min(32).optional(),
  LEGACY_GAME_IDENTITY_VERIFY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(15_000)
    .default(5_000),
  LEGACY_GAMES_ROSTER_SYNC_SOURCE: z.enum(['public', 'mongo']).default('mongo'),
  LEGACY_GAMES_MONGODB_URI: z.string().min(1).optional(),
  LEGACY_GAMES_PUBLIC_BASE_URL: z.string().url().default('https://padlhub.su'),
  LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: z.string().min(1).optional(),
  LEGACY_GAMES_ROSTER_SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(3_600_000)
    .default(120_000),
  LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(0).max(30).default(1),
  LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS: z.coerce.number().int().min(1).max(90).default(42),
  LEGACY_GAMES_ROSTER_SYNC_LIMIT: z.coerce.number().int().min(1).max(500).default(200),
  LEGACY_GAMES_PROFILE_PHOTO_SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  HOME_PROJECTION_MAX_STALE_SECONDS: z.coerce.number().int().nonnegative().max(86_400).default(300),
  HOME_PROJECTION_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  HOME_BASE_SYNC_ENABLED: booleanFromEnvironment,
  HOME_BASE_SYNC_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  HOME_BASE_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  HOME_VIVA_SYNC_ENABLED: booleanFromEnvironment,
  HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED: booleanFromEnvironment,
  HOME_VIVA_SYNC_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  HOME_VIVA_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  HOME_VIVA_SYNC_FAILURE_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(86_400_000)
    .default(300_000),
  COMMUNITY_HOME_SYNC_ENABLED: booleanFromEnvironment,
  COMMUNITY_HOME_SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(3_600_000)
    .default(120_000),
  COMMUNITY_HOME_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  PLATFORM_HOME_SYNC_ENABLED: booleanFromEnvironment,
  PLATFORM_HOME_SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(3_600_000)
    .default(120_000),
  PLATFORM_HOME_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  COMMUNITIES_READ_MODE: z.enum(['mock', 'legacy', 'local']).default('mock'),
  COMMUNITY_LEGACY_READ_DETAIL_ENABLED: booleanFromEnvironment,
  COMMUNITY_LEGACY_READ_FEED_ENABLED: booleanFromEnvironment,
  COMMUNITY_LEGACY_READ_CHAT_ENABLED: booleanFromEnvironment,
  COMMUNITY_LEGACY_READ_RATING_ENABLED: booleanFromEnvironment,
  COMMUNITY_INVITES_ENABLED: booleanFromEnvironment,
  COMMUNITIES_REALTIME_ENABLED: booleanFromEnvironment,
  COMMUNITY_MEDIA_ENABLED: booleanFromEnvironment,
  COMMUNITY_MEDIA_SCAN_MODE: z.enum(['mock', 'clamav']).default('mock'),
  COMMUNITY_MEDIA_CLAMAV_HOST: z.string().min(1).optional(),
  COMMUNITY_MEDIA_CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
  COMMUNITY_MEDIA_CLAMAV_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000),
  COMMUNITY_MEDIA_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  COMMUNITY_MEDIA_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  COMMUNITY_MEDIA_SCAN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  COMMUNITY_MEDIA_GC_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  COMMUNITY_MEDIA_READ_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  COMMUNITY_INVITE_TOKEN_KEYS: z.string().optional(),
  COMMUNITY_INVITE_ACTIVE_KEY_ID: z.string().min(1).max(64).optional(),
  COMMUNITIES_LEGACY_BASE_URL: z.string().url().default('https://padlhub.su'),
  COMMUNITIES_LEGACY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
  COMMUNITIES_LEGACY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(2),
  COMMUNITIES_LEGACY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  COMMUNITIES_LEGACY_CIRCUIT_RESET_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  COMMUNITIES_LEGACY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  COMMUNITY_LOGO_ALLOWED_HOSTS: z
    .string()
    .min(1)
    .default('padlhub.su,lk-reserve.89-108-64-209.sslip.io'),
  COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED: booleanFromEnvironment,
  COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED: booleanFromEnvironment,
  COMMUNITY_LOGO_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(20 * 1_024 * 1_024)
    .default(5 * 1_024 * 1_024),
  COMMUNITY_LOGO_MAX_DIMENSION: z.coerce.number().int().min(128).max(1_024).default(512),
  COMMUNITY_LOGO_WEBP_QUALITY: z.coerce.number().int().min(40).max(95).default(82),
  COMMUNITY_LOGO_GC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  PROMOTIONS_READ_MODE: z.enum(['mock', 'legacy']).default('mock'),
  PROMOTIONS_LEGACY_BASE_URL: z.string().url().default('https://padlhub.su'),
  PROMOTIONS_HERO_PLACEMENT: z.enum(['cabinet_home', 'cabinet_home_top']).default('cabinet_home'),
  PROMOTIONS_STANDARD_PLACEMENT: z
    .enum(['cabinet_home', 'cabinet_home_top'])
    .default('cabinet_home'),
  PROMOTIONS_RECOMMENDATION_STRIP_PLACEMENT: z
    .literal('cabinet_for_me_strip')
    .default('cabinet_for_me_strip'),
  PROMOTIONS_RECOMMENDATION_CARD_PLACEMENT: z
    .literal('cabinet_for_me_card')
    .default('cabinet_for_me_card'),
  PROMOTIONS_LEGACY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  PROMOTIONS_LEGACY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(2),
  PROMOTIONS_LEGACY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  PROMOTIONS_LEGACY_CIRCUIT_RESET_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  PROMOTIONS_ENGAGEMENT_SECRET: z.string().min(32).optional(),
  PROMOTIONS_SYNC_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  PROMOTIONS_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  PROMOTION_ROTATION_INTERVAL_SECONDS: z.coerce.number().int().min(3).max(30).default(6),
  PROMOTION_IMAGE_ALLOWED_HOSTS: z.string().min(1).default('padlhub.su'),
  PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS: z.string().default(''),
  PROMOTION_IMAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(20 * 1_024 * 1_024)
    .default(10 * 1_024 * 1_024),
  PROMOTION_IMAGE_DESKTOP_MAX_WIDTH: z.coerce.number().int().min(375).max(2_048).default(1_600),
  PROMOTION_IMAGE_DESKTOP_MAX_HEIGHT: z.coerce.number().int().min(240).max(2_048).default(900),
  PROMOTION_IMAGE_MOBILE_WIDTH: z.coerce.number().int().min(375).max(1_200).default(750),
  PROMOTION_IMAGE_MOBILE_HEIGHT: z.coerce.number().int().min(240).max(1_200).default(480),
  PROMOTION_IMAGE_WEBP_QUALITY: z.coerce.number().int().min(40).max(95).default(80),
  PROMOTION_MEDIA_GC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  LOCATION_MEDIA_ENABLED: booleanFromEnvironment,
  LOCATION_MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(8 * 1_024 * 1_024)
    .default(8 * 1_024 * 1_024),
  LOCATION_MEDIA_MAX_DIMENSION: z.coerce.number().int().min(512).max(2_048).default(1_600),
  LOCATION_MEDIA_WEBP_QUALITY: z.coerce.number().int().min(60).max(95).default(84),
  LOCATION_MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),
  LOCATION_MEDIA_STORAGE_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  GIFT_CERTIFICATE_MEDIA_ENABLED: booleanFromEnvironment,
  GIFT_CERTIFICATE_MEDIA_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1_024)
    .max(8 * 1_024 * 1_024)
    .default(5 * 1_024 * 1_024),
  GIFT_CERTIFICATE_MEDIA_MAX_DIMENSION: z.coerce.number().int().min(512).max(2_048).default(1_600),
  GIFT_CERTIFICATE_MEDIA_WEBP_QUALITY: z.coerce.number().int().min(60).max(95).default(84),
  GIFT_CERTIFICATE_MEDIA_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(3_600),
  GIFT_CERTIFICATE_MEDIA_STORAGE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(30_000)
    .default(5_000),
  GIFT_CERTIFICATE_PAYMENT_MODE: z.enum(['disabled', 'sandbox']).default('disabled'),
  GIFT_CERTIFICATE_ISSUANCE_ENABLED: booleanFromEnvironment,
  GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET: z.string().min(32).optional(),
  GIFT_CERTIFICATE_ARTIFACT_STORAGE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(30_000)
    .default(5_000),
  GIFT_CERTIFICATE_DELIVERY_MODE: z.enum(['disabled', 'sandbox']).default('disabled'),
  GIFT_CERTIFICATE_DELIVERY_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(1_000),
  GIFT_CERTIFICATE_DELIVERY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  GIFT_CERTIFICATE_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  GIFT_CERTIFICATE_DELIVERY_RETRY_BASE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(5_000),
  WEB_PUSH_ENABLED: booleanFromEnvironment,
  WEB_PUSH_ENVIRONMENT: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
  WEB_PUSH_APP_ID: z.string().min(1).max(300).default('padlhub-web'),
  WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: z.string().default(''),
  WEB_PUSH_VAPID_SUBJECT: z.string().optional(),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  WEB_PUSH_TTL_SECONDS: z.coerce.number().int().min(0).max(2_419_200).default(300),
  WEB_PUSH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  WEB_PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WEB_PUSH_RETRY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(5_000),
  WEB_PUSH_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  WEB_PUSH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(1),
  WEB_PUSH_ENDPOINTS_PER_USER_MAX: z.coerce.number().int().min(1).max(20).default(5),
  WEB_PUSH_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  WEB_PUSH_CIRCUIT_RESET_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: z.string().optional(),
  NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: z.string().min(1).max(64).default('v1'),
  VIVA_API_URL: z.string().url().optional().or(z.literal('')),
  VIVA_API_KEY: z.string().optional(),
  VIVA_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
  VIVA_DIRECT_READ_ENABLED: booleanFromEnvironment,
  VIVA_AUTH_BASE_URL: z.string().url().default('https://kc.vivacrm.ru'),
  VIVA_END_USER_API_URL: z.string().url().default('https://api.vivacrm.ru/end-user/api'),
  VIVA_AUTH_REALM: z.string().min(1).default('clients'),
  VIVA_AUTH_CLIENT_ID: z.string().min(1).default('widget'),
  VIVA_AUTH_TENANT_KEY: z.string().min(1).default('iSkq6G'),
  VIVA_AUTH_CHANNEL: z.string().min(1).default('cascade'),
  VIVA_OAUTH_ENABLED: booleanFromEnvironment,
  VIVA_OAUTH_ALLOWED_PROVIDERS: z
    .string()
    .regex(/^(?:vkid|yandex)(?:,(?:vkid|yandex))*$/)
    .default('vkid,yandex'),
  VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED: booleanFromEnvironment,
  VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED: booleanFromEnvironment,
  VIVA_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal('')),
  VIVA_OAUTH_SUCCESS_REDIRECT_URL: z.string().url().optional().or(z.literal('')),
  VIVA_OAUTH_SCOPES: z.string().min(1).default('openid'),
  VIVA_DELEGATION_ENCRYPTION_KEY: z.string().optional(),
  VIVA_DELEGATION_KEY_VERSION: z.string().min(1).default('v1'),
  PUBLIC_OFFER_VERSION: z.string().min(1).default('pending'),
  PERSONAL_DATA_POLICY_VERSION: z.string().min(1).default('pending'),
  OTEL_SERVICE_NAMESPACE: z.string().default('phub'),
  OTEL_SERVICE_INSTANCE_ID: z.string().min(1).max(255).optional().or(z.literal('')),
  REALTIME_EXPECTED_REPLICAS: z.coerce.number().int().min(1).max(100).default(1),
  LOCAL_RUNTIME_CONTOUR_ATTESTATION: booleanFromEnvironment,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export interface ConfigRequirements {
  readonly profilePhotoStorage?: boolean;
  readonly realtimeReplicaMonitoring?: boolean;
}

export interface RuntimeContourAttestation {
  readonly database?: string;
  readonly redis?: string;
  readonly rabbitmq?: string;
}

export function runtimeContourTargetFingerprint(value: string): string {
  const url = new URL(value);
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('Runtime contour attestation requires query-free dependency URLs');
  }
  url.username = '';
  url.password = '';
  return createHash('sha256').update(url.toString()).digest('hex');
}

function materializeFileSecret(
  environment: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
): string | undefined {
  const directValue = environment[valueName];
  if (directValue?.trim()) return directValue;
  const path = environment[fileName]?.trim();
  if (!path) return directValue;
  let value: string;
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`${fileName} could not be read`);
  }
  if (!value) throw new Error(`${fileName} points to an empty secret`);
  return value;
}

function normalizeWebPushAllowedOrigins(serialized: string): string {
  const normalized = new Set<string>();
  for (const candidate of serialized.split(',')) {
    const value = candidate.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS must contain valid HTTPS origins');
    }
    const hostname = url.hostname.toLowerCase();
    const addressCandidate =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (
      url.protocol !== 'https:' ||
      (url.port.length > 0 && url.port !== '443') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      isIP(addressCandidate) !== 0 ||
      hostname.includes('*') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      throw new Error(
        'WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS must contain public credential-free HTTPS origins on port 443 only',
      );
    }
    normalized.add(url.origin);
  }
  return [...normalized].join(',');
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  requirements: ConfigRequirements = {},
): AppConfig {
  const resolvedEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    WEB_PUSH_VAPID_PRIVATE_KEY: materializeFileSecret(
      environment,
      'WEB_PUSH_VAPID_PRIVATE_KEY',
      'WEB_PUSH_VAPID_PRIVATE_KEY_FILE',
    ),
    NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: materializeFileSecret(
      environment,
      'NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS',
      'NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS_FILE',
    ),
    CUP_RATING_SERVICE_TOKEN: materializeFileSecret(
      environment,
      'CUP_RATING_SERVICE_TOKEN',
      'CUP_RATING_SERVICE_TOKEN_FILE',
    ),
    CUP_PLAYER_LEVEL_PROJECTION_TOKEN: materializeFileSecret(
      environment,
      'CUP_PLAYER_LEVEL_PROJECTION_TOKEN',
      'CUP_PLAYER_LEVEL_PROJECTION_TOKEN_FILE',
    ),
    PARTICIPATION_COMMAND_TOKEN: materializeFileSecret(
      environment,
      'PARTICIPATION_COMMAND_TOKEN',
      'PARTICIPATION_COMMAND_TOKEN_FILE',
    ),
    LEGACY_GAME_COMMAND_BRIDGE_TOKEN: materializeFileSecret(
      environment,
      'LEGACY_GAME_COMMAND_BRIDGE_TOKEN',
      'LEGACY_GAME_COMMAND_BRIDGE_TOKEN_FILE',
    ),
    LEGACY_GAME_IDENTITY_VERIFY_TOKEN: materializeFileSecret(
      environment,
      'LEGACY_GAME_IDENTITY_VERIFY_TOKEN',
      'LEGACY_GAME_IDENTITY_VERIFY_TOKEN_FILE',
    ),
    SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN: materializeFileSecret(
      environment,
      'SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN',
      'SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN_FILE',
    ),
    SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS: materializeFileSecret(
      environment,
      'SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS',
      'SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS_FILE',
    ),
  };
  const parsed = environmentSchema.safeParse(resolvedEnvironment);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid application configuration: ${issues}`);
  }
  if (parsed.data.DATABASE_POOL_WARM_CONNECTIONS > parsed.data.DATABASE_POOL_MAX) {
    throw new Error('DATABASE_POOL_WARM_CONNECTIONS must not exceed DATABASE_POOL_MAX');
  }
  if (
    parsed.data.REALTIME_DATABASE_POOL_WARM_CONNECTIONS > parsed.data.REALTIME_DATABASE_POOL_MAX
  ) {
    throw new Error(
      'REALTIME_DATABASE_POOL_WARM_CONNECTIONS must not exceed REALTIME_DATABASE_POOL_MAX',
    );
  }

  if (
    requirements.realtimeReplicaMonitoring &&
    (parsed.data.APP_ENV === 'staging' || parsed.data.APP_ENV === 'production') &&
    !environment.REALTIME_EXPECTED_REPLICAS?.trim()
  ) {
    throw new Error('REALTIME_EXPECTED_REPLICAS must be explicit for deployed realtime');
  }
  if (parsed.data.LOCAL_RUNTIME_CONTOUR_ATTESTATION) {
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'ci') {
      throw new Error('LOCAL_RUNTIME_CONTOUR_ATTESTATION is allowed only in local or ci');
    }
    for (const target of [
      parsed.data.DATABASE_URL,
      parsed.data.REDIS_URL,
      parsed.data.RABBITMQ_URL,
    ]) {
      runtimeContourTargetFingerprint(target);
    }
  }

  const webPushAllowedEndpointOrigins = normalizeWebPushAllowedOrigins(
    parsed.data.WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS,
  );

  if (parsed.data.APP_ENV === 'production' && parsed.data.GAMES_READ_ENABLED) {
    throw new Error('GAMES_READ_ENABLED is staging-only until the Games production gate passes');
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.GAMES_COMMANDS_ENABLED) {
    throw new Error(
      'GAMES_COMMANDS_ENABLED is staging-only until the Games production gate passes',
    );
  }
  if (parsed.data.GAMES_COMMANDS_ENABLED && !parsed.data.GAMES_READ_ENABLED) {
    throw new Error('GAMES_COMMANDS_ENABLED requires GAMES_READ_ENABLED=true');
  }
  if (parsed.data.SUBSCRIPTION_RUNTIME_WARN_MODE === 'WARN') {
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'staging') {
      throw new Error('SUBSCRIPTION_RUNTIME_WARN_MODE=WARN is allowed only in local or staging');
    }
    if (
      !parsed.data.SUBSCRIPTION_RUNTIME_BASE_URL ||
      !parsed.data.SUBSCRIPTION_RUNTIME_INTEGRATION_TOKEN ||
      !parsed.data.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS ||
      !parsed.data.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID ||
      !parsed.data.SUBSCRIPTION_RUNTIME_DELEGATION_ISSUER ||
      !parsed.data.SUBSCRIPTION_RUNTIME_DELEGATION_AUDIENCE
    ) {
      throw new Error(
        'SUBSCRIPTION_RUNTIME_WARN_MODE=WARN requires complete boundary configuration',
      );
    }
    let privateKeys: Record<string, unknown>;
    try {
      const candidate: unknown = JSON.parse(
        parsed.data.SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS,
      );
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
        throw new Error();
      privateKeys = candidate as Record<string, unknown>;
    } catch {
      throw new Error('SUBSCRIPTION_RUNTIME_DELEGATION_PRIVATE_KEYS must be a JSON object');
    }
    const activePrivateKey = privateKeys[parsed.data.SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID];
    if (
      typeof activePrivateKey !== 'string' ||
      !activePrivateKey.startsWith(pkcs8PrivateKeyHeader)
    ) {
      throw new Error(
        'SUBSCRIPTION_RUNTIME_DELEGATION_ACTIVE_KEY_ID must select a PKCS8 private key',
      );
    }
  }
  if (parsed.data.LEGACY_GAME_COMMAND_BRIDGE_ENABLED) {
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'staging') {
      throw new Error('LEGACY_GAME_COMMAND_BRIDGE_ENABLED is allowed only in local or staging');
    }
    if (!parsed.data.GAMES_COMMANDS_ENABLED || !parsed.data.GAMES_READ_ENABLED) {
      throw new Error(
        'LEGACY_GAME_COMMAND_BRIDGE_ENABLED requires GAMES_COMMANDS_ENABLED and GAMES_READ_ENABLED',
      );
    }
    if (
      !parsed.data.LEGACY_GAME_COMMAND_BRIDGE_TOKEN ||
      !parsed.data.LEGACY_GAME_IDENTITY_VERIFY_URL ||
      !parsed.data.LEGACY_GAME_IDENTITY_VERIFY_TOKEN
    ) {
      throw new Error(
        'LEGACY_GAME_COMMAND_BRIDGE_ENABLED requires bridge and identity-verifier configuration',
      );
    }
  }
  if (
    parsed.data.GAMES_RESULTS_WRITE_MODE === 'local_primary' &&
    !parsed.data.GAMES_COMMANDS_ENABLED
  ) {
    throw new Error('GAMES_RESULTS_WRITE_MODE=local_primary requires GAMES_COMMANDS_ENABLED=true');
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.GAMES_RESULTS_WRITE_MODE !== 'disabled') {
    throw new Error('Games results cutover is staging-only until the production gate passes');
  }
  if (
    parsed.data.CUP_RATING_CONSUMER_ENABLED &&
    (!parsed.data.CUP_RATING_API_URL || !parsed.data.CUP_RATING_SERVICE_TOKEN)
  ) {
    throw new Error(
      'CUP_RATING_CONSUMER_ENABLED requires CUP_RATING_API_URL and CUP_RATING_SERVICE_TOKEN',
    );
  }
  if (
    parsed.data.CUP_PLAYER_LEVEL_PROJECTION_ENABLED &&
    (!parsed.data.CUP_PLAYER_LEVEL_PROJECTION_TOKEN ||
      !parsed.data.CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY)
  ) {
    throw new Error(
      'CUP_PLAYER_LEVEL_PROJECTION_ENABLED requires CUP_PLAYER_LEVEL_PROJECTION_TOKEN and CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY',
    );
  }
  if (parsed.data.PARTICIPATION_COMMANDS_ENABLED) {
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'staging') {
      throw new Error('PARTICIPATION_COMMANDS_ENABLED is allowed only in local or staging');
    }
    if (
      !parsed.data.PARTICIPATION_COMMAND_TOKEN ||
      !parsed.data.PARTICIPATION_COMMAND_TENANT_KEY ||
      !parsed.data.PARTICIPATION_COMMAND_PRINCIPAL_KEY
    ) {
      throw new Error(
        'PARTICIPATION_COMMANDS_ENABLED requires token, tenant key, and principal key',
      );
    }
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.ACTIVITY_HISTORY_ENABLED) {
    throw new Error(
      'ACTIVITY_HISTORY_ENABLED is staging-only until the activity history production gate passes',
    );
  }
  if (parsed.data.ACTIVITY_HISTORY_SYNC_ENABLED && !parsed.data.ACTIVITY_HISTORY_ENABLED) {
    throw new Error('ACTIVITY_HISTORY_SYNC_ENABLED requires ACTIVITY_HISTORY_ENABLED=true');
  }
  if (
    parsed.data.ACTIVITY_HISTORY_SYNC_ENABLED &&
    (!parsed.data.VIVA_OAUTH_ENABLED ||
      parsed.data.VIVA_MODE === 'mock' ||
      parsed.data.VIVA_MODE === 'disabled')
  ) {
    throw new Error(
      'ACTIVITY_HISTORY_SYNC_ENABLED requires Viva OAuth and VIVA_MODE=sandbox or production',
    );
  }
  if (parsed.data.ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED) {
    if (!parsed.data.ACTIVITY_HISTORY_SYNC_ENABLED) {
      throw new Error(
        'ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED requires ACTIVITY_HISTORY_SYNC_ENABLED=true',
      );
    }
    if (!parsed.data.GAMES_READ_ENABLED) {
      throw new Error('ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED requires GAMES_READ_ENABLED=true');
    }
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'staging') {
      throw new Error('ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED is allowed only in local or staging');
    }
    if (
      parsed.data.APP_ENV === 'local' &&
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'public'
    ) {
      throw new Error('Local activity history game backfill requires the public CUP source');
    }
    if (
      parsed.data.APP_ENV === 'staging' &&
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'mongo'
    ) {
      throw new Error('Staging activity history game backfill requires the CUP Mongo mirror');
    }
    if (
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'mongo' &&
      !parsed.data.LEGACY_GAMES_MONGODB_URI
    ) {
      throw new Error('ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED requires LEGACY_GAMES_MONGODB_URI');
    }
    if (!parsed.data.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY) {
      throw new Error(
        'ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED requires LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY',
      );
    }
  }
  if (parsed.data.LEGACY_GAMES_ROSTER_SYNC_ENABLED) {
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'staging') {
      throw new Error('LEGACY_GAMES_ROSTER_SYNC_ENABLED is allowed only in local or staging');
    }
    if (!parsed.data.GAMES_READ_ENABLED) {
      throw new Error('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires GAMES_READ_ENABLED=true');
    }
    if (
      parsed.data.APP_ENV === 'local' &&
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'public'
    ) {
      throw new Error('Local legacy roster sync requires the public anonymized source');
    }
    if (
      parsed.data.APP_ENV === 'staging' &&
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'public' &&
      parsed.data.GAMES_COMMANDS_ENABLED
    ) {
      throw new Error('Staging public legacy roster sync requires GAMES_COMMANDS_ENABLED=false');
    }
    if (
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'mongo' &&
      !parsed.data.LEGACY_GAMES_MONGODB_URI
    ) {
      throw new Error('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires LEGACY_GAMES_MONGODB_URI');
    }
    if (!parsed.data.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY) {
      throw new Error(
        'LEGACY_GAMES_ROSTER_SYNC_ENABLED requires LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY',
      );
    }
  }
  if (parsed.data.HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED) {
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'staging') {
      throw new Error('HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED is allowed only in local or staging');
    }
    if (!parsed.data.HOME_VIVA_SYNC_ENABLED) {
      throw new Error('HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED requires HOME_VIVA_SYNC_ENABLED=true');
    }
    if (!parsed.data.GAMES_READ_ENABLED) {
      throw new Error('HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED requires GAMES_READ_ENABLED=true');
    }
    if (
      parsed.data.APP_ENV === 'local' &&
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE !== 'public'
    ) {
      throw new Error('Local Viva Home Game bridge requires the public anonymized source');
    }
    if (
      parsed.data.APP_ENV === 'staging' &&
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'public' &&
      parsed.data.GAMES_COMMANDS_ENABLED
    ) {
      throw new Error('Staging public Viva Home Game bridge requires GAMES_COMMANDS_ENABLED=false');
    }
    if (
      parsed.data.LEGACY_GAMES_ROSTER_SYNC_SOURCE === 'mongo' &&
      !parsed.data.LEGACY_GAMES_MONGODB_URI
    ) {
      throw new Error('HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED requires LEGACY_GAMES_MONGODB_URI');
    }
    if (!parsed.data.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY) {
      throw new Error(
        'HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED requires LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY',
      );
    }
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.OUTBOX_PUBLISH_MODE === 'leased') {
    throw new Error(
      'OUTBOX_PUBLISH_MODE=leased is staging-only until the outbox lease production gate passes',
    );
  }
  if (
    parsed.data.OUTBOX_PUBLISH_MODE === 'leased' &&
    parsed.data.OUTBOX_CLAIM_TTL_MS - parsed.data.OUTBOX_CONFIRM_TIMEOUT_MS < 5_000
  ) {
    throw new Error('OUTBOX_CLAIM_TTL_MS must exceed OUTBOX_CONFIRM_TIMEOUT_MS by at least 5000ms');
  }
  if (
    parsed.data.BOOKING_REMINDER_SCHEDULER_ENABLED &&
    (parsed.data.APP_ENV === 'staging' || parsed.data.APP_ENV === 'production') &&
    (!environment.BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS?.trim() ||
      !environment.BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS?.trim())
  ) {
    throw new Error(
      'Deployed booking reminder scheduler requires explicit max lateness for HOURS_24 and HOURS_2',
    );
  }
  if (
    parsed.data.BOOKING_REMINDER_CLAIM_TTL_MS - parsed.data.BOOKING_REMINDER_DATABASE_TIMEOUT_MS <
    5_000
  ) {
    throw new Error(
      'BOOKING_REMINDER_CLAIM_TTL_MS must exceed BOOKING_REMINDER_DATABASE_TIMEOUT_MS by at least 5000ms',
    );
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.VIVA_MODE === 'mock') {
    throw new Error('VIVA_MODE=mock is forbidden in production');
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.AUTH_COOKIE_SECURE) {
    throw new Error('AUTH_COOKIE_SECURE=true is required in production');
  }
  if (parsed.data.APP_ENV === 'production' && !parsed.data.TRUSTED_PROXY_CIDRS.trim()) {
    throw new Error('TRUSTED_PROXY_CIDRS is required in production');
  }
  if (parsed.data.CUP_DEV_AUTH_ENABLED) {
    if (parsed.data.APP_ENV !== 'local') {
      throw new Error('CUP_DEV_AUTH_ENABLED is allowed only in APP_ENV=local');
    }
    if (!parsed.data.CUP_DEV_AUTH_PHONE_E164 || !parsed.data.CUP_DEV_AUTH_OTP_CODE) {
      throw new Error('CUP dev auth requires an explicit phone and OTP code');
    }
  }
  if (parsed.data.VIVA_OAUTH_ENABLED) {
    if (!parsed.data.VIVA_OAUTH_REDIRECT_URI || !parsed.data.VIVA_OAUTH_SUCCESS_REDIRECT_URL) {
      throw new Error('Viva OAuth redirect URLs are required when VIVA_OAUTH_ENABLED=true');
    }
    if (!parsed.data.VIVA_DELEGATION_ENCRYPTION_KEY) {
      throw new Error('Viva delegation encryption key is required when VIVA_OAUTH_ENABLED=true');
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(parsed.data.VIVA_DELEGATION_ENCRYPTION_KEY)) {
      throw new Error('Viva delegation encryption key must be 32-byte base64url');
    }
  }
  if (parsed.data.HOME_VIVA_SYNC_ENABLED) {
    throw new Error(
      'HOME_VIVA_SYNC_ENABLED is retired because Viva End User reads require client-assisted browser transport',
    );
  }
  if (parsed.data.COMMUNITY_HOME_SYNC_ENABLED) {
    if (parsed.data.COMMUNITIES_READ_MODE === 'mock') {
      throw new Error('COMMUNITY_HOME_SYNC_ENABLED requires COMMUNITIES_READ_MODE=legacy or local');
    }
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `COMMUNITY_HOME_SYNC_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (parsed.data.PROFILE_PHOTO_CLIENT_SYNC_ENABLED) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `PROFILE_PHOTO_CLIENT_SYNC_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (parsed.data.PROFILE_PHOTO_MAINTENANCE_ENABLED && requirements.profilePhotoStorage) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `PROFILE_PHOTO_MAINTENANCE_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (
    parsed.data.COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED &&
    requirements.profilePhotoStorage
  ) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (parsed.data.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (
    parsed.data.COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED &&
    parsed.data.COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED
  ) {
    throw new Error(
      'COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED requires stable delivery disabled',
    );
  }
  if (parsed.data.PROMOTIONS_READ_MODE === 'legacy' && requirements.profilePhotoStorage) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `PROMOTIONS_READ_MODE=legacy requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (
    parsed.data.GIFT_CERTIFICATE_PAYMENT_MODE === 'sandbox' &&
    parsed.data.APP_ENV !== 'local' &&
    parsed.data.APP_ENV !== 'ci'
  ) {
    throw new Error('GIFT_CERTIFICATE_PAYMENT_MODE=sandbox is allowed only in local or ci');
  }
  if (parsed.data.GIFT_CERTIFICATE_MEDIA_ENABLED) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `GIFT_CERTIFICATE_MEDIA_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (parsed.data.LOCATION_MEDIA_ENABLED) {
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `LOCATION_MEDIA_ENABLED requires media storage: ${missingStorage.join(', ')}`,
      );
    }
  }
  if (
    parsed.data.GIFT_CERTIFICATE_DELIVERY_MODE === 'sandbox' &&
    parsed.data.APP_ENV !== 'local' &&
    parsed.data.APP_ENV !== 'ci'
  ) {
    throw new Error('GIFT_CERTIFICATE_DELIVERY_MODE=sandbox is allowed only in local or ci');
  }
  if (parsed.data.GIFT_CERTIFICATE_ISSUANCE_ENABLED) {
    const missingIssuance = [
      [
        'GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET',
        parsed.data.GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET,
      ],
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingIssuance.length > 0) {
      throw new Error(
        `GIFT_CERTIFICATE_ISSUANCE_ENABLED requires private artifacts: ${missingIssuance.join(', ')}`,
      );
    }
  }
  if (
    parsed.data.GIFT_CERTIFICATE_DELIVERY_MODE !== 'disabled' &&
    !parsed.data.GIFT_CERTIFICATE_ISSUANCE_ENABLED
  ) {
    throw new Error('GIFT_CERTIFICATE_DELIVERY_MODE requires GIFT_CERTIFICATE_ISSUANCE_ENABLED');
  }
  if (
    parsed.data.VIVA_DIRECT_READ_ENABLED &&
    (parsed.data.VIVA_MODE === 'mock' || parsed.data.VIVA_MODE === 'disabled')
  ) {
    throw new Error('VIVA_DIRECT_READ_ENABLED requires VIVA_MODE=sandbox or production');
  }
  if (parsed.data.VIVA_DIRECT_READ_ENABLED && !parsed.data.VIVA_OAUTH_ENABLED) {
    throw new Error('VIVA_DIRECT_READ_ENABLED requires VIVA_OAUTH_ENABLED=true');
  }
  if (
    parsed.data.VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED &&
    (parsed.data.VIVA_MODE === 'mock' || parsed.data.VIVA_MODE === 'disabled')
  ) {
    throw new Error(
      'VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED requires VIVA_MODE=sandbox or production',
    );
  }
  if (
    parsed.data.VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED &&
    !parsed.data.VIVA_OAUTH_ENABLED
  ) {
    throw new Error(
      'VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED requires VIVA_OAUTH_ENABLED=true',
    );
  }
  if (
    parsed.data.VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED &&
    (parsed.data.VIVA_MODE === 'mock' || parsed.data.VIVA_MODE === 'disabled')
  ) {
    throw new Error(
      'VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED requires VIVA_MODE=sandbox or production',
    );
  }
  if (parsed.data.VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED && !parsed.data.VIVA_OAUTH_ENABLED) {
    throw new Error('VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED requires VIVA_OAUTH_ENABLED=true');
  }
  if (
    parsed.data.VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED &&
    parsed.data.VIVA_OAUTH_ALLOWED_PROVIDERS !== 'yandex'
  ) {
    throw new Error(
      'VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED requires VIVA_OAUTH_ALLOWED_PROVIDERS=yandex',
    );
  }
  if (
    parsed.data.VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED &&
    parsed.data.VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED
  ) {
    throw new Error(
      'VIVA OAuth subject provisioning and existing-subject bootstrap are mutually exclusive',
    );
  }
  if (
    parsed.data.VIVA_OAUTH_SUBJECT_PROVISIONING_ENABLED &&
    (parsed.data.PUBLIC_OFFER_VERSION === 'pending' ||
      parsed.data.PERSONAL_DATA_POLICY_VERSION === 'pending')
  ) {
    throw new Error(
      'Published legal document versions are required for OAuth subject provisioning',
    );
  }
  if (parsed.data.WEB_PUSH_ENABLED) {
    const missingWebPush = [
      ['WEB_PUSH_VAPID_SUBJECT', parsed.data.WEB_PUSH_VAPID_SUBJECT],
      ['WEB_PUSH_VAPID_PUBLIC_KEY', parsed.data.WEB_PUSH_VAPID_PUBLIC_KEY],
      ['WEB_PUSH_VAPID_PRIVATE_KEY', parsed.data.WEB_PUSH_VAPID_PRIVATE_KEY],
      ['NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS', parsed.data.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingWebPush.length > 0) {
      throw new Error(`WEB_PUSH_ENABLED requires runtime secrets: ${missingWebPush.join(', ')}`);
    }
    if (!webPushAllowedEndpointOrigins) {
      throw new Error('WEB_PUSH_ENABLED requires WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS');
    }
    if (
      !parsed.data.WEB_PUSH_VAPID_SUBJECT?.startsWith('mailto:') &&
      !parsed.data.WEB_PUSH_VAPID_SUBJECT?.startsWith('https://')
    ) {
      throw new Error('WEB_PUSH_VAPID_SUBJECT must use mailto: or https:');
    }
    let endpointKeys: unknown;
    try {
      endpointKeys = JSON.parse(parsed.data.NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS as string);
    } catch {
      throw new Error('NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS must be a JSON object');
    }
    if (!endpointKeys || typeof endpointKeys !== 'object' || Array.isArray(endpointKeys)) {
      throw new Error('NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS must be a JSON object');
    }
    const activeKey = (endpointKeys as Record<string, unknown>)[
      parsed.data.NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID
    ];
    if (
      typeof activeKey !== 'string' ||
      Buffer.from(activeKey, 'base64').length !== 32 ||
      Buffer.from(activeKey, 'base64').toString('base64').replace(/=+$/, '') !==
        activeKey.replace(/=+$/, '')
    ) {
      throw new Error('Active notification endpoint encryption key must be 32-byte base64');
    }
  }
  if (
    parsed.data.APP_ENV === 'production' &&
    (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET ||
      /replace|change|local|test|example|ci-/i.test(parsed.data.JWT_ACCESS_SECRET) ||
      /replace|change|local|test|example|ci-/i.test(parsed.data.JWT_REFRESH_SECRET))
  ) {
    throw new Error('Production JWT secrets must be distinct non-placeholder values');
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.HOME_READ_MODE !== 'projection') {
    throw new Error('HOME_READ_MODE=projection is required in production');
  }
  if (
    parsed.data.APP_ENV === 'production' &&
    (parsed.data.PUBLIC_OFFER_VERSION === 'pending' ||
      parsed.data.PERSONAL_DATA_POLICY_VERSION === 'pending')
  ) {
    throw new Error('Published legal document versions are required in production');
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.COMMUNITIES_READ_MODE === 'mock') {
    throw new Error('COMMUNITIES_READ_MODE=mock is forbidden in production');
  }
  if (
    (parsed.data.COMMUNITY_LEGACY_READ_DETAIL_ENABLED ||
      parsed.data.COMMUNITY_LEGACY_READ_FEED_ENABLED ||
      parsed.data.COMMUNITY_LEGACY_READ_CHAT_ENABLED ||
      parsed.data.COMMUNITY_LEGACY_READ_RATING_ENABLED) &&
    parsed.data.COMMUNITIES_READ_MODE !== 'legacy'
  ) {
    throw new Error('COMMUNITY_LEGACY_READ_*_ENABLED requires COMMUNITIES_READ_MODE=legacy');
  }
  if (parsed.data.COMMUNITIES_REALTIME_ENABLED) {
    if (parsed.data.COMMUNITIES_READ_MODE !== 'local') {
      throw new Error('COMMUNITIES_REALTIME_ENABLED requires COMMUNITIES_READ_MODE=local');
    }
    if (!parsed.data.JWT_REALTIME_SECRET) {
      throw new Error('COMMUNITIES_REALTIME_ENABLED requires JWT_REALTIME_SECRET');
    }
    if (
      parsed.data.JWT_REALTIME_SECRET === parsed.data.JWT_ACCESS_SECRET ||
      parsed.data.JWT_REALTIME_SECRET === parsed.data.JWT_REFRESH_SECRET
    ) {
      throw new Error('JWT_REALTIME_SECRET must be distinct from API and refresh secrets');
    }
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.COMMUNITIES_REALTIME_ENABLED) {
    throw new Error(
      'COMMUNITIES_REALTIME_ENABLED is staging-only until durable event recovery and fan-out pass the production gate',
    );
  }
  if (parsed.data.COMMUNITY_MEDIA_ENABLED) {
    if (parsed.data.COMMUNITIES_READ_MODE !== 'local') {
      throw new Error('COMMUNITY_MEDIA_ENABLED requires COMMUNITIES_READ_MODE=local');
    }
    const missingStorage = [
      ['S3_ENDPOINT', parsed.data.S3_ENDPOINT],
      ['S3_PUBLIC_ENDPOINT', parsed.data.S3_PUBLIC_ENDPOINT],
      ['S3_BUCKET', parsed.data.S3_BUCKET],
      ['S3_ACCESS_KEY', parsed.data.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', parsed.data.S3_SECRET_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingStorage.length > 0) {
      throw new Error(
        `COMMUNITY_MEDIA_ENABLED requires versioned media storage: ${missingStorage.join(', ')}`,
      );
    }
    if (parsed.data.APP_ENV !== 'local' && parsed.data.APP_ENV !== 'ci') {
      let publicEndpoint: URL;
      try {
        publicEndpoint = new URL(parsed.data.S3_PUBLIC_ENDPOINT as string);
      } catch {
        throw new Error('COMMUNITY_MEDIA_ENABLED requires a valid S3_PUBLIC_ENDPOINT URL');
      }
      if (
        publicEndpoint.protocol !== 'https:' ||
        publicEndpoint.username ||
        publicEndpoint.password ||
        publicEndpoint.pathname !== '/' ||
        publicEndpoint.search ||
        publicEndpoint.hash
      ) {
        throw new Error(
          'COMMUNITY_MEDIA_ENABLED requires an HTTPS S3_PUBLIC_ENDPOINT origin outside local/ci',
        );
      }
    }
    if (
      parsed.data.APP_ENV !== 'local' &&
      parsed.data.APP_ENV !== 'ci' &&
      parsed.data.COMMUNITY_MEDIA_SCAN_MODE !== 'clamav'
    ) {
      throw new Error(
        'COMMUNITY_MEDIA_ENABLED requires COMMUNITY_MEDIA_SCAN_MODE=clamav outside local/ci',
      );
    }
    if (
      parsed.data.COMMUNITY_MEDIA_SCAN_MODE === 'clamav' &&
      !parsed.data.COMMUNITY_MEDIA_CLAMAV_HOST
    ) {
      throw new Error('COMMUNITY_MEDIA_SCAN_MODE=clamav requires COMMUNITY_MEDIA_CLAMAV_HOST');
    }
  }
  if (parsed.data.COMMUNITY_INVITES_ENABLED) {
    if (parsed.data.COMMUNITIES_READ_MODE !== 'local') {
      throw new Error('COMMUNITY_INVITES_ENABLED requires COMMUNITIES_READ_MODE=local');
    }
    if (!parsed.data.COMMUNITY_INVITE_TOKEN_KEYS || !parsed.data.COMMUNITY_INVITE_ACTIVE_KEY_ID) {
      throw new Error(
        'COMMUNITY_INVITES_ENABLED requires COMMUNITY_INVITE_TOKEN_KEYS and COMMUNITY_INVITE_ACTIVE_KEY_ID',
      );
    }
    let inviteTokenKeys: unknown;
    try {
      inviteTokenKeys = JSON.parse(parsed.data.COMMUNITY_INVITE_TOKEN_KEYS);
    } catch {
      throw new Error('COMMUNITY_INVITE_TOKEN_KEYS must be a JSON object');
    }
    if (
      !inviteTokenKeys ||
      typeof inviteTokenKeys !== 'object' ||
      Array.isArray(inviteTokenKeys) ||
      Object.keys(inviteTokenKeys).length === 0
    ) {
      throw new Error('COMMUNITY_INVITE_TOKEN_KEYS must be a non-empty JSON object');
    }
    for (const value of Object.values(inviteTokenKeys as Record<string, unknown>)) {
      if (
        typeof value !== 'string' ||
        Buffer.from(value, 'base64').length !== 32 ||
        Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') !==
          value.replace(/=+$/, '')
      ) {
        throw new Error('Community invite token keys must be 32-byte base64 values');
      }
    }
    if (!(parsed.data.COMMUNITY_INVITE_ACTIVE_KEY_ID in inviteTokenKeys)) {
      throw new Error('COMMUNITY_INVITE_ACTIVE_KEY_ID must select a configured token key');
    }
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.PROMOTIONS_READ_MODE === 'mock') {
    throw new Error('PROMOTIONS_READ_MODE=mock is forbidden in production');
  }
  if (
    parsed.data.APP_ENV === 'production' &&
    new URL(parsed.data.PROMOTIONS_LEGACY_BASE_URL).protocol !== 'https:'
  ) {
    throw new Error('PROMOTIONS_LEGACY_BASE_URL must use https in production');
  }
  if (
    parsed.data.APP_ENV === 'production' &&
    parsed.data.PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS.trim()
  ) {
    throw new Error('PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS is forbidden in production');
  }

  return {
    ...parsed.data,
    WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: webPushAllowedEndpointOrigins,
  };
}

const REALTIME_ACCESS_SECRET_SENTINEL = 'x'.repeat(32);
const REALTIME_REFRESH_SECRET_SENTINEL = 'y'.repeat(32);

/**
 * Realtime validates tickets with its dedicated key and must not receive API or refresh signing
 * secrets when the Communities gate is enabled outside local/CI. Sentinels satisfy the shared
 * config shape but are never accepted by an API process and are not read by the gateway.
 */
export function loadRealtimeConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!environment.JWT_REALTIME_SECRET) {
    throw new Error('Realtime runtime requires JWT_REALTIME_SECRET');
  }
  if (
    environment.APP_ENV !== 'local' &&
    environment.APP_ENV !== 'ci' &&
    (environment.JWT_ACCESS_SECRET || environment.JWT_REFRESH_SECRET)
  ) {
    throw new Error('Realtime runtime must not receive JWT_ACCESS_SECRET or JWT_REFRESH_SECRET');
  }
  return loadConfig(
    {
      ...environment,
      JWT_ACCESS_SECRET: REALTIME_ACCESS_SECRET_SENTINEL,
      JWT_REFRESH_SECRET: REALTIME_REFRESH_SECRET_SENTINEL,
    },
    { realtimeReplicaMonitoring: true },
  );
}
