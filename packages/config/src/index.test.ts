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
      VIVA_MODE: 'mock',
      HOME_READ_MODE: 'mock',
      HOME_PROJECTION_TTL_SECONDS: 300,
      HOME_VIVA_SYNC_ENABLED: false,
      HOME_VIVA_SYNC_INTERVAL_MS: 120_000,
      HOME_VIVA_SYNC_FAILURE_BACKOFF_MS: 300_000,
      S3_FORCE_PATH_STYLE: true,
      S3_AUTO_CREATE_BUCKET: false,
      PROFILE_PHOTO_WEBP_QUALITY: 82,
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

  it('requires private object storage for the real Home photo projection', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VIVA_MODE: 'sandbox',
        VIVA_OAUTH_ENABLED: 'true',
        VIVA_OAUTH_REDIRECT_URI: 'https://lk.padlhub.test/oauth/callback',
        VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'https://lk.padlhub.test/',
        VIVA_DELEGATION_ENCRYPTION_KEY: 'test-delegation-key-at-least-32-characters',
        HOME_VIVA_SYNC_ENABLED: 'true',
      }),
    ).toThrow('HOME_VIVA_SYNC_ENABLED requires profile photo storage');
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
});
