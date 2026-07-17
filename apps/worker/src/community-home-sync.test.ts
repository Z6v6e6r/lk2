import { communitySummarySchema, type CommunityDirectoryRepository } from '@phub/communities';
import { loadConfig } from '@phub/config';
import { homeProjectionComponentPayloadSchema } from '@phub/home-projection';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { runCommunityHomeSyncCycle } from './community-home-sync.js';
import type { ProfilePhotoObjectStore } from './profile-photo-sync.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const communityIds = [
  communityId,
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
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
        sourceMode: 'LOCAL',
        store,
        now: new Date('2026-07-17T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(listMemberships).toHaveBeenCalledTimes(2);
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
    expect(projectedCommunities).toHaveLength(5);
    expect(projectedCommunities.map((item) => item.id)).toEqual(communityIds.slice(0, 5));
  });
});
