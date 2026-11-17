import { loadConfig } from '@phub/config';
import { createLogger } from '@phub/observability';
import { VivaClientAdminReadError } from '@phub/viva-adapter';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildAppWithActiveSession as buildApp } from '../testing/build-test-app.js';
import type { UserVivaAdminSource } from './user-viva-admin-routes.js';

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
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const subjectUserId = '11111111-1111-4111-8111-111111111111';
const vivaClientId = '99999999-9999-4999-8999-999999999999';
const base = `/admin/api/v1/padlhub/users/${subjectUserId}/viva`;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function token(
  permissions: readonly string[],
  audience = config.JWT_ADMIN_AUDIENCE,
  roles: readonly string[] = ['admin'],
): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles,
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(audience)
    .setSubject(actorUserId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

function fakeSource(): { [K in keyof UserVivaAdminSource]: ReturnType<typeof vi.fn> } {
  const pageResult = { items: [], page: 0, size: 25, totalElements: 0, hasNext: false };
  return {
    readProfile: vi.fn().mockResolvedValue({ depositKopecks: 0, categoryName: 'Резидент' }),
    readSummary: vi.fn().mockResolvedValue({ counters: { todayBookings: 0 } }),
    listSubscriptions: vi.fn().mockResolvedValue(pageResult),
    listBookings: vi.fn().mockResolvedValue(pageResult),
    listTransactions: vi.fn().mockResolvedValue(pageResult),
  };
}

async function setup(
  options: {
    source?: ReturnType<typeof fakeSource>;
    resolve?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const source = options.source ?? fakeSource();
  const resolve = options.resolve ?? vi.fn().mockResolvedValue(vivaClientId);
  const app = await buildApp({
    config,
    logger: createLogger('api-test', 'silent'),
    pool: fakePool(),
    userVivaAdminSource: source as unknown as UserVivaAdminSource,
    resolveUserVivaClientId: resolve as unknown as (input: {
      readonly tenantId: string;
      readonly userId: string;
    }) => Promise<string | undefined>,
  });
  apps.push(app);
  return { app, source, resolve };
}

function headers(accessToken: string, platform = 'cup-admin') {
  return { authorization: `Bearer ${accessToken}`, 'x-app-platform': platform };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('user viva admin routes', () => {
  it('resolves the Viva client from the subject and tenant, never from the request', async () => {
    const { app, source, resolve } = await setup();
    const response = await app.inject({
      method: 'GET',
      url: `${base}/profile`,
      headers: headers(await token(['support.read'])),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ categoryName: 'Резидент' });
    expect(resolve).toHaveBeenCalledWith({ tenantId, userId: subjectUserId });
    const [readInput] = source.readProfile.mock.calls[0] as [
      { providerClientId: string; correlationId: string },
    ];
    expect(readInput.providerClientId).toBe(vivaClientId);
    expect(readInput.correlationId).toMatch(/\S/);
  });

  it('passes validated paging and filters for each list section', async () => {
    const { app, source } = await setup();
    const auth = headers(await token(['support.manage']));
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${base}/subscriptions?group=ARCHIVED&page=1&size=10`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(source.listSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'ARCHIVED', page: 1, size: 10 }),
    );

    await app.inject({
      method: 'GET',
      url: `${base}/bookings?period=PAST&includeCancelled=true`,
      headers: auth,
    });
    expect(source.listBookings).toHaveBeenCalledWith(
      expect.objectContaining({ period: 'PAST', includeCancelled: true, page: 0, size: 25 }),
    );

    await app.inject({ method: 'GET', url: `${base}/transactions?page=2`, headers: auth });
    expect(source.listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, size: 25 }),
    );

    await app.inject({ method: 'GET', url: `${base}/summary`, headers: auth });
    expect(source.readSummary).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown query parameters, oversized pages and bad user ids', async () => {
    const { app, source } = await setup();
    const auth = headers(await token(['support.read']));
    for (const url of [
      `${base}/transactions?size=500`,
      `${base}/bookings?period=ALL`,
      `${base}/profile?providerClientId=${vivaClientId}`,
      `/admin/api/v1/padlhub/users/not-a-uuid/viva/profile`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: auth });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toMatchObject({ code: 'USER_VIVA_QUERY_INVALID' });
    }
    expect(source.readProfile).not.toHaveBeenCalled();
    expect(source.listTransactions).not.toHaveBeenCalled();
  });

  it('requires the CUP platform, admin audience and support permission', async () => {
    const { app, source, resolve } = await setup();
    const cases = [
      { headers: headers(await token(['support.read']), 'web'), code: 'ADMIN_CLIENT_REQUIRED' },
      {
        headers: headers(await token(['locations.read'])),
        code: 'USER_VIVA_READ_PERMISSION_REQUIRED',
      },
    ];
    for (const item of cases) {
      const response = await app.inject({
        method: 'GET',
        url: `${base}/profile`,
        headers: item.headers,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: item.code });
    }
    const clientAudience = await app.inject({
      method: 'GET',
      url: `${base}/profile`,
      headers: headers(await token(['support.read'], config.JWT_AUDIENCE, ['client'])),
    });
    expect(clientAudience.statusCode).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(source.readProfile).not.toHaveBeenCalled();
  });

  it('returns 404 when the user has no synced Viva link', async () => {
    const { app, source } = await setup({ resolve: vi.fn().mockResolvedValue(undefined) });
    const response = await app.inject({
      method: 'GET',
      url: `${base}/subscriptions`,
      headers: headers(await token(['support.read'])),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'USER_VIVA_NOT_LINKED' });
    expect(source.listSubscriptions).not.toHaveBeenCalled();
  });

  it('maps provider failures to stable codes without leaking details', async () => {
    const source = fakeSource();
    source.readProfile
      .mockRejectedValueOnce(new VivaClientAdminReadError('CLIENT_ADMIN_READ_OWNERSHIP_CONFLICT'))
      .mockRejectedValueOnce(new VivaClientAdminReadError('CLIENT_ADMIN_READ_TIMEOUT', true))
      .mockRejectedValueOnce(new VivaClientAdminReadError('CLIENT_ADMIN_READ_NOT_FOUND'));
    const { app } = await setup({ source });
    const auth = headers(await token(['support.read']));
    const expected = [
      [502, 'USER_VIVA_OWNERSHIP_CONFLICT'],
      [503, 'USER_VIVA_UNAVAILABLE'],
      [404, 'USER_VIVA_CLIENT_NOT_FOUND'],
    ] as const;
    for (const [status, code] of expected) {
      const response = await app.inject({ method: 'GET', url: `${base}/profile`, headers: auth });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain(vivaClientId);
    }
  });

  it('reports the source as disabled when Viva is not configured', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: `${base}/profile`,
      headers: headers(await token(['support.read'])),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'USER_VIVA_SOURCE_DISABLED' });
  });
});
