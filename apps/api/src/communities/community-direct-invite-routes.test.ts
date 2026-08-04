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
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const inviteId = '22222222-2222-4222-8222-222222222222';
const token = 't'.repeat(43);
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

describe('community DIRECT invite routes', () => {
  it('returns a bounded preview without echoing the sensitive token', async () => {
    const preview = vi.fn<CommunityDirectInviteService['preview']>().mockResolvedValue({
      outcome: 'found',
      preview: {
        inviteId,
        inviteRevision: 1,
        communityId,
        title: 'Скрытое сообщество',
        logoUrl: null,
        isVerified: true,
        visibility: 'HIDDEN',
        expiresAt: '2026-08-11T12:00:00.000Z',
        membershipRevision: 0,
        redeemAction: 'CONFIRM_MEMBERSHIP',
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ preview }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/community-direct-invites/preview',
      headers: { authorization: `Bearer ${await accessToken()}` },
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(token);
    expect(response.json()).toMatchObject({
      inviteId,
      membershipRevision: 0,
      redeemAction: 'CONFIRM_MEMBERSHIP',
      community: { id: communityId, visibility: 'HIDDEN' },
    });
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId: userId, token }),
    );
  });

  it('creates a server-owned seven-day invite without accepting role or expiry', async () => {
    const issue = vi.fn<CommunityDirectInviteService['issue']>().mockResolvedValue({
      outcome: 'issued',
      replayed: false,
      token,
      invite: {
        id: inviteId,
        communityId,
        issuedByUserId: userId,
        tokenKeyId: 'current',
        state: 'ACTIVE',
        revision: 1,
        createdAt: '2026-08-04T12:00:00.000Z',
        updatedAt: '2026-08-04T12:00:00.000Z',
        expiresAt: '2026-08-11T12:00:00.000Z',
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ issue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/direct-invites`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'direct-invite-create-route-0001',
      },
      payload: { expectedIssuerMembershipRevision: 0 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: inviteId, token, status: 'ACTIVE' });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        communityId,
        expectedIssuerMembershipRevision: 0,
      }),
    );
    expect(issue.mock.calls[0]?.[0]).not.toHaveProperty('role');
    expect(issue.mock.calls[0]?.[0]).not.toHaveProperty('expiresAt');
    expect(issue.mock.calls[0]?.[0]).not.toHaveProperty('quotaOverride');
  });

  it('rejects forged quota override and grant selectors before calling Communities', async () => {
    const issue = vi.fn<CommunityDirectInviteService['issue']>();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ issue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/direct-invites`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'direct-invite-create-route-override-forgery',
      },
      payload: {
        expectedIssuerMembershipRevision: 7,
        quotaOverride: {
          capability: 'communities.invite.quota.override',
          reasonCode: 'FORGED',
          ticketId: 'FORGED-1',
        },
        quotaGrantId: '33333333-3333-4333-8333-333333333333',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_DIRECT_INVITE_CREATE_INVALID' });
    expect(issue).not.toHaveBeenCalled();
  });

  it('returns stable quota errors with a bounded Retry-After', async () => {
    const issue = vi.fn<CommunityDirectInviteService['issue']>().mockResolvedValue({
      outcome: 'daily_limit_exceeded',
      retryAfterSeconds: 3600,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ issue }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/local-padel/communities/${communityId}/direct-invites`,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'direct-invite-create-route-quota-0001',
      },
      payload: { expectedIssuerMembershipRevision: 7 },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('3600');
    expect(response.json()).toMatchObject({
      code: 'COMMUNITY_DIRECT_INVITE_DAILY_LIMIT_EXCEEDED',
    });
  });

  it('keeps an existing request pending instead of auto-approving it', async () => {
    const redeem = vi
      .fn<CommunityDirectInviteService['redeem']>()
      .mockResolvedValue({ outcome: 'request_pending' });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityDirectInviteService: service({ redeem }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/community-direct-invites/redeem',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'test-replay-key-0001',
      },
      payload: { token, expectedInviteRevision: 1, expectedMembershipRevision: 3 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_DIRECT_INVITE_REQUEST_PENDING' });
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }));
  });
});
