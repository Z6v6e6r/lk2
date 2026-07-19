import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from './index.js';

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
      VIVA_MODE: 'mock',
      HOME_READ_MODE: 'mock',
      GAMES_READ_ENABLED: false,
      GAMES_COMMANDS_ENABLED: false,
      LEGACY_GAMES_ROSTER_SYNC_ENABLED: false,
      LEGACY_GAMES_ROSTER_SYNC_INTERVAL_MS: 120_000,
      LEGACY_GAMES_ROSTER_SYNC_LOOKBACK_DAYS: 1,
      LEGACY_GAMES_ROSTER_SYNC_LOOKAHEAD_DAYS: 42,
      LEGACY_GAMES_ROSTER_SYNC_LIMIT: 200,
      HOME_PROJECTION_TTL_SECONDS: 300,
      HOME_VIVA_SYNC_ENABLED: false,
      HOME_VIVA_SYNC_INTERVAL_MS: 120_000,
      HOME_VIVA_SYNC_FAILURE_BACKOFF_MS: 300_000,
      COMMUNITIES_READ_MODE: 'mock',
      COMMUNITIES_LEGACY_TIMEOUT_MS: 10_000,
      COMMUNITIES_LEGACY_MAX_ATTEMPTS: 2,
      COMMUNITIES_LEGACY_CACHE_TTL_MS: 30_000,
      COMMUNITY_LOGO_MAX_BYTES: 5 * 1_024 * 1_024,
      COMMUNITY_LOGO_MAX_DIMENSION: 512,
      COMMUNITY_LOGO_WEBP_QUALITY: 82,
      PROMOTIONS_READ_MODE: 'mock',
      PROMOTIONS_SYNC_INTERVAL_MS: 120_000,
      PROMOTIONS_SYNC_BATCH_SIZE: 20,
      PROMOTION_ROTATION_INTERVAL_SECONDS: 6,
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
      WEB_PUSH_MAX_ATTEMPTS: 5,
      WEB_PUSH_CIRCUIT_FAILURE_THRESHOLD: 5,
      WEB_PUSH_CIRCUIT_RESET_MS: 30_000,
      CUP_DEV_AUTH_ENABLED: false,
    });
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

  it('permits the legacy roster mirror only in an explicitly gated staging worker', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
      }),
    ).toThrow('LEGACY_GAMES_ROSTER_SYNC_ENABLED is staging-only');
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
      }),
    ).toThrow('LEGACY_GAMES_ROSTER_SYNC_ENABLED requires LEGACY_GAMES_MONGODB_URI');
    expect(
      loadConfig({
        ...validEnvironment,
        APP_ENV: 'staging',
        GAMES_READ_ENABLED: 'true',
        LEGACY_GAMES_ROSTER_SYNC_ENABLED: 'true',
        LEGACY_GAMES_MONGODB_URI: 'mongodb://readonly:secret@mongo.test/games',
        LEGACY_GAMES_ROSTER_SYNC_TENANT_KEY: 'staging-padel',
      }),
    ).toMatchObject({ LEGACY_GAMES_ROSTER_SYNC_ENABLED: true });
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

  it('keeps real Viva Home synchronization explicitly feature-gated', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        HOME_VIVA_SYNC_ENABLED: 'true',
      }),
    ).toThrow('HOME_VIVA_SYNC_ENABLED requires VIVA_OAUTH_ENABLED=true');
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

  it('requires complete VAPID and endpoint encryption secrets when Web Push is enabled', () => {
    expect(() => loadConfig({ ...validEnvironment, WEB_PUSH_ENABLED: 'true' })).toThrow(
      'WEB_PUSH_ENABLED requires runtime secrets',
    );
    expect(
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
    ).toMatchObject({ WEB_PUSH_ENABLED: true, NOTIFICATION_ENDPOINT_ACTIVE_KEY_ID: 'v1' });
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

  it('requires private object storage for the real Home photo projection', () => {
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
    ).toThrow('HOME_VIVA_SYNC_ENABLED requires profile photo storage');
  });

  it('does not expose worker-only storage requirements to API and realtime', () => {
    const config = loadConfig({
      ...validEnvironment,
      VIVA_MODE: 'sandbox',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      HOME_VIVA_SYNC_ENABLED: 'true',
    });

    expect(config.HOME_VIVA_SYNC_ENABLED).toBe(true);
    expect(config.S3_ENDPOINT).toBeUndefined();
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
});
