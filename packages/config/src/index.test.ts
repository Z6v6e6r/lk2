import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig, loadRealtimeConfig, runtimeContourTargetFingerprint } from './index.js';

const validEnvironment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

describe('loadConfig', () => {
  it('parses safe defaults', () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      APP_ENV: 'ci',
      OUTBOX_PUBLISH_MODE: 'transactional',
      OUTBOX_BATCH_SIZE: 50,
      OUTBOX_CLAIM_TTL_MS: 60_000,
      OUTBOX_CONFIRM_TIMEOUT_MS: 10_000,
      OUTBOX_FAILURE_BACKOFF_MS: 5_000,
      DATABASE_POOL_MAX: 20,
      DATABASE_POOL_WARM_CONNECTIONS: 1,
      REALTIME_MAX_CONNECTIONS: 10_000,
      REALTIME_DATABASE_POOL_MAX: 10,
      REALTIME_DATABASE_POOL_WARM_CONNECTIONS: 2,
      REALTIME_MAX_SUBSCRIPTIONS_PER_CONNECTION: 100,
      REALTIME_MAX_SOCKET_BUFFER_BYTES: 512 * 1_024,
      REALTIME_HEARTBEAT_INTERVAL_MS: 30_000,
      BOOKING_REMINDER_SCHEDULER_ENABLED: false,
      BOOKING_REMINDER_POLL_INTERVAL_MS: 1_000,
      BOOKING_REMINDER_BATCH_SIZE: 20,
      BOOKING_REMINDER_CLAIM_TTL_MS: 60_000,
      BOOKING_REMINDER_DATABASE_TIMEOUT_MS: 5_000,
      BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS: 21_600_000,
      BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS: 1_800_000,
      LOCAL_RUNTIME_CONTOUR_ATTESTATION: false,
      VIVA_MODE: 'mock',
      HOME_READ_MODE: 'mock',
      GAMES_READ_ENABLED: false,
      GAMES_COMMANDS_ENABLED: false,
      GAMES_RESULTS_WRITE_MODE: 'disabled',
      CUP_RATING_CONSUMER_ENABLED: false,
      CUP_PLAYER_LEVEL_PROJECTION_ENABLED: false,
      PARTICIPATION_COMMANDS_ENABLED: false,
      PARTICIPATION_COMMAND_AUTHORIZATION_TTL_SECONDS: 300,
      PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED: false,
      PARTICIPATION_COMMAND_EXPIRY_INTERVAL_MS: 60_000,
      PARTICIPATION_COMMAND_EXPIRY_BATCH_SIZE: 100,
      ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: false,
      LEGACY_GAMES_ROSTER_SYNC_ENABLED: false,
      LEGACY_GAME_COMMAND_BRIDGE_ENABLED: false,
      LEGACY_GAME_IDENTITY_VERIFY_TIMEOUT_MS: 5_000,
      LEGACY_GAMES_ROSTER_SYNC_INTERVAL_MS: 120_000,
      LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS: 1,
      LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS: 42,
      LEGACY_GAMES_ROSTER_SYNC_LIMIT: 200,
      LEGACY_GAMES_PROFILE_PHOTO_SYNC_LOOKBACK_DAYS: 30,
      HOME_PROJECTION_TTL_SECONDS: 300,
      HOME_BASE_SYNC_ENABLED: false,
      HOME_BASE_SYNC_INTERVAL_MS: 120_000,
      HOME_BASE_SYNC_BATCH_SIZE: 20,
      HOME_VIVA_SYNC_ENABLED: false,
      HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED: false,
      HOME_VIVA_SYNC_INTERVAL_MS: 120_000,
      HOME_VIVA_SYNC_FAILURE_BACKOFF_MS: 300_000,
      COMMUNITY_HOME_SYNC_ENABLED: false,
      COMMUNITY_HOME_SYNC_INTERVAL_MS: 120_000,
      COMMUNITY_HOME_SYNC_BATCH_SIZE: 20,
      PLATFORM_HOME_SYNC_ENABLED: false,
      PLATFORM_HOME_SYNC_INTERVAL_MS: 120_000,
      PLATFORM_HOME_SYNC_BATCH_SIZE: 20,
      COMMUNITIES_READ_MODE: 'mock',
      COMMUNITY_LEGACY_READ_DETAIL_ENABLED: false,
      COMMUNITY_LEGACY_READ_FEED_ENABLED: false,
      COMMUNITY_LEGACY_READ_CHAT_ENABLED: false,
      COMMUNITY_LEGACY_READ_RATING_ENABLED: false,
      COMMUNITY_INVITES_ENABLED: false,
      COMMUNITIES_REALTIME_ENABLED: false,
      COMMUNITY_MEDIA_ENABLED: false,
      COMMUNITY_MEDIA_SCAN_MODE: 'mock',
      COMMUNITY_MEDIA_CLAMAV_PORT: 3310,
      COMMUNITY_MEDIA_CLAMAV_TIMEOUT_MS: 30_000,
      COMMUNITY_MEDIA_POLL_INTERVAL_MS: 2_000,
      COMMUNITY_MEDIA_BATCH_SIZE: 10,
      COMMUNITY_MEDIA_SCAN_MAX_ATTEMPTS: 8,
      COMMUNITY_MEDIA_GC_MAX_ATTEMPTS: 8,
      COMMUNITY_MEDIA_READ_URL_TTL_SECONDS: 300,
      COMMUNITIES_LEGACY_TIMEOUT_MS: 10_000,
      COMMUNITIES_LEGACY_MAX_ATTEMPTS: 2,
      COMMUNITIES_LEGACY_CACHE_TTL_MS: 30_000,
      COMMUNITY_LOGO_MAX_BYTES: 5 * 1_024 * 1_024,
      COMMUNITY_LOGO_MAX_DIMENSION: 512,
      COMMUNITY_LOGO_WEBP_QUALITY: 82,
      COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED: false,
      COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED: false,
      PROMOTIONS_READ_MODE: 'mock',
      PROMOTIONS_HERO_PLACEMENT: 'cabinet_home',
      PROMOTIONS_STANDARD_PLACEMENT: 'cabinet_home',
      PROMOTIONS_SYNC_INTERVAL_MS: 120_000,
      PROMOTIONS_SYNC_BATCH_SIZE: 20,
      PROMOTION_ROTATION_INTERVAL_SECONDS: 6,
      PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS: '',
      PROMOTION_IMAGE_MOBILE_WIDTH: 750,
      PROMOTION_IMAGE_MOBILE_HEIGHT: 480,
      PROMOTION_IMAGE_WEBP_QUALITY: 80,
      LOCATION_MEDIA_ENABLED: false,
      GIFT_CERTIFICATE_MEDIA_ENABLED: false,
      GIFT_CERTIFICATE_PAYMENT_MODE: 'disabled',
      GIFT_CERTIFICATE_ISSUANCE_ENABLED: false,
      GIFT_CERTIFICATE_DELIVERY_MODE: 'disabled',
      S3_FORCE_PATH_STYLE: true,
      S3_AUTO_CREATE_BUCKET: false,
      PROFILE_PHOTO_WEBP_QUALITY: 82,
      WEB_PUSH_ENABLED: false,
      WEB_PUSH_ENVIRONMENT: 'SANDBOX',
      WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: '',
      WEB_PUSH_BATCH_SIZE: 1,
      WEB_PUSH_ENDPOINTS_PER_USER_MAX: 5,
      WEB_PUSH_MAX_ATTEMPTS: 5,
      WEB_PUSH_CIRCUIT_FAILURE_THRESHOLD: 5,
      WEB_PUSH_CIRCUIT_RESET_MS: 30_000,
      MESSAGING_USER_BLOCK_COMMANDS_ENABLED: false,
      REALTIME_EXPECTED_REPLICAS: 1,
      CUP_DEV_AUTH_ENABLED: false,
      VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED: false,
    });
  });

  it('requires a server token and exact tenant scope when CUP player level projection ingestion is enabled', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, CUP_PLAYER_LEVEL_PROJECTION_ENABLED: 'true' }),
    ).toThrow('requires CUP_PLAYER_LEVEL_PROJECTION_TOKEN');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        CUP_PLAYER_LEVEL_PROJECTION_ENABLED: 'true',
        CUP_PLAYER_LEVEL_PROJECTION_TOKEN: 'x'.repeat(32),
      }),
    ).toThrow('CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY');
    expect(
      loadConfig({
        ...validEnvironment,
        CUP_PLAYER_LEVEL_PROJECTION_ENABLED: 'true',
        CUP_PLAYER_LEVEL_PROJECTION_TOKEN: 'x'.repeat(32),
        CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY: 'local-padel',
      }),
    ).toMatchObject({
      CUP_PLAYER_LEVEL_PROJECTION_ENABLED: true,
      CUP_PLAYER_LEVEL_PROJECTION_TENANT_KEY: 'local-padel',
    });
  });

  it('keeps participation commands default-off and requires an exact server boundary', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        PARTICIPATION_COMMANDS_ENABLED: 'true',
      }),
    ).toThrow('requires token, tenant key, and principal key');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        PARTICIPATION_COMMANDS_ENABLED: 'true',
        PARTICIPATION_COMMAND_TOKEN: 'x'.repeat(32),
        PARTICIPATION_COMMAND_TENANT_KEY: 'local-padel',
      }),
    ).toThrow('principal key');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        PARTICIPATION_COMMANDS_ENABLED: 'true',
        PARTICIPATION_COMMAND_TOKEN: 'x'.repeat(32),
        PARTICIPATION_COMMAND_TENANT_KEY: 'local-padel',
        PARTICIPATION_COMMAND_PRINCIPAL_KEY: 'legacy-lk-writer',
      }),
    ).toMatchObject({
      PARTICIPATION_COMMANDS_ENABLED: true,
      PARTICIPATION_COMMAND_TENANT_KEY: 'local-padel',
      PARTICIPATION_COMMAND_PRINCIPAL_KEY: 'legacy-lk-writer',
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        PARTICIPATION_COMMANDS_ENABLED: 'true',
        PARTICIPATION_COMMAND_TOKEN: 'x'.repeat(32),
        PARTICIPATION_COMMAND_TENANT_KEY: 'local-padel',
        PARTICIPATION_COMMAND_PRINCIPAL_KEY: 'legacy-lk-writer',
      }),
    ).toThrow('allowed only in local or staging');
  });

  it('provides a credential-free target fingerprint and keeps attestation local-only', () => {
    expect(
      runtimeContourTargetFingerprint(
        'postgresql://runtime:secret@127.0.0.1:55432/padlhub_chat_verify',
      ),
    ).toBe(
      runtimeContourTargetFingerprint(
        'postgresql://another:credential@127.0.0.1:55432/padlhub_chat_verify',
      ),
    );
    expect(() =>
      runtimeContourTargetFingerprint(
        'postgresql://runtime:secret@127.0.0.1:55432/padlhub_chat_verify?host=remote',
      ),
    ).toThrow('Runtime contour attestation requires query-free dependency URLs');
    expect(() =>
      runtimeContourTargetFingerprint(
        'postgresql://runtime@127.0.0.1:55432/padlhub_chat_verify?password=secret',
      ),
    ).toThrow('Runtime contour attestation requires query-free dependency URLs');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LOCAL_RUNTIME_CONTOUR_ATTESTATION: 'true',
        DATABASE_URL: 'postgresql://runtime@127.0.0.1:55432/padlhub_chat_verify?password=secret',
      }),
    ).toThrow('Runtime contour attestation requires query-free dependency URLs');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        LOCAL_RUNTIME_CONTOUR_ATTESTATION: 'true',
      }),
    ).toThrow('LOCAL_RUNTIME_CONTOUR_ATTESTATION is allowed only in local or ci');
  });

  it('bounds the declared realtime replica count used by monitoring', () => {
    expect(
      loadConfig({ ...validEnvironment, REALTIME_EXPECTED_REPLICAS: '3' })
        .REALTIME_EXPECTED_REPLICAS,
    ).toBe(3);
    expect(() => loadConfig({ ...validEnvironment, REALTIME_EXPECTED_REPLICAS: '0' })).toThrow(
      'Invalid application configuration',
    );
    expect(() => loadConfig({ ...validEnvironment, REALTIME_EXPECTED_REPLICAS: '101' })).toThrow(
      'Invalid application configuration',
    );
  });

  it('requires an explicit replica target for deployed realtime processes', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, APP_ENV: 'staging' }, { realtimeReplicaMonitoring: true }),
    ).toThrow('REALTIME_EXPECTED_REPLICAS must be explicit for deployed realtime');
    expect(
      loadConfig(
        { ...validEnvironment, APP_ENV: 'staging', REALTIME_EXPECTED_REPLICAS: '2' },
        { realtimeReplicaMonitoring: true },
      ).REALTIME_EXPECTED_REPLICAS,
    ).toBe(2);
  });

  it('keeps legacy community experience sections default-off and legacy-only', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        COMMUNITIES_READ_MODE: 'legacy',
        COMMUNITY_LEGACY_READ_DETAIL_ENABLED: 'true',
      }),
    ).toMatchObject({
      COMMUNITY_LEGACY_READ_DETAIL_ENABLED: true,
      COMMUNITY_LEGACY_READ_FEED_ENABLED: false,
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_LEGACY_READ_DETAIL_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_LEGACY_READ_*_ENABLED requires COMMUNITIES_READ_MODE=legacy');
  });

  it('gates Community Home projection independently from retired Viva Home reads', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITY_HOME_SYNC_ENABLED: 'true',
      }),
    ).toThrow('requires COMMUNITIES_READ_MODE=legacy or local');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITY_HOME_SYNC_ENABLED: 'true',
        COMMUNITIES_READ_MODE: 'local',
      }),
    ).toThrow('COMMUNITY_HOME_SYNC_ENABLED requires media storage');
    expect(
      loadConfig({
        ...validEnvironment,
        COMMUNITY_HOME_SYNC_ENABLED: 'true',
        COMMUNITIES_READ_MODE: 'local',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'https://media.example.test',
        S3_BUCKET: 'phub-media',
        S3_ACCESS_KEY: 'access',
        S3_SECRET_KEY: 'secret',
      }),
    ).toMatchObject({
      COMMUNITY_HOME_SYNC_ENABLED: true,
      HOME_VIVA_SYNC_ENABLED: false,
      PLATFORM_HOME_SYNC_ENABLED: false,
    });
  });

  it('keeps Communities realtime staging-only until durable recovery is proven', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        JWT_REALTIME_SECRET: 'staging-realtime-secret-at-least-32-characters',
        COMMUNITIES_REALTIME_ENABLED: 'true',
      }),
    ).toMatchObject({ COMMUNITIES_REALTIME_ENABLED: true });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/24',
        JWT_ACCESS_SECRET: 'prod-access-secret-very-long-and-random-123',
        JWT_REALTIME_SECRET: 'prod-realtime-secret-very-long-and-random-789',
        JWT_REFRESH_SECRET: 'prod-refresh-secret-very-long-and-random-456',
        HOME_READ_MODE: 'projection',
        PUBLIC_OFFER_VERSION: '2026-07-18',
        PERSONAL_DATA_POLICY_VERSION: '2026-07-18',
        COMMUNITIES_READ_MODE: 'local',
        PROMOTIONS_READ_MODE: 'legacy',
        COMMUNITIES_REALTIME_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITIES_REALTIME_ENABLED is staging-only');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITIES_REALTIME_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITIES_REALTIME_ENABLED requires JWT_REALTIME_SECRET');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITIES_REALTIME_ENABLED: 'true',
        JWT_REALTIME_SECRET: validEnvironment.JWT_ACCESS_SECRET,
      }),
    ).toThrow('JWT_REALTIME_SECRET must be distinct');
  });

  it('keeps API and refresh signing secrets out of an enabled staging realtime runtime', () => {
    expect(() =>
      loadRealtimeConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        JWT_REALTIME_SECRET: 'staging-realtime-secret-at-least-32-characters',
        COMMUNITIES_REALTIME_ENABLED: 'true',
      }),
    ).toThrow('Realtime runtime must not receive JWT_ACCESS_SECRET or JWT_REFRESH_SECRET');

    expect(() =>
      loadRealtimeConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        JWT_ACCESS_SECRET: undefined,
        JWT_REFRESH_SECRET: undefined,
        JWT_REALTIME_SECRET: 'staging-realtime-secret-at-least-32-characters',
        COMMUNITIES_REALTIME_ENABLED: 'true',
      }),
    ).toThrow('REALTIME_EXPECTED_REPLICAS must be explicit for deployed realtime');

    expect(
      loadRealtimeConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        JWT_ACCESS_SECRET: undefined,
        JWT_REFRESH_SECRET: undefined,
        JWT_REALTIME_SECRET: 'staging-realtime-secret-at-least-32-characters',
        COMMUNITIES_REALTIME_ENABLED: 'true',
        REALTIME_EXPECTED_REPLICAS: '2',
      }),
    ).toMatchObject({ COMMUNITIES_REALTIME_ENABLED: true, REALTIME_EXPECTED_REPLICAS: 2 });

    expect(() =>
      loadRealtimeConfig({
        ...validEnvironment,
        APP_ENV: 'ci',
        JWT_REALTIME_SECRET: undefined,
        COMMUNITIES_REALTIME_ENABLED: 'false',
      }),
    ).toThrow('Realtime runtime requires JWT_REALTIME_SECRET');
  });

  it('requires versioned media dependencies and a real scanner outside local/ci', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITY_MEDIA_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_MEDIA_ENABLED requires COMMUNITIES_READ_MODE=local');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_MEDIA_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_MEDIA_ENABLED requires versioned media storage');

    const storage = {
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'phub-media',
      S3_ACCESS_KEY: 'access',
      S3_SECRET_KEY: 'secret',
    } as const;
    expect(
      loadConfig({
        ...validEnvironment,
        ...storage,
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_MEDIA_ENABLED: 'true',
      }),
    ).toMatchObject({ COMMUNITY_MEDIA_ENABLED: true, COMMUNITY_MEDIA_SCAN_MODE: 'mock' });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        ...storage,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_MEDIA_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_MEDIA_ENABLED requires an HTTPS S3_PUBLIC_ENDPOINT origin');
    const stagingStorage = { ...storage, S3_PUBLIC_ENDPOINT: 'https://media.staging.padlhub.test' };
    expect(() =>
      loadConfig({
        ...validEnvironment,
        ...stagingStorage,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_MEDIA_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_MEDIA_ENABLED requires COMMUNITY_MEDIA_SCAN_MODE=clamav');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        ...stagingStorage,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_MEDIA_ENABLED: 'true',
        COMMUNITY_MEDIA_SCAN_MODE: 'clamav',
      }),
    ).toThrow('COMMUNITY_MEDIA_SCAN_MODE=clamav requires COMMUNITY_MEDIA_CLAMAV_HOST');
    expect(
      loadConfig({
        ...validEnvironment,
        ...stagingStorage,
        APP_ENV: 'staging',
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_MEDIA_ENABLED: 'true',
        COMMUNITY_MEDIA_SCAN_MODE: 'clamav',
        COMMUNITY_MEDIA_CLAMAV_HOST: 'clamav',
      }),
    ).toMatchObject({
      COMMUNITY_MEDIA_ENABLED: true,
      COMMUNITY_MEDIA_SCAN_MODE: 'clamav',
      COMMUNITY_MEDIA_CLAMAV_HOST: 'clamav',
    });
  });

  it('requires the startup pool warmup to fit inside the configured pool', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        DATABASE_POOL_MAX: '20',
        DATABASE_POOL_WARM_CONNECTIONS: '20',
      }),
    ).toMatchObject({ DATABASE_POOL_MAX: 20, DATABASE_POOL_WARM_CONNECTIONS: 20 });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        DATABASE_POOL_MAX: '10',
        DATABASE_POOL_WARM_CONNECTIONS: '11',
      }),
    ).toThrow('DATABASE_POOL_WARM_CONNECTIONS must not exceed DATABASE_POOL_MAX');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        REALTIME_DATABASE_POOL_MAX: '4',
        REALTIME_DATABASE_POOL_WARM_CONNECTIONS: '5',
      }),
    ).toThrow('REALTIME_DATABASE_POOL_WARM_CONNECTIONS must not exceed REALTIME_DATABASE_POOL_MAX');
  });

  it('keeps leased outbox publication explicit, staging-only and lease-safe', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        OUTBOX_PUBLISH_MODE: 'leased',
      }),
    ).toMatchObject({ OUTBOX_PUBLISH_MODE: 'leased' });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        OUTBOX_PUBLISH_MODE: 'leased',
      }),
    ).toThrow('OUTBOX_PUBLISH_MODE=leased is staging-only');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        OUTBOX_PUBLISH_MODE: 'leased',
        OUTBOX_CLAIM_TTL_MS: '14000',
        OUTBOX_CONFIRM_TIMEOUT_MS: '10000',
      }),
    ).toThrow('OUTBOX_CLAIM_TTL_MS must exceed OUTBOX_CONFIRM_TIMEOUT_MS by at least 5000ms');
  });

  it('keeps booking reminders off and requires explicit lateness on deployed enablement', () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      BOOKING_REMINDER_SCHEDULER_ENABLED: false,
      BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS: 21_600_000,
      BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS: 1_800_000,
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        BOOKING_REMINDER_SCHEDULER_ENABLED: 'true',
      }),
    ).toThrow('requires explicit max lateness for HOURS_24 and HOURS_2');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        BOOKING_REMINDER_SCHEDULER_ENABLED: 'true',
        BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS: '7200000',
        BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS: '900000',
      }),
    ).toMatchObject({
      BOOKING_REMINDER_SCHEDULER_ENABLED: true,
      BOOKING_REMINDER_HOURS_24_MAX_LATENESS_MS: 7_200_000,
      BOOKING_REMINDER_HOURS_2_MAX_LATENESS_MS: 900_000,
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        BOOKING_REMINDER_CLAIM_TTL_MS: '10000',
        BOOKING_REMINDER_DATABASE_TIMEOUT_MS: '6000',
      }),
    ).toThrow(
      'BOOKING_REMINDER_CLAIM_TTL_MS must exceed BOOKING_REMINDER_DATABASE_TIMEOUT_MS by at least 5000ms',
    );
  });

  it('gates the result writer and requires a complete worker-only CUP boundary', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_COMMANDS_ENABLED: 'true',
        GAMES_RESULTS_WRITE_MODE: 'local_primary',
      }),
    ).toMatchObject({ GAMES_RESULTS_WRITE_MODE: 'local_primary' });
    expect(() =>
      loadConfig({ ...validEnvironment, GAMES_RESULTS_WRITE_MODE: 'local_primary' }),
    ).toThrow('requires GAMES_COMMANDS_ENABLED=true');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        CUP_RATING_CONSUMER_ENABLED: 'true',
        CUP_RATING_API_URL: 'https://cup.internal',
      }),
    ).toThrow('requires CUP_RATING_API_URL and CUP_RATING_SERVICE_TOKEN');
    expect(
      loadConfig({
        ...validEnvironment,
        CUP_RATING_CONSUMER_ENABLED: 'true',
        CUP_RATING_API_URL: 'https://cup.internal',
        CUP_RATING_SERVICE_TOKEN: 'x'.repeat(32),
      }),
    ).toMatchObject({ CUP_RATING_CONSUMER_ENABLED: true });
  });

  it('keeps certificate payment sandbox local and requires complete private media storage', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        GIFT_CERTIFICATE_PAYMENT_MODE: 'sandbox',
      }),
    ).toMatchObject({ GIFT_CERTIFICATE_PAYMENT_MODE: 'sandbox' });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GIFT_CERTIFICATE_PAYMENT_MODE: 'sandbox',
      }),
    ).toThrow('GIFT_CERTIFICATE_PAYMENT_MODE=sandbox is allowed only in local or ci');
    expect(() =>
      loadConfig({ ...validEnvironment, GIFT_CERTIFICATE_MEDIA_ENABLED: 'true' }),
    ).toThrow('GIFT_CERTIFICATE_MEDIA_ENABLED requires media storage');
    expect(
      loadConfig({
        ...validEnvironment,
        GIFT_CERTIFICATE_MEDIA_ENABLED: 'true',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'padlhub-media',
        S3_ACCESS_KEY: 'padlhub',
        S3_SECRET_KEY: 'test-secret',
      }),
    ).toMatchObject({ GIFT_CERTIFICATE_MEDIA_ENABLED: true });
  });

  it('requires complete private S3 delivery when location uploads are enabled', () => {
    expect(() => loadConfig({ ...validEnvironment, LOCATION_MEDIA_ENABLED: 'true' })).toThrow(
      'LOCATION_MEDIA_ENABLED requires media storage',
    );
    expect(
      loadConfig({
        ...validEnvironment,
        LOCATION_MEDIA_ENABLED: 'true',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'padlhub-media',
        S3_ACCESS_KEY: 'padlhub',
        S3_SECRET_KEY: 'test-secret',
      }),
    ).toMatchObject({ LOCATION_MEDIA_ENABLED: true });
  });

  it('requires a private artifact store and secret for certificate issuance', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, GIFT_CERTIFICATE_ISSUANCE_ENABLED: 'true' }),
    ).toThrow('GIFT_CERTIFICATE_ISSUANCE_ENABLED requires private artifacts');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        GIFT_CERTIFICATE_ISSUANCE_ENABLED: 'true',
        GIFT_CERTIFICATE_ACTIVATION_HMAC_SECRET: 'test-gift-certificate-activation-secret',
        GIFT_CERTIFICATE_DELIVERY_MODE: 'sandbox',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'padlhub-media',
        S3_ACCESS_KEY: 'padlhub',
        S3_SECRET_KEY: 'test-secret',
      }),
    ).toMatchObject({
      GIFT_CERTIFICATE_ISSUANCE_ENABLED: true,
      GIFT_CERTIFICATE_DELIVERY_MODE: 'sandbox',
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GIFT_CERTIFICATE_DELIVERY_MODE: 'sandbox',
      }),
    ).toThrow('GIFT_CERTIFICATE_DELIVERY_MODE=sandbox is allowed only in local or ci');
  });

  it('keeps Games reads off by default and staging-only during the rollout gate', () => {
    expect(
      loadConfig({ ...validEnvironment, APP_ENV: 'staging', GAMES_READ_ENABLED: 'true' }),
    ).toMatchObject({ GAMES_READ_ENABLED: true });
    expect(() =>
      loadConfig({ ...validEnvironment, APP_ENV: 'production', GAMES_READ_ENABLED: 'true' }),
    ).toThrow('GAMES_READ_ENABLED is staging-only');
  });

  it('keeps Games commands off by default and rejects them in production', () => {
    expect(
      loadConfig({ ...validEnvironment, APP_ENV: 'staging', GAMES_COMMANDS_ENABLED: 'true' }),
    ).toMatchObject({ GAMES_COMMANDS_ENABLED: true });
    expect(() =>
      loadConfig({ ...validEnvironment, APP_ENV: 'production', GAMES_COMMANDS_ENABLED: 'true' }),
    ).toThrow('GAMES_COMMANDS_ENABLED is staging-only');
  });

  it('keeps the legacy command bridge default-off and requires both server trust boundaries', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        GAMES_COMMANDS_ENABLED: 'true',
        LEGACY_GAME_COMMAND_BRIDGE_ENABLED: 'true',
      }),
    ).toThrow('requires bridge and identity-verifier configuration');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        GAMES_COMMANDS_ENABLED: 'true',
        LEGACY_GAME_COMMAND_BRIDGE_ENABLED: 'true',
        LEGACY_GAME_COMMAND_BRIDGE_TOKEN: 'node-red-bridge-token-at-least-32-characters',
        LEGACY_GAME_IDENTITY_VERIFY_URL: 'https://cup.example.test/api/internal/lk/identity/verify',
        LEGACY_GAME_IDENTITY_VERIFY_TOKEN: 'cup-verifier-token-at-least-32-characters',
      }),
    ).toMatchObject({
      LEGACY_GAME_COMMAND_BRIDGE_ENABLED: true,
      LEGACY_GAME_IDENTITY_VERIFY_TIMEOUT_MS: 5_000,
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        GAMES_READ_ENABLED: 'true',
        GAMES_COMMANDS_ENABLED: 'true',
        LEGACY_GAME_COMMAND_BRIDGE_ENABLED: 'true',
        LEGACY_GAME_COMMAND_BRIDGE_TOKEN: 'node-red-bridge-token-at-least-32-characters',
        LEGACY_GAME_IDENTITY_VERIFY_URL: 'https://cup.example.test/api/internal/lk/identity/verify',
        LEGACY_GAME_IDENTITY_VERIFY_TOKEN: 'cup-verifier-token-at-least-32-characters',
      }),
    ).toThrow('GAMES_READ_ENABLED is staging-only');
  });

  it('permits the anonymized public roster bridge in read-only local and staging runtimes', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
      }),
    ).toThrow('allowed only in local or staging');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
      }),
    ).toThrow('Local legacy roster sync requires the public anonymized source');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'local-padel',
      }),
    ).toMatchObject({
      LEGACY_GAMES_ROSTER_SYNC_ENABLED: true,
      LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
      }),
    ).toThrow('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires GAMES_READ_ENABLED=true');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'mongo',
      }),
    ).toThrow('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires LEGACY_GAMES_MONGODB_URI');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'mongo',
        LEGACY_GAMES_MONGODB_URI: 'mongodb://readonly:secret@mongo.test/games',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'staging-padel',
      }),
    ).toMatchObject({
      LEGACY_GAMES_ROSTER_SYNC_ENABLED: true,
      LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'mongo',
    });
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        GAMES_COMMANDS_ENABLED: 'false',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'staging-padel',
      }),
    ).toMatchObject({
      LEGACY_GAMES_ROSTER_SYNC_ENABLED: true,
      LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
      GAMES_COMMANDS_ENABLED: false,
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        GAMES_COMMANDS_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'staging-padel',
      }),
    ).toThrow('Staging public legacy roster sync requires GAMES_COMMANDS_ENABLED=false');
  });

  it('enables activity history game backfill independently from continuous roster sync', () => {
    const configured = loadConfig({
      ...validEnvironment,
      APP_ENV: 'local',
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      GAMES_READ_ENABLED: 'true',
      ACTIVITY_HISTORY_ENABLED: 'true',
      ACTIVITY_HISTORY_SYNC_ENABLED: 'true',
      ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: 'true',
      LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
      LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'local-padel',
    });
    expect(configured).toMatchObject({
      ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: true,
      LEGACY_GAMES_ROSTER_SYNC_ENABLED: false,
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        GAMES_READ_ENABLED: 'true',
        ACTIVITY_HISTORY_ENABLED: 'true',
        ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'local-padel',
      }),
    ).toThrow('ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED requires ACTIVITY_HISTORY_SYNC_ENABLED=true');
  });

  it('gates the targeted Viva Home Game bridge independently from continuous roster sync', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED: 'true',
      }),
    ).toThrow('requires HOME_VIVA_SYNC_ENABLED=true');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        HOME_VIVA_SYNC_ENABLED: 'true',
        HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED: 'true',
      }),
    ).toThrow('requires GAMES_READ_ENABLED=true');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        VIVA_MODE: 'sandbox',
        VIVA_OAUTH_ENABLED: 'true',
        VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
        VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
        VIVA_DELEGATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        HOME_VIVA_SYNC_ENABLED: 'true',
        HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED: 'true',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'false',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'local-padel',
      }),
    ).toThrow('HOME_VIVA_SYNC_ENABLED is retired');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'ci',
        HOME_VIVA_SYNC_ENABLED: 'true',
        HOME_VIVA_LEGACY_GAME_BRIDGE_ENABLED: 'true',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_SOURCE: 'public',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'ci-padel',
      }),
    ).toThrow('allowed only in local or staging');
  });

  it('allows the synthetic CUP operator code only in a fully explicit local runtime', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        CUP_DEV_AUTH_ENABLED: 'true',
        CUP_DEV_AUTH_PHONE_E164: '+79990000001',
        CUP_DEV_AUTH_OTP_CODE: '0000',
      }),
    ).toThrow('CUP_DEV_AUTH_ENABLED is allowed only in APP_ENV=local');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        CUP_DEV_AUTH_ENABLED: 'true',
      }),
    ).toThrow('CUP dev auth requires an explicit phone and OTP code');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'local',
        CUP_DEV_AUTH_ENABLED: 'true',
        CUP_DEV_AUTH_PHONE_E164: '+79990000001',
        CUP_DEV_AUTH_OTP_CODE: '0000',
      }),
    ).toMatchObject({
      CUP_DEV_AUTH_ENABLED: true,
      CUP_DEV_AUTH_PHONE_E164: '+79990000001',
      CUP_DEV_AUTH_OTP_CODE: '0000',
    });
  });

  it('rejects the retired real Viva Home server synchronization gate', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        HOME_VIVA_SYNC_ENABLED: 'true',
      }),
    ).toThrow('HOME_VIVA_SYNC_ENABLED is retired');
  });

  it('keeps browser Viva reads behind both the real provider and OAuth delegation gates', () => {
    expect(() => loadConfig({ ...validEnvironment, VIVA_DIRECT_READ_ENABLED: 'true' })).toThrow(
      'VIVA_DIRECT_READ_ENABLED requires VIVA_MODE=sandbox or production',
    );
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        VIVA_DIRECT_READ_ENABLED: 'true',
      }),
    ).toThrow('VIVA_DIRECT_READ_ENABLED requires VIVA_OAUTH_ENABLED=true');
  });

  it('gates existing-subject OAuth bootstrap independently from browser Viva reads', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED: 'true',
      }),
    ).toThrow(
      'VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED requires VIVA_MODE=sandbox or production',
    );
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED: 'true',
      }),
    ).toThrow('VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED requires VIVA_OAUTH_ENABLED=true');
    expect(
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        VIVA_OAUTH_ENABLED: 'true',
        VIVA_OAUTH_REDIRECT_URI:
          'https://api.example.test/user/api/v1/local-padel/auth/viva/callback',
        VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://app.example.test/',
        VIVA_DELEGATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
        VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED: 'true',
      }),
    ).toMatchObject({
      VIVA_DIRECT_READ_ENABLED: false,
      VIVA_OAUTH_EXISTING_SUBJECT_BOOTSTRAP_ENABLED: true,
    });
  });

  it('requires complete VAPID and endpoint encryption secrets when Web Push is enabled', () => {
    expect(() => loadConfig({ ...validEnvironment, WEB_PUSH_ENABLED: 'true' })).toThrow(
      'WEB_PUSH_ENABLED requires runtime secrets',
    );
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENABLED: 'true',
        WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@padlhub.test',
        WEB_PUSH_VAPID_PUBLIC_KEY: 'public-vapid-key',
        WEB_PUSH_VAPID_PRIVATE_KEY: 'private-vapid-key',
        NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: JSON.stringify({
          v1: Buffer.alloc(32, 7).toString('base64'),
        }),
      }),
    ).toThrow('WEB_PUSH_ENABLED requires WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS');
    expect(
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENABLED: 'true',
        WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@padlhub.test',
        WEB_PUSH_VAPID_PUBLIC_KEY: 'public-vapid-key',
        WEB_PUSH_VAPID_PRIVATE_KEY: 'private-vapid-key',
        WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS:
          'https://push.example.test, https://fcm.googleapis.com:443',
        NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: JSON.stringify({
          v1: Buffer.alloc(32, 7).toString('base64'),
        }),
      }),
    ).toMatchObject({
      WEB_PUSH_ENABLED: true,
      WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: 'https://push.example.test,https://fcm.googleapis.com',
      NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: 'v1',
    });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENABLED: 'true',
        WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@padlhub.test',
        WEB_PUSH_VAPID_PUBLIC_KEY: 'public-vapid-key',
        WEB_PUSH_VAPID_PRIVATE_KEY: 'private-vapid-key',
        WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: 'https://127.0.0.1',
        NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: JSON.stringify({
          v1: Buffer.alloc(32, 7).toString('base64'),
        }),
      }),
    ).toThrow('public credential-free HTTPS origins on port 443 only');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: 'https://[::1]',
      }),
    ).toThrow('public credential-free HTTPS origins on port 443 only');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: 'https://push.example.test:8443',
      }),
    ).toThrow('port 443 only');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: 'https://*.example.test',
      }),
    ).toThrow('port 443 only');
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_BATCH_SIZE: '101',
      }),
    ).toThrow('Invalid application configuration');
    expect(
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENDPOINTS_PER_USER_MAX: '20',
      }).WEB_PUSH_ENDPOINTS_PER_USER_MAX,
    ).toBe(20);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        WEB_PUSH_ENDPOINTS_PER_USER_MAX: '21',
      }),
    ).toThrow('Invalid application configuration');
  });

  it('loads private Web Push material from mounted secret files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-web-push-config-'));
    const privateKeyPath = join(directory, 'vapid-private-key');
    const endpointKeyringPath = join(directory, 'endpoint-keyring.json');
    writeFileSync(privateKeyPath, 'private-vapid-key\n', { mode: 0o600 });
    writeFileSync(
      endpointKeyringPath,
      JSON.stringify({ v1: Buffer.alloc(32, 8).toString('base64') }),
      { mode: 0o600 },
    );
    try {
      expect(
        loadConfig({
          ...validEnvironment,
          WEB_PUSH_ENABLED: 'true',
          WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@padlhub.test',
          WEB_PUSH_VAPID_PUBLIC_KEY: 'public-vapid-key',
          WEB_PUSH_ALLOWED_ENDPOINT_ORIGINS: 'https://push.example.test',
          WEB_PUSH_VAPID_PRIVATE_KEY_FILE: privateKeyPath,
          NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS_FILE: endpointKeyringPath,
        }),
      ).toMatchObject({
        WEB_PUSH_ENABLED: true,
        WEB_PUSH_VAPID_PRIVATE_KEY: 'private-vapid-key',
        NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: 'v1',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects retired Home sync before evaluating its former storage requirements', () => {
    expect(() =>
      loadConfig(
        {
          ...validEnvironment,
          VIVA_MODE: 'sandbox',
          VIVA_OAUTH_ENABLED: 'true',
          VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
          VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
          VIVA_DELEGATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          HOME_VIVA_SYNC_ENABLED: 'true',
        },
        { profilePhotoStorage: true },
      ),
    ).toThrow('HOME_VIVA_SYNC_ENABLED is retired');
  });

  it('requires media storage when client-assisted profile photo writes are enabled', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        PROFILE_PHOTO_CLIENT_SYNC_ENABLED: 'true',
      }),
    ).toThrow('PROFILE_PHOTO_CLIENT_SYNC_ENABLED requires media storage');
  });

  it('requires worker media storage when profile photo maintenance is enabled', () => {
    expect(() =>
      loadConfig(
        {
          ...validEnvironment,
          PROFILE_PHOTO_MAINTENANCE_ENABLED: 'true',
        },
        { profilePhotoStorage: true },
      ),
    ).toThrow('PROFILE_PHOTO_MAINTENANCE_ENABLED requires media storage');
  });

  it('requires worker media storage for community-logo rollback backfill', () => {
    expect(() =>
      loadConfig(
        {
          ...validEnvironment,
          COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED: 'true',
        },
        { profilePhotoStorage: true },
      ),
    ).toThrow('COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED requires media storage');
  });

  it('rejects simultaneous stable delivery and rollback backfill', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED: 'true',
        COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED: 'true',
        S3_ENDPOINT: 'http://minio:9000',
        S3_PUBLIC_ENDPOINT: 'https://media.padlhub.test',
        S3_BUCKET: 'phub-media',
        S3_ACCESS_KEY: 'test-access',
        S3_SECRET_KEY: 'test-secret',
      }),
    ).toThrow('requires stable delivery disabled');
  });

  it('requires media storage before stable community-logo delivery can be enabled', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED requires media storage');
  });

  it('rejects the retired server-side Viva Home synchronization path', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        VIVA_OAUTH_ENABLED: 'true',
        VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
        VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
        VIVA_DELEGATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        HOME_VIVA_SYNC_ENABLED: 'true',
      }),
    ).toThrow('HOME_VIVA_SYNC_ENABLED is retired');
  });

  it('rejects a Viva delegation key that is not 32-byte base64url', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        VIVA_OAUTH_ENABLED: 'true',
        VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
        VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
        VIVA_DELEGATION_ENCRYPTION_KEY: 'not-a-valid-key',
      }),
    ).toThrow('Viva delegation encryption key must be 32-byte base64url');
  });

  it('requires private responsive-media storage when legacy CUP promotions are enabled', () => {
    expect(() =>
      loadConfig(
        { ...validEnvironment, PROMOTIONS_READ_MODE: 'legacy' },
        { profilePhotoStorage: true },
      ),
    ).toThrow('PROMOTIONS_READ_MODE=legacy requires media storage');
  });

  it('keeps CUP Block 2 as the explicit Home promotion source', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        PROMOTIONS_HERO_PLACEMENT: 'cabinet_home',
        PROMOTIONS_STANDARD_PLACEMENT: 'cabinet_home',
      }),
    ).toMatchObject({
      PROMOTIONS_HERO_PLACEMENT: 'cabinet_home',
      PROMOTIONS_STANDARD_PLACEMENT: 'cabinet_home',
    });
  });

  it('keeps private HTTP promotion media staging-only', () => {
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS: 'phab-showcase',
      }),
    ).toMatchObject({ PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS: 'phab-showcase' });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/24',
        JWT_ACCESS_SECRET: 'prod-access-secret-very-long-and-random-123',
        JWT_REFRESH_SECRET: 'prod-refresh-secret-very-long-and-random-456',
        HOME_READ_MODE: 'projection',
        PUBLIC_OFFER_VERSION: '2026-07-18',
        PERSONAL_DATA_POLICY_VERSION: '2026-07-18',
        COMMUNITIES_READ_MODE: 'legacy',
        PROMOTIONS_READ_MODE: 'legacy',
        PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS: 'phab-showcase',
      }),
    ).toThrow('PROMOTION_IMAGE_PRIVATE_HTTP_HOSTS is forbidden in production');
  });

  it('rejects incomplete secrets', () => {
    expect(() => loadConfig({ ...validEnvironment, JWT_ACCESS_SECRET: 'short' })).toThrow(
      'Invalid application configuration',
    );
  });

  it('forbids mock Viva in production', () => {
    expect(() => loadConfig({ ...validEnvironment, APP_ENV: 'production' })).toThrow(
      'VIVA_MODE=mock is forbidden in production',
    );
  });

  it('requires a secure session cookie in production', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, APP_ENV: 'production', VIVA_MODE: 'production' }),
    ).toThrow('AUTH_COOKIE_SECURE=true is required in production');
  });

  it('requires an explicit trusted proxy boundary in production', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
      }),
    ).toThrow('TRUSTED_PROXY_CIDRS is required in production');
  });

  it('rejects placeholder JWT secrets in production', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/24',
      }),
    ).toThrow('Production JWT secrets must be distinct non-placeholder values');
  });

  it('requires the persisted Home projection in production', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/24',
        JWT_ACCESS_SECRET: 'prod-access-secret-very-long-and-random-123',
        JWT_REFRESH_SECRET: 'prod-refresh-secret-very-long-and-random-456',
      }),
    ).toThrow('HOME_READ_MODE=projection is required in production');
  });

  it('requires published legal document versions in production', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/24',
        JWT_ACCESS_SECRET: 'prod-access-secret-very-long-and-random-123',
        JWT_REFRESH_SECRET: 'prod-refresh-secret-very-long-and-random-456',
        HOME_READ_MODE: 'projection',
      }),
    ).toThrow('Published legal document versions are required in production');
  });

  it('forbids synthetic community memberships in production', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'production',
        VIVA_MODE: 'production',
        AUTH_COOKIE_SECURE: 'true',
        TRUSTED_PROXY_CIDRS: '10.0.0.0/24',
        JWT_ACCESS_SECRET: 'prod-access-secret-very-long-and-random-123',
        JWT_REFRESH_SECRET: 'prod-refresh-secret-very-long-and-random-456',
        HOME_READ_MODE: 'projection',
        PUBLIC_OFFER_VERSION: '2026-07-18',
        PERSONAL_DATA_POLICY_VERSION: '2026-07-18',
      }),
    ).toThrow('COMMUNITIES_READ_MODE=mock is forbidden in production');
  });

  it('requires a dedicated secret when community invites are enabled', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITY_INVITES_ENABLED: 'true',
      }),
    ).toThrow('COMMUNITY_INVITES_ENABLED requires COMMUNITIES_READ_MODE=local');

    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_INVITES_ENABLED: 'true',
      }),
    ).toThrow(
      'COMMUNITY_INVITES_ENABLED requires COMMUNITY_INVITE_TOKEN_KEYS and COMMUNITY_INVITE_ACTIVE_KEY_ID',
    );

    expect(() =>
      loadConfig({
        ...validEnvironment,
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_INVITES_ENABLED: 'true',
        COMMUNITY_INVITE_TOKEN_KEYS: JSON.stringify({
          current: Buffer.alloc(32, 7).toString('base64'),
        }),
        COMMUNITY_INVITE_ACTIVE_KEY_ID: 'missing',
      }),
    ).toThrow('COMMUNITY_INVITE_ACTIVE_KEY_ID must select a configured token key');

    expect(
      loadConfig({
        ...validEnvironment,
        COMMUNITIES_READ_MODE: 'local',
        COMMUNITY_INVITES_ENABLED: 'true',
        COMMUNITY_INVITE_TOKEN_KEYS: JSON.stringify({
          current: Buffer.alloc(32, 7).toString('base64'),
        }),
        COMMUNITY_INVITE_ACTIVE_KEY_ID: 'current',
      }),
    ).toMatchObject({ COMMUNITY_INVITES_ENABLED: true, COMMUNITY_INVITE_ACTIVE_KEY_ID: 'current' });
  });
});
