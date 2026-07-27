import { describe, expect, it, vi } from 'vitest';

import { createProfileLevelHistoryRepository } from './profile-level-history-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

describe('profile level history repository', () => {
  it('returns the latest points in chronological chart order', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
      expect(text).toContain('from profile.level_history');
      expect(values).toEqual([tenantId, userId, 100]);
      return Promise.resolve({
        rows: [
          {
            changed_at: new Date('2026-05-10T09:00:00.000Z'),
            level_label: 'D+',
            level_value: '2.75',
          },
          {
            changed_at: '2026-07-20T12:00:00.000Z',
            level_label: 'C',
            level_value: 3.1,
          },
        ],
      });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(
      createProfileLevelHistoryRepository(pool as never).list(tenantId, userId, 100),
    ).resolves.toEqual({
      userId,
      items: [
        {
          changedAt: '2026-05-10T09:00:00.000Z',
          levelLabel: 'D+',
          levelValue: 2.75,
        },
        {
          changedAt: '2026-07-20T12:00:00.000Z',
          levelLabel: 'C',
          levelValue: 3.1,
        },
      ],
    });
  });
});
