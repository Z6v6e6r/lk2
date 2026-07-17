import { describe, expect, it, vi } from 'vitest';

import {
  createCommunityLegacyBridgeRepository,
  createLocalCommunityDirectoryRepository,
} from './community-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';

function poolWithQueries(
  handler: (text: string, values: readonly unknown[]) => { rows: readonly unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve(handler(text, values));
  });
  const release = vi.fn();
  const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
  return { pool: pool as never, query, release };
}

describe('community repositories', () => {
  it('resolves legacy viewer identity only inside a tenant transaction', async () => {
    const { pool, query, release } = poolWithQueries((text, values) => {
      if (text.includes('from identity.users')) {
        expect(values).toEqual([tenantId, userId]);
        return { rows: [{ phone_e164: '+79990000001', client_id: 'viva-profile-1' }] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      createCommunityLegacyBridgeRepository(pool).getViewerIdentity(tenantId, userId),
    ).resolves.toEqual({ phoneE164: '+79990000001', clientId: 'viva-profile-1' });
    expect(query).toHaveBeenCalledWith("select set_config('app.tenant_id', $1, true)", [tenantId]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('deduplicates legacy IDs and returns only their PadlHub UUID mapping', async () => {
    const { pool } = poolWithQueries((text, values) => {
      if (text.includes('insert into integration.external_entity_map')) {
        expect(values).toEqual([tenantId, ['legacy-one', 'legacy-two']]);
        return {
          rows: [
            {
              external_id: 'legacy-one',
              internal_id: '11111111-1111-4111-8111-111111111111',
            },
            {
              external_id: 'legacy-two',
              internal_id: '22222222-2222-4222-8222-222222222222',
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const mapping = await createCommunityLegacyBridgeRepository(pool).resolveCommunityIds(
      tenantId,
      ['legacy-one', ' legacy-two ', 'legacy-one'],
    );
    expect([...mapping]).toEqual([
      ['legacy-one', '11111111-1111-4111-8111-111111111111'],
      ['legacy-two', '22222222-2222-4222-8222-222222222222'],
    ]);
  });

  it('reads only PadlHub delivery URLs for copied community logos', async () => {
    const communityId = '11111111-1111-4111-8111-111111111111';
    const { pool } = poolWithQueries((text, values) => {
      if (text.includes('from integration.community_logo_sync')) {
        expect(values).toEqual([tenantId, [communityId]]);
        return {
          rows: [
            {
              community_id: communityId,
              delivery_url: 'https://media.padlhub.test/community.webp?sig=test',
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      createCommunityLegacyBridgeRepository(pool).getCommunityLogoUrls?.(tenantId, [communityId]),
    ).resolves.toEqual(
      new Map([[communityId, 'https://media.padlhub.test/community.webp?sig=test']]),
    );
  });

  it('reads active local memberships without exposing storage or external identifiers', async () => {
    const { pool } = poolWithQueries((text, values) => {
      if (text.includes('from communities.memberships')) {
        expect(values).toEqual([tenantId, userId, 21, null, null, null]);
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Локальное сообщество',
              is_verified: true,
              logo_url: null,
              pinned: true,
              sort_at: new Date('2026-07-17T10:00:00.000Z'),
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      createLocalCommunityDirectoryRepository(pool).listMemberships({
        tenantId,
        userId,
        correlationId: 'community-local-test',
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'Локальное сообщество',
          logoUrl: null,
          isVerified: true,
          unreadChatCount: 0,
          pinned: true,
          sortAt: '2026-07-17T10:00:00.000Z',
        },
      ],
      hasMore: false,
    });
  });
});
