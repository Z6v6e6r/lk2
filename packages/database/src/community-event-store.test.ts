import { describe, expect, it, vi } from 'vitest';

import { appendCommunityEvent } from './community-event-store.js';

describe('community durable event store', () => {
  it('allocates and appends one identifier-only sequence in the caller transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ last_sequence: '42' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      appendCommunityEvent({ query } as never, {
        tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
        communityId: '11111111-1111-4111-8111-111111111111',
        eventType: 'community.post.edited.v1',
        targetType: 'POST',
        targetId: '22222222-2222-4222-8222-222222222222',
        targetRevision: 8,
        targetStatus: 'PUBLISHED',
      }),
    ).resolves.toMatchObject({ sequence: 42, targetRevision: 8 });
    expect(query.mock.calls[0]?.[0]).toContain('on conflict (tenant_id, community_id) do update');
    expect(query.mock.calls[0]?.[0]).toContain('retention_due_at');
    expect(query.mock.calls[0]?.[0]).toContain("interval '30 days'");
    expect(query.mock.calls[1]?.[0]).toContain('insert into community_content.events');
    expect(JSON.stringify(query.mock.calls)).not.toContain('body');
  });
});
