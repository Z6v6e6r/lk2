import { createHmac } from 'node:crypto';

import { loadConfig } from '@phub/config';
import type { AdminNotificationRepository, LocationRepository } from '@phub/database';
import { createLogger } from '@phub/observability';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';

// The ЦУП delegation credential replaces the second PadlHub operator session for the notification and
// station-card blocks. These tests prove both directions: the credential opens exactly those two
// contours for the configured tenant, and it opens nothing else — not another admin contour, not
// another tenant, and not even those two once the switch is off.

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
// A real PadlHub user id: the delegated writes are audited under it, and location-media plus campaign
// rows carry a foreign key to identity.users.
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const delegationToken = 'cup-admin-delegation-token-at-least-32-chars';

const baseEnvironment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:***@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:***@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

const enabledConfig = loadConfig({
  ...baseEnvironment,
  CUP_ADMIN_DELEGATION_ENABLED: 'true',
  CUP_ADMIN_DELEGATION_TOKEN: delegationToken,
  CUP_ADMIN_DELEGATION_ACTOR_ID: actorUserId,
  CUP_ADMIN_DELEGATION_TENANT_KEYS: 'local-padel',
});

// Same credential present, switch off: the token must not be accepted at all.
const switchedOffConfig = loadConfig({
  ...baseEnvironment,
  CUP_ADMIN_DELEGATION_ENABLED: 'false',
  CUP_ADMIN_DELEGATION_TOKEN: delegationToken,
  CUP_ADMIN_DELEGATION_ACTOR_ID: actorUserId,
  CUP_ADMIN_DELEGATION_TENANT_KEYS: 'local-padel',
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
  } as unknown as Pool;
}

function notificationRepository() {
  const getCapabilities = vi.fn().mockResolvedValue({
    inAppTenantEnabled: true,
    webPushTenantEnabled: true,
    webPushProviderConfigured: true,
    iosPushTenantEnabled: false,
    androidPushTenantEnabled: false,
  });
  const createCampaign = vi.fn().mockResolvedValue({
    outcome: 'accepted',
    campaignId: '50b93bf8-490c-4b76-a5b0-d76c3a4b685a',
    matchedCount: 1,
    unresolvedCount: 0,
    inAppCreatedCount: 1,
    pushQueuedCount: 0,
    suppressedCount: 0,
    replayed: false,
  });
  const listNativePushSubscribers = vi.fn().mockResolvedValue({ items: [] });
  const value = {
    getCapabilities,
    resolveRecipients: vi.fn(),
    listWebPushSubscribers: vi.fn(),
    listNativePushSubscribers,
    getDeliveryStats: vi.fn(),
    createCampaign,
  } as unknown as AdminNotificationRepository & { getCapabilities: typeof getCapabilities };
  return { value, getCapabilities, createCampaign, listNativePushSubscribers };
}

function locationRepository() {
  const listAdmin = vi.fn().mockResolvedValue([]);
  return { value: { listAdmin } as unknown as LocationRepository, listAdmin };
}

function delegationHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${delegationAssertion()}`,
    'x-app-platform': 'cup-admin',
    ...overrides,
  };
}

// Mirrors the ЦУП side: the console signs `<version>\n<tenantKey>\n<issuedAtMs>` with the shared
// secret, so the secret itself never travels and a captured request expires with the replay window.
function delegationAssertion(
  issuedAtMs: number = Date.now(),
  tenantKey: string = 'local-padel',
  secret: string = delegationToken,
): string {
  const mac = createHmac('sha256', secret)
    .update(`cupv1\n${tenantKey}\n${issuedAtMs}`)
    .digest('hex');
  return `cupv1.${issuedAtMs}.${mac}`;
}

async function app(options: {
  readonly config?: typeof enabledConfig;
  readonly sessionActive?: boolean;
  readonly notification?: ReturnType<typeof notificationRepository>;
  readonly location?: ReturnType<typeof locationRepository>;
}) {
  const built = await buildApp({
    config: options.config ?? enabledConfig,
    logger: createLogger('cup-admin-delegation-test', 'silent'),
    pool: fakePool(),
    accessSessionChecker: () => Promise.resolve(options.sessionActive === true),
    ...(options.notification ? { adminNotificationRepository: options.notification.value } : {}),
    ...(options.location ? { locationRepository: options.location.value } : {}),
  });
  apps.push(built);
  return built;
}

describe('CUP admin delegation', () => {
  it('opens the notification block for the configured tenant without a PadlHub session', async () => {
    const notification = notificationRepository();
    // The session checker denies every PadlHub session: only the delegation credential can pass.
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: delegationHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(notification.getCapabilities).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(response.body) as {
      channels: Array<{ channel: string; enabled: boolean }>;
    };
    const inApp = payload.channels.find((entry) => entry.channel === 'IN_APP');
    expect(inApp?.enabled).toBe(true);
  });

  it.each(['ANDROID', 'IOS'])(
    'reads %s subscriber lists through tenant-bound CUP delegation',
    async (platform) => {
      const notification = notificationRepository();
      const built = await app({ notification, sessionActive: false });
      const response = await built.inject({
        method: 'GET',
        url: `/admin/api/v1/local-padel/notifications/native-push-subscribers?platform=${platform}`,
        headers: delegationHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const denied = await built.inject({
        method: 'GET',
        url: `/admin/api/v1/another-padel/notifications/native-push-subscribers?platform=${platform}`,
        headers: delegationHeaders(),
      });
      expect(denied.statusCode).toBe(401);
      expect(notification.listNativePushSubscribers).toHaveBeenCalledTimes(1);
    },
  );

  it('opens the station-card block for the configured tenant without a PadlHub session', async () => {
    const location = locationRepository();
    const built = await app({ location, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/locations',
      headers: delegationHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(location.listAdmin).toHaveBeenCalledWith(tenantId);
  });

  it('audits a delegated campaign under the configured operator identity', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/notifications/campaigns',
      headers: delegationHeaders({ 'idempotency-key': 'cup-admin-delegation-campaign-0001' }),
      payload: {
        phones: ['+79990000001'],
        title: 'Тест',
        body: 'Сообщение',
        channels: ['IN_APP'],
      },
    });

    expect(response.statusCode).toBe(202);
    const input = notification.createCampaign.mock.calls[0]?.[0] as
      { actorUserId?: string } | undefined;
    expect(input?.actorUserId).toBe(actorUserId);
  });

  it('refuses the credential for a tenant outside the configured allowlist', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/another-padel/notifications/capabilities',
      headers: {
        authorization: `Bearer ${delegationAssertion(Date.now(), 'another-padel')}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'TENANT_ACCESS_DENIED' });
    expect(notification.getCapabilities).not.toHaveBeenCalled();
  });

  it('binds the assertion to the tenant it was minted for', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/another-padel/notifications/capabilities',
      headers: delegationHeaders(),
    });

    expect(response.statusCode).toBe(401);
    expect(notification.getCapabilities).not.toHaveBeenCalled();
  });

  it('refuses an assertion outside the replay window', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: {
        authorization: `Bearer ${delegationAssertion(Date.now() - 10 * 60 * 1000)}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
    expect(notification.getCapabilities).not.toHaveBeenCalled();
  });

  it('refuses an assertion signed with another secret', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: {
        authorization: `Bearer ${delegationAssertion(
          Date.now(),
          'local-padel',
          'a-different-secret-that-is-long-enough',
        )}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(notification.getCapabilities).not.toHaveBeenCalled();
  });

  it('refuses the credential without the CUP platform header', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: false });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: { authorization: `Bearer ${delegationAssertion()}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ADMIN_CLIENT_REQUIRED' });
  });

  it('does not accept the credential while the switch is off', async () => {
    const notification = notificationRepository();
    const built = await app({
      notification,
      sessionActive: true,
      config: switchedOffConfig,
    });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: delegationHeaders(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
    expect(notification.getCapabilities).not.toHaveBeenCalled();
  });

  it('does not widen to admin contours outside the notification and station blocks', async () => {
    const built = await app({ sessionActive: true });

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/gift-certificate-catalog',
      headers: delegationHeaders(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
  });

  it('authorizes the binary station-media upload through the delegation', async () => {
    const built = await app({ sessionActive: false });

    const authorized = await built.inject({
      method: 'POST',
      url: '/admin/api/v1/local-padel/location-media',
      headers: delegationHeaders({
        'idempotency-key': 'cup-admin-delegation-media-0001',
        'content-type': 'image/png',
      }),
      payload: Buffer.from('synthetic-not-an-image'),
    });
    // The credential passed the guard: whatever the media contour answers about these synthetic bytes,
    // it is not the refusal an unauthorized caller gets.
    expect([401, 403]).not.toContain(authorized.statusCode);

    const wrongTenant = await built.inject({
      method: 'POST',
      url: '/admin/api/v1/another-padel/location-media',
      headers: delegationHeaders({
        'idempotency-key': 'cup-admin-delegation-media-0002',
        'content-type': 'image/png',
      }),
      payload: Buffer.from('synthetic-not-an-image'),
    });
    expect(wrongTenant.statusCode).toBe(401);
  });

  it('still accepts a real phub-admin session for the same routes', async () => {
    const notification = notificationRepository();
    const built = await app({ notification, sessionActive: true });
    const token = await new SignJWT({
      tenants: [tenantId],
      roles: ['admin'],
      permissions: ['notifications.manage'],
      sid: '55555555-5555-4555-8555-555555555555',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(enabledConfig.JWT_ISSUER)
      .setAudience(enabledConfig.JWT_ADMIN_AUDIENCE)
      .setSubject('d938caf6-4eca-49d3-8f78-c7ab1b967a41')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(enabledConfig.JWT_ACCESS_SECRET));

    const response = await built.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/notifications/capabilities',
      headers: { authorization: `Bearer ${token}`, 'x-app-platform': 'cup-admin' },
    });

    expect(response.statusCode).toBe(200);
    expect(notification.getCapabilities).toHaveBeenCalledTimes(1);
  });
});
