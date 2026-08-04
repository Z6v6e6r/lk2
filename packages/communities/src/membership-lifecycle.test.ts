import { describe, expect, it, vi } from 'vitest';

import {
  createCommunityMembershipLifecycleService,
  type CommunityMembershipLifecycleError,
  type CommunityMembershipLifecycleRepository,
} from './membership-lifecycle.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const requestedAt = '2026-08-03T10:00:00.000Z';
const decidedAt = '2026-08-03T11:00:00.000Z';

const commandBase = {
  tenantId,
  actorUserId,
  communityId,
  idempotencyKey: 'membership-lifecycle-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'membership-lifecycle-correlation',
} as const;

const pendingRequest = {
  id: requestId,
  communityId,
  userId: actorUserId,
  state: 'PENDING' as const,
  originStatus: 'REMOVED' as const,
  revision: 1,
  requestedAt,
};

const pendingMembership = {
  communityId,
  status: 'PENDING' as const,
  role: 'MEMBER' as const,
  revision: 4,
  updatedAt: requestedAt,
  pendingRequest,
  joinAction: 'MEMBERSHIP_PENDING' as const,
};

function repository(
  overrides: Partial<CommunityMembershipLifecycleRepository> = {},
): CommunityMembershipLifecycleRepository {
  return {
    getOwnState: vi.fn().mockResolvedValue({
      outcome: 'found',
      membership: {
        communityId,
        status: 'ABSENT',
        role: null,
        revision: 0,
        pendingRequest: null,
        joinAction: 'REQUEST_TO_JOIN',
        updatedAt: null,
      },
    }),
    selfJoin: vi.fn().mockResolvedValue({
      outcome: 'requested',
      membership: pendingMembership,
      replayed: false,
    }),
    cancelPending: vi.fn().mockResolvedValue({ outcome: 'request_not_pending' }),
    leave: vi.fn().mockResolvedValue({ outcome: 'membership_not_active' }),
    listPending: vi.fn().mockResolvedValue({ outcome: 'found', items: [] }),
    approve: vi.fn().mockResolvedValue({ outcome: 'request_not_found' }),
    reject: vi.fn().mockResolvedValue({ outcome: 'request_not_found' }),
    ...overrides,
  };
}

