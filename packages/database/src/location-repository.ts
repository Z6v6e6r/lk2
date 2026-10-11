import {
  LOCATION_PROFILE_CHANGED_EVENT,
  locationAdminViewSchema,
  locationCompleteness,
  locationProfileInputSchema,
  type LocationAdminView,
  type LocationProfileInput,
  type LocationRecommendationPhoto,
} from '@phub/locations';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type LocationCommandResult =
  | {
      readonly outcome: 'applied';
      readonly location: LocationAdminView;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'version_conflict'; readonly current: LocationAdminView }
  | { readonly outcome: 'media_invalid' }
  | { readonly outcome: 'publication_incomplete'; readonly missingFields: readonly string[] };

export interface LocationRepository {
  listAdmin(tenantId: string): Promise<readonly LocationAdminView[]>;
  getAdmin(tenantId: string, locationId: string): Promise<LocationAdminView | undefined>;
  listPublished(
    tenantId: string,
    options?: { readonly homeOnly?: boolean; readonly limit?: number },
  ): Promise<readonly LocationAdminView[]>;
  getPublished(tenantId: string, locationId: string): Promise<LocationAdminView | undefined>;
  readRecommendationPhotos?(
    tenantId: string,
    locationIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly LocationRecommendationPhoto[]>>;
  create(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly profile: LocationProfileInput;
  }): Promise<LocationCommandResult>;
  update(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly locationId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly correlationId: string;
    readonly profile: LocationProfileInput;
  }): Promise<LocationCommandResult>;
}

interface LocationRow extends QueryResultRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly short_title: string | null;
  readonly city: string | null;
  readonly court_count: number;
  readonly address: string | null;
  readonly latitude: string | number | null;
  readonly longitude: string | number | null;
  readonly timezone: string;
  readonly metro_name: string | null;
  readonly metro_distance_meters: number | null;
  readonly phone_e164: string | null;
  readonly working_hours: unknown;
  readonly amenities: unknown;
  readonly gallery: unknown;
  readonly publication_status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  readonly show_on_home: boolean;
  readonly sort_order: number;
  readonly version: number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly published_at: Date | string | null;
  readonly archived_at: Date | string | null;
}

interface CommandRow extends QueryResultRow {
  readonly command_type: 'CREATE' | 'UPDATE';
  readonly request_hash: string;
  readonly result_payload: unknown;
}

interface RevisionRow extends QueryResultRow {
  readonly component_revision: string;
}

interface RecommendationPhotoRow extends QueryResultRow {
  readonly location_id: string;
  readonly asset_id: string;
  readonly event_type: LocationRecommendationPhoto['eventType'];
  readonly is_active: boolean;
  readonly sort_order: number;
}

