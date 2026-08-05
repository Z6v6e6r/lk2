import type { CommunityCreateService } from '@phub/communities';
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
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const subjectUserId = '11111111-1111-4111-8111-111111111111';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) =>
      text.includes('identity.tenants')
        ? Promise.resolve({ rows: [{ id: tenantId }] })
        : Promise.reject(new Error(`Unexpected query: ${text}`)),
  } as unknown as Pool;
}

async function adminToken(permissions: readonly string[]): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['admin'],
    permissions,
    sid: '55555555-5555-4555-8555-555555555555',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_ADMIN_AUDIENCE)
    .setSubject(actorUserId)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('community create quota grant admin route', () => {
  it('derives actor, capability and subject while accepting only scopes and audit evidence', async () => {
    const createQuotaGrant = vi
      .fn<NonNullable<CommunityCreateService['createQuotaGrant']>>()
      .mockResolvedValue({
        outcome: 'granted',
        replayed: false,
        grant: {
          id: '22222222-2222-4222-8222-222222222222',
          subjectUserId,
          authorizedByUserId: actorUserId,
          scopes: ['ACTIVE_OWNER_LIMIT'],
          state: 'ACTIVE',
          revision: 1,
          createdAt: '2026-08-04T12:00:00.000Z',
          updatedAt: '2026-08-04T12:00:00.000Z',
          expiresAt: '2026-08-05T12:00:00.000Z',
          consumedAt: null,
        },
      });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityCreateService: { create: vi.fn(), createQuotaGrant },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/users/${subjectUserId}/community-create-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.create.quota.override'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'community-create-grant-route-0001',
      },
      payload: {
        scopes: ['ACTIVE_OWNER_LIMIT'],
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createQuotaGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId,
        subjectUserId,
        capability: 'communities.create.quota.override',
        scopes: ['ACTIVE_OWNER_LIMIT'],
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      }),
    );
  });

  it('rejects missing capability and client-supplied authority fields', async () => {
    const createQuotaGrant = vi.fn<NonNullable<CommunityCreateService['createQuotaGrant']>>();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityCreateService: { create: vi.fn(), createQuotaGrant },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/users/${subjectUserId}/community-create-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken([])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'community-create-grant-route-0002',
      },
      payload: {
        scopes: ['ACTIVE_OWNER_LIMIT'],
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
        capability: 'communities.create.quota.override',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(createQuotaGrant).not.toHaveBeenCalled();

    const forged = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/users/${subjectUserId}/community-create-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.create.quota.override'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'community-create-grant-route-0003',
      },
      payload: {
        scopes: ['ACTIVE_OWNER_LIMIT'],
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
        capability: 'communities.create.quota.override',
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(createQuotaGrant).not.toHaveBeenCalled();
  });
});
