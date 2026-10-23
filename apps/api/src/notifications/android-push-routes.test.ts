import { loadConfig } from '@phub/config';
import type { NotificationEndpointRepository } from '@phub/database';
import { createNotificationEndpointCipher } from '@phub/notifications';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';

const keyring = JSON.stringify({ v1: Buffer.alloc(32, 7).toString('base64') });
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
  NOTIFICATION_ENDPOINT_ENCRYPTION_KEYS: keyring,
  FCM_ENABLED: 'true',
  FCM_PROJECT_ID: 'padlhub',
  FCM_CREDENTIAL_FILE: '/tmp/fcm.json',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const installationId = '11111111-1111-4111-8111-111111111111';
const endpointId = '22222222-2222-4222-8222-222222222222';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function pool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [{ id: tenantId }] }) } as unknown as Pool;
}
async function token(subject = userId): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions: ['notifications.write'],
    sid: installationId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(subject)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}
function repository(
  overrides: Partial<NotificationEndpointRepository> = {},
): NotificationEndpointRepository {
  return {
    recordClientDeliveryReceipt: vi.fn(),
    getWebPushCapabilities: vi.fn(),
    registerWebPush: vi.fn(),
    revokeWebPush: vi.fn(),
    getAndroidPushCapabilities: vi
      .fn()
      .mockResolvedValue({ tenantEnabled: true, providerConfigured: true }),
    registerAndroidPush: vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'ACTIVE',
      replayed: false,
    }),
    revokeAndroidPush: vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'REVOKED',
      replayed: false,
    }),
    ...overrides,
  };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Android Push endpoint User API', () => {
  it('rejects missing auth, idempotency and invalid FCM tokens before the repository', async () => {
    const registerAndroidPush = vi.fn();
    const app = await buildApp({
      config,
      logger: createLogger('android-push-test', 'silent'),
      pool: pool(),
      notificationEndpointRepository: repository({ registerAndroidPush }),
      notificationEndpointCipher: createNotificationEndpointCipher({
        serializedKeys: keyring,
        activeKeyId: 'v1',
      }),
    });
    apps.push(app);
    const url = '/user/api/v1/local-padel/notification-endpoints/android';
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { installationId, token: 'a'.repeat(32) },
        })
      ).statusCode,
    ).toBe(401);
    const authorization = `Bearer ${await token()}`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization },
          payload: { installationId, token: 'a'.repeat(32) },
        })
      ).json(),
    ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization, 'idempotency-key': 'android-register-test-0001' },
          payload: { installationId, token: 'bad' },
        })
      ).json(),
    ).toMatchObject({ code: 'ANDROID_PUSH_TOKEN_INVALID' });
    expect(registerAndroidPush).not.toHaveBeenCalled();
  });

  it('uses the Android FCM selector, encrypts the token and reports gates without registration', async () => {
    const registerAndroidPush = vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'ACTIVE',
      replayed: false,
    });
    const getAndroidPushCapabilities = vi
      .fn()
      .mockResolvedValue({ tenantEnabled: true, providerConfigured: false });
    const app = await buildApp({
      config,
      logger: createLogger('android-push-test', 'silent'),
      pool: pool(),
      notificationEndpointRepository: repository({
        registerAndroidPush,
        getAndroidPushCapabilities,
      }),
      notificationEndpointCipher: createNotificationEndpointCipher({
        serializedKeys: keyring,
        activeKeyId: 'v1',
      }),
    });
    apps.push(app);
    const authorization = `Bearer ${await token()}`;
    const configResponse = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/notification-endpoints/android/config',
      headers: { authorization },
    });
    expect(configResponse.json()).toEqual({ enabled: false, reason: 'PROVIDER_NOT_CONFIGURED' });
    const denied = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/notification-endpoints/android',
      headers: { authorization, 'idempotency-key': 'android-register-test-0002' },
      payload: { installationId, token: 'a'.repeat(32) },
    });
    expect(denied.statusCode).toBe(503);
    expect(registerAndroidPush).not.toHaveBeenCalled();
    getAndroidPushCapabilities.mockResolvedValue({ tenantEnabled: true, providerConfigured: true });
    const accepted = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/notification-endpoints/android',
      headers: { authorization, 'idempotency-key': 'android-register-test-0003' },
      payload: { installationId, token: 'a'.repeat(32) },
    });
    expect(accepted.statusCode).toBe(200);
    const input = registerAndroidPush.mock.calls[0]?.[0] as
      Parameters<NonNullable<NotificationEndpointRepository['registerAndroidPush']>>[0] | undefined;
    expect(input).toBeDefined();
    expect(input).toMatchObject({
      tenantId,
      userId,
      installationId,
      selector: {
        appId: 'ru.padlhub.app',
        environment: 'SANDBOX',
        platform: 'ANDROID',
        provider: 'FCM',
      },
    });
    expect(input?.ciphertext.toString()).not.toContain('a'.repeat(32));
  });
});

describe('iOS APNs endpoint User API', () => {
  it('validates APNs token and binds the server-owned credential selector', async () => {
    const registered = vi.fn().mockResolvedValue({
      outcome: 'updated',
      endpointId,
      installationId,
      status: 'ACTIVE',
      replayed: false,
    });
    const repo = repository({
      getIosPushCapabilities: vi
        .fn()
        .mockResolvedValue({ tenantEnabled: true, providerConfigured: true }),
      registerWebPush: registered,
    });
    const app = await buildApp({
      config: {
        ...config,
        NOTIFICATION_SCENARIOS_ENABLED: true,
        APNS_ENABLED: true,
        APNS_CREDENTIAL_FILE: '/synthetic/apns.json',
      },
      logger: createLogger('ios-push-test', 'silent'),
      pool: pool(),
      notificationEndpointRepository: repo,
      notificationEndpointCipher: createNotificationEndpointCipher({
        serializedKeys: keyring,
        activeKeyId: 'v1',
      }),
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await token()}`,
      'x-app-platform': 'ios',
      'idempotency-key': 'synthetic-ios-register-0001',
    };
    const url = '/user/api/v1/local-padel/notification-endpoints/ios';
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { installationId, token: 'a'.repeat(33) },
        })
      ).statusCode,
    ).toBe(400);
    expect(registered).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { installationId, token: 'A'.repeat(64) },
        })
      ).statusCode,
    ).toBe(200);
    expect(registered).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        userId,
        selector: expect.objectContaining({
          platform: 'IOS',
          provider: 'APNS',
          credentialRef: config.APNS_CREDENTIAL_REF,
        }) as unknown,
      }),
    );
    const stored = registered.mock.calls[0]![0] as { ciphertext: Buffer; encryptionKeyId: string };
    expect(
      createNotificationEndpointCipher({ serializedKeys: keyring, activeKeyId: 'v1' }).decrypt(
        stored.ciphertext,
        stored.encryptionKeyId,
      ),
    ).toBe('a'.repeat(64));
  });
});
