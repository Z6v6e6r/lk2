import { loadConfig } from '@phub/config';
import type { AdminNotificationRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

async function token(
  input: {
    readonly audience?: string;
    readonly roles?: readonly string[];
    readonly permissions?: readonly string[];
  } = {},
): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: input.roles ?? ['admin'],
    permissions: input.permissions ?? ['notifications.manage'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(input.audience ?? config.JWT_ADMIN_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function repository() {
  const getCapabilities = vi.fn().mockResolvedValue({
    inAppTenantEnabled: true,
    webPushTenantEnabled: true,
    webPushProviderConfigured: true,
    iosPushTenantEnabled: false,
    androidPushTenantEnabled: false,
  });
  const resolveRecipients = vi.fn().mockResolvedValue({
    matched: [
      {
        userId: 'f342df5e-2e86-42cf-b938-c00f56a2ee6e',
        displayName: 'Игрок',
        phoneMasked: '•••• 0001',
        availableChannels: ['IN_APP', 'WEB_PUSH'],
      },
    ],
    unresolvedPhones: [],
  });
  const createCampaign = vi.fn().mockResolvedValue({
    outcome: 'accepted',
    campaignId: '50b93bf8-490c-4b76-a5b0-d76c3a4b685a',
    matchedCount: 1,
    unresolvedCount: 0,
    inAppCreatedCount: 1,
    pushQueuedCount: 1,
    suppressedCount: 0,
    replayed: false,
  });
  return {
    value: {
      getCapabilities,
      resolveRecipients,
      createCampaign,
    } satisfies AdminNotificationRepository,
    getCapabilities,
    resolveRecipients,
    createCampaign,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin notification routes', () => {
  it('requires the dedicated admin audience and CUP platform', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: repository().value,
    });
    apps.push(app);

    const wrongAudience = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: {
        authorization: `Bearer ${await token({ audience: config.JWT_AUDIENCE })}`,
        'x-app-platform': 'cup-admin',
      },
    });
    expect(wrongAudience.statusCode).toBe(401);

    const wrongPlatform = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'web',
      },
    });
    expect(wrongPlatform.statusCode).toBe(403);
    expect(wrongPlatform.json()).toMatchObject({ code: 'ADMIN_CLIENT_REQUIRED' });
  });

  it('normalizes phone recipients and returns only masked resolution data', async () => {
    const adminRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: adminRepository.value,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/recipients/resolve',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'cup-admin',
      },
      payload: { phones: ['8 (999) 000-00-01', '+7 999 000-00-01'] },
    });

    expect(response.statusCode).toBe(200);
    expect(adminRepository.resolveRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedPhones: ['+79990000001'] }),
    );
    expect(response.json()).toMatchObject({
      matched: [{ phoneMasked: '•••• 0001' }],
      unresolvedPhones: [],
    });
  });

  it('fails closed for mobile channels until APNs and FCM are implemented', async () => {
    const adminRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: adminRepository.value,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'admin-notification-mobile-test-0001',
      },
      payload: {
        phones: ['+79990000001'],
        title: 'Тест',
        body: 'Сообщение',
        channels: ['ANDROID_PUSH'],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'NOTIFICATION_CHANNEL_UNAVAILABLE' });
    expect(adminRepository.createCampaign).not.toHaveBeenCalled();
  });

  it('accepts an idempotent Web Push and inbox campaign', async () => {
    const adminRepository = repository();
    const app = await buildApp({
      config: { ...config, WEB_PUSH_ENABLED: true },
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: adminRepository.value,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'admin-notification-send-test-0001',
      },
      payload: {
        phones: ['+79990000001'],
        title: 'Тест',
        body: 'Сообщение',
        deepLink: '/notifications',
        channels: ['WEB_PUSH', 'IN_APP'],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      outcome: 'accepted',
      matchedCount: 1,
      pushQueuedCount: 1,
    });
    expect(adminRepository.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: userId,
        requestedChannels: ['WEB_PUSH', 'IN_APP'],
        idempotencyKey: 'admin-notification-send-test-0001',
      }),
    );
  });
});
