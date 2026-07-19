import { createHash, randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import {
  HOME_PROJECTION_COMPONENT_EVENT,
  homeAdditionalLinkSchema,
  homeCapabilitiesSchema,
  homeLocationSchema,
  homeProjectionComponentPayloadSchema,
  homeQuickActionSchema,
  type HomeProjectionComponentPayload,
} from '@phub/home-projection';
import { locationGalleryImageSchema } from '@phub/locations';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

const PLATFORM_COMPONENTS = ['messaging', 'navigation', 'capabilities'] as const;
type PlatformComponent = (typeof PLATFORM_COMPONENTS)[number];

interface SourceRow extends QueryResultRow {
  readonly component: PlatformComponent;
  readonly source_revision: string;
  readonly payload_checksum: string;
}

interface HomeComponentRow extends QueryResultRow {
  readonly component: string;
  readonly component_revision: string;
  readonly payload_checksum: string;
}

interface LocationRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly short_title: string | null;
  readonly court_count: number;
  readonly gallery: unknown;
}

interface AccessRow extends QueryResultRow {
  readonly roles: string[];
  readonly permissions: string[];
}

export interface PlatformHomeUser {
  readonly userId: string;
}

export interface PlatformHomeSyncResult {
  readonly published: number;
  readonly unchanged: number;
  readonly locationQueued: boolean;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function listDuePlatformHomeUsers(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly dueBefore: Date;
  readonly limit: number;
}): Promise<readonly PlatformHomeUser[]> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `select delegation.user_id::text as user_id
         from integration.user_delegations delegation
         left join lateral (
           select count(*)::integer as component_count, min(source.last_synced_at) as oldest_sync
             from integration.platform_home_source_components source
            where source.tenant_id = delegation.tenant_id
              and source.user_id = delegation.user_id
         ) sync on true
        where delegation.tenant_id = $1
          and delegation.provider = 'VIVA'
          and delegation.revoked_at is null
          and (delegation.refresh_expires_at is null or delegation.refresh_expires_at > now())
          and (coalesce(sync.component_count, 0) < 3 or sync.oldest_sync < $2)
        order by sync.oldest_sync asc nulls first, delegation.updated_at, delegation.user_id
        limit $3`,
      [input.tenantId, input.dueBefore, input.limit],
    );
    return result.rows.map((row) => ({ userId: row.user_id }));
  });
}

function navigationValue() {
  return {
    quickActions: z.array(homeQuickActionSchema).parse([
      {
        id: 'play',
        title: 'Найти игру',
        subtitle: 'Открытые игры рядом',
        route: '/games',
        tone: 'violet',
      },
      {
        id: 'group_training',
        title: 'Тренировки',
        subtitle: 'Группы по уровню',
        route: '/trainings',
        tone: 'lime',
      },
      {
        id: 'tournament',
        title: 'Турниры',
        subtitle: 'Сетка и регистрация',
        route: '/tournaments',
        tone: 'mint',
      },
      {
        id: 'individual_training',
        title: 'С тренером',
        subtitle: 'Индивидуальная запись',
        route: '/coaches',
        tone: 'sand',
      },
    ]),
    additionalLinks: z.array(homeAdditionalLinkSchema).parse([
      { id: 'promotions', title: 'Все акции', route: '/promotions' },
      {
        id: 'gift_certificates',
        title: 'Подарочные сертификаты',
        route: '/gift-certificates',
      },
      { id: 'offers', title: 'Предложения', route: '/offers' },
    ]),
  };
}

function platformValues(input: {
  readonly unreadChats: number;
  readonly access: AccessRow;
}): readonly Pick<HomeProjectionComponentPayload, 'component' | 'value'>[] {
  return [
    { component: 'messaging', value: { unreadChats: input.unreadChats } },
    { component: 'navigation', value: navigationValue() },
    {
      component: 'capabilities',
      value: homeCapabilitiesSchema.parse({
        canCreateGame: input.access.permissions.includes('games.play'),
        canManageTournaments:
          input.access.roles.some((role) => role === 'admin' || role === 'manager') ||
          input.access.permissions.includes('tournaments.manage'),
        canViewCommunities: true,
      }),
    },
  ];
}