const LOCATION_COLUMNS = `
  id, slug, title, short_title, city, court_count, address,
  latitude, longitude, timezone, metro_name, metro_distance_meters,
  phone_e164, working_hours, amenities, gallery, publication_status,
  show_on_home, sort_order, version, created_at, updated_at, published_at, archived_at
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function mapLocation(row: LocationRow): LocationAdminView {
  const profile = locationProfileInputSchema.parse({
    slug: row.slug,
    title: row.title,
    shortTitle: row.short_title,
    city: row.city,
    courtCount: row.court_count,
    address: row.address,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    timezone: row.timezone,
    metroName: row.metro_name,
    metroDistanceMeters: row.metro_distance_meters,
    phoneE164: row.phone_e164,
    workingHours: row.working_hours,
    amenities: row.amenities,
    gallery: row.gallery,
    publicationStatus: row.publication_status,
    showOnHome: row.show_on_home,
    sortOrder: row.sort_order,
  });
  return locationAdminViewSchema.parse({
    id: row.id,
    ...profile,
    version: row.version,
    completeness: locationCompleteness(profile),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    publishedAt: nullableTimestamp(row.published_at),
    archivedAt: nullableTimestamp(row.archived_at),
  });
}

async function readRecommendationPhotos(
  client: PoolClient,
  tenantId: string,
  locationIds: readonly string[],
  options: { readonly publishedOnly?: boolean } = {},
): Promise<ReadonlyMap<string, readonly LocationRecommendationPhoto[]>> {
  const uniqueLocationIds = [...new Set(locationIds)];
  const result = new Map<string, readonly LocationRecommendationPhoto[]>();
  if (uniqueLocationIds.length === 0) return result;
  const profiles = await client.query<{ readonly id: string }>(
    `select id from locations.profiles
      where tenant_id = $1 and id = any($2::uuid[])
        and ($3::boolean = false or publication_status = 'PUBLISHED')`,
    [tenantId, uniqueLocationIds, options.publishedOnly ?? false],
  );
  for (const profile of profiles.rows) result.set(profile.id, []);
  if (result.size === 0) return result;
  const rows = await client.query<RecommendationPhotoRow>(
    `select photos.location_id, photos.asset_id, photos.event_type, photos.is_active, photos.sort_order
       from locations.recommendation_card_photos photos
       join locations.media_assets assets
         on assets.tenant_id = photos.tenant_id and assets.id = photos.asset_id and assets.status = 'READY'
      where photos.tenant_id = $1 and photos.location_id = any($2::uuid[])
      order by photos.location_id, photos.event_type, photos.sort_order, photos.asset_id`,
    [tenantId, [...result.keys()]],
  );
  for (const row of rows.rows) {
    const current = result.get(row.location_id) ?? [];
    result.set(row.location_id, [
      ...current,
      {
        assetId: row.asset_id,
        eventType: row.event_type,
        isActive: row.is_active,
        sortOrder: row.sort_order,
      },
    ]);
  }
  return result;
}

function withRecommendationPhotos(
  location: LocationAdminView,
  recommendationPhotos: readonly LocationRecommendationPhoto[],
): LocationAdminView {
  return locationAdminViewSchema.parse({ ...location, recommendationPhotos });
}

async function hydrateLocations(
  client: PoolClient,
  tenantId: string,
  locations: readonly LocationAdminView[],
  options?: { readonly publishedOnly?: boolean },
): Promise<LocationAdminView[]> {
  const photos = await readRecommendationPhotos(
    client,
    tenantId,
    locations.map((location) => location.id),
    options,
  );
  return locations.map((location) =>
    withRecommendationPhotos(location, photos.get(location.id) ?? []),
  );
}

async function recommendationMediaValid(
  client: PoolClient,
  tenantId: string,
  photos: readonly LocationRecommendationPhoto[],
): Promise<boolean> {
  if (photos.length === 0) return true;
  const assetIds = [...new Set(photos.map((photo) => photo.assetId))];
  const result = await client.query<{ readonly id: string }>(
    `select id
       from locations.media_assets
      where tenant_id = $1 and status = 'READY' and id = any($2::uuid[])`,
    [tenantId, assetIds],
  );
  return result.rows.length === assetIds.length;
}

async function replaceRecommendationPhotos(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  photos: readonly LocationRecommendationPhoto[],
): Promise<void> {
  await client.query(
    `delete from locations.recommendation_card_photos
      where tenant_id = $1 and location_id = $2`,
    [tenantId, locationId],
  );
  for (const photo of photos) {
    await client.query(
      `insert into locations.recommendation_card_photos (
         tenant_id, location_id, asset_id, event_type, is_active, sort_order
       ) values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, locationId, photo.assetId, photo.eventType, photo.isActive, photo.sortOrder],
    );
  }
}

async function currentCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
  },
): Promise<CommandRow | undefined> {
  return queryOne<CommandRow>(
    client,
    `select command_type, request_hash, result_payload
       from locations.admin_commands
      where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3
      for update`,
    [input.tenantId, input.actorUserId, input.idempotencyKey],
  );
}

function replayCommand(
  command: CommandRow | undefined,
  commandType: CommandRow['command_type'],
  requestHash: string,
): LocationCommandResult | undefined {
  if (!command) return undefined;
  if (command.command_type !== commandType || command.request_hash !== requestHash) {
    return { outcome: 'idempotency_conflict' };
  }
  return {
    outcome: 'applied',
    location: locationAdminViewSchema.parse(command.result_payload),
    replayed: true,
  };
}

async function nextHomeRevision(client: PoolClient, tenantId: string): Promise<string> {
  const row = await queryOne<RevisionRow>(
    client,
    `insert into locations.home_projection_state (tenant_id, component_revision)
     select $1,
            greatest(
              coalesce((
                select max(component_revision) + 1
                  from home.dashboard_components
                 where tenant_id = $1 and component = 'locations'
              ), 1),
              1
            )
     on conflict (tenant_id) do update set
       component_revision = locations.home_projection_state.component_revision + 1,
       updated_at = now()
     returning component_revision::text as component_revision`,
    [tenantId],
  );
  if (!row) throw new Error('LOCATION_HOME_REVISION_WRITE_LOST');
  return row.component_revision;
}

function auditMetadata(location: LocationAdminView): Record<string, unknown> {
  return {
    slug: location.slug,
    version: location.version,
    publicationStatus: location.publicationStatus,
    showOnHome: location.showOnHome,
    completenessPercent: location.completeness.percent,
    recommendationPhotos: location.recommendationPhotos ?? [],
  };
}

