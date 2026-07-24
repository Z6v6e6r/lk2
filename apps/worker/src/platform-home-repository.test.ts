import { homeProjectionComponentPayloadSchema } from '@phub/home-projection';
import { describe, expect, it, vi } from 'vitest';

import {
  listDuePlatformHomeUsers,
  synchronizePlatformHomeUser,
} from './platform-home-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const locationId = '11111111-1111-4111-8111-111111111111';

function database(handler: (text: string, values: readonly unknown[]) => readonly unknown[]) {
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
    const rows = handler(text, values);
    return Promise.resolve({ rows, rowCount: rows.length || 1 });
  });
  return {
    pool: {
      query,
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never,
    query,
  };
}

describe('platform Home source persistence', () => {
  it('selects only delegated users whose three platform components are due', async () => {
    const { pool, query } = database((text, values) => {
      if (text.includes('from integration.user_delegations delegation')) {
        expect(values).toEqual([tenantId, new Date('2026-07-19T10:00:00.000Z'), 20]);
        return [{ user_id: userId }];
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      listDuePlatformHomeUsers({
        pool,
        tenantId,
        dueBefore: new Date('2026-07-19T10:00:00.000Z'),
        limit: 20,
      }),
    ).resolves.toEqual([{ userId }]);
    expect(query).toHaveBeenCalled();
  });

  it('publishes canonical messaging, navigation, capabilities and initial locations', async () => {
    const { pool, query } = database((text) => {
      if (text.includes('from messaging.conversation_members')) return [{ unread_chats: 4 }];
      if (text.includes('from locations.profiles')) {
        return [
          {
            id: locationId,
            title: 'ПаделХАБ Селигерская',
            short_title: 'Селигерская',
            court_count: 5,
            gallery: [],
          },
        ];
      }
      if (text.includes('from identity.users identity_user')) {
        expect(text).not.toMatch(/\bcurrent_user\./i);
        return [
          {
            roles: ['client', 'manager'],
            permissions: ['profile.read', 'games.play', 'communities.read'],
          },
        ];
      }
      if (text.includes('from locations.home_projection_state')) {
        return [{ component_revision: '7' }];
      }
      if (text.includes('from integration.platform_home_source_components')) return [];
      if (text.includes('from home.dashboard_components')) return [];
      if (
        text.includes('insert into integration.platform_home_source_components') ||
        text.includes('insert into audit.outbox_events') ||
        text.includes('insert into audit.audit_log')
      ) {
        return [];
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    await expect(
      synchronizePlatformHomeUser({
        pool,
        tenantId,
        userId,
        correlationId: 'platform-home-test',
        fetchedAt: '2026-07-19T12:00:00.000Z',
      }),
    ).resolves.toEqual({ published: 3, unchanged: 0, locationQueued: true });

    const payloads = query.mock.calls
      .filter(([text]) => String(text).includes('insert into audit.outbox_events'))
      .map(([, values]) =>
        homeProjectionComponentPayloadSchema.parse(JSON.parse(String(values?.[5]))),
      );
    expect(payloads.map((payload) => payload.component).sort()).toEqual([
      'capabilities',
      'locations',
      'messaging',
      'navigation',
    ]);
    expect(payloads.find((payload) => payload.component === 'messaging')?.value).toEqual({
      unreadChats: 4,
    });
    expect(payloads.find((payload) => payload.component === 'locations')).toMatchObject({
      componentRevision: '7',
      value: [
        {
          id: locationId,
          title: 'Селигерская',
          courtCount: 5,
          route: `/locations/${locationId}`,
        },
      ],
    });
    expect(payloads.find((payload) => payload.component === 'capabilities')?.value).toEqual({
      canCreateGame: true,
      canManageTournaments: true,
      canViewCommunities: true,
    });
  });
});