describe('community membership lifecycle service', () => {
  it('returns a canonical own state without accepting another user selector', async () => {
    const getOwnState = vi.fn().mockResolvedValue({
      outcome: 'found',
      membership: {
        communityId,
        status: 'ACTIVE',
        role: 'ADMIN',
        revision: 0,
        updatedAt: requestedAt,
        pendingRequest: null,
        joinAction: 'OPEN_COMMUNITY',
      },
    });
    const service = createCommunityMembershipLifecycleService(repository({ getOwnState }));
    const input = { tenantId, actorUserId, communityId, correlationId: commandBase.correlationId };

    await expect(service.getOwnState(input)).resolves.toMatchObject({
      outcome: 'found',
      membership: { status: 'ACTIVE', role: 'ADMIN', revision: 0 },
    });
    expect(getOwnState).toHaveBeenCalledWith(input);
  });

  it('lets the repository choose an immediate join or a pending request', async () => {
    const selfJoin = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'joined',
        membership: {
          communityId,
          status: 'ACTIVE',
          role: 'MEMBER',
          revision: 1,
          updatedAt: requestedAt,
          pendingRequest: null,
          joinAction: 'OPEN_COMMUNITY',
        },
        replayed: false,
      })
      .mockResolvedValueOnce({
        outcome: 'requested',
        membership: pendingMembership,
        replayed: false,
      });
    const service = createCommunityMembershipLifecycleService(repository({ selfJoin }));
    const command = { ...commandBase, expectedMembershipRevision: 0 };

    await expect(service.selfJoin(command)).resolves.toMatchObject({ outcome: 'joined' });
    await expect(service.selfJoin(command)).resolves.toMatchObject({
      outcome: 'requested',
      membership: { status: 'PENDING', pendingRequest: { originStatus: 'REMOVED' } },
    });
    expect(selfJoin).toHaveBeenNthCalledWith(1, command);
  });

  it('cancels only a revision-checked pending request and restores its origin state', async () => {
    const cancelPending = vi.fn().mockResolvedValue({
      outcome: 'cancelled',
      membership: {
        communityId,
        status: 'REMOVED',
        role: 'MEMBER',
        revision: 5,
        updatedAt: decidedAt,
        pendingRequest: null,
        joinAction: 'REQUEST_REJOIN',
      },
      request: {
        ...pendingRequest,
        state: 'CANCELLED',
        revision: 2,
        decidedByUserId: actorUserId,
        decidedAt,
      },
      replayed: false,
    });
    const service = createCommunityMembershipLifecycleService(repository({ cancelPending }));
    const command = {
      ...commandBase,
      requestId,
      expectedMembershipRevision: 4,
      expectedRequestRevision: 1,
    };

    await expect(service.cancelPending(command)).resolves.toMatchObject({
      outcome: 'cancelled',
      membership: { status: 'REMOVED', revision: 5 },
      request: { state: 'CANCELLED', revision: 2 },
    });
    expect(cancelPending).toHaveBeenCalledWith(command);
  });

  it('enforces that a successful leave returns LEFT/MEMBER with a new revision', async () => {
    const leave = vi.fn().mockResolvedValue({
      outcome: 'left',
      membership: {
        communityId,
        status: 'LEFT',
        role: 'MEMBER',
        revision: 9,
        updatedAt: decidedAt,
        pendingRequest: null,
        joinAction: 'REQUEST_TO_JOIN',
      },
      replayed: false,
    });
    const service = createCommunityMembershipLifecycleService(repository({ leave }));
    const command = { ...commandBase, expectedMembershipRevision: 8 };

    await expect(service.leave(command)).resolves.toMatchObject({
      outcome: 'left',
      membership: { status: 'LEFT', role: 'MEMBER', revision: 9 },
    });
  });

  it('lists only bounded canonical pending requests for an authorized admin', async () => {
    const listPending = vi.fn().mockResolvedValue({
      outcome: 'found',
      items: [{ request: pendingRequest, membershipRevision: 4 }],
      nextCursor: 'pending-request-cursor-0001',
    });
    const service = createCommunityMembershipLifecycleService(repository({ listPending }));
    const query = {
      tenantId,
      actorUserId,
      communityId,
      limit: 20,
      correlationId: commandBase.correlationId,
    };

    await expect(service.listPending(query)).resolves.toMatchObject({
      outcome: 'found',
      items: [{ membershipRevision: 4, request: { state: 'PENDING' } }],
    });
    expect(listPending).toHaveBeenCalledWith(query);
  });

  it('approves and rejects with both membership and request revisions', async () => {
    const approve = vi.fn().mockResolvedValue({
      outcome: 'approved',
      membership: {
        communityId,
        status: 'ACTIVE',
        role: 'MEMBER',
        revision: 5,
        updatedAt: decidedAt,
        pendingRequest: null,
        joinAction: 'OPEN_COMMUNITY',
      },
      request: {
        ...pendingRequest,
        state: 'APPROVED',
        revision: 2,
        decidedByUserId: actorUserId,
        decidedAt,
      },
      replayed: false,
    });
    const reject = vi.fn().mockResolvedValue({
      outcome: 'rejected',
      membership: {
        communityId,
        status: 'REMOVED',
        role: 'MEMBER',
        revision: 5,
        updatedAt: decidedAt,
        pendingRequest: null,
        joinAction: 'REQUEST_REJOIN',
      },
      request: {
        ...pendingRequest,
        state: 'REJECTED',
        revision: 2,
        decidedByUserId: actorUserId,
        decidedAt,
        reasonCode: 'COMMUNITY_RULES',
      },
      replayed: false,
    });
    const service = createCommunityMembershipLifecycleService(repository({ approve, reject }));
    const decision = {
      tenantId,
      actorUserId,
      idempotencyKey: commandBase.idempotencyKey,
      requestHash: commandBase.requestHash,
      correlationId: commandBase.correlationId,
      requestId,
      expectedMembershipRevision: 4,
      expectedRequestRevision: 1,
    };

    await expect(service.approve(decision)).resolves.toMatchObject({
      outcome: 'approved',
      membership: { status: 'ACTIVE', role: 'MEMBER' },
    });
    await expect(
      service.reject({ ...decision, reasonCode: 'COMMUNITY_RULES' }),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      membership: { status: 'REMOVED' },
      request: { state: 'REJECTED', reasonCode: 'COMMUNITY_RULES' },
    });
  });

  it('passes stable conflicts through and rejects invalid commands or repository states', async () => {
    const selfJoin = vi.fn().mockResolvedValue({
      outcome: 'revision_conflict',
      currentRevision: 6,
    });
    const leave = vi.fn().mockResolvedValue({
      outcome: 'left',
      membership: {
        communityId,
        status: 'LEFT',
        role: 'ADMIN',
        revision: 2,
        updatedAt: decidedAt,
        pendingRequest: null,
        joinAction: 'REQUEST_TO_JOIN',
      },
      replayed: false,
    });
    const service = createCommunityMembershipLifecycleService(repository({ selfJoin, leave }));

    await expect(
      service.selfJoin({ ...commandBase, expectedMembershipRevision: 5 }),
    ).resolves.toEqual({ outcome: 'revision_conflict', currentRevision: 6 });
    await expect(
      service.selfJoin({ ...commandBase, expectedMembershipRevision: -1 }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommunityMembershipLifecycleError>>({
        code: 'COMMUNITY_MEMBERSHIP_LIFECYCLE_INVALID',
      }),
    );
    await expect(service.leave({ ...commandBase, expectedMembershipRevision: 1 })).rejects.toEqual(
      expect.objectContaining<Partial<CommunityMembershipLifecycleError>>({
        code: 'COMMUNITY_MEMBERSHIP_LIFECYCLE_INVALID',
      }),
    );
  });
});
