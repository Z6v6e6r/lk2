import { describe, expect, it, vi } from 'vitest';

import { createCommunityEventRecoveryRepository } from './community-event-recovery-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const viewerUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';

function repositoryWith(handler: (text: string, values: readonly unknown[]) => readonly unknown[]) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: handler(text, values) });
  });
  return {
    repository: createCommunityEventRecoveryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never),
    query,
  };
}

describe('community event recovery repository', () => {
  it('authorizes ACTIVE membership and returns ordered events bounded by the captured head', async () => {
    const { repository, query } = repositoryWith((text) => {
      if (text.includes('from identity.users')) return [{ active: true }];
      if (text.includes('with authority as materialized')) {
        return [
          {
            latest_sequence: '8',
            retained_from_sequence: '3',
            community_id: communityId,
            sequence: '7',
            event_type: 'community.post.edited.v1',
            target_type: 'POST',
            target_id: '22222222-2222-4222-8222-222222222222',
            target_revision: '4',
            target_status: 'PUBLISHED',
            occurred_at: new Date('2026-08-04T13:00:00.000Z'),
          },
        ];
      }
      return [];
    });
    await expect(
      repository.listEvents({
        tenantId,
        viewerUserId,
        communityId,
        afterSequence: 6,
        limit: 50,
        correlationId: 'recovery-correlation',
      }),
    ).resolves.toMatchObject({
      outcome: 'found',
      page: { latestSequence: 8, retainedFromSequence: 3, nextAfterSequence: 7 },
    });
    const read = query.mock.calls.find(([text]) =>
      String(text).includes('with authority as materialized'),
    );
    expect(read?.[1]).toEqual([tenantId, viewerUserId, communityId, 6, 51]);
    expect(String(read?.[0])).toContain('coalesce(head.retained_from_sequence, 1)');
    expect(String(read?.[0])).not.toContain('min(event.sequence)');
  });

  it('returns explicit reset semantics for expired and future cursors', async () => {
    const { repository } = repositoryWith((text) => {
      if (text.includes('from identity.users')) return [{ active: true }];
      if (text.includes('with authority as materialized')) {
        return [
          {
            latest_sequence: '20',
            retained_from_sequence: '10',
            community_id: null,
            sequence: null,
            event_type: null,
            target_type: null,
            target_id: null,
            target_revision: null,
            target_status: null,
            occurred_at: null,
          },
        ];
      }
      return [];
    });
    const base = {
      tenantId,
      viewerUserId,
      communityId,
      limit: 50,
      correlationId: 'recovery-correlation',
    };
    await expect(repository.listEvents({ ...base, afterSequence: 4 })).resolves.toEqual({
      outcome: 'gap_expired',
      latestSequence: 20,
      retainedFromSequence: 10,
    });
    await expect(repository.listEvents({ ...base, afterSequence: 21 })).resolves.toEqual({
      outcome: 'cursor_ahead',
      latestSequence: 20,
    });
  });
});
