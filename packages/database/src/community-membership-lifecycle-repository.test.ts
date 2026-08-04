import { describe, expect, it, vi } from 'vitest';

import { createCommunityMembershipLifecycleRepository } from './community-membership-lifecycle-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const subjectUserId = '33333333-3333-4333-8333-333333333333';
const communityId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const at = new Date('2026-08-03T10:00:00.000Z');
const later = new Date('2026-08-03T11:00:00.000Z');

const commandBase = {
  tenantId,
  actorUserId,
  communityId,
  idempotencyKey: 'membership-lifecycle-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'membership-lifecycle-correlation',
} as const;

const adminCommandBase = {
  tenantId,
  actorUserId,
  idempotencyKey: 'membership-lifecycle-admin-0001',
  requestHash: 'b'.repeat(64),
  correlationId: 'membership-lifecycle-admin-correlation',
} as const;

function poolWithQuery(handler: (text: string, values: readonly unknown[]) => unknown) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: (handler(text, values) as readonly unknown[]) ?? [] });
  });
  const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) };
  return { pool: pool as never, query };
}

function activeActorAndCommunity(text: string): readonly unknown[] | undefined {
  if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
  if (text.includes('from communities.communities')) {
    return [{ join_policy: 'INSTANT', visibility: 'PUBLIC' }];
  }
  return undefined;
}

function pendingRequestRow(
  overrides: Partial<{
    community_id: string;
    user_id: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
    origin_status: 'ABSENT' | 'LEFT' | 'REMOVED';
    revision: number;
    decided_by: string | null;
    decided_at: Date | null;
    decision_reason_code: string | null;
  }> = {},
) {
  return {
    id: requestId,
    community_id: communityId,
    user_id: subjectUserId,
    status: 'PENDING' as const,
    origin_status: 'ABSENT' as const,
    revision: 1,
    requested_at: at,
    decided_by: null,
    decided_at: null,
    decision_reason_code: null,
    ...overrides,
  };
}

