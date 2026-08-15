import { communitySummarySchema, type CommunityDirectoryRepository } from '@phub/communities';
import { loadConfig } from '@phub/config';
import { homeProjectionComponentPayloadSchema } from '@phub/home-projection';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  runCommunityHomeSyncCycle,
  runCommunityLogoCompatibilityBackfill,
} from './community-home-sync.js';
import type { synchronizeLegacyCommunityLogos } from './community-logo-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityIds = [
  '00000001-0000-4000-8000-000000000001',
  '00000002-0000-4000-8000-000000000002',
  '00000003-0000-4000-8000-000000000003',
  '00000004-0000-4000-8000-000000000004',
  '00000005-0000-4000-8000-000000000005',
  '00000006-0000-4000-8000-000000000006',
  '00000007-0000-4000-8000-000000000007',
  '00000008-0000-4000-8000-000000000008',
  '00000009-0000-4000-8000-000000000009',
  '00000010-0000-4000-8000-000000000010',
  '00000011-0000-4000-8000-000000000011',
  '00000012-0000-4000-8000-000000000012',
] as const;

describe('independent community Home synchronization', () => {
  it('publishes a due community component without requiring a Viva provider read', async () => {
    const query = vi.fn((text: string, values: readonly unknown[] = []) => {
      void values;
      if (
        text === 'begin' ||
        text === 'commit' ||
        text === 'rollback' ||
        text.includes("set_config('app.tenant_id'") ||
        text.includes('pg_advisory_xact_lock')
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from identity.tenants')) {
        return Promise.resolve({ rows: [{ id: tenantId }], rowCount: 1 });
      }
      if (text.includes('from identity.users u')) {
        return Promise.resolve({ rows: [{ user_id: userId }], rowCount: 1 });
      }
      if (text.includes('from integration.community_home_source_components')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from home.dashboard_components')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (text.includes('from integration.community_logo_object_gc')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (
        text.includes('insert into integration.community_home_source_components') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = {
      query,
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never;
    const directoryItems = communityIds.map((id, index) => ({
      id,
      title: `Сообщество ${index + 1}`,
      logoUrl: null,
      isVerified: true,
      unreadChatCount: 0,
      pinned: false,
      sortAt: new Date(Date.UTC(2026, 6, 17, 10, 0, -index)).toISOString(),
    }));
    const listMemberships = vi
      .fn()
      .mockResolvedValueOnce({ items: directoryItems.slice(0, 5), hasMore: true })
      .mockResolvedValueOnce({ items: directoryItems.slice(5), hasMore: false });
    const repository: CommunityDirectoryRepository = {
      listMemberships,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as Logger;
    const store: ProfilePhotoObjectStore = {
      put: vi.fn().mockResolvedValue(undefined),
      createReadUrl: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const synchronizeLogos = vi.fn<typeof synchronizeLegacyCommunityLogos>().mockResolvedValue([]);
    const config = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    });

    await expect(
      runCommunityHomeSyncCycle({
        pool,
        config,
        logger,
        repository,
        sourceMode: 'LEGACY',
        store,
        synchronizeLogos,
        now: new Date('2026-07-17T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(listMemberships).toHaveBeenCalledTimes(2);
    expect(synchronizeLogos).toHaveBeenCalledOnce();
    expect(synchronizeLogos.mock.calls[0]?.[0].items.map((item) => item.id)).toEqual(
      communityIds.slice(0, 10),
    );
    expect(listMemberships).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        after: {
          pinned: false,
          sortAt: directoryItems[4]?.sortAt,
          id: directoryItems[4]?.id,
        },
      }),
    );
    const outbox = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(outbox).toBeDefined();
    const rawOutboxPayload: unknown = JSON.parse(String(outbox?.[1]?.[5]));
    const outboxPayload = homeProjectionComponentPayloadSchema.parse(rawOutboxPayload);
    const projectedCommunities = communitySummarySchema.array().parse(outboxPayload.value);
    expect(outboxPayload).toMatchObject({ component: 'communities' });
    expect(projectedCommunities).toHaveLength(10);
    expect(projectedCommunities.map((item) => item.id)).toEqual(communityIds.slice(0, 10));
  });

  it('refreshes expiring signed delivery without Viva and rejects source-mode drift', async () => {
    const communityId = communityIds[0];
    const objectKey = `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`;
    const stableUrl = `https://lk.padlhub.test/public/api/v1/media/community-logos/${tenantId}/${communityId}`;
    const signedUrl = `https://media.padlhub.test/${objectKey}?sig=rollback`;
    const communities = [
      {
        id: communityId,
        title: 'До конкурентного обновления',
        logoUrl: stableUrl,
        isVerified: true,
        unreadChatCount: 0,
        route: `/communities/${communityId}`,
      },
    ];
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
      if (text.includes('from identity.tenants')) {
        return Promise.resolve({ rows: [{ id: tenantId }], rowCount: 1 });
      }
      if (text.includes('select community_id::text as community_id, object_key')) {
        return Promise.resolve({
          rows: [{ community_id: communityId, object_key: objectKey }],
          rowCount: 1,
        });
      }
      if (text.includes('update integration.community_logo_sync')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (text.includes('select user_id::text as user_id, source_mode, source_revision')) {
        return Promise.resolve({
          rows: [
            {
              user_id: userId,
              source_mode: 'LEGACY',
              source_revision: '7',
              payload: communities,
              payload_checksum: 'old-checksum',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('source_last_modified, content_sha256, object_key, delivery_url')) {
        return Promise.resolve({
          rows: [
            {
              community_id: communityId,
              source_url: 'https://legacy.padlhub.test/logo.png',
              source_etag: null,
              source_last_modified: null,
              content_sha256: 'a'.repeat(64),
              object_key: objectKey,
              delivery_url: signedUrl,
              delivery_expires_at: '2026-07-17T13:00:00.000Z',
              synced_at: '2026-07-17T11:00:00.000Z',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from integration.community_home_source_components')) {
        return Promise.resolve({
          rows: [
            {
              source_revision: '7',
              source_mode: 'LOCAL',
              payload_checksum: 'old-checksum',
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('from home.dashboard_components')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    const config = loadConfig({
      APP_ENV: 'ci',
      DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
      REDIS_URL: 'redis://localhost:6379',
      RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
      JWT_ISSUER: 'phub-identity',
      JWT_AUDIENCE: 'phub-api',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
      COMMUNITY_LOGO_COMPATIBILITY_BACKFILL_ENABLED: 'true',
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'https://media.padlhub.test',
      S3_BUCKET: 'phub-media',
      S3_ACCESS_KEY: 'test-access',
      S3_SECRET_KEY: 'test-secret',
    });
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const createReadUrl = vi.fn().mockResolvedValue(signedUrl);
    const store: ProfilePhotoObjectStore = {
      put: vi.fn(),
      createReadUrl,
      delete: vi.fn(),
    };

    await expect(
      runCommunityLogoCompatibilityBackfill({
        pool: {
          query,
          connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
        } as never,
        config,
        logger,
        store,
        now: new Date('2026-07-17T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ logos: 1, homes: 0, failed: 0 });
    expect(createReadUrl).toHaveBeenCalledWith(objectKey);
    expect(
      query.mock.calls.some(
        ([text]) =>
          String(text).includes("delivery_expires_at <= now() + interval '10 minutes'") &&
          String(text).includes('from integration.community_logo_sync'),
      ),
    ).toBe(true);
    const tenantDiscovery = query.mock.calls.find(([text]) =>
      String(text).includes('from identity.tenants'),
    );
    expect(String(tenantDiscovery?.[0])).not.toContain('integration.community_logo_sync');
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.outbox_events')),
    ).toBe(false);
  });
});
