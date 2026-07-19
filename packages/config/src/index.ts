import { readFileSync } from 'node:fs';

import { z } from 'zod';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const booleanFromEnvironmentDefaultTrue = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  REALTIME_HOST: z.string().default('0.0.0.0'),
  REALTIME_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(60_000).default(1000),
  OUTBOX_PUBLISH_MODE: z.enum(['transactional', 'leased']).default('transactional'),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_CLAIM_TTL_MS: z.coerce.number().int().min(10_000).max(300_000).default(60_000),
  OUTBOX_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  OUTBOX_FAILURE_BACKOFF_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  DATABASE_URL: z.string().url(),
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
  PROFILE_PHOTO_ALLOWED_HOSTS: z.string().min(1).default('.selcdn.ru'),
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
  // The old LK can supply roster changes only during the staged migration mirror. This source
  // URI is process-only and is never exposed through API configuration or client bundles.
  LEGACY_GAMES_ROSTER_SYNC_ENABLED: booleanFromEnvironment,
  LEGACY_GAMES_MONGODB_URI: z.string().min(1).optional(),
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
  HOME_PROJECTION_MAX_STALE_SECONDS: z.coerce.number().int().nonnegative().max(86_400).default(300),
  HOME_PROJECTION_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  HOME_VIVA_SYNC_ENABLED: booleanFromEnvironment,
  HOME_VIVA_SYNC_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  HOME_VIVA_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  HOME_VIVA_SYNC_FAILURE_BACKOFF_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(86_400_000)
    .default(300_000),
  COMMUNITIES_READ_MODE: z.enum(['mock', 'legacy', 'local']).default('mock'),
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
  PROMOTIONS_LEGACY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  PROMOTIONS_LEGACY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(2).default(2),
  PROMOTIONS_LEGACY_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(20).default(3),
  PROMOTIONS_LEGACY_CIRCUIT_RESET_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  PROMOTIONS_SYNC_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(120_000),
  PROMOTIONS_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  PROMOTION_ROTATION_INTERVAL_SECONDS: z.coerce.number().int().min(3).max(30).default(6),
  PROMOTION_IMAGE_ALLOWED_HOSTS: z.string().min(1).default('padlhub.su'),
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
  WEB_PUSH_VAPID_SUBJECT: z.string().optional(),
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  WEB_PUSH_TTL_SECONDS: z.coerce.number().int().min(0).max(2_419_200).default(300),
  WEB_PUSH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  WEB_PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  WEB_PUSH_RETRY_BASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(5_000),
  WEB_PUSH_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  WEB_PUSH_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
  WEB_PUSH_CIRCUIT_RESET_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: z.string().optional(),
  NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: z.string().min(1).max(64).default('v1'),
  VIVA_API_URL: z.string().url().optional().or(z.literal('')),
  VIVA_API_KEY: z.string().optional(),
  VIVA_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
  VIVA_DIRECT_READ_ENABLED: booleanFromEnvironment,
  VIVA_AUTH_BASE_URL: z.string().url().default('https://kc.vivacrm.ru'),
  VIVA_AUTH_PROFILE_API_URL: z.string().url().default('https://api.vivacrm.ru/end-user/api/v1'),
  VIVA_END_USER_API_URL: z.string().url().default('https://api.vivacrm.ru/end-user/api'),
  VIVA_AUTH_REALM: z.string().min(1).default('clients'),
  VIVA_AUTH_CLIENT_ID: z.string().min(1).default('widget'),
  VIVA_AUTH_TENANT_KEY: z.string().min(1).default('iSkq6G'),
  VIVA_AUTH_CHANNEL: z.string().min(1).default('cascade'),
  VIVA_OAUTH_ENABLED: booleanFromEnvironment,
  VIVA_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal('')),
  VIVA_OAUTH_SUCCESS_REDIRECT_URL: z.string().url().optional().or(z.literal('')),
  VIVA_OAUTH_SCOPES: z.string().min(1).default('openid'),
  VIVA_DELEGATION_ENCRYPTION_KEY: z.string().optional(),
  VIVA_DELEGATION_KEY_VERSION: z.string().min(1).default('v1'),
  PUBLIC_OFFER_VERSION: z.string().min(1).default('pending'),
  PERSONAL_DATA_POLICY_VERSION: z.string().min(1).default('pending'),
  OTEL_SERVICE_NAMESPACE: z.string().default('phub'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal('')),
  SENTRY_DSN: z.string().url().optional().or(z.literal('')),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export interface ConfigRequirements {
  readonly profilePhotoStorage?: boolean;
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
  };
  const parsed = environmentSchema.safeParse(resolvedEnvironment);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid application configuration: ${issues}`);
  }

  if (parsed.data.APP_ENV === 'production' && parsed.data.GAMES_READ_ENABLED) {
    throw new Error('GAMES_READ_ENABLED is staging-only until the Games production gate passes');
  }
  if (parsed.data.APP_ENV === 'production' && parsed.data.GAMES_COMMANDS_ENABLED) {
    throw new Error(
      'GAMES_COMMANDS_ENABLED is staging-only until the Games production gate passes',
    );
  }
  if (parsed.data.LEGACY_GAMES_ROSTER_SYNC_ENABLED) {
    if (parsed.data.APP_ENV !== 'staging') {
      throw new Error(
        'LEGACY_GAMES_ROSTER_SYNC_ENABLED is staging-only until the Games production gate passes',
      );
    }
    if (!parsed.data.GAMES_READ_ENABLED) {
      throw new Error('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires GAMES_READ_ENABLED=true');
    }
    if (!parsed.data.LEGACY_GAMES_MONGODB_URI) {
      throw new Error('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires LEGACY_GAMES_MONGODB_URI');
    }
    if (!parsed.data.LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY) {
      throw new Error(
        'LEGACY_GAMES_ROSTER_SYNC_ENABLED requires LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY',
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
  if (
    parsed.data.HOME_VIVA_SYNC_ENABLED &&
    (parsed.data.VIVA_MODE === 'mock' || parsed.data.VIVA_MODE === 'disabled')
  ) {
    throw new Error('HOME_VIVA_SYNC_ENABLED requires VIVA_MODE=sandbox or production');
  }
  if (parsed.data.HOME_VIVA_SYNC_ENABLED && !parsed.data.VIVA_OAUTH_ENABLED) {
    throw new Error('HOME_VIVA_SYNC_ENABLED requires VIVA_OAUTH_ENABLED=true');
  }
  if (parsed.data.HOME_VIVA_SYNC_ENABLED && requirements.profilePhotoStorage) {
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
        `HOME_VIVA_SYNC_ENABLED requires profile photo storage: ${missingStorage.join(', ')}`,
      );
    }
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
  if (parsed.data.APP_ENV === 'production' && parsed.data.PROMOTIONS_READ_MODE === 'mock') {
    throw new Error('PROMOTIONS_READ_MODE=mock is forbidden in production');
  }
  if (
    parsed.data.APP_ENV === 'production' &&
    new URL(parsed.data.PROMOTIONS_LEGACY_BASE_URL).protocol !== 'https:'
  ) {
    throw new Error('PROMOTIONS_LEGACY_BASE_URL must use https in production');
  }

  return parsed.data;
}
