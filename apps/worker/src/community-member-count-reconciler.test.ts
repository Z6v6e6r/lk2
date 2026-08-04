import { describe, expect, it, vi } from 'vitest';

import { runCommunityMemberCountReconciliationCycle } from './community-member-count-reconciler.js';

describe('community member-count reconciler', () => {
  it('runs one bounded batch for every selected community', async () => {
    const repository = {
      listReconciliationCandidates: vi.fn().mockResolvedValue(['a', 'b']),
      reconcileBatch: vi.fn().mockResolvedValue({ outcome: 'progressed', processed: 250 }),
    };
    await expect(
      runCommunityMemberCountReconciliationCycle({
        repository,
        logger: { info: vi.fn() } as never,
        tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
        reconcileBefore: '2026-08-03T00:00:00.000Z',
        candidateLimit: 10,
        batchSize: 250,
      }),
    ).resolves.toEqual({ candidates: 2, processed: 500 });
    expect(repository.reconcileBatch).toHaveBeenCalledTimes(2);
  });
});
