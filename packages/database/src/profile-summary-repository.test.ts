import { describe, expect, it, vi } from 'vitest';

import { createProfileSummaryRepository } from './profile-summary-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const firstUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const secondUserId = 'bd35543d-c565-443a-bd3d-eea68eb2fbe6';

describe('profile summary repository', () => {
  it('loads current display names for game-card initials in one batch', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('select user_id, display_name')) {
        return Promise.resolve({
          rows: [
            { user_id: firstUserId, display_name: 'Мария Шмакина' },
            { user_id: secondUserId, display_name: 'Артур Ситдиков' },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = createProfileSummaryRepository(pool as never);

    await expect(
      repository.getDisplayNames(tenantId, [firstUserId, secondUserId]),
    ).resolves.toEqual(
      new Map([
        [firstUserId, 'Мария Шмакина'],
        [secondUserId, 'Артур Ситдиков'],
      ]),
    );
    expect(
      query.mock.calls.some(([text]) => String(text).includes('select user_id, display_name')),
    ).toBe(true);
  });

  it('loads normalized CUP level values for game-card progress rings', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('select user_id, level_value')) {
        return Promise.resolve({
          rows: [
            { user_id: firstUserId, level_value: '3.43844' },
            { user_id: secondUserId, level_value: 4.82 },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };
    const repository = createProfileSummaryRepository(pool as never);

    await expect(repository.getLevelValues(tenantId, [firstUserId, secondUserId])).resolves.toEqual(
      new Map([
        [firstUserId, 3.43844],
        [secondUserId, 4.82],
      ]),
    );
    expect(
      query.mock.calls.some(([text]) => String(text).includes('level_value is not null')),
    ).toBe(true);
  });
});
