import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { expireCommunityDirectInviteBatch } from './community-direct-invite-expiry.js';

describe('community DIRECT invite expiry worker', () => {
  it('claims a bounded due batch and emits token-free audit/outbox state', async () => {
    const query = vi.fn((text: string) => {
      if (text.includes('update communities.direct_invites invite')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              community_id: '22222222-2222-4222-8222-222222222222',
              revision: 2,
              expires_at: '2026-08-04T10:00:00.000Z',
              updated_at: '2026-08-04T10:01:00.000Z',
            },
          ],
        };
      }
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as Pool;
    const logger = { info: vi.fn() };

    await expect(
      expireCommunityDirectInviteBatch({
        pool,
        logger: logger as never,
        tenantId: '33333333-3333-4333-8333-333333333333',
        batchSize: 100,
      }),
    ).resolves.toBe(1);

    const sql = query.mock.calls.map(([text]) => text).join('\n');
    expect(sql).toContain('limit $2');
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain("set state = 'EXPIRED'");
    expect(sql).toContain('community.direct_invite.expired.v1');
    expect(sql).not.toContain('token_hash');
    expect(sql).not.toContain('token_key_id');
    expect(release).toHaveBeenCalledOnce();
  });
});
