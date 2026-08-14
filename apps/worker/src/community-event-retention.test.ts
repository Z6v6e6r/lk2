import { describe, expect, it, vi } from 'vitest';

import { runCommunityEventRetentionCycle } from './community-event-retention.js';

describe('community event retention cycle', () => {
  it('uses one durable claim token and releases only a failed community', async () => {
    const repository = {
      claimDue: vi.fn().mockResolvedValue(['community-a', 'community-b']),
      purgeClaimed: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'purged', deleted: 7, retainedFromSequence: 8 })
        .mockRejectedValueOnce(new Error('database unavailable')),
      releaseClaim: vi.fn().mockResolvedValue(true),
    };
    const result = await runCommunityEventRetentionCycle({
      repository,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      tenantId: '86afbe01-0318-4dd2-bc25-303b7bf0d430',
      candidateBatchSize: 20,
      eventBatchSize: 1_000,
      leaseMs: 60_000,
      claimTokenFactory: () => '22222222-2222-4222-8222-222222222222',
    });
    expect(result).toEqual({ claimed: 2, purged: 7, claimLost: 0, failures: 1 });
    expect(repository.releaseClaim).toHaveBeenCalledWith(
      expect.objectContaining({ communityId: 'community-b' }),
    );
  });
});
