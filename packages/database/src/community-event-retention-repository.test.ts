import { describe, expect, it, vi } from 'vitest';

import { createCommunityEventRetentionRepository } from './community-event-retention-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const communityId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';

function createRepository(handler: (text: string, values: readonly unknown[]) => unknown) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback')
      return Promise.resolve({ rows: [], rowCount: 0 });
    if (text.includes("set_config('app.tenant_id'") || text.startsWith('set local')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    const value = handler(text, values) as { rows?: readonly unknown[]; rowCount?: number };
    return Promise.resolve({
      rows: value.rows ?? [],
      rowCount: value.rowCount ?? value.rows?.length ?? 0,
    });
  });
  return {
    repository: createCommunityEventRetentionRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never),
    query,
  };
}

describe('community event retention repository', () => {
  it('claims due heads with an expiring durable SKIP LOCKED lease', async () => {
    const { repository, query } = createRepository((text) =>
      text.includes('returning head.community_id') ? { rows: [{ community_id: communityId }] } : {},
    );
    await expect(
      repository.claimDue({ tenantId, claimToken, batchSize: 20, leaseMs: 60_000 }),
    ).resolves.toEqual([communityId]);
    const sql = String(query.mock.calls.find(([text]) => text.includes('with candidates'))?.[0]);
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain('purge_claim_expires_at <= clock_timestamp()');
    expect(sql).toContain('first_retained.sequence = head.retained_from_sequence');
  });

  it('deletes only the continuous expired sequence prefix and advances the durable bound', async () => {
    const { repository, query } = createRepository((text) => {
      if (text.includes('select last_sequence, retained_from_sequence')) {
        return { rows: [{ last_sequence: '13', retained_from_sequence: '10' }] };
      }
      if (text.includes('cross join cutoff')) {
        return {
          rows: [
            { sequence: '10', occurred_at: '2026-06-01T00:00:00.000Z', expired: true },
            { sequence: '11', occurred_at: '2026-08-01T00:00:00.000Z', expired: false },
            { sequence: '12', occurred_at: '2026-05-01T00:00:00.000Z', expired: true },
          ],
        };
      }
      if (text.includes('delete from community_content.events')) return { rowCount: 1 };
      if (text.includes('select sequence, occurred_at, false as expired')) {
        return {
          rows: [{ sequence: '11', occurred_at: '2026-08-01T00:00:00.000Z', expired: false }],
        };
      }
      return {};
    });
    await expect(
      repository.purgeClaimed({
        tenantId,
        communityId,
        claimToken,
        batchSize: 1_000,
        correlationId: 'retention-correlation',
      }),
    ).resolves.toEqual({ outcome: 'purged', deleted: 1, retainedFromSequence: 11 });
    const deletion = query.mock.calls.find(([text]) =>
      String(text).includes('delete from community_content.events'),
    );
    expect(deletion?.[1]).toEqual([tenantId, communityId, [10]]);
    const headUpdate = query.mock.calls.find(([text]) =>
      String(text).includes('set retained_from_sequence = $4'),
    );
    expect(headUpdate?.[1]?.[3]).toBe(11);
  });

  it('does not purge after a claim is lost', async () => {
    const { repository, query } = createRepository(() => ({}));
    await expect(
      repository.purgeClaimed({
        tenantId,
        communityId,
        claimToken,
        batchSize: 100,
        correlationId: 'retention-correlation',
      }),
    ).resolves.toEqual({ outcome: 'claim_lost' });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('delete from community_content.events'),
      ),
    ).toBe(false);
  });
});