async function recordChange(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly action: 'LOCATION_CREATED' | 'LOCATION_UPDATED';
    readonly location: LocationAdminView;
    readonly previous?: LocationAdminView;
  },
): Promise<void> {
  const componentRevision = await nextHomeRevision(client, input.tenantId);
  await client.query(
    `insert into audit.audit_log (
       tenant_id, actor_id, action, resource_type, resource_id,
       result, correlation_id, old_value, new_value
     ) values ($1, $2, $3, 'LOCATION_PROFILE', $4,
               'SUCCESS', $5, $6::jsonb, $7::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.action,
      input.location.id,
      input.correlationId,
      input.previous ? JSON.stringify(auditMetadata(input.previous)) : null,
      JSON.stringify(auditMetadata(input.location)),
    ],
  );
  await client.query(
    `insert into audit.outbox_events (
       tenant_id, event_type, aggregate_id, correlation_id, payload
     ) values ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.tenantId,
      LOCATION_PROFILE_CHANGED_EVENT,
      input.location.id,
      input.correlationId,
      JSON.stringify({ locationId: input.location.id, componentRevision }),
    ],
  );
}

function commandPayload(input: LocationProfileInput): readonly unknown[] {
  return [
    input.slug,
    input.title,
    input.shortTitle,
    input.city,
    input.courtCount,
    input.address,
    input.latitude,
    input.longitude,
    input.timezone,
    input.metroName,
    input.metroDistanceMeters,
    input.phoneE164,
    JSON.stringify(input.workingHours),
    JSON.stringify(input.amenities),
    JSON.stringify(input.gallery),
    input.publicationStatus,
    input.showOnHome,
    input.sortOrder,
  ];
}

function publicationIncomplete(profile: LocationProfileInput): LocationCommandResult | undefined {
  if (profile.publicationStatus !== 'PUBLISHED') return undefined;
  const completeness = locationCompleteness(profile);
  return completeness.readyToPublish
    ? undefined
    : { outcome: 'publication_incomplete', missingFields: completeness.missingFields };
}

