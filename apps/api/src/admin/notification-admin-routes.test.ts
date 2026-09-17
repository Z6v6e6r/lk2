import { createHash } from 'node:crypto';

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
    unresolvedUserIds: [],
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

type CreateCampaignInput = Parameters<AdminNotificationRepository['createCampaign']>[0];

// The repository double records its calls with `any` arguments; read them through one typed accessor
// instead of an unsafe member access at every assertion.
function createCampaignInput(
  createCampaign: ReturnType<typeof repository>['createCampaign'],
  index: number,
): CreateCampaignInput | undefined {
  const call = createCampaign.mock.calls[index];
  return call ? (call[0] as CreateCampaignInput) : undefined;
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
      unresolvedUserIds: [],
    });
  });

  it('normalizes user ids and forwards both selectors to the repository', async () => {
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
      payload: {
        phones: ['8 (999) 000-00-01'],
        userIds: [
          '  F342DF5E-2E86-42CF-B938-C00F56A2EE6E  ',
          'f342df5e-2e86-42cf-b938-c00f56a2ee6e',
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(adminRepository.resolveRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedPhones: ['+79990000001'],
        normalizedUserIds: ['f342df5e-2e86-42cf-b938-c00f56a2ee6e'],
      }),
    );
  });

  it('resolves recipients addressed only by user id', async () => {
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
      payload: { userIds: ['f342df5e-2e86-42cf-b938-c00f56a2ee6e'] },
    });

    expect(response.statusCode).toBe(200);
    expect(adminRepository.resolveRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedPhones: [],
        normalizedUserIds: ['f342df5e-2e86-42cf-b938-c00f56a2ee6e'],
      }),
    );
  });

  it('rejects an empty selector and a malformed user id with stable codes', async () => {
    const adminRepository = repository();
    const app = await buildApp({
      config,
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: adminRepository.value,
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await token()}`,
      'x-app-platform': 'cup-admin',
    };

    const empty = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/recipients/resolve',
      headers,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: 'INVALID_REQUEST' });

    const malformed = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/recipients/resolve',
      headers,
      payload: { userIds: ['not-a-uuid'] },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'USER_ID_INVALID' });

    const tooMany = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/recipients/resolve',
      headers,
      payload: {
        phones: ['+79990000001', '+79990000002'],
        userIds: Array.from(
          { length: 99 },
          (_, index) => `f342df5e-2e86-42cf-b938-${String(index).padStart(12, '0')}`,
        ),
      },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(adminRepository.resolveRecipients).not.toHaveBeenCalled();
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
        normalizedPhones: ['+79990000001'],
        normalizedUserIds: [],
        requestedChannels: ['WEB_PUSH', 'IN_APP'],
        idempotencyKey: 'admin-notification-send-test-0001',
      }),
    );
  });

  it('accepts a campaign addressed by user id and hashes the selector into the request hash', async () => {
    const adminRepository = repository();
    const app = await buildApp({
      config: { ...config, WEB_PUSH_ENABLED: true },
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: adminRepository.value,
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await token()}`,
      'x-app-platform': 'cup-admin',
    };
    const recipientUserId = 'f342df5e-2e86-42cf-b938-c00f56a2ee6e';
    const payload = {
      userIds: [recipientUserId],
      title: 'Тест',
      body: 'Сообщение',
      channels: ['IN_APP'],
    };

    const response = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers: { ...headers, 'idempotency-key': 'admin-notification-user-id-test-0001' },
      payload,
    });

    expect(response.statusCode).toBe(202);
    const first = createCampaignInput(adminRepository.createCampaign, 0);
    expect(first).toMatchObject({
      normalizedPhones: [],
      normalizedUserIds: [recipientUserId],
    });

    await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers: { ...headers, 'idempotency-key': 'admin-notification-user-id-test-0002' },
      payload: { ...payload, userIds: ['96d1b47c-dc5c-493f-836c-827f01c31546'] },
    });
    // A different selector set must hash differently, so a repeated key cannot replay a command that
    // would reach different recipients.
    const second = createCampaignInput(adminRepository.createCampaign, 1);
    expect(second?.requestHash).not.toBe(first?.requestHash);

    // A phone-only request keeps the pre-user-id hash, so an in-flight retry still replays.
    await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers: { ...headers, 'idempotency-key': 'admin-notification-phone-hash-test-0001' },
      payload: {
        phones: ['+79990000001'],
        title: 'Тест',
        body: 'Сообщение',
        channels: ['IN_APP'],
      },
    });
    const phoneOnly = createCampaignInput(adminRepository.createCampaign, 2);
    const legacyHash = createHash('sha256')
      .update(
        JSON.stringify({
          normalizedPhones: ['+79990000001'],
          title: 'Тест',
          body: 'Сообщение',
          deepLink: null,
          channels: ['IN_APP'],
        }),
      )
      .digest('hex');
    expect(phoneOnly?.requestHash).toBe(legacyHash);
  });

  it('maps a reused idempotency key with a different selector to a stable conflict', async () => {
    const adminRepository = repository();
    adminRepository.createCampaign
      .mockResolvedValueOnce({
        outcome: 'accepted',
        campaignId: '50b93bf8-490c-4b76-a5b0-d76c3a4b685a',
        matchedCount: 1,
        unresolvedCount: 0,
        inAppCreatedCount: 1,
        pushQueuedCount: 0,
        suppressedCount: 0,
        replayed: false,
      })
      .mockResolvedValueOnce({ outcome: 'idempotency_conflict' });
    const app = await buildApp({
      config,
      logger: createLogger('admin-notification-test', 'silent'),
      pool: fakePool(),
      adminNotificationRepository: adminRepository.value,
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await token()}`,
      'x-app-platform': 'cup-admin',
      'idempotency-key': 'admin-notification-reused-key-0001',
    };
    const base = { title: 'Тест', body: 'Сообщение', channels: ['IN_APP'] as const };

    const accepted = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers,
      payload: { ...base, userIds: ['f342df5e-2e86-42cf-b938-c00f56a2ee6e'] },
    });
    expect(accepted.statusCode).toBe(202);

    const conflict = await app.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers,
      payload: { ...base, userIds: ['96d1b47c-dc5c-493f-836c-827f01c31546'] },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(createCampaignInput(adminRepository.createCampaign, 1)?.requestHash).not.toBe(
      createCampaignInput(adminRepository.createCampaign, 0)?.requestHash,
    );
  });
});
