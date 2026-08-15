import type { CommunityMembershipLifecycleService } from '@phub/communities';
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
const communityId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const subjectUserId = '33333333-3333-4333-8333-333333333333';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

function fakePool(): Pool {
  return {
    query: (text: string) => {
      if (text.includes('identity.tenants')) return Promise.resolve({ rows: [{ id: tenantId }] });
      return Promise.reject(new Error(`Unexpected query: ${text}`));
    },
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

function lifecycle(
  overrides: Partial<CommunityMembershipLifecycleService>,
): CommunityMembershipLifecycleService {
  return {
    getOwnState: vi.fn(),
    selfJoin: vi.fn(),
    cancelPending: vi.fn(),
    leave: vi.fn(),
    listPending: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('community membership admin routes', () => {
  it('lists a bounded queue using the phub-admin principal', async () => {
    const listPending = vi
      .fn<CommunityMembershipLifecycleService['listPending']>()
      .mockResolvedValue({ outcome: 'found', items: [] });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMembershipLifecycleService: lifecycle({ listPending }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/admin/api/v1/local-padel/community-join-requests/pending?communityId=${communityId}&limit=10`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.moderation.read'])}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(200);
    const listCall = listPending.mock.calls[0]?.[0];
    expect(listCall).toMatchObject({
      tenantId,
      actorUserId,
      communityId,
      limit: 10,
    });
    expect(listCall?.correlationId).toBeTypeOf('string');
  });

  it('approves through a revision-checked idempotent Communities command', async () => {
    const approve = vi.fn<CommunityMembershipLifecycleService['approve']>().mockResolvedValue({
      outcome: 'approved',
      membership: {
        communityId,
        status: 'ACTIVE',
        role: 'MEMBER',
        revision: 4,
        updatedAt: '2026-08-03T11:00:00.000Z',
        pendingRequest: null,
        joinAction: 'OPEN_COMMUNITY',
      },
      request: {
        id: requestId,
        communityId,
        userId: subjectUserId,
        state: 'APPROVED',
        originStatus: 'REMOVED',
        revision: 2,
        requestedAt: '2026-08-03T10:00:00.000Z',
        decidedByUserId: actorUserId,
        decidedAt: '2026-08-03T11:00:00.000Z',
      },
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMembershipLifecycleService: lifecycle({ approve }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/community-join-requests/${requestId}/approve`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.join.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'community-approve-route-test-0001',
      },
      payload: { expectedMembershipRevision: 3, expectedRequestRevision: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: 'APPROVED',
      communityId,
      membershipStatus: 'ACTIVE',
      membershipRevision: 4,
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId, requestId }),
    );
  });

  it('rejects a CUP request without the granular permission', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMembershipLifecycleService: lifecycle({}),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/v1/local-padel/community-join-requests/pending',
      headers: {
        authorization: `Bearer ${await adminToken(['notifications.manage'])}`,
        'x-app-platform': 'cup-admin',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'COMMUNITY_MODERATION_PERMISSION_REQUIRED',
    });
  });
});
