import { describe, expect, it, vi } from 'vitest';

import { createHomeBaseProjectionRepository } from './home-base-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

describe('HomeBase projection repository', () => {
  it('reads the tenant-scoped partial snapshot', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      if (text === 'begin' || text === 'commit' || text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from home.base_snapshots')) {
        expect(values).toEqual([tenantId, userId]);
        return Promise.resolve({
          rows: [
            {
              tenant_id: tenantId,
              user_id: userId,
              source_revision: '4',
              source_event_id: '11111111-1111-4111-8111-111111111111',
              producer: 'HOME_BASE_PROJECTOR',
              snapshot_version: 'home-base-v1-4',
              payload: { viewerUserId: userId },
              payload_checksum: 'a'.repeat(64),
              generated_at: new Date('2026-07-29T12:00:00.000Z'),
              checked_at: new Date('2026-07-29T12:01:00.000Z'),
              updated_at: new Date('2026-07-29T12:00:00.000Z'),
            },
          ],
          rowCount: 1,
        });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(
      createHomeBaseProjectionRepository(pool as never).get(tenantId, userId),
    ).resolves.toMatchObject({
      tenantId,
      userId,
      sourceRevision: '4',
      snapshotVersion: 'home-base-v1-4',
      checkedAt: '2026-07-29T12:01:00.000Z',
    });
  });
});