describe('community membership lifecycle repository', () => {
  it('reads revision zero as a valid tenant-scoped membership state', async () => {
    const { pool, query } = poolWithQuery((text) => {
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships')) {
        return [{ status: 'BANNED', role: 'ADMIN', revision: 0, updated_at: at }];
      }
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).getOwnState({
        tenantId,
        actorUserId,
        communityId,
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toEqual({
      outcome: 'found',
      membership: {
        communityId,
        status: 'BANNED',
        role: 'MEMBER',
        revision: 0,
        updatedAt: at.toISOString(),
        pendingRequest: null,
        joinAction: 'UNAVAILABLE',
      },
    });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('hides a HIDDEN community from an actor with no membership state', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities')) {
        return [{ join_policy: 'INSTANT', visibility: 'HIDDEN' }];
      }
      if (text.includes('from communities.memberships')) return [];
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).getOwnState({
        tenantId,
        actorUserId,
        communityId,
        correlationId: commandBase.correlationId,
      }),
    ).resolves.toEqual({ outcome: 'community_not_found' });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('from communities.join_requests')),
    ).toBe(false);
  });

  it('fails a HIDDEN absent self-join without creating canonical state', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities')) {
        return [{ join_policy: 'INSTANT', visibility: 'HIDDEN' }];
      }
      if (text.includes('from communities.memberships') && text.includes('for update')) return [];
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).selfJoin({
        ...commandBase,
        expectedMembershipRevision: 0,
      }),
    ).resolves.toEqual({ outcome: 'community_not_found' });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.memberships'),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(false);
  });

  it('joins an absent user instantly and commits state, command, audit and outbox atomically', async () => {
    const input = { ...commandBase, expectedMembershipRevision: 0 };
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships') && text.includes('for update')) return [];
      if (text.includes('insert into communities.memberships')) {
        expect(values).toEqual([tenantId, communityId, actorUserId]);
        return [{ status: 'ACTIVE', role: 'MEMBER', revision: 1, updated_at: at }];
      }
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).selfJoin(input),
    ).resolves.toEqual({
      outcome: 'joined',
      membership: {
        communityId,
        status: 'ACTIVE',
        role: 'MEMBER',
        revision: 1,
        updatedAt: at.toISOString(),
        pendingRequest: null,
        joinAction: 'OPEN_COMMUNITY',
      },
      replayed: false,
    });
    expect(
      query.mock.calls.filter(([text]) => String(text).includes('select pg_advisory_xact_lock')),
    ).toHaveLength(2);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.membership_lifecycle_commands'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('never restores REMOVED through INSTANT join and creates one revisioned request instead', async () => {
    const input = { ...commandBase, expectedMembershipRevision: 0 };
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'REMOVED', role: 'ADMIN', revision: 0, updated_at: at }];
      }
      if (text.includes("set status = 'PENDING'")) {
        return [{ status: 'PENDING', role: 'MEMBER', revision: 1, updated_at: later }];
      }
      if (text.includes('insert into communities.join_requests')) {
        return [
          pendingRequestRow({
            user_id: actorUserId,
            origin_status: 'REMOVED',
          }),
        ];
      }
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).selfJoin(input),
    ).resolves.toMatchObject({
      outcome: 'requested',
      membership: {
        status: 'PENDING',
        role: 'MEMBER',
        revision: 1,
        pendingRequest: { originStatus: 'REMOVED', state: 'PENDING' },
      },
      replayed: false,
    });
    expect(
      query.mock.calls.some(
        ([text, values]) =>
          String(text).includes('insert into communities.join_requests') &&
          (values as readonly unknown[])[3] === 'REJOIN',
      ),
    ).toBe(true);
  });

  it('fails closed for a banned membership without recording a command or event', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'BANNED', role: 'MEMBER', revision: 0, updated_at: at }];
      }
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).selfJoin({
        ...commandBase,
        expectedMembershipRevision: 99,
      }),
    ).resolves.toEqual({ outcome: 'membership_banned' });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('membership_lifecycle_commands (')),
    ).toBe(false);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(false);
  });

  it('replays only the same JOIN request hash and rejects key reuse across payloads', async () => {
    const stored = {
      outcome: 'joined',
      membership: {
        communityId,
        status: 'ACTIVE',
        role: 'MEMBER',
        revision: 1,
        updatedAt: at.toISOString(),
        pendingRequest: null,
        joinAction: 'OPEN_COMMUNITY',
      },
    };
    const matching = poolWithQuery((text) =>
      text.includes('from communities.membership_lifecycle_commands')
        ? [{ command_type: 'JOIN', request_hash: commandBase.requestHash, result_payload: stored }]
        : [],
    );
    await expect(
      createCommunityMembershipLifecycleRepository(matching.pool).selfJoin({
        ...commandBase,
        expectedMembershipRevision: 0,
      }),
    ).resolves.toMatchObject({ outcome: 'joined', replayed: true });
    expect(
      matching.query.mock.calls.some(([text]) => String(text).includes('from identity.users')),
    ).toBe(false);

    const conflict = poolWithQuery((text) =>
      text.includes('from communities.membership_lifecycle_commands')
        ? [{ command_type: 'JOIN', request_hash: 'c'.repeat(64), result_payload: stored }]
        : [],
    );
    await expect(
      createCommunityMembershipLifecycleRepository(conflict.pool).selfJoin({
        ...commandBase,
        expectedMembershipRevision: 0,
      }),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
  });

  it('cancels an absent-origin pending request by revision and deletes the transient membership', async () => {
    const input = {
      ...commandBase,
      requestId,
      expectedMembershipRevision: 1,
      expectedRequestRevision: 1,
    };
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'PENDING', role: 'MEMBER', revision: 1, updated_at: at }];
      }
      if (text.includes('from communities.join_requests') && text.includes('for update')) {
        return [pendingRequestRow({ user_id: actorUserId })];
      }
      if (text.includes('update communities.join_requests')) {
        return [
          pendingRequestRow({
            user_id: actorUserId,
            status: 'CANCELLED',
            revision: 2,
            decided_by: actorUserId,
            decided_at: later,
          }),
        ];
      }
      if (text.includes('delete from communities.memberships')) return [{ user_id: actorUserId }];
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).cancelPending(input),
    ).resolves.toMatchObject({
      outcome: 'cancelled',
      membership: { status: 'ABSENT', revision: 0 },
      request: { state: 'CANCELLED', revision: 2 },
      replayed: false,
    });
    expect(
      query.mock.calls.some(([text, values]) => {
        return (
          String(text).includes('delete from communities.memberships') &&
          (values as readonly unknown[])[3] === 1
        );
      }),
    ).toBe(true);
  });

  it('prevents an owner from leaving and accepts revision zero for an ordinary member', async () => {
    const owner = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'ACTIVE', role: 'OWNER', revision: 0, updated_at: at }];
      }
      return [];
    });
    await expect(
      createCommunityMembershipLifecycleRepository(owner.pool).leave({
        ...commandBase,
        expectedMembershipRevision: 0,
      }),
    ).resolves.toEqual({ outcome: 'owner_cannot_leave' });

    const member = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      const common = activeActorAndCommunity(text);
      if (common) return common;
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'ACTIVE', role: 'ADMIN', revision: 0, updated_at: at }];
      }
      if (text.includes("set status = 'LEFT'")) {
        return [{ status: 'LEFT', role: 'MEMBER', revision: 1, updated_at: later }];
      }
      return [];
    });
    await expect(
      createCommunityMembershipLifecycleRepository(member.pool).leave({
        ...commandBase,
        expectedMembershipRevision: 0,
      }),
    ).resolves.toMatchObject({
      outcome: 'left',
      membership: { status: 'LEFT', role: 'MEMBER', revision: 1 },
    });
  });

  it('lists a bounded tenant-wide CUP queue with a scope-bound opaque keyset cursor', async () => {
    const secondRequestId = '44444444-4444-4444-8444-444444444444';
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from identity.user_access_profiles')) return [{ authorized: true }];
      if (text.includes('from communities.join_requests r')) {
        return [
          { ...pendingRequestRow(), membership_revision: 0, sort_requested_at: at.toISOString() },
          {
            ...pendingRequestRow({ user_id: actorUserId }),
            id: secondRequestId,
            membership_revision: 3,
            sort_requested_at: later.toISOString(),
          },
        ];
      }
      return [];
    });

    const first = await createCommunityMembershipLifecycleRepository(pool).listPending({
      tenantId,
      actorUserId,
      limit: 1,
      correlationId: adminCommandBase.correlationId,
    });
    expect(first).toMatchObject({
      outcome: 'found',
      items: [{ membershipRevision: 0, request: { id: requestId } }],
    });
    expect(first.outcome === 'found' ? first.nextCursor : undefined).toEqual(expect.any(String));

    if (first.outcome !== 'found' || !first.nextCursor) throw new Error('cursor missing');
    await createCommunityMembershipLifecycleRepository(pool).listPending({
      tenantId,
      actorUserId,
      communityId: undefined,
      limit: 1,
      cursor: first.nextCursor,
      correlationId: adminCommandBase.correlationId,
    });
    const queueCalls = query.mock.calls.filter(([text]) =>
      String(text).includes('from communities.join_requests r'),
    );
    expect(queueCalls[0]?.[1]).toEqual([tenantId, null, null, null, 2]);
    expect(queueCalls[1]?.[1]).toEqual([tenantId, null, at.toISOString(), requestId, 2]);
  });

  it('resolves approve subject and community from the request before the aggregate lock', async () => {
    const input = {
      ...adminCommandBase,
      requestId,
      expectedMembershipRevision: 0,
      expectedRequestRevision: 1,
    };
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from identity.user_access_profiles')) return [{ authorized: true }];
      if (text.includes('select community_id, user_id from communities.join_requests')) {
        expect(values).toEqual([tenantId, requestId]);
        return [{ community_id: communityId, user_id: subjectUserId }];
      }
      if (text.includes('from communities.communities')) {
        return [{ join_policy: 'MODERATED', visibility: 'PUBLIC' }];
      }
      if (text.includes('from communities.join_requests') && text.includes('for update')) {
        return [pendingRequestRow()];
      }
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'PENDING', role: 'MEMBER', revision: 0, updated_at: at }];
      }
      if (text.includes('update communities.join_requests')) {
        return [
          pendingRequestRow({
            status: 'APPROVED',
            revision: 2,
            decided_by: actorUserId,
            decided_at: later,
          }),
        ];
      }
      if (text.includes("set status = 'ACTIVE'")) {
        expect(values).toEqual([tenantId, communityId, subjectUserId, 0]);
        return [{ status: 'ACTIVE', role: 'MEMBER', revision: 1, updated_at: later }];
      }
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(pool).approve(input),
    ).resolves.toMatchObject({
      outcome: 'approved',
      membership: { communityId, status: 'ACTIVE', role: 'MEMBER', revision: 1 },
      request: { userId: subjectUserId, state: 'APPROVED', revision: 2 },
      replayed: false,
    });
    const aggregateLock = query.mock.calls.find(
      ([text, values]) =>
        String(text).includes('pg_advisory_xact_lock') &&
        String((values as readonly unknown[])[0]).startsWith('community-membership:'),
    );
    expect(aggregateLock?.[1]).toEqual([
      `community-membership:${tenantId}:${communityId}:${subjectUserId}`,
    ]);
    const commandInsert = query.mock.calls.find(([text]) =>
      String(text).includes('insert into communities.membership_lifecycle_commands'),
    );
    expect(commandInsert?.[1]).toContain(subjectUserId);
    expect(commandInsert?.[1]).toContain(communityId);
  });

  it('rejects to the durable origin with a reason and denies unprivileged CUP actors first', async () => {
    const denied = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from identity.user_access_profiles')) return [{ authorized: false }];
      return [];
    });
    await expect(
      createCommunityMembershipLifecycleRepository(denied.pool).reject({
        ...adminCommandBase,
        requestId,
        expectedMembershipRevision: 4,
        expectedRequestRevision: 1,
        reasonCode: 'COMMUNITY_RULES',
      }),
    ).resolves.toEqual({ outcome: 'permission_denied' });
    expect(
      denied.query.mock.calls.some(([text]) =>
        String(text).includes('select community_id, user_id from communities.join_requests'),
      ),
    ).toBe(false);

    const allowed = poolWithQuery((text) => {
      if (text.includes('from communities.membership_lifecycle_commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from identity.user_access_profiles')) return [{ authorized: true }];
      if (text.includes('select community_id, user_id from communities.join_requests')) {
        return [{ community_id: communityId, user_id: subjectUserId }];
      }
      if (text.includes('from communities.communities')) {
        return [{ join_policy: 'MODERATED', visibility: 'PUBLIC' }];
      }
      if (text.includes('from communities.join_requests') && text.includes('for update')) {
        return [pendingRequestRow({ origin_status: 'REMOVED' })];
      }
      if (text.includes('from communities.memberships') && text.includes('for update')) {
        return [{ status: 'PENDING', role: 'MEMBER', revision: 4, updated_at: at }];
      }
      if (text.includes('update communities.join_requests')) {
        return [
          pendingRequestRow({
            origin_status: 'REMOVED',
            status: 'REJECTED',
            revision: 2,
            decided_by: actorUserId,
            decided_at: later,
            decision_reason_code: 'COMMUNITY_RULES',
          }),
        ];
      }
      if (text.includes('set status = $5')) {
        return [{ status: 'REMOVED', role: 'MEMBER', revision: 5, updated_at: later }];
      }
      return [];
    });

    await expect(
      createCommunityMembershipLifecycleRepository(allowed.pool).reject({
        ...adminCommandBase,
        requestId,
        expectedMembershipRevision: 4,
        expectedRequestRevision: 1,
        reasonCode: 'COMMUNITY_RULES',
      }),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      membership: { status: 'REMOVED', role: 'MEMBER', revision: 5 },
      request: { state: 'REJECTED', reasonCode: 'COMMUNITY_RULES', revision: 2 },
      replayed: false,
    });
  });
});
