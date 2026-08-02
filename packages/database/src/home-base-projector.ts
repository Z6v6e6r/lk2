import { createHash, randomUUID } from 'node:crypto';

import {
  buildHomeBase,
  homeBaseSchema,
  homeAdditionalLinkSchema,
  homeCapabilitiesSchema,
  homeLocationSchema,
  homeProjectionComponentPayloadSchema,
  homeQuickActionSchema,
  normalizeHomeProjectionComponentPayload,
  type HomeBase,
} from '@phub/home-projection';
import { locationGalleryImageSchema } from '@phub/locations';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

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

interface OptionalSourceRow extends QueryResultRow {
  readonly source_revision: string;
  readonly payload: unknown;
  readonly fetched_at: Date | string;
}

interface RevisionRow extends QueryResultRow {
  readonly source_revision: string;
  readonly snapshot_version: string;
  readonly payload: unknown;
}

export interface DueHomeBaseUser {
  readonly userId: string;
}

export interface HomeBaseProjectionResult {
  readonly outcome: 'projected' | 'unchanged';
  readonly sourceRevision: string;
  readonly snapshotVersion: string;
  readonly communities: 'READY' | 'STALE' | 'UNAVAILABLE';
  readonly promotions: 'READY' | 'STALE' | 'UNAVAILABLE';
  readonly invalidSections: readonly ('communities' | 'promotions')[];
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function projectionContent(value: HomeBase): unknown {
  return {
    viewerUserId: value.viewerUserId,
    quickActions: value.quickActions,
    communities:
      value.communities.status === 'UNAVAILABLE'
        ? value.communities
        : { ...value.communities, status: 'READY' },
    promotions:
      value.promotions.status === 'UNAVAILABLE'
        ? value.promotions
        : { ...value.promotions, status: 'READY' },
    locations: value.locations,
    additionalLinks: value.additionalLinks,
    capabilities: value.capabilities,
  };
}

function timestamp(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalComponent(
  row: OptionalSourceRow | undefined,
  userId: string,
  component: 'communities' | 'promotion',
) {
  if (!row) return undefined;
  try {
    const observedAt = timestamp(row.fetched_at);
    if (!Number.isFinite(observedAt.getTime())) return undefined;
    const parsed = homeProjectionComponentPayloadSchema.safeParse(
      normalizeHomeProjectionComponentPayload({
        userId,
        component,
        componentRevision: row.source_revision,
        value: row.payload,
      }),
    );
    if (!parsed.success || parsed.data.component !== component) return undefined;
    return { payload: parsed.data, observedAt };
  } catch {
    return undefined;
  }
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

export async function listDueHomeBaseUsers(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly dueBefore: Date;
  readonly limit: number;
  readonly cycleSeed: string;
}): Promise<readonly DueHomeBaseUser[]> {
  const client = await input.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [input.tenantId]);
    const result = await client.query<{ user_id: string } & QueryResultRow>(
      `select identity_user.id::text as user_id
         from identity.users identity_user
         left join home.base_snapshots snapshot
           on snapshot.tenant_id = identity_user.tenant_id
          and snapshot.user_id = identity_user.id
        where identity_user.tenant_id = $1
          and identity_user.status = 'ACTIVE'
          and (snapshot.checked_at is null or snapshot.checked_at < $2)
        order by case
                   when exists (
                     select 1
                       from integration.user_delegations delegation
                      where delegation.tenant_id = identity_user.tenant_id
                        and delegation.user_id = identity_user.id
                        and delegation.provider = 'VIVA'
                        and delegation.revoked_at is null
                        and (
                          delegation.refresh_expires_at is null
                          or delegation.refresh_expires_at > now()
                        )
                   ) then 0
                   else 1
                 end,
                 snapshot.checked_at asc nulls first,
                 case
                   when snapshot.checked_at is null
                     then hashtextextended(identity_user.id::text, $4::bigint)
                 end,
                 identity_user.id
        limit $3`,
      [input.tenantId, input.dueBefore, input.limit, input.cycleSeed],
    );
    await client.query('commit');
    return result.rows.map((row) => ({ userId: row.user_id }));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function projectHomeBaseUser(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
  readonly ttlSeconds: number;
  readonly now?: Date;
}): Promise<HomeBaseProjectionResult> {
  const now = input.now ?? new Date();
  const client = await input.pool.connect();
  try {
    await client.query('begin isolation level repeatable read');
    await client.query("select set_config('app.tenant_id', $1, true)", [input.tenantId]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);
    const locationResult = await client.query<LocationRow>(
      `select id::text as id, title, short_title, court_count, gallery
             from locations.profiles
            where tenant_id = $1
              and publication_status = 'PUBLISHED'
              and show_on_home = true
            order by sort_order, title, id
            limit 8`,
      [input.tenantId],
    );
    const accessResult = await client.query<AccessRow>(
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
    );
    const communityResult = await client.query<OptionalSourceRow>(
      `select source_revision::text as source_revision, payload, fetched_at
             from integration.community_home_source_components
            where tenant_id = $1 and user_id = $2`,
      [input.tenantId, input.userId],
    );
    const promotionResult = await client.query<OptionalSourceRow>(
      `select source_revision::text as source_revision, payload, fetched_at
             from integration.promotion_home_source_components
            where tenant_id = $1 and user_id = $2`,
      [input.tenantId, input.userId],
    );
    const revisionResult = await client.query<RevisionRow>(
      `select source_revision::text as source_revision, snapshot_version, payload
             from home.base_snapshots
            where tenant_id = $1 and user_id = $2
            for update`,
      [input.tenantId, input.userId],
    );

    const access = accessResult.rows[0];
    if (!access) throw new Error('HOME_BASE_USER_NOT_ACTIVE');
    const navigation = navigationValue();
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
    const community = communityResult.rows[0];
    const communities = optionalComponent(community, input.userId, 'communities');
    const promotion = promotionResult.rows[0];
    const promotions = optionalComponent(promotion, input.userId, 'promotion');
    const invalidSections = [
      ...(community && !communities ? (['communities'] as const) : []),
      ...(promotion && !promotions ? (['promotions'] as const) : []),
    ];
    const currentProjection = revisionResult.rows[0];
    const sourceRevision = (BigInt(currentProjection?.source_revision ?? '0') + 1n).toString();
    const homeBase = buildHomeBase({
      viewerUserId: input.userId,
      sourceRevision,
      generatedAt: now,
      ttlSeconds: input.ttlSeconds,
      quickActions: navigation.quickActions,
      locations,
      additionalLinks: navigation.additionalLinks,
      capabilities: homeCapabilitiesSchema.parse({
        canCreateGame: access.permissions.includes('games.play'),
        canManageTournaments:
          access.roles.some((role) => role === 'admin' || role === 'manager') ||
          access.permissions.includes('tournaments.manage'),
        canViewCommunities: true,
      }),
      ...(community && communities?.payload.component === 'communities'
        ? {
            communities: {
              revision: community.source_revision,
              observedAt: communities.observedAt,
              value: communities.payload.value,
            },
          }
        : {}),
      ...(promotion && promotions?.payload.component === 'promotion'
        ? {
            promotions: {
              revision: promotion.source_revision,
              observedAt: promotions.observedAt,
              value: promotions.payload.value,
            },
          }
        : {}),
    });
    const currentPayload = homeBaseSchema.safeParse(currentProjection?.payload);
    if (
      currentProjection &&
      currentPayload.success &&
      checksum(projectionContent(currentPayload.data)) === checksum(projectionContent(homeBase))
    ) {
      await client.query(
        `update home.base_snapshots
            set checked_at = $3
          where tenant_id = $1 and user_id = $2`,
        [input.tenantId, input.userId, now],
      );
      await client.query('commit');
      return {
        outcome: 'unchanged',
        sourceRevision: currentProjection.source_revision,
        snapshotVersion: currentProjection.snapshot_version,
        communities: currentPayload.data.communities.status,
        promotions: currentPayload.data.promotions.status,
        invalidSections,
      };
    }
    const sourceEventId = randomUUID();
    const payloadChecksum = checksum(homeBase);
    await client.query(
      `insert into home.base_snapshots (
         tenant_id, user_id, source_revision, source_event_id, producer,
         snapshot_version, payload, payload_checksum, generated_at
       ) values ($1, $2, $3::bigint, $4, 'HOME_BASE_PROJECTOR', $5, $6::jsonb, $7, $8)
       on conflict (tenant_id, user_id) do update set
         source_revision = excluded.source_revision,
         source_event_id = excluded.source_event_id,
         producer = excluded.producer,
         snapshot_version = excluded.snapshot_version,
         payload = excluded.payload,
         payload_checksum = excluded.payload_checksum,
         generated_at = excluded.generated_at,
         checked_at = now(),
         updated_at = now()`,
      [
        input.tenantId,
        input.userId,
        sourceRevision,
        sourceEventId,
        homeBase.snapshot.version,
        JSON.stringify(homeBase),
        payloadChecksum,
        homeBase.snapshot.generatedAt,
      ],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, actor_id, action, resource_type, resource_id,
         result, correlation_id, new_value
       ) values ($1, $2, 'HOME_BASE_PROJECTED', 'HOME_BASE_PROJECTION', $2,
                 'SUCCESS', $3, $4::jsonb)`,
      [
        input.tenantId,
        input.userId,
        input.correlationId,
        JSON.stringify({
          sourceRevision,
          sourceEventId,
          snapshotVersion: homeBase.snapshot.version,
          payloadChecksum,
          communities: homeBase.communities.status,
          promotions: homeBase.promotions.status,
        }),
      ],
    );
    await client.query('commit');
    return {
      outcome: 'projected',
      sourceRevision,
      snapshotVersion: homeBase.snapshot.version,
      communities: homeBase.communities.status,
      promotions: homeBase.promotions.status,
      invalidSections,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
