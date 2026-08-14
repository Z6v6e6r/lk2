import { createHash } from 'node:crypto';

import type { CommunitySummary } from '@phub/communities';
import { describe, expect, it, vi } from 'vitest';

import {
  deleteCommunityLogoObjectIfSafe,
  listDueCommunityLogoObjects,
  persistCommunityHomeSource,
  reserveCommunityLogoObjectUpload,
} from './community-home-repository.js';

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
  it('filters and rechecks active logos under the community lock before object deletion', async () => {
    let listSql = '';
    const listQuery = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'")
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      listSql = text;
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    await listDueCommunityLogoObjects({
      pool: {
        connect: vi.fn().mockResolvedValue({ query: listQuery, release: vi.fn() }),
      } as never,
      tenantId,
      limit: 20,
    });
    expect(listSql).toContain('not exists');
    expect(listSql).toContain('community_logo_sync active');

    const deleteObject = vi.fn();
    const objectKey = `community-logos/${tenantId}/${communities[0]?.id}/${'f'.repeat(64)}.webp`;
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.community_logo_object_gc')) {
        return Promise.resolve({ rows: [{ object_key: objectKey }], rowCount: 1 });
      }
      if (text.includes('from integration.community_logo_sync')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      }
      if (text.includes('delete from integration.community_logo_object_gc')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      deleteCommunityLogoObjectIfSafe({
        pool: {
          connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
        } as never,
        tenantId,
        objectKey,
        deleteObject,
      }),
    ).resolves.toBe(false);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('moves a due community object deadline before upload', async () => {
    let reservationSql = '';
    const query = vi.fn((text: string) => {
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('select object_key')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into integration.community_logo_object_gc')) {
        reservationSql = text;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    await expect(
      reserveCommunityLogoObjectUpload({
        pool: {
          connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
        } as never,
        tenantId,
        communityId: communities[0]?.id as string,
        objectKey: `community-logos/${tenantId}/${communities[0]?.id}/${'e'.repeat(64)}.webp`,
        deleteAfter: '2026-07-17T14:00:00.000Z',
      }),
    ).resolves.toBe(true);
    expect(reservationSql).toContain('greatest');
  });

  it('publishes the canonical null logo when a late photo loses to a newer removal watermark', async () => {
    let outboxPayload = '';
    let mappingRestored = false;
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
      if (text.includes('select object_key, synced_at')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.community_logo_observation_watermarks')) {
        return Promise.resolve({
          rows: [{ observed_at: '2026-07-17T12:03:00.000Z' }],
          rowCount: 1,
        });
      }
      if (text.includes('select community_id::text as community_id')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('from integration.community_home_source_components') ||
        text.includes('from home.dashboard_components')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('insert into integration.community_logo_sync')) {
        mappingRestored = true;
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('insert into audit.outbox_events')) {
        outboxPayload = String(values[5]);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (
        text.includes('insert into integration.community_home_source_components') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const community = communities[0] as CommunitySummary;

    await persistCommunityHomeSource({
      pool: {
        connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
      } as never,
      tenantId,
      userId,
      sourceMode: 'LEGACY',
      publicApplicationOrigin: 'https://lk.padlhub.test',
      communities: [
        {
          ...community,
          logoUrl: `https://lk.padlhub.test/public/api/v1/media/community-logos/${tenantId}/${community.id}`,
        },
      ],
      logoAssets: [
        {
          communityId: community.id,
          sourceUrl: 'https://legacy.padlhub.test/old.jpg',
          contentSha256: 'd'.repeat(64),
          objectKey: `community-logos/${tenantId}/${community.id}/${'d'.repeat(64)}.webp`,
          syncedAt: '2026-07-17T12:02:00.000Z',
        },
      ],
      correlationId: 'stale-community-logo-test',
      fetchedAt: '2026-07-17T12:02:00.000Z',
    });

    expect(mappingRestored).toBe(false);
    expect(outboxPayload).toContain('"logoUrl":null');
  });

  it('acquires community locks in one deterministic order across membership orderings', async () => {
    const secondId = '00000000-0000-4000-8000-000000000001';
    const firstId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const items: CommunitySummary[] = [
      { ...communities[0]!, id: firstId },
      { ...communities[0]!, id: secondId },
    ];
    const { pool, query } = poolWithQueries((text) => {
      if (
        text.includes('select object_key, synced_at') ||
        text.includes('from integration.community_logo_observation_watermarks') ||
        text.includes('from integration.community_home_source_components') ||
        text.includes('from home.dashboard_components')
      ) {
        return { rows: [] };
      }
      if (text.includes('select community_id::text as community_id')) {
        return { rows: [{ community_id: firstId }, { community_id: secondId }] };
      }
      if (
        text.includes('insert into integration.community_logo_observation_watermarks') ||
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
      publicApplicationOrigin: 'https://lk.padlhub.test',
      communities: items,
      logoAssets: items.map((item) => ({
        communityId: item.id,
        sourceUrl: `https://legacy.padlhub.test/${item.id}.jpg`,
        contentSha256: 'a'.repeat(64),
        objectKey: `community-logos/${tenantId}/${item.id}/${'a'.repeat(64)}.webp`,
        syncedAt: '2026-07-17T12:00:00.000Z',
      })),
      correlationId: 'community-lock-order-test',
      fetchedAt: '2026-07-17T12:00:00.000Z',
    });

    expect(
      query.mock.calls
        .filter(([text]) => String(text).includes('hashtextextended($1, 1)'))
        .map(([, values]) => values?.[0]),
    ).toEqual([secondId, firstId]);
  });

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
        publicApplicationOrigin: 'https://lk.padlhub.test',
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
        publicApplicationOrigin: 'https://lk.padlhub.test',
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
    const deliveryUrl = `/public/api/v1/media/community-logos/${tenantId}/${communities[0]?.id}`;
    const communitiesWithLogo = communities.map((community) => ({
      ...community,
      logoUrl: deliveryUrl,
    }));
    const { pool, query } = poolWithQueries((text) => {
      if (text.includes('select object_key, synced_at')) return { rows: [] };
      if (text.includes('from integration.community_logo_observation_watermarks')) {
        return { rows: [] };
      }
      if (text.includes('select community_id::text as community_id')) {
        return { rows: [{ community_id: communities[0]?.id }] };
      }
      if (text.includes('from integration.community_home_source_components')) return { rows: [] };
      if (text.includes('from home.dashboard_components')) return { rows: [] };
      if (
        text.includes('insert into integration.community_logo_sync') ||
        text.includes('insert into integration.community_logo_observation_watermarks') ||
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
      publicApplicationOrigin: 'https://lk.padlhub.test',
      communities: communitiesWithLogo,
      logoAssets: [
        {
          communityId: communities[0]?.id as string,
          sourceUrl: 'https://legacy.padlhub.test/community-logo/source',
          contentSha256: 'f'.repeat(64),
          objectKey,
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
    expect(String(outbox?.[1]?.[5])).toContain('/public/api/v1/media/community-logos/');
    expect(String(outbox?.[1]?.[5])).not.toContain('legacy.padlhub.test');
  });
});
