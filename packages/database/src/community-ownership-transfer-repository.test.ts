import { describe, expect, it, vi } from 'vitest';

import { createCommunityOwnershipTransferRepository } from './community-ownership-transfer-repository.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  targetUserId: '22222222-2222-4222-8222-222222222222',
  expectedOwnerRevision: 4,
  expectedTargetRevision: 2,
  idempotencyKey: 'owner-transfer-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'owner-transfer-correlation',
} as const;

function poolWithQuery(handler: (text: string, values: readonly unknown[]) => readonly unknown[]) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: handler(text, values) });
  });
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
    query,
  };
}

function successfulPool() {
  const transferredAt = new Date('2026-08-04T12:00:00.000Z');
  let update = 0;
  return poolWithQuery((text) => {
    if (text.includes('from communities.ownership_transfer_commands')) return [];
    if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
    if (text.includes('from communities.communities')) return [{ status: 'ACTIVE' }];
    if (text.includes('from communities.memberships')) {
      return [
        { user_id: input.actorUserId, role: 'OWNER', status: 'ACTIVE', revision: 4 },
        { user_id: input.targetUserId, role: 'MEMBER', status: 'ACTIVE', revision: 2 },
      ];
    }
    if (text.includes('update communities.memberships')) {
      update += 1;
      return [{ revision: update === 1 ? 5 : 3, updated_at: transferredAt }];
    }
    return [];
  });
}

describe('community ownership transfer repository', () => {
  it('commits both role changes, replay state, audit and outbox atomically', async () => {
    const { pool, query } = successfulPool();
    await expect(createCommunityOwnershipTransferRepository(pool).transfer(input)).resolves.toEqual(
      {
        outcome: 'transferred',
        replayed: false,
        transfer: {
          communityId: input.communityId,
          previousOwner: { userId: input.actorUserId, role: 'ADMIN', revision: 5 },
          owner: {
            userId: input.targetUserId,
            previousRole: 'MEMBER',
            role: 'OWNER',
            revision: 3,
          },
          transferredAt: '2026-08-04T12:00:00.000Z',
        },
      },
    );
    expect(
      query.mock.calls.filter(([text]) => String(text).includes('update communities.memberships')),
    ).toHaveLength(2);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('ownership_transfer_commands')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(true);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('replays before authorization and rejects request-hash reuse', async () => {
    const transfer = {
      communityId: input.communityId,
      previousOwner: { userId: input.actorUserId, role: 'ADMIN', revision: 5 },
      owner: {
        userId: input.targetUserId,
        previousRole: 'MEMBER',
        role: 'OWNER',
        revision: 3,
      },
      transferredAt: '2026-08-04T12:00:00.000Z',
    } as const;
    const replay = poolWithQuery((text) =>
      text.includes('from communities.ownership_transfer_commands')
        ? [{ request_hash: input.requestHash, result_payload: transfer }]
        : [],
    );
    await expect(
      createCommunityOwnershipTransferRepository(replay.pool).transfer(input),
    ).resolves.toEqual({ outcome: 'transferred', transfer, replayed: true });
    expect(
      replay.query.mock.calls.some(([text]) => String(text).includes('from identity.users')),
    ).toBe(false);

    const conflict = poolWithQuery((text) =>
      text.includes('from communities.ownership_transfer_commands')
        ? [{ request_hash: 'b'.repeat(64), result_payload: transfer }]
        : [],
    );
    await expect(
      createCommunityOwnershipTransferRepository(conflict.pool).transfer(input),
    ).resolves.toEqual({ outcome: 'idempotency_conflict' });
  });

  it('fails closed for stale revisions and inactive targets', async () => {
    const stale = successfulPool();
    await expect(
      createCommunityOwnershipTransferRepository(stale.pool).transfer({
        ...input,
        expectedTargetRevision: 1,
      }),
    ).resolves.toEqual({ outcome: 'target_revision_conflict', currentRevision: 2 });

    const inactive = poolWithQuery((text) => {
      if (text.includes('ownership_transfer_commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.memberships')) {
        return [
          { user_id: input.actorUserId, role: 'OWNER', status: 'ACTIVE', revision: 4 },
          { user_id: input.targetUserId, role: 'MEMBER', status: 'LEFT', revision: 2 },
        ];
      }
      return [];
    });
    await expect(
      createCommunityOwnershipTransferRepository(inactive.pool).transfer(input),
    ).resolves.toEqual({ outcome: 'target_not_active' });
  });
});
