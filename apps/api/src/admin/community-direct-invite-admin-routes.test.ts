import type { CommunityDirectInviteService } from '@phub/communities';
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
const grantId = '22222222-2222-4222-8222-222222222222';
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

function service(overrides: Partial<CommunityDirectInviteService>): CommunityDirectInviteService {
  return {
    issue: vi.fn().mockResolvedValue({ outcome: 'permission_denied' }),
    createQuotaGrant: vi.fn().mockResolvedValue({ outcome: 'actor_not_active' }),
    preview: vi.fn().mockResolvedValue({ outcome: 'invalid' }),
    redeem: vi.fn().mockResolvedValue({ outcome: 'invalid_invite' }),
    revoke: vi.fn().mockResolvedValue({ outcome: 'invite_not_found' }),
    listActive: vi.fn().mockResolvedValue({ outcome: 'permission_denied' }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('community DIRECT invite quota grant admin route', () => {
  it('derives a one-time grant only from the admin principal and mandatory evidence', async () => {
    const createQuotaGrant = vi
      .fn<CommunityDirectInviteService['createQuotaGrant']>()
      .mockResolvedValue({
        outcome: 'granted',
        replayed: false,
        grant: {
          id: grantId,
          communityId,
          authorizedByUserId: actorUserId,
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
      communityDirectInviteService: service({ createQuotaGrant }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/direct-invite-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.invite.quota.override'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'direct-invite-override-route-0001',
      },
      payload: {
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      id: grantId,
      status: 'ACTIVE',
      expiresAt: '2026-08-05T12:00:00.000Z',
      replayed: false,
    });
    expect(response.json()).not.toHaveProperty('token');
    expect(createQuotaGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId,
        communityId,
        capability: 'communities.invite.quota.override',
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      }),
    );
  });

  it('rejects missing evidence and absent capability before calling Communities', async () => {
    const createQuotaGrant = vi.fn<CommunityDirectInviteService['createQuotaGrant']>();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ createQuotaGrant }),
    });
    apps.push(app);

    const missingEvidence = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/direct-invite-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.invite.quota.override'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'direct-invite-override-route-0002',
      },
      payload: { reasonCode: 'OPERATIONS_EXCEPTION' },
    });
    expect(missingEvidence.statusCode).toBe(400);
    expect(missingEvidence.json()).toMatchObject({
      code: 'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_INVALID',
    });

    const noCapability = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/direct-invite-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.join.decide'])}`,
        'x-app-platform': 'cup-admin',
        'idempotency-key': 'direct-invite-override-route-0003',
      },
      payload: {
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
      },
    });
    expect(noCapability.statusCode).toBe(403);
    expect(noCapability.json()).toMatchObject({
      code: 'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_PERMISSION_REQUIRED',
    });

    const wrongClient = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/direct-invite-quota-grants`,
      headers: {
        authorization: `Bearer ${await adminToken(['communities.invite.quota.override'])}`,
        'x-app-platform': 'web',
        'idempotency-key': 'direct-invite-override-route-wrong-client',
      },
      payload: { reasonCode: 'OPERATIONS_EXCEPTION', ticketId: 'CUP-1842' },
    });
    expect(wrongClient.statusCode).toBe(403);
    expect(wrongClient.json()).toMatchObject({ code: 'ADMIN_CLIENT_REQUIRED' });
    expect(createQuotaGrant).not.toHaveBeenCalled();
  });

  it('rejects issuer selectors and returns the stable active-grant conflict', async () => {
    const createQuotaGrant = vi
      .fn<CommunityDirectInviteService['createQuotaGrant']>()
      .mockResolvedValue({
        outcome: 'active_grant_exists',
        currentGrantId: grantId,
        currentRevision: 1,
        expiresAt: '2026-08-05T12:00:00.000Z',
      });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ createQuotaGrant }),
    });
    apps.push(app);
    const headers = {
      authorization: `Bearer ${await adminToken(['communities.invite.quota.override'])}`,
      'x-app-platform': 'cup-admin',
      'idempotency-key': 'direct-invite-override-route-0004',
    };

    const forgedIssuer = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/direct-invite-quota-grants`,
      headers,
      payload: {
        reasonCode: 'OPERATIONS_EXCEPTION',
        ticketId: 'CUP-1842',
        expectedIssuerMembershipRevision: 7,
      },
    });
    expect(forgedIssuer.statusCode).toBe(400);
    expect(createQuotaGrant).not.toHaveBeenCalled();

    const active = await app.inject({
      method: 'POST',
      url: `/admin/api/v1/local-padel/communities/${communityId}/direct-invite-quota-grants`,
      headers,
      payload: { reasonCode: 'OPERATIONS_EXCEPTION', ticketId: 'CUP-1842' },
    });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toMatchObject({ code: 'COMMUNITY_DIRECT_INVITE_QUOTA_GRANT_ACTIVE' });
  });
});
