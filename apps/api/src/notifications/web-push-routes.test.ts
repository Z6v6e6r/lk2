import { loadConfig } from '@phub/config';
import type { NotificationEndpointRepository } from '@phub/database';
import { createNotificationEndpointCipher } from '@phub/notifications';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

const endpointKeyring = JSON.stringify({ v1: Buffer.alloc(32, 9).toString('base64') });
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  WEB_PUSH_ENABLED: 'true',
  WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@padlhub.test',
  WEB_PUSH_VAPID_PUBLIC_KEY: 'test-public-vapid-key',
  WEB_PUSH_VAPID_PRIVATE_KEY: 'test-private-vapid-key',
  NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: endpointKeyring,
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const installationId = '11111111-1111-4111-8111-111111111111';
const endpointId = '22222222-2222-4222-8222-222222222222';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function accessToken(): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['notifications.write'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Web Push endpoint User API', () => {
  it('returns public VAPID configuration only when every gate is ready', async () => {
    const getWebPushCapabilities = vi.fn().mockResolvedValue({
      tenantEnabled: true,
      providerConfigured: true,
    });
    const app = await buildApp({
      config,
      logger: createLogger('web-push-api-test', 'silent'),
      pool: fakePool(),
      notificationEndpointRepository: {
        getWebPushCapabilities,
        registerWebPush: vi.fn(),
        revokeWebPush: vi.fn(),
      },
      notificationEndpointCipher: createNotificationEndpointCipher({
        serializedKeys: endpointKeyring,
        activeKeyId: 'v1',
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/notification-endpoints/web/config',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true, publicKey: 'test-public-vapid-key' });
    expect(getWebPushCapabilities).toHaveBeenCalledWith(tenantId, {
      appId: 'padlhub-web',
      environment: 'SANDBOX',
    });
  });

  it('encrypts the subscription before the repository boundary and supports revoke', async () => {
    const registerWebPush = vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'ACTIVE',
      replayed: false,
    });
    const revokeWebPush = vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'REVOKED',
      replayed: false,
    });
    const repository: NotificationEndpointRepository = {
      getWebPushCapabilities: vi.fn().mockResolvedValue({
        tenantEnabled: true,
        providerConfigured: true,
      }),
      registerWebPush,
      revokeWebPush,
    };
    const app = await buildApp({
      config,
      logger: createLogger('web-push-api-test', 'silent'),
      pool: fakePool(),
      notificationEndpointRepository: repository,
      notificationEndpointCipher: createNotificationEndpointCipher({
        serializedKeys: endpointKeyring,
        activeKeyId: 'v1',
      }),
    });
    apps.push(app);
    const authorization = `Bearer ${await accessToken()}`;
    const subscription = {
      endpoint: 'https://push.example.test/subscriptions/secret',
      expirationTime: null,
      keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) },
    };

    const registered = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/notification-endpoints/web',
      headers: { authorization, 'idempotency-key': 'web-push-register-test-0001' },
      payload: { installationId, subscription },
    });
    expect(registered.statusCode).toBe(200);
    const input = registerWebPush.mock.calls[0]?.[0] as { ciphertext: Buffer; addressHash: string };
    expect(input.ciphertext.toString('utf8')).not.toContain(subscription.endpoint);
    expect(input.addressHash).toMatch(/^[0-9a-f]{64}$/);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/local-padel/notification-endpoints/web/${installationId}`,
      headers: { authorization, 'idempotency-key': 'web-push-revoke-test-0001' },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revokeWebPush).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, userId, installationId }),
    );
  });

  it('keeps endpoint revocation available while the global delivery gate is off', async () => {
    const revokeWebPush = vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'REVOKED',
      replayed: false,
    });
    const app = await buildApp({
      config: { ...config, WEB_PUSH_ENABLED: false },
      logger: createLogger('web-push-api-test', 'silent'),
      pool: fakePool(),
      notificationEndpointRepository: {
        getWebPushCapabilities: vi.fn(),
        registerWebPush: vi.fn(),
        revokeWebPush,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: `/user/api/v1/local-padel/notification-endpoints/web/${installationId}`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'web-push-revoke-disabled-0001',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(revokeWebPush).toHaveBeenCalledOnce();
  });
});
