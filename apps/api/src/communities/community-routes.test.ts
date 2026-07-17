import type { CommunityDirectoryService } from '@phub/communities';
import { loadConfig } from '@phub/config';
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
    permissions: ['communities.read'],
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

describe('community routes', () => {
  it('loads an authenticated page and passes the continuation cursor to the domain service', async () => {
    const listMemberships = vi.fn().mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Padel Friends',
          logoUrl: null,
          isVerified: true,
          unreadChatCount: 2,
          route: '/communities/11111111-1111-4111-8111-111111111111',
        },
      ],
      nextCursor: 'eyJ2IjoxLCJleGFtcGxlIjp0cnVlfQ',
    });
    const service: CommunityDirectoryService = {
      listMemberships,
    };
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectory: service,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/communities/mine?limit=10&cursor=opaque-cursor-value',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('private');
    expect(response.json()).toMatchObject({
      items: [{ id: '11111111-1111-4111-8111-111111111111' }],
      nextCursor: 'eyJ2IjoxLCJleGFtcGxlIjp0cnVlfQ',
    });
    expect(listMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, userId, limit: 10, cursor: 'opaque-cursor-value' }),
    );
  });

  it('requires a PadlHub session before loading legacy-backed data', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectory: { listMemberships: vi.fn() },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/communities/mine',
    });
    expect(response.statusCode).toBe(401);
  });
});
