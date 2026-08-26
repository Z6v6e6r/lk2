import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  parseEnvironment,
  validateRuntimeEnvironments,
} from './verify-timeweb-beta-runtime-env.js';

const dependencies = {
  DATABASE_URL: 'postgresql://runtime:secret@db.internal:5432/phub',
  REDIS_URL: 'redis://:secret@redis.internal:6379/0',
  RABBITMQ_URL: 'amqps://runtime:secret@rabbit.internal/phub',
};
const disabled = {
  GAMES_COMMANDS_ENABLED: 'false',
  LEGACY_GAME_COMMAND_BRIDGE_ENABLED: 'false',
  PARTICIPATION_COMMANDS_ENABLED: 'false',
  BOOKING_REMINDER_SCHEDULER_ENABLED: 'false',
  PARTICIPATION_COMMAND_EXPIRY_WORKER_ENABLED: 'false',
  ACTIVITY_HISTORY_SYNC_ENABLED: 'false',
  ACTIVITY_HISTORY_GAME_BACKFILL_ENABLED: 'false',
  PROFILE_PHOTO_MAINTENANCE_ENABLED: 'false',
  GIFT_CERTIFICATE_ISSUANCE_ENABLED: 'false',
};
const jwtIdentity = {
  JWT_ISSUER: 'https://beta.example.test',
  JWT_AUDIENCE: 'phub-api',
};
const keyMaterial = (purpose: string) =>
  createHash('sha256').update(`timeweb-beta-${purpose}`).digest('base64url');

function environments() {
  const safe = {
    APP_ENV: 'staging',
    ...dependencies,
    ...jwtIdentity,
    GAMES_READ_ENABLED: 'true',
    GAMES_RESULTS_WRITE_MODE: 'disabled',
    GIFT_CERTIFICATE_PAYMENT_MODE: 'disabled',
    SUBSCRIPTION_RUNTIME_WARN_MODE: 'OFF',
    ...disabled,
  };
  return {
    host: 'beta.example.test',
    tenantKey: 'local-padel',
    api: {
      ...safe,
      OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-api-1',
      AUTH_COOKIE_SECURE: 'true',
      CORS_ORIGINS: 'https://beta.example.test',
      TRUSTED_PROXY_CIDRS: '172.30.26.10/32',
      CUP_DEV_AUTH_ENABLED: 'false',
      VIVA_MODE: 'production',
      VIVA_OAUTH_ENABLED: 'true',
      VIVA_OAUTH_REDIRECT_URI:
        'https://beta.example.test/user/api/v1/local-padel/auth/viva/callback',
      VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://beta.example.test/',
      VIVA_DELEGATION_ENCRYPTION_KEY: keyMaterial('viva-delegation'),
      JWT_ACCESS_SECRET: keyMaterial('access'),
      JWT_REFRESH_SECRET: keyMaterial('refresh'),
      JWT_REALTIME_SECRET: keyMaterial('realtime'),
      JWT_REALTIME_AUDIENCE: 'phub-realtime',
    },
    worker: {
      ...safe,
      DATABASE_URL: 'postgresql://worker:other@db.internal:5432/phub',
      REDIS_URL: 'redis://worker:other@redis.internal:6379/0',
      RABBITMQ_URL: 'amqps://worker:other@rabbit.internal/phub',
      OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-worker-1',
      OUTBOX_PUBLISH_MODE: 'leased',
      WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED: 'true',
      GAMES_READ_ENABLED: 'false',
    },
    realtime: {
      APP_ENV: 'staging',
      ...dependencies,
      DATABASE_URL: 'postgresql://realtime:other@db.internal:5432/phub',
      REDIS_URL: 'redis://realtime:other@redis.internal:6379/0',
      RABBITMQ_URL: 'amqps://realtime:other@rabbit.internal/phub',
      ...jwtIdentity,
      JWT_REALTIME_SECRET: keyMaterial('realtime'),
      JWT_REALTIME_AUDIENCE: 'phub-realtime',
      OTEL_SERVICE_INSTANCE_ID: 'timeweb-beta-realtime-1',
    },
    migrator: {
      DATABASE_URL: 'postgresql://migrator:other@db.internal:5432/phub',
      MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
    },
  };
}

describe('Timeweb beta runtime environment gate', () => {
  it('accepts an isolated staging contour with fail-closed writers', () => {
    expect(() => validateRuntimeEnvironments(environments())).not.toThrow();
  });

  it('rejects provider-affecting command enablement', () => {
    const input = environments();
    input.worker.GAMES_COMMANDS_ENABLED = 'true';
    expect(() => validateRuntimeEnvironments(input)).toThrow('unsafe_GAMES_COMMANDS_ENABLED');
  });

  it('rejects any undeclared worker feature or provider secret', () => {
    const featureInput = environments();
    Object.assign(featureInput.worker, { WEB_PUSH_ENABLED: 'true' });
    expect(() => validateRuntimeEnvironments(featureInput)).toThrow(
      'unsafe_worker_WEB_PUSH_ENABLED',
    );

    const secretInput = environments();
    Object.assign(secretInput.worker, { VIVA_API_KEY: 'provider-secret' });
    expect(() => validateRuntimeEnvironments(secretInput)).toThrow('worker_secret_VIVA_API_KEY');
  });

  it('rejects API signing secrets in realtime', () => {
    const input = environments();
    Object.assign(input.realtime, { JWT_ACCESS_SECRET: keyMaterial('access') });
    expect(() => validateRuntimeEnvironments(input)).toThrow('realtime_key_JWT_ACCESS_SECRET');
  });

  it('rejects a realtime ticket signing key mismatch', () => {
    const input = environments();
    input.realtime.JWT_REALTIME_SECRET = keyMaterial('other-realtime');
    expect(() => validateRuntimeEnvironments(input)).toThrow('realtime_signing_secret_mismatch');
  });

  it('rejects a realtime ticket audience mismatch', () => {
    const input = environments();
    input.realtime.JWT_REALTIME_AUDIENCE = 'other-realtime';
    expect(() => validateRuntimeEnvironments(input)).toThrow('realtime_audience_mismatch');
  });

  it('rejects duplicate environment keys without exposing values', () => {
    expect(() => parseEnvironment('APP_ENV=staging\nAPP_ENV=production\n')).toThrow(
      'env_duplicate',
    );
  });

  it('rejects predictable key material', () => {
    const input = environments();
    input.api.JWT_ACCESS_SECRET = 'a'.repeat(43);
    expect(() => validateRuntimeEnvironments(input)).toThrow('unsafe_JWT_ACCESS_SECRET');
  });

  it('rejects mock Viva identity mode and development OTP credentials', () => {
    const mockInput = environments();
    mockInput.api.VIVA_MODE = 'mock';
    expect(() => validateRuntimeEnvironments(mockInput)).toThrow('unsafe_VIVA_MODE');

    const devOtpInput = environments();
    Object.assign(devOtpInput.api, { AUTH_DEV_OTP_CODE: '0000' });
    expect(() => validateRuntimeEnvironments(devOtpInput)).toThrow('api_dev_auth');
  });
});
