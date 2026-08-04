import { describe, expect, it, vi } from 'vitest';

import { createCommunityReadRepository } from './community-read-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const viewerUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';

function poolWithRows(rows: readonly unknown[]) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    void values;
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows });
  });
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
    query,
  };
}

const row = {
  id: communityId,
  title: 'Padel Friends',
  description: 'Description',
  logo_url: null,
  is_verified: true,
  visibility: 'PUBLIC',
  join_policy: 'MODERATED',
  publishing_preset: 'STAFF_FEED',
  revision: 1,
  member_count: 42,
  created_at: new Date('2026-08-03T10:00:00.000Z'),
  updated_at: new Date('2026-08-03T11:00:00.000Z'),
  sort_created_at: '2026-08-03 10:00:00+00',
  membership_status: null,
  membership_role: null,
  membership_revision: null,
  ranking_position: null,
};

describe('community read repository', () => {
  it('uses a tenant-bound bounded discovery query and never searches private descriptions', async () => {
    const { pool, query } = poolWithRows([row]);
    await expect(
      createCommunityReadRepository(pool).listDiscoverable({
        tenantId,
        viewerUserId,
        query: 'friends',
        limit: 20,
      }),
    ).resolves.toMatchObject({ items: [{ id: communityId, memberCount: 42 }], hasMore: false });

    const call =
      query.mock.calls.find(([text]) => String(text).includes('listDiscoverable')) ??
      query.mock.calls.find(([text]) => String(text).includes("c.visibility in ('PUBLIC'"));
    expect(call?.[0]).toContain("c.visibility in ('PUBLIC', 'LISTED_PRIVATE')");
    expect(call?.[0]).toContain("c.visibility = 'PUBLIC'");
    expect(call?.[0]).toContain("lower(coalesce(c.description, ''))");
    expect(call?.[0]).toContain('left join communities.member_count_projections counters');
    expect(call?.[0]).toContain("when counters.state = 'READY'");
    expect(call?.[0]).toContain('select count(*)::integer');
    expect(call?.[1]).toEqual([tenantId, viewerUserId, 'friends', null, null, 21]);
  });

  it('loads detail by tenant, viewer and PadlHub UUID with field-level SQL redaction', async () => {
    const { pool, query } = poolWithRows([
      {
        ...row,
        visibility: 'HIDDEN',
        membership_status: 'ACTIVE',
        membership_role: 'MEMBER',
        membership_revision: 3,
        ranking_position: 7,
      },
    ]);
    await expect(
      createCommunityReadRepository(pool).getDetail({ tenantId, viewerUserId, communityId }),
    ).resolves.toMatchObject({
      id: communityId,
      viewerMembership: { status: 'ACTIVE', role: 'MEMBER', revision: 3, memberRank: 7 },
    });

    const call = query.mock.calls.find(([text]) => String(text).includes('c.id = $3'));
    expect(call?.[0]).toContain("c.visibility = 'PUBLIC' or viewer.status = 'ACTIVE'");
    expect(call?.[1]).toEqual([tenantId, viewerUserId, communityId]);
  });
});
