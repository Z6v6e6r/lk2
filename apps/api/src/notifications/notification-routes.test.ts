import { loadConfig } from '@phub/config';
import type { NotificationInboxRepository } from '@phub/database';
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
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const itemId = '11111111-1111-4111-8111-111111111111';
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
    permissions: ['notifications.read'],
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject(userId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function repository(
  overrides: Partial<NotificationInboxRepository> = {},
): NotificationInboxRepository {
  return {
    getRuntimeSettings: vi.fn().mockResolvedValue({
      inAppEnabled: true,
      webPushEnabled: false,
      iosPushEnabled: false,
      androidPushEnabled: false,
    }),
    listInbox: vi.fn().mockResolvedValue({
      items: [
        {
          id: itemId,
          category: 'GAME',
          title: 'Игра скоро начнётся',
          body: 'Начало в 19:00',
          deepLink: `/games/${itemId}`,
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      ],
      unreadCount: 1,
    }),
    markReadThrough: vi.fn().mockResolvedValue({
      outcome: 'updated',
      readThrough: { id: itemId, createdAt: '2026-07-16T12:00:00.000Z' },
      changedCount: 1,
      replayed: false,
    }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('notification User API', () => {
  it('returns the authenticated user inbox without cacheable data', async () => {
    const listInbox = vi.fn().mockResolvedValue({
      items: [
        {
          id: itemId,
          category: 'GAME',
          title: 'Игра скоро начнётся',
          body: 'Начало в 19:00',
          deepLink: `/games/${itemId}`,
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      ],
      unreadCount: 1,
    });
    const notificationRepository = repository({ listInbox });
    const app = await buildApp({
      config,
      logger: createLogger('notification-api-test', 'silent'),
      pool: fakePool(),
      notificationRepository,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/notifications?limit=20&unreadOnly=true',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ items: [{ id: itemId }], unreadCount: 1 });
    expect(listInbox).toHaveBeenCalledWith({
      tenantId,
      userId,
      limit: 20,
      unreadOnly: true,
    });
  });

  it('keeps the route closed until the tenant gate is enabled', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('notification-api-test', 'silent'),
      pool: fakePool(),
      notificationRepository: repository({
        getRuntimeSettings: vi.fn().mockResolvedValue({
          inAppEnabled: false,
          webPushEnabled: false,
          iosPushEnabled: false,
          androidPushEnabled: false,
        }),
      }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/notifications',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOTIFICATIONS_DISABLED' });
  });

  it('requires idempotency and advances the read cursor through the repository', async () => {
    const markReadThrough = vi.fn().mockResolvedValue({
      outcome: 'updated',
      readThrough: { id: itemId, createdAt: '2026-07-16T12:00:00.000Z' },
      changedCount: 1,
      replayed: false,
    });
    const notificationRepository = repository({ markReadThrough });
    const app = await buildApp({
      config,
      logger: createLogger('notification-api-test', 'silent'),
      pool: fakePool(),
      notificationRepository,
    });
    apps.push(app);
    const authorization = `Bearer ${await accessToken()}`;

    const missingKey = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/notifications/read-cursor',
      headers: { authorization },
      payload: { throughId: itemId },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const response = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/notifications/read-cursor',
      headers: { authorization, 'idempotency-key': 'notification-read-test-0001' },
      payload: { throughId: itemId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ changedCount: 1, replayed: false });
    expect(markReadThrough).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, userId, throughItemId: itemId }),
    );
  });
});
