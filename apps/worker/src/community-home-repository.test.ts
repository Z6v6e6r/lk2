import { createHash } from 'node:crypto';

import type { CommunitySummary } from '@phub/communities';
import { describe, expect, it, vi } from 'vitest';

import { persistCommunityHomeSource } from './community-home-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communities: readonly CommunitySummary[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Реальное сообщество',
    logoUrl: null,
    isVerified: true,
    unreadChatCount: 0,
    route: '/communities/11111111-1111-4111-8111-111111111111',
  },
];

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function poolWithQueries(
  handler: (text: string, values: readonly unknown[]) => { rows: readonly unknown[] },
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes('pg_advisory_xact_lock')
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ ...handler(text, values), rowCount: 1 });
  });
  const release = vi.fn();
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release }) } as never,
    query,
    release,
  };
}

describe('community Home source persistence', () => {
  it('publishes a higher component revision than the previous synthetic Home component', async () => {
    const { pool, query, release } = poolWithQueries((text) => {
      if (text.includes('from integration.community_home_source_components')) return { rows: [] };
      if (text.includes('from home.dashboard_components')) {
        return { rows: [{ component_revision: '1', payload_checksum: 'a'.repeat(64) }] };
      }
      if (
        text.includes('insert into integration.community_home_source_components') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      persistCommunityHomeSource({
        pool,
        tenantId,
        userId,
        sourceMode: 'LEGACY',
        communities,
        correlationId: 'community-home-sync-test',
        fetchedAt: '2026-07-17T10:00:00.000Z',
      }),
    ).resolves.toEqual({ outcome: 'published', sourceRevision: '2' });

    const outbox = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(outbox?.[1]).toEqual(
      expect.arrayContaining([
        'home.projection.component.changed.v1',
        userId,
        'community-home-sync-test',
      ]),
    );
    expect(JSON.parse(String(outbox?.[1]?.[5]))).toMatchObject({
      component: 'communities',
      componentRevision: '2',
      value: communities,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('refreshes producer metadata without emitting an unchanged component', async () => {
    const payloadChecksum = checksum(communities);
    const { pool, query } = poolWithQueries((text) => {
      if (text.includes('from integration.community_home_source_components')) {
        return { rows: [{ source_revision: '7', payload_checksum: payloadChecksum }] };
      }
      if (text.includes('from home.dashboard_components')) {
        return { rows: [{ component_revision: '7', payload_checksum: payloadChecksum }] };
      }
      if (text.includes('update integration.community_home_source_components')) return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      persistCommunityHomeSource({
        pool,
        tenantId,
        userId,
        sourceMode: 'LEGACY',
        communities,
        correlationId: 'community-home-sync-test',
        fetchedAt: '2026-07-17T10:00:00.000Z',
      }),
    ).resolves.toEqual({ outcome: 'unchanged', sourceRevision: '7' });
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(false);
  });

  it('persists logo metadata with the Home component without exposing the legacy URL', async () => {
    const objectKey = `community-logos/${tenantId}/${communities[0]?.id}/${'f'.repeat(64)}.webp`;
    const deliveryUrl = `https://media.padlhub.test/${objectKey}?sig=test`;
    const communitiesWithLogo = communities.map((community) => ({
      ...community,
      logoUrl: deliveryUrl,
    }));
    const { pool, query } = poolWithQueries((text) => {
      if (text.includes('from integration.community_home_source_components')) return { rows: [] };
      if (text.includes('from home.dashboard_components')) return { rows: [] };
      if (
        text.includes('insert into integration.community_logo_sync') ||
        text.includes('delete from integration.community_logo_object_gc') ||
        text.includes('insert into integration.community_home_source_components') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await persistCommunityHomeSource({
      pool,
      tenantId,
      userId,
      sourceMode: 'LEGACY',
      communities: communitiesWithLogo,
      logoAssets: [
        {
          communityId: communities[0]?.id as string,
          sourceUrl: 'https://legacy.padlhub.test/community-logo/source',
          contentSha256: 'f'.repeat(64),
          objectKey,
          deliveryUrl,
          deliveryExpiresAt: '2026-07-17T13:00:00.000Z',
          syncedAt: '2026-07-17T12:00:00.000Z',
        },
      ],
      correlationId: 'community-logo-home-test',
      fetchedAt: '2026-07-17T12:00:00.000Z',
    });

    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into integration.community_logo_sync'),
      ),
    ).toBe(true);
    const outbox = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(String(outbox?.[1]?.[5])).toContain('media.padlhub.test');
    expect(String(outbox?.[1]?.[5])).not.toContain('legacy.padlhub.test');
  });
});
