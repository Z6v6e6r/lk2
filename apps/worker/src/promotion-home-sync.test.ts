import { describe, expect, it, vi } from 'vitest';

import type { LegacyPromotionSourceSnapshot } from './legacy-promotion-source.js';
import { readPromotionSourceSnapshots } from './promotion-home-sync.js';

const block2Snapshot: LegacyPromotionSourceSnapshot = {
  rotationEnabled: false,
  items: [],
  updatedAt: '2026-07-30T11:45:14.928Z',
};

describe('promotion Home source slots', () => {
  it('reads CUP Block 2 once when it supplies both compatible Home slots', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(block2Snapshot);
    const block2Source = { getSnapshot };

    await expect(
      readPromotionSourceSnapshots(
        { hero: block2Source, standard: block2Source },
        'promotion-block-2-test',
      ),
    ).resolves.toEqual({
      hero: block2Snapshot,
      standard: block2Snapshot,
      mirrorsStandard: true,
    });
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(getSnapshot).toHaveBeenCalledWith('promotion-block-2-test');
  });
});