export function synchronizePlatformHomeUser(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
  readonly fetchedAt: string;
}): Promise<PlatformHomeSyncResult> {
  return withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
    const [
      unreadResult,
      locationResult,
      accessResult,
      locationStateResult,
      sourceResult,
      homeResult,
    ] = await Promise.all([
      client.query<{ unread_chats: number } & QueryResultRow>(
        `select coalesce(sum(greatest(
                    (conversation.next_sequence - 1) - member.last_read_sequence,
                    0
                  )), 0)::integer as unread_chats
             from messaging.conversation_members member
             join messaging.conversations conversation
               on conversation.tenant_id = member.tenant_id
              and conversation.id = member.conversation_id
            where member.tenant_id = $1
              and member.user_id = $2
              and member.state = 'ACTIVE'
              and conversation.state = 'OPEN'`,
        [input.tenantId, input.userId],
      ),
      client.query<LocationRow>(
        `select id::text as id, title, short_title, court_count, gallery
             from locations.profiles
            where tenant_id = $1
              and publication_status = 'PUBLISHED'
              and show_on_home = true
            order by sort_order, title, id
            limit 8`,
        [input.tenantId],
      ),
      client.query<AccessRow>(
        `select coalesce(access.roles, array['client']::text[]) as roles,
                  coalesce(access.permissions, array['profile.read']::text[]) as permissions
             from identity.users identity_user
             left join identity.user_access_profiles access
               on access.tenant_id = identity_user.tenant_id
              and access.user_id = identity_user.id
            where identity_user.tenant_id = $1
              and identity_user.id = $2
              and identity_user.status = 'ACTIVE'`,
        [input.tenantId, input.userId],
      ),
      client.query<{ component_revision: string } & QueryResultRow>(
        `select component_revision::text as component_revision
             from locations.home_projection_state
            where tenant_id = $1`,
        [input.tenantId],
      ),
      client.query<SourceRow>(
        `select component, source_revision::text as source_revision, payload_checksum
             from integration.platform_home_source_components
            where tenant_id = $1 and user_id = $2
            for update`,
        [input.tenantId, input.userId],
      ),
      client.query<HomeComponentRow>(
        `select component, component_revision::text as component_revision, payload_checksum
             from home.dashboard_components
            where tenant_id = $1 and user_id = $2
              and component = any($3::text[])`,
        [input.tenantId, input.userId, [...PLATFORM_COMPONENTS, 'locations']],
      ),
    ]);

    const access = accessResult.rows[0] ?? { roles: ['client'], permissions: ['profile.read'] };
    const values = platformValues({
      unreadChats: unreadResult.rows[0]?.unread_chats ?? 0,
      access,
    });
    const sourceByComponent = new Map(sourceResult.rows.map((row) => [row.component, row]));
    const homeByComponent = new Map(homeResult.rows.map((row) => [row.component, row]));
    let published = 0;
    let unchanged = 0;

    for (const item of values) {
      const valueChecksum = checksum(item.value);
      const source = sourceByComponent.get(item.component as PlatformComponent);
      const currentHome = homeByComponent.get(item.component);
      if (
        source?.payload_checksum === valueChecksum &&
        currentHome?.payload_checksum === valueChecksum
      ) {
        await client.query(
          `update integration.platform_home_source_components
              set correlation_id = $4, fetched_at = $5,
                  last_synced_at = now(), updated_at = now()
            where tenant_id = $1 and user_id = $2 and component = $3`,
          [input.tenantId, input.userId, item.component, input.correlationId, input.fetchedAt],
        );
        unchanged += 1;
        continue;
      }
      const nextRevision = (
        [source?.source_revision, currentHome?.component_revision]
          .filter((value): value is string => Boolean(value))
          .map(BigInt)
          .reduce((highest, value) => (value > highest ? value : highest), 0n) + 1n
      ).toString();
      const eventPayload = homeProjectionComponentPayloadSchema.parse({
        userId: input.userId,
        component: item.component,
        componentRevision: nextRevision,
        value: item.value,
      });
      await client.query(
        `insert into integration.platform_home_source_components (
           tenant_id, user_id, component, source_revision, payload,
           payload_checksum, correlation_id, fetched_at
         ) values ($1, $2, $3, $4::bigint, $5::jsonb, $6, $7, $8)
         on conflict (tenant_id, user_id, component) do update set
           source_revision = excluded.source_revision,
           payload = excluded.payload,
           payload_checksum = excluded.payload_checksum,
           correlation_id = excluded.correlation_id,
           fetched_at = excluded.fetched_at,
           last_synced_at = now(),
           updated_at = now()`,
        [
          input.tenantId,
          input.userId,
          item.component,
          nextRevision,
          JSON.stringify(eventPayload.value),
          valueChecksum,
          input.correlationId,
          input.fetchedAt,
        ],
      );
      await client.query(
        `insert into audit.outbox_events (
           id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          randomUUID(),
          input.tenantId,
          HOME_PROJECTION_COMPONENT_EVENT,
          input.userId,
          input.correlationId,
          JSON.stringify(eventPayload),
          input.fetchedAt,
        ],
      );
      published += 1;
    }

    let locationQueued = false;
    if (!homeByComponent.has('locations')) {
      const locationRevision = locationStateResult.rows[0]?.component_revision;
      if (!locationRevision) throw new Error('LOCATION_HOME_REVISION_MISSING');
      const locations = locationResult.rows.map((row) => {
        const gallery = z.array(locationGalleryImageSchema).max(12).parse(row.gallery);
        return homeLocationSchema.parse({
          id: row.id,
          title: row.short_title ?? row.title,
          courtCount: row.court_count,
          imageUrl: gallery.find((image) => image.isCover)?.url ?? null,
          route: `/locations/${row.id}`,
        });
      });
      const eventPayload = homeProjectionComponentPayloadSchema.parse({
        userId: input.userId,
        component: 'locations',
        componentRevision: locationRevision,
        value: locations,
      });
      await client.query(
        `insert into audit.outbox_events (
           id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          randomUUID(),
          input.tenantId,
          HOME_PROJECTION_COMPONENT_EVENT,
          input.userId,
          input.correlationId,
          JSON.stringify(eventPayload),
          input.fetchedAt,
        ],
      );
      locationQueued = true;
    }

    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id,
         result, correlation_id, new_value
       ) values ($1, $2, 'PLATFORM_HOME_SYNC', 'HOME_SOURCE', $2,
                 'SUCCESS', $3, $4::jsonb)`,
      [
        input.tenantId,
        input.userId,
        input.correlationId,
        JSON.stringify({ published, unchanged, locationQueued }),
      ],
    );
    return { published, unchanged, locationQueued };
  });
}
