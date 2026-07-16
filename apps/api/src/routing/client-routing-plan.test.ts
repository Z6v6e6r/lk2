import { loadConfig } from '@phub/config';
import { describe, expect, it } from 'vitest';

import { buildClientRoutingPlan, canUseDirectViva } from './client-routing-plan.js';

const baseEnvironment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

const stored = {
  mode: 'MIXED_END_USER_READS' as const,
  revision: '12',
  validForSeconds: 60,
  directOperations: ['profile.read'] as const,
  providerTenantKey: 'iSkq6G',
  delegationReady: true,
};

const enabledEnvironment = {
  ...baseEnvironment,
  VIVA_MODE: 'sandbox',
  VIVA_DIRECT_READ_ENABLED: 'true',
  VIVA_OAUTH_ENABLED: 'true',
  VIVA_OAUTH_REDIRECT_URI: 'http://localhost:3000/user/api/v1/local-padel/auth/viva/callback',
  VIVA_OAUTH_SUCCESS_REDIRECT_URL: 'http://localhost:5173/',
  VIVA_DELEGATION_ENCRYPTION_KEY: 'test-delegation-encryption-key-at-least-32-chars',
} as const;

describe('client routing plan', () => {
  it('requires the global gate, tenant mode, user delegation and supported client together', () => {
    const disabledConfig = loadConfig(baseEnvironment);
    expect(canUseDirectViva({ config: disabledConfig, stored, platform: 'web' })).toBe(false);

    const enabledConfig = loadConfig(enabledEnvironment);
    expect(canUseDirectViva({ config: enabledConfig, stored, platform: 'web' })).toBe(true);
    expect(
      canUseDirectViva({
        config: enabledConfig,
        stored: { ...stored, directOperations: [] },
        platform: 'web',
      }),
    ).toBe(false);
    expect(
      canUseDirectViva({
        config: enabledConfig,
        stored: { ...stored, delegationReady: false },
        platform: 'web',
      }),
    ).toBe(false);
    expect(canUseDirectViva({ config: enabledConfig, stored, platform: 'cup-admin' })).toBe(false);
  });

  it('returns an allowlisted short-lived mixed plan without credentials', () => {
    const config = loadConfig(enabledEnvironment);
    const now = new Date('2026-07-15T08:00:00.000Z');
    const result = buildClientRoutingPlan({ config, stored, platform: 'web', now });

    expect(result).toMatchObject({
      revision: '12',
      mode: 'MIXED_END_USER_READS',
      issuedAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2026-07-15T08:01:00.000Z',
      directViva: {
        apiBaseUrl: 'https://api.vivacrm.ru/end-user/api',
        providerTenantKey: 'iSkq6G',
        allowedRequestHeaders: ['Authorization'],
      },
    });
    expect(result.operations).toHaveLength(5);
    expect(result.operations).toContainEqual({
      operation: 'profile.read',
      transport: 'DIRECT_VIVA',
      fallback: 'UNAVAILABLE',
    });
    expect(
      result.operations
        .filter((operation) => operation.operation !== 'profile.read')
        .every((operation) => operation.transport === 'PADLHUB_API'),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('token');
    expect(JSON.stringify(result)).not.toContain('keyVersion');
  });

  it('downgrades to PadlHub-only when any direct-read precondition is absent', () => {
    const config = loadConfig(enabledEnvironment);
    const result = buildClientRoutingPlan({
      config,
      stored: { ...stored, delegationReady: false },
      platform: 'android',
    });

    expect(result.mode).toBe('PADLHUB_ONLY');
    expect(result.directViva).toBeUndefined();
    expect(result.operations.every((operation) => operation.transport === 'PADLHUB_API')).toBe(
      true,
    );
  });

  it('fails closed when storage contains a read whose provider contract is not ready', () => {
    const config = loadConfig(enabledEnvironment);
    const result = buildClientRoutingPlan({
      config,
      stored: { ...stored, directOperations: ['bookings.read'] },
      platform: 'web',
    });

    expect(result.mode).toBe('PADLHUB_ONLY');
    expect(result.directViva).toBeUndefined();
    expect(result.operations.every((operation) => operation.transport === 'PADLHUB_API')).toBe(
      true,
    );
  });
});