async function storeCommand(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly idempotencyKey: string;
    readonly commandType: CommandRow['command_type'];
    readonly requestHash: string;
    readonly location: LocationAdminView;
  },
): Promise<void> {
  await client.query(
    `insert into locations.admin_commands (
       tenant_id, actor_user_id, idempotency_key, command_type,
       request_hash, location_id, result_version, result_payload
     ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.tenantId,
      input.actorUserId,
      input.idempotencyKey,
      input.commandType,
      input.requestHash,
      input.location.id,
      input.location.version,
      JSON.stringify(input.location),
    ],
  );
}

export function createLocationRepository(pool: Pool): LocationRepository {
  return {
    listAdmin(tenantId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<LocationRow>(
          `select ${LOCATION_COLUMNS}
             from locations.profiles
            where tenant_id = $1
            order by sort_order, title, id`,
          [tenantId],
        );
        return hydrateLocations(client, tenantId, result.rows.map(mapLocation));
      });
    },

    getAdmin(tenantId, locationId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<LocationRow>(
          client,
          `select ${LOCATION_COLUMNS}
             from locations.profiles
            where tenant_id = $1 and id = $2`,
          [tenantId, locationId],
        );
        if (!row) return undefined;
        const [location] = await hydrateLocations(client, tenantId, [mapLocation(row)]);
        return location;
      });
    },

    listPublished(tenantId, options = {}) {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 100));
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<LocationRow>(
          `select ${LOCATION_COLUMNS}
             from locations.profiles
            where tenant_id = $1
              and publication_status = 'PUBLISHED'
              and ($2::boolean = false or show_on_home = true)
            order by sort_order, title, id
            limit $3`,
          [tenantId, options.homeOnly ?? false, limit],
        );
        return result.rows.map(mapLocation);
      });
    },

    getPublished(tenantId, locationId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<LocationRow>(
          client,
          `select ${LOCATION_COLUMNS}
             from locations.profiles
            where tenant_id = $1 and id = $2 and publication_status = 'PUBLISHED'`,
          [tenantId, locationId],
        );
        return row ? mapLocation(row) : undefined;
      });
    },

    readRecommendationPhotos(tenantId, locationIds) {
      return withTenantTransaction(pool, tenantId, (client) =>
        readRecommendationPhotos(client, tenantId, locationIds, { publishedOnly: true }),
      );
    },

    create(input) {
      const invalidPublication = publicationIncomplete(input.profile);
      if (invalidPublication) return Promise.resolve(invalidPublication);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `location-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const replay = replayCommand(
          await currentCommand(client, input),
          'CREATE',
          input.requestHash,
        );
        if (replay) return replay;
        const recommendationPhotos = input.profile.recommendationPhotos ?? [];
        if (!(await recommendationMediaValid(client, input.tenantId, recommendationPhotos))) {
          return { outcome: 'media_invalid' };
        }
        const values = commandPayload(input.profile);
        const inserted = await queryOne<LocationRow>(
          client,
          `insert into locations.profiles (
             tenant_id, slug, title, short_title, city, court_count, address,
             latitude, longitude, timezone, metro_name, metro_distance_meters,
             phone_e164, working_hours, amenities, gallery, publication_status,
             show_on_home, sort_order, created_by, updated_by, published_at, archived_at
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $20,
             case when $17 = 'PUBLISHED' then now() else null end,
             case when $17 = 'ARCHIVED' then now() else null end
           ) returning ${LOCATION_COLUMNS}`,
          [input.tenantId, ...values, input.actorUserId],
        );
        if (!inserted) throw new Error('LOCATION_PROFILE_WRITE_LOST');
        await replaceRecommendationPhotos(
          client,
          input.tenantId,
          inserted.id,
          recommendationPhotos,
        );
        const location = withRecommendationPhotos(mapLocation(inserted), recommendationPhotos);
        await storeCommand(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'CREATE',
          requestHash: input.requestHash,
          location,
        });
        await recordChange(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'LOCATION_CREATED',
          location,
        });
        return { outcome: 'applied', location, replayed: false };
      });
    },

    update(input) {
      const invalidPublication = publicationIncomplete(input.profile);
      if (invalidPublication) return Promise.resolve(invalidPublication);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `location-command:${input.tenantId}:${input.actorUserId}:${input.idempotencyKey}`,
        ]);
        const replay = replayCommand(
          await currentCommand(client, input),
          'UPDATE',
          input.requestHash,
        );
        if (replay) return replay;
        const currentRow = await queryOne<LocationRow>(
          client,
          `select ${LOCATION_COLUMNS}
             from locations.profiles
            where tenant_id = $1 and id = $2
            for update`,
          [input.tenantId, input.locationId],
        );
        if (!currentRow) return { outcome: 'not_found' };
        const previousBase = mapLocation(currentRow);
        const previousPhotos = await readRecommendationPhotos(client, input.tenantId, [
          input.locationId,
        ]);
        const previous = withRecommendationPhotos(
          previousBase,
          previousPhotos.get(input.locationId) ?? [],
        );
        if (previous.version !== input.expectedVersion) {
          return { outcome: 'version_conflict', current: previous };
        }
        const recommendationPhotos =
          input.profile.recommendationPhotos ?? previous.recommendationPhotos ?? [];
        if (!(await recommendationMediaValid(client, input.tenantId, recommendationPhotos))) {
          return { outcome: 'media_invalid' };
        }
        const values = commandPayload(input.profile);
        const updated = await queryOne<LocationRow>(
          client,
          `update locations.profiles set
             slug = $3, title = $4, short_title = $5, city = $6, court_count = $7,
             address = $8, latitude = $9, longitude = $10, timezone = $11,
             metro_name = $12, metro_distance_meters = $13, phone_e164 = $14,
             working_hours = $15::jsonb, amenities = $16::jsonb, gallery = $17::jsonb,
             publication_status = $18, show_on_home = $19, sort_order = $20,
             version = version + 1, updated_by = $21, updated_at = now(),
             published_at = case
               when $18 = 'PUBLISHED' then coalesce(published_at, now()) else null end,
             archived_at = case when $18 = 'ARCHIVED' then coalesce(archived_at, now()) else null end
           where tenant_id = $1 and id = $2 and version = $22
           returning ${LOCATION_COLUMNS}`,
          [input.tenantId, input.locationId, ...values, input.actorUserId, input.expectedVersion],
        );
        if (!updated) return { outcome: 'version_conflict', current: previous };
        await replaceRecommendationPhotos(client, input.tenantId, updated.id, recommendationPhotos);
        const location = withRecommendationPhotos(mapLocation(updated), recommendationPhotos);
        await storeCommand(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          commandType: 'UPDATE',
          requestHash: input.requestHash,
          location,
        });
        await recordChange(client, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          correlationId: input.correlationId,
          action: 'LOCATION_UPDATED',
          location,
          previous,
        });
        return { outcome: 'applied', location, replayed: false };
      });
    },
  };
}
