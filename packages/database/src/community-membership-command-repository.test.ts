import { describe, expect, it, vi } from 'vitest';

import { createCommunityMembershipPinRepository } from './community-membership-command-repository.js';

const input = {
  tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
  actorUserId: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  communityId: '11111111-1111-4111-8111-111111111111',
  pinned: true,
  expectedRevision: 2,
  idempotencyKey: 'community-pin-test-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-pin-correlation',
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

describe('community membership pin repository', () => {
  it('commits state, idempotency, audit and outbox in one tenant transaction', async () => {
    const changedAt = new Date('2026-08-03T10:00:00.000Z');
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from communities.membership_pin_commands')) return [];
      if (text.includes('from communities.memberships m')) {
        expect(values).toEqual([input.tenantId, input.communityId, input.actorUserId]);
        return [{ pinned_at: null, revision: 2, updated_at: changedAt }];
      }
      if (text.includes('update communities.memberships')) {
        return [{ pinned_at: changedAt, revision: 3, updated_at: changedAt }];
      }
      return [];
    });

    await expect(createCommunityMembershipPinRepository(pool).setPin(input)).resolves.toMatchObject(
      {
        outcome: 'applied',
        replayed: false,
        membership: { communityId: input.communityId, pinned: true, revision: 3 },
      },
    );
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [
      input.tenantId,
    ]);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into communities.membership_pin_commands'),
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

  it('replays a matching command and rejects a reused key with another hash', async () => {
    const stored = {
      communityId: input.communityId,
      pinned: true,
      revision: 3,
      updatedAt: '2026-08-03T10:00:00.000Z',
    };
    const matching = poolWithQuery((text) =>
      text.includes('from communities.membership_pin_commands')
        ? [{ request_hash: input.requestHash, result_payload: stored }]
        : [],
    );
    await expect(
      createCommunityMembershipPinRepository(matching.pool).setPin(input),
    ).resolves.toMatchObject({
      outcome: 'applied',
      replayed: true,
      membership: stored,
    });
    expect(
      matching.query.mock.calls.some(([text]) =>
        String(text).includes('update communities.memberships'),
      ),
    ).toBe(false);

    const conflict = poolWithQuery((text) =>
      text.includes('from communities.membership_pin_commands')
        ? [{ request_hash: 'b'.repeat(64), result_payload: stored }]
        : [],
    );
    await expect(
      createCommunityMembershipPinRepository(conflict.pool).setPin(input),
    ).resolves.toEqual({
      outcome: 'idempotency_conflict',
    });
  });
});
