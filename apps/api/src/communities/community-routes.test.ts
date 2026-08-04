import type {
  CommunityCreateService,
  CommunityDirectoryService,
  CommunityMembershipLifecycleService,
  CommunityReadService,
  CommunityOwnershipTransferService,
} from '@phub/communities';
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

async function accessToken(permissions: readonly string[] = ['communities.read']): Promise<string> {
  return new SignJWT({
    tenants: [tenantId],
    roles: ['client'],
    permissions,
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
  it('joins using only the JWT subject and a server-selected lifecycle transition', async () => {
    const selfJoin = vi.fn<CommunityMembershipLifecycleService['selfJoin']>().mockResolvedValue({
      outcome: 'requested',
      membership: {
        communityId: '11111111-1111-4111-8111-111111111111',
        status: 'PENDING',
        role: 'MEMBER',
        revision: 1,
        updatedAt: '2026-08-03T10:00:00.000Z',
        pendingRequest: {
          id: '22222222-2222-4222-8222-222222222222',
          communityId: '11111111-1111-4111-8111-111111111111',
          userId,
          state: 'PENDING',
          originStatus: 'ABSENT',
          revision: 1,
          requestedAt: '2026-08-03T10:00:00.000Z',
        },
        joinAction: 'MEMBERSHIP_PENDING',
      },
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMembershipLifecycleService: {
        getOwnState: vi.fn(),
        selfJoin,
        cancelPending: vi.fn(),
        leave: vi.fn(),
        listPending: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/members/me/join',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-join-route-test-0001',
      },
      payload: { expectedMembershipRevision: 0 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      membershipStatus: 'PENDING',
      joinRequest: { kind: 'JOIN', status: 'PENDING' },
    });
    expect(selfJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        communityId: '11111111-1111-4111-8111-111111111111',
        expectedMembershipRevision: 0,
      }),
    );
    expect(selfJoin.mock.calls[0]?.[0]).not.toHaveProperty('role');
  });

  it('keeps banned join attempts fail-closed', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMembershipLifecycleService: {
        getOwnState: vi.fn(),
        selfJoin: vi.fn().mockResolvedValue({ outcome: 'membership_banned' }),
        cancelPending: vi.fn(),
        leave: vi.fn(),
        listPending: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/members/me/join',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-join-banned-test-0001',
      },
      payload: { expectedMembershipRevision: 3 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_MEMBERSHIP_BANNED' });
  });

  it('serves bounded authenticated discovery without client identity selectors', async () => {
    const listDiscoverable = vi.fn<CommunityReadService['listDiscoverable']>().mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Private Padel',
          logoUrl: null,
          isVerified: true,
          visibility: 'LISTED_PRIVATE',
          joinAction: 'REQUEST_TO_JOIN',
        },
      ],
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityReadService: { listDiscoverable, getDetail: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/communities?query=Private&limit=10',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items[0]).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Private Padel',
      logoUrl: null,
      isVerified: true,
      visibility: 'LISTED_PRIVATE',
      joinAction: 'REQUEST_TO_JOIN',
    });
    expect(listDiscoverable).toHaveBeenCalledWith({
      tenantId,
      viewerUserId: userId,
      query: 'Private',
      limit: 10,
    });
  });

  it('returns one indistinguishable 404 for missing and inaccessible HIDDEN detail', async () => {
    const getDetail = vi.fn<CommunityReadService['getDetail']>().mockResolvedValue({
      outcome: 'not_found',
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityReadService: { listDiscoverable: vi.fn(), getDetail },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_NOT_FOUND' });
    expect(getDetail).toHaveBeenCalledWith({
      tenantId,
      viewerUserId: userId,
      communityId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('does not accept an invite proof before the signed invite contract exists', async () => {
    const getDetail = vi.fn<CommunityReadService['getDetail']>();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityReadService: { listDiscoverable: vi.fn(), getDetail },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111?inviteCode=legacy-code',
      headers: { authorization: `Bearer ${await accessToken()}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_DETAIL_QUERY_INVALID' });
    expect(getDetail).not.toHaveBeenCalled();
  });

  it('creates a community for the JWT subject without accepting a quota override', async () => {
    const created = {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Padel Friends',
      description: null,
      visibility: 'PUBLIC' as const,
      joinPolicy: 'INSTANT' as const,
      publishingPreset: 'OPEN_COMMUNITY' as const,
      status: 'ACTIVE' as const,
      revision: 1 as const,
      ownerUserId: userId,
      createdAt: '2026-08-03T10:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    const create = vi.fn<CommunityCreateService['create']>().mockResolvedValue({
      outcome: 'created',
      community: created,
      replayed: false,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityCreateService: { create },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities',
      headers: {
        authorization: `Bearer ${await accessToken(['communities.create'])}`,
        'idempotency-key': 'community-create-route-0001',
      },
      payload: {
        title: '  Padel Friends  ',
        visibility: 'PUBLIC',
        joinPolicy: 'INSTANT',
        publishingPreset: 'OPEN_COMMUNITY',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-idempotent-replayed']).toBe('false');
    expect(response.json()).toEqual(created);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        title: 'Padel Friends',
        quotaOverride: false,
      }),
    );
  });

  it('requires communities.create and rejects client-supplied authority fields', async () => {
    const create = vi.fn<CommunityCreateService['create']>();
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityCreateService: { create },
    });
    apps.push(app);

    const withoutCapability = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-create-route-0002',
      },
      payload: {
        title: 'Padel Friends',
        visibility: 'PUBLIC',
        joinPolicy: 'INSTANT',
        publishingPreset: 'OPEN_COMMUNITY',
      },
    });
    expect(withoutCapability.statusCode).toBe(403);
    expect(withoutCapability.json()).toMatchObject({
      code: 'COMMUNITY_CREATE_PERMISSION_REQUIRED',
    });

    const forgedOverride = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities',
      headers: {
        authorization: `Bearer ${await accessToken(['communities.create'])}`,
        'idempotency-key': 'community-create-route-0003',
      },
      payload: {
        title: 'Padel Friends',
        visibility: 'PUBLIC',
        joinPolicy: 'INSTANT',
        publishingPreset: 'OPEN_COMMUNITY',
        quotaOverride: true,
      },
    });
    expect(forgedOverride.statusCode).toBe(400);
    expect(forgedOverride.json()).toMatchObject({ code: 'COMMUNITY_CREATE_PAYLOAD_INVALID' });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns a stable rolling-quota error and Retry-After', async () => {
    const create = vi.fn<CommunityCreateService['create']>().mockResolvedValue({
      outcome: 'daily_create_quota_exceeded',
      retryAfterSeconds: 3600,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityCreateService: { create },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities',
      headers: {
        authorization: `Bearer ${await accessToken(['communities.create'])}`,
        'idempotency-key': 'community-create-route-0004',
      },
      payload: {
        title: 'Padel Friends',
        visibility: 'PUBLIC',
        joinPolicy: 'MODERATED',
        publishingPreset: 'MODERATED_FEED',
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('3600');
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_DAILY_CREATE_QUOTA_EXCEEDED' });
  });

  it('fails closed when canonical creation is disabled', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities',
      headers: {
        authorization: `Bearer ${await accessToken(['communities.create'])}`,
        'idempotency-key': 'community-create-route-0005',
      },
      payload: {
        title: 'Padel Friends',
        visibility: 'PUBLIC',
        joinPolicy: 'INSTANT',
        publishingPreset: 'OPEN_COMMUNITY',
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_COMMAND_UNAVAILABLE' });
  });

  it('transfers ownership from the JWT owner with optimistic revisions', async () => {
    const targetUserId = '22222222-2222-4222-8222-222222222222';
    const transfer = vi.fn<CommunityOwnershipTransferService['transfer']>().mockResolvedValue({
      outcome: 'transferred',
      replayed: false,
      transfer: {
        communityId: '11111111-1111-4111-8111-111111111111',
        previousOwner: { userId, role: 'ADMIN', revision: 5 },
        owner: { userId: targetUserId, previousRole: 'MEMBER', role: 'OWNER', revision: 3 },
        transferredAt: '2026-08-04T12:00:00.000Z',
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityOwnershipTransferService: { transfer },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/ownership-transfers',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-owner-transfer-route-0001',
      },
      payload: {
        targetUserId,
        expectedOwnerRevision: 4,
        expectedTargetRevision: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-idempotent-replayed']).toBe('false');
    expect(response.json()).toMatchObject({
      previousOwner: { userId, role: 'ADMIN', revision: 5 },
      owner: { userId: targetUserId, role: 'OWNER', revision: 3 },
    });
    expect(transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorUserId: userId,
        targetUserId,
        expectedOwnerRevision: 4,
        expectedTargetRevision: 2,
      }),
    );
  });

  it('rejects self-transfer and fails closed for a stale target revision', async () => {
    const transfer = vi.fn<CommunityOwnershipTransferService['transfer']>().mockResolvedValue({
      outcome: 'target_revision_conflict',
      currentRevision: 3,
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityOwnershipTransferService: { transfer },
    });
    apps.push(app);

    const self = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/ownership-transfers',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-owner-transfer-route-0002',
      },
      payload: { targetUserId: userId, expectedOwnerRevision: 4, expectedTargetRevision: 4 },
    });
    expect(self.statusCode).toBe(400);
    expect(transfer).not.toHaveBeenCalled();

    const stale = await app.inject({
      method: 'POST',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/ownership-transfers',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-owner-transfer-route-0003',
      },
      payload: {
        targetUserId: '22222222-2222-4222-8222-222222222222',
        expectedOwnerRevision: 4,
        expectedTargetRevision: 2,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'COMMUNITY_MEMBERSHIP_REVISION_CONFLICT' });
  });

  it('loads an authenticated page and passes the continuation cursor to the domain service', async () => {
    const listMemberships = vi.fn().mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Padel Friends',
          logoUrl: null,
          isVerified: true,
          unreadChatCount: 2,
          memberRank: 4,
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
      items: [{ id: '11111111-1111-4111-8111-111111111111', memberRank: 4 }],
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

  it('pins only the JWT subject membership and returns the stored revision', async () => {
    const setPin = vi.fn().mockResolvedValue({
      outcome: 'applied',
      replayed: false,
      membership: {
        communityId: '11111111-1111-4111-8111-111111111111',
        pinned: true,
        revision: 3,
        updatedAt: '2026-08-03T10:00:00.000Z',
      },
    });
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
      communityMembershipPinService: { setPin },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/members/me/pin',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-pin-route-0001',
      },
      payload: { pinned: true, expectedRevision: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ pinned: true, revision: 3 });
    expect(setPin).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, actorUserId: userId, expectedRevision: 2 }),
    );
  });

  it('fails closed when the canonical membership command runtime is disabled', async () => {
    const app = await buildApp({
      config,
      logger: createLogger('api-test', 'silent'),
      pool: fakePool(),
    });
    apps.push(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/user/api/v1/local-padel/communities/11111111-1111-4111-8111-111111111111/members/me/pin',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'idempotency-key': 'community-pin-route-0002',
      },
      payload: { pinned: false, expectedRevision: 3 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'COMMUNITY_COMMAND_UNAVAILABLE' });
  });
});
