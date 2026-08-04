import { describe, expect, it, vi } from 'vitest';

import { createCommunityMemberCountProjectionRepository } from './community-member-count-projection-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const communityId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';

function repositoryWith(
  handler: (
    text: string,
    values: readonly unknown[],
  ) => { readonly rows?: readonly unknown[]; readonly rowCount?: number },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    const result = handler(text, values);
    return Promise.resolve({ rows: result.rows ?? [], rowCount: result.rowCount ?? 0 });
  });
  return {
    repository: createCommunityMemberCountProjectionRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never),
    query,
  };
}

describe('community member-count projection repository', () => {
  it('applies an ACTIVE contribution exactly once in the inbox transaction', async () => {
    const { repository, query } = repositoryWith((text) => {
      if (text.includes('insert into audit.inbox_events')) return { rowCount: 1 };
      if (text.includes('insert into communities.member_count_projections')) {
        return { rows: [{ community_id: communityId }], rowCount: 1 };
      }
      if (text.includes('from communities.memberships') && text.includes('select status')) {
        return { rows: [{ status: 'ACTIVE', revision: 2 }], rowCount: 1 };
      }
      if (text.includes('from communities.member_count_contributions')) {
        return { rows: [{ is_active: false, membership_revision: 1 }], rowCount: 1 };
      }
      return {};
    });
    await expect(
      repository.projectEvent({
        tenantId,
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'community.member.joined.v1',
        communityId,
        userId,
      }),
    ).resolves.toBe('applied');
    expect(
      query.mock.calls.find(([text]) => String(text).includes('active_member_count + $3'))?.[1],
    ).toEqual([tenantId, communityId, 1]);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('deduplicates before reading canonical membership state', async () => {
    const { repository, query } = repositoryWith((text) =>
      text.includes('insert into audit.inbox_events') ? { rowCount: 0 } : {},
    );
    await expect(
      repository.projectEvent({
        tenantId,
        eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        eventType: 'community.member.left.v1',
        communityId,
        userId,
      }),
    ).resolves.toBe('duplicate');
    expect(
      query.mock.calls.some(([text]) => String(text).includes('communities.memberships')),
    ).toBe(false);
  });

  it('ignores reordered delivery when canonical revision is already projected', async () => {
    const { repository, query } = repositoryWith((text) => {
      if (text.includes('insert into audit.inbox_events')) return { rowCount: 1 };
      if (text.includes('insert into communities.member_count_projections')) {
        return { rows: [{ community_id: communityId }], rowCount: 1 };
      }
      if (text.includes('from communities.memberships') && text.includes('select status')) {
        return { rows: [{ status: 'LEFT', revision: 4 }], rowCount: 1 };
      }
      if (text.includes('from communities.member_count_contributions')) {
        return { rows: [{ is_active: false, membership_revision: 4 }], rowCount: 1 };
      }
      return {};
    });
    await expect(
      repository.projectEvent({
        tenantId,
        eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        eventType: 'community.member.joined.v1',
        communityId,
        userId,
      }),
    ).resolves.toBe('stale');
    expect(
      query.mock.calls.some(([text]) => String(text).includes('active_member_count + $3')),
    ).toBe(false);
  });

  it('advances a bounded reconciliation cursor without declaring readiness', async () => {
    const { repository, query } = repositoryWith((text) => {
      if (text.includes('insert into communities.member_count_projections')) {
        return { rows: [{ community_id: communityId }], rowCount: 1 };
      }
      if (text.includes('select state, reconciliation_cursor')) {
        return { rows: [{ state: 'BUILDING', reconciliation_cursor: null }], rowCount: 1 };
      }
      if (text.includes('with source as materialized')) {
        return {
          rows: [{ processed_count: 250, next_cursor: userId, active_delta: 100 }],
          rowCount: 1,
        };
      }
      return {};
    });
    await expect(
      repository.reconcileBatch({ tenantId, communityId, batchSize: 250 }),
    ).resolves.toEqual({ outcome: 'progressed', processed: 250 });
    expect(
      query.mock.calls.find(([text]) => String(text).includes('reconciliation_cursor = $4'))?.[1],
    ).toEqual([tenantId, communityId, 100, userId]);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('user_id::text from source order by user_id desc limit 1'),
      ),
    ).toBe(true);
  });

  it('marks the projection READY only after canonical and projected counts match', async () => {
    const { repository, query } = repositoryWith((text) => {
      if (text.includes('insert into communities.member_count_projections')) {
        return { rows: [{ community_id: communityId }], rowCount: 1 };
      }
      if (text.includes('select state, reconciliation_cursor')) {
        return { rows: [{ state: 'BUILDING', reconciliation_cursor: userId }], rowCount: 1 };
      }
      if (text.includes('with source as materialized')) {
        return { rows: [{ processed_count: 0, next_cursor: null, active_delta: 0 }], rowCount: 1 };
      }
      if (text.includes('as canonical_count')) {
        return { rows: [{ canonical_count: 10, projected_count: 10 }], rowCount: 1 };
      }
      return {};
    });
    await expect(
      repository.reconcileBatch({ tenantId, communityId, batchSize: 250 }),
    ).resolves.toEqual({ outcome: 'ready', processed: 0 });
    expect(query.mock.calls.find(([text]) => String(text).includes('set state = $3'))?.[1]).toEqual(
      [tenantId, communityId, 'READY'],
    );
  });
});
