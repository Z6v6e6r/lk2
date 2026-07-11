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
    expect(loadConfig(validEnvironment)).toMatchObject({ APP_ENV: 'ci', VIVA_MODE: 'mock' });
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
});
