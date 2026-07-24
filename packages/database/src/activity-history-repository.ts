import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type ActivityHistoryKind = 'GAME' | 'TRAINING' | 'TOURNAMENT';
export type ActivityHistoryStatus = 'COMPLETED' | 'CANCELLED';
export type ActivityHistoryCoverageStatus = 'UNSYNCED' | 'PARTIAL' | 'COMPLETE';
export type ActivityHistoryFreshness = 'UNSYNCED' | 'FRESH' | 'STALE';

export interface ActivityHistoryItem {
  readonly id: string;
  readonly userId: string;
  readonly kind: ActivityHistoryKind;
  readonly status: ActivityHistoryStatus;
  readonly occurredAt: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly title: string;
  readonly venueName: string | null;
  readonly route: string | null;
  readonly gameId: string | null;
  readonly tournamentId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly sourceRevision: string;
  readonly syncedAt: string;
}

export interface ActivityHistoryPage {
  readonly items: readonly ActivityHistoryItem[];
  readonly next?: { readonly occurredAt: string; readonly id: string };
}

export interface ActivityHistorySyncState {
  readonly userId: string;
  readonly coverageStatus: ActivityHistoryCoverageStatus;
  readonly freshness: ActivityHistoryFreshness;
  readonly lastSuccessAt: string | null;
  readonly staleAt: string | null;
  readonly oldestSyncedAt: string | null;
  readonly nextProviderCursor: string | null;
  readonly sourceRevision: string | null;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string | null;
}

export interface ActivityHistorySourceMapping {
  /** Opaque integration.external_entity_map row UUID. */
  readonly mappingId: string;
  /** Stable PadlHub UUID to use as ActivityHistoryItem.id. */
  readonly internalId: string;
}

export interface ActivityHistoryGameAssociation {
  /** One-way server-side association key. It is never returned by an API route. */
  readonly associationId: string;
  readonly gameId: string;
}

export interface PersistActivityHistoryItemInput {
  readonly id: string;
  readonly kind: ActivityHistoryKind;
  readonly status: ActivityHistoryStatus;
  readonly occurredAt: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly title: string;
  readonly venueName?: string;
  readonly route?: string;
  readonly gameId?: string;
  readonly tournamentId?: string;
  /** Opaque UUID from integration.external_entity_map; never a provider identifier. */
  readonly integrationMappingId?: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly sourceRevision: string;
  readonly syncedAt: string;
}

interface PersistSyncBase {
  readonly lastSuccessAt: string;
  readonly staleAt: string;
  readonly oldestSyncedAt?: string;
  readonly sourceRevision: string;
}

export type PersistActivityHistorySyncInput =
  | (PersistSyncBase & {
      readonly coverageStatus: 'PARTIAL';
      readonly nextProviderCursor: string;
    })
  | (PersistSyncBase & {
      readonly coverageStatus: 'COMPLETE';
      readonly nextProviderCursor?: never;
    });

export interface ActivityHistoryRepository {
  resolveVivaExerciseGameAssociations(input: {
    readonly tenantId: string;
    readonly associationIds: readonly string[];
  }): Promise<readonly ActivityHistoryGameAssociation[]>;
  resolveSourceMapping(input: {
    readonly tenantId: string;
    readonly externalSystem: 'VIVA';
    readonly entityType: 'booking_history';
    readonly externalId: string;
    readonly externalVersion: string;
    readonly syncedAt: string;
  }): Promise<ActivityHistorySourceMapping>;
  list(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly kind?: ActivityHistoryKind;
    readonly status?: ActivityHistoryStatus;
    readonly limit: number;
    readonly after?: { readonly occurredAt: string; readonly id: string };
  }): Promise<ActivityHistoryPage>;
  getSyncState(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly asOf?: string;
  }): Promise<ActivityHistorySyncState>;
  persistPage(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly items: readonly PersistActivityHistoryItemInput[];
    /** Previous provider rows replaced by canonical PadlHub aggregates in this page. */
    readonly supersededItemIds?: readonly string[];
    readonly sync: PersistActivityHistorySyncInput;
  }): Promise<ActivityHistorySyncState>;
  recordSyncFailure(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly errorCode: string;
  }): Promise<ActivityHistorySyncState>;
}

interface ActivityHistoryRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly kind: ActivityHistoryKind;
  readonly status: ActivityHistoryStatus;
  readonly occurred_at: Date | string;
  readonly starts_at: Date | string;
  readonly ends_at: Date | string | null;
  readonly title: string;
  readonly venue_name: string | null;
  readonly route: string | null;
  readonly game_id: string | null;
  readonly tournament_id: string | null;
  readonly details: unknown;
  readonly source_revision: string;
  readonly synced_at: Date | string;
}

interface ActivityHistorySyncRow extends QueryResultRow {
  readonly user_id: string;
  readonly coverage_status: ActivityHistoryCoverageStatus;
  readonly last_success_at: Date | string | null;
  readonly stale_at: Date | string | null;
  readonly oldest_synced_at: Date | string | null;
  readonly next_provider_cursor: string | null;
  readonly source_revision: string | null;
  readonly last_error_code: string | null;
  readonly updated_at: Date | string;
}

interface ActivityHistorySourceMappingRow extends QueryResultRow {
  readonly id: string;
  readonly internal_id: string;
}

const HISTORY_COLUMNS = `
  id, user_id, kind, status, occurred_at, starts_at, ends_at, title,
  venue_name, route, game_id, tournament_id, details, source_revision, synced_at
`;

const SYNC_COLUMNS = `
  user_id, coverage_status, last_success_at, stale_at, oldest_synced_at,
  next_provider_cursor, source_revision, last_error_code, updated_at
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function detailsObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ACTIVITY_HISTORY_DETAILS_INVALID');
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertNoExternalIdentifiers(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoExternalIdentifiers(entry);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      normalizedKey.endsWith('id') &&
      (normalizedKey.includes('external') ||
        normalizedKey.includes('provider') ||
        normalizedKey.includes('viva'))
    ) {
      throw new Error('ACTIVITY_HISTORY_EXTERNAL_IDENTIFIER_FORBIDDEN');
    }
    assertNoExternalIdentifiers(nested);
  }
}

function mapHistoryItem(row: ActivityHistoryRow): ActivityHistoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    occurredAt: timestamp(row.occurred_at),
    startsAt: timestamp(row.starts_at),
    endsAt: nullableTimestamp(row.ends_at),
    title: row.title,
    venueName: row.venue_name,
    route: row.route,
    gameId: row.game_id,
    tournamentId: row.tournament_id,
    details: detailsObject(row.details),
    sourceRevision: row.source_revision,
    syncedAt: timestamp(row.synced_at),
  };
}

function unsyncedState(userId: string): ActivityHistorySyncState {
  return {
    userId,
    coverageStatus: 'UNSYNCED',
    freshness: 'UNSYNCED',
    lastSuccessAt: null,
    staleAt: null,
    oldestSyncedAt: null,
    nextProviderCursor: null,
    sourceRevision: null,
    lastErrorCode: null,
    updatedAt: null,
  };
}

function mapSyncState(
  row: ActivityHistorySyncRow | undefined,
  userId: string,
  asOf: string,
): ActivityHistorySyncState {
  if (!row || row.coverage_status === 'UNSYNCED' || row.last_success_at === null) {
    return row
      ? {
          ...unsyncedState(userId),
          lastErrorCode: row.last_error_code,
          updatedAt: timestamp(row.updated_at),
        }
      : unsyncedState(userId);
  }
  if (row.stale_at === null) throw new Error('ACTIVITY_HISTORY_SYNC_STATE_INVALID');
  return {
    userId: row.user_id,
    coverageStatus: row.coverage_status,
    freshness: new Date(row.stale_at).getTime() <= new Date(asOf).getTime() ? 'STALE' : 'FRESH',
    lastSuccessAt: timestamp(row.last_success_at),
    staleAt: timestamp(row.stale_at),
    oldestSyncedAt: nullableTimestamp(row.oldest_synced_at),
    nextProviderCursor: row.next_provider_cursor,
    sourceRevision: row.source_revision,
    lastErrorCode: row.last_error_code,
    updatedAt: timestamp(row.updated_at),
  };
}

function serializedItems(items: readonly PersistActivityHistoryItemInput[]): string {
  for (const item of items) assertNoExternalIdentifiers(item.details);
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      occurredAt: item.occurredAt,
      startsAt: item.startsAt,
      endsAt: item.endsAt ?? null,
      title: item.title,
      venueName: item.venueName ?? null,
      route: item.route ?? null,
      gameId: item.gameId ?? null,
      tournamentId: item.tournamentId ?? null,
      sourceMappingId: item.integrationMappingId ?? null,
      details: item.details,
      sourceRevision: item.sourceRevision,
      syncedAt: item.syncedAt,
    })),
  );
}

export function createActivityHistoryRepository(pool: Pool): ActivityHistoryRepository {
  return {
    resolveVivaExerciseGameAssociations(input) {
      const associationIds = [...new Set(input.associationIds.filter(Boolean))];
      if (associationIds.length === 0) return Promise.resolve([]);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<{
          readonly external_id: string;
          readonly internal_id: string;
        }>(
          `select mapping.external_id, mapping.internal_id
             from integration.external_entity_map mapping
             join games.games game
               on game.tenant_id = mapping.tenant_id and game.id = mapping.internal_id
            where mapping.tenant_id = $1
              and mapping.external_system = 'VIVA'
              and mapping.entity_type = 'exercise'
              and mapping.external_id = any($2::text[])`,
          [input.tenantId, associationIds],
        );
        return result.rows.map((row) => ({
          associationId: row.external_id,
          gameId: row.internal_id,
        }));
      });
    },

    resolveSourceMapping(input) {
      if (input.externalId.trim().length === 0) {
        return Promise.reject(new Error('ACTIVITY_HISTORY_EXTERNAL_ID_REQUIRED'));
      }
      if (input.externalVersion.trim().length === 0) {
        return Promise.reject(new Error('ACTIVITY_HISTORY_EXTERNAL_VERSION_REQUIRED'));
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<ActivityHistorySourceMappingRow>(
          client,
          `insert into integration.external_entity_map (
             tenant_id, external_system, entity_type, internal_id, external_id,
             external_version, last_synced_at, sync_status, sync_error_code
           ) values ($1, $2, $3, gen_random_uuid(), $4, $5, $6, 'synced', null)
           on conflict (tenant_id, external_system, entity_type, external_id) do update set
             external_version = excluded.external_version,
             last_synced_at = excluded.last_synced_at,
             sync_status = 'synced',
             sync_error_code = null
           returning id, internal_id`,
          [
            input.tenantId,
            input.externalSystem,
            input.entityType,
            input.externalId,
            input.externalVersion,
            input.syncedAt,
          ],
        );
        if (!row) throw new Error('ACTIVITY_HISTORY_SOURCE_MAPPING_WRITE_LOST');
        return { mappingId: row.id, internalId: row.internal_id };
      });
    },

    list(input) {
      const limit = Math.max(1, Math.min(input.limit, 100));
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<ActivityHistoryRow>(
          `select ${HISTORY_COLUMNS}
             from booking.activity_history_projection
            where tenant_id = $1
              and user_id = $2
              and ($3::text is null or kind = $3)
              and ($4::text is null or status = $4)
              and (
                $5::timestamptz is null
                or (occurred_at, id) < ($5::timestamptz, $6::uuid)
              )
            order by occurred_at desc, id desc
            limit $7`,
          [
            input.tenantId,
            input.userId,
            input.kind ?? null,
            input.status ?? null,
            input.after?.occurredAt ?? null,
            input.after?.id ?? null,
            limit + 1,
          ],
        );
        const items = result.rows.slice(0, limit).map(mapHistoryItem);
        const last = items.at(-1);
        return {
          items,
          ...(result.rows.length > limit && last
            ? { next: { occurredAt: last.occurredAt, id: last.id } }
            : {}),
        };
      });
    },

    getSyncState(input) {
      const asOf = input.asOf ?? new Date().toISOString();
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<ActivityHistorySyncRow>(
          client,
          `select ${SYNC_COLUMNS}
             from integration.user_activity_history_sync_state
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.userId],
        );
        return mapSyncState(row, input.userId, asOf);
      });
    },

    async persistPage(input) {
      const itemsJson = serializedItems(input.items);
      const currentItemIds = new Set(input.items.map((item) => item.id));
      const supersededItemIds = [...new Set(input.supersededItemIds ?? [])].filter(
        (id) => !currentItemIds.has(id),
      );
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `activity-history-sync:${input.tenantId}:${input.userId}`,
        ]);
        if (input.items.length > 0) {
          await client.query(
            `with source as (
               select *
                 from jsonb_to_recordset($3::jsonb) as item(
                   id uuid,
                   kind text,
                   status text,
                   "occurredAt" timestamptz,
                   "startsAt" timestamptz,
                   "endsAt" timestamptz,
                   title text,
                   "venueName" text,
                   route text,
                   "gameId" uuid,
                   "tournamentId" uuid,
                   "sourceMappingId" uuid,
                   details jsonb,
                   "sourceRevision" text,
                   "syncedAt" timestamptz
                 )
             )
             insert into booking.activity_history_projection (
               tenant_id, user_id, id, kind, status, occurred_at, starts_at, ends_at,
               title, venue_name, route, game_id, tournament_id, source_mapping_id,
               details, source_revision, synced_at
             )
             select $1, $2, id, kind, status, "occurredAt", "startsAt", "endsAt",
                    title, "venueName", route, "gameId", "tournamentId", "sourceMappingId",
                    details, "sourceRevision", "syncedAt"
               from source
             on conflict (tenant_id, user_id, id) do update set
               kind = excluded.kind,
               status = excluded.status,
               occurred_at = excluded.occurred_at,
               starts_at = excluded.starts_at,
               ends_at = excluded.ends_at,
               title = excluded.title,
               venue_name = excluded.venue_name,
               route = excluded.route,
               game_id = excluded.game_id,
               tournament_id = excluded.tournament_id,
               source_mapping_id = excluded.source_mapping_id,
               details = excluded.details,
               source_revision = excluded.source_revision,
               synced_at = excluded.synced_at,
               updated_at = now()
             where excluded.synced_at >= booking.activity_history_projection.synced_at`,
            [input.tenantId, input.userId, itemsJson],
          );
        }
        if (supersededItemIds.length > 0) {
          await client.query(
            `delete from booking.activity_history_projection
              where tenant_id = $1 and user_id = $2 and id = any($3::uuid[])`,
            [input.tenantId, input.userId, supersededItemIds],
          );
        }
        const row = await queryOne<ActivityHistorySyncRow>(
          client,
          `insert into integration.user_activity_history_sync_state (
             tenant_id, user_id, coverage_status, last_success_at, stale_at,
             oldest_synced_at, next_provider_cursor, source_revision, last_error_code
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, null)
           on conflict (tenant_id, user_id) do update set
             coverage_status = excluded.coverage_status,
             last_success_at = excluded.last_success_at,
             stale_at = excluded.stale_at,
             oldest_synced_at = excluded.oldest_synced_at,
             next_provider_cursor = excluded.next_provider_cursor,
             source_revision = excluded.source_revision,
             last_error_code = null,
             updated_at = now()
           returning ${SYNC_COLUMNS}`,
          [
            input.tenantId,
            input.userId,
            input.sync.coverageStatus,
            input.sync.lastSuccessAt,
            input.sync.staleAt,
            input.sync.oldestSyncedAt ?? null,
            input.sync.coverageStatus === 'PARTIAL' ? input.sync.nextProviderCursor : null,
            input.sync.sourceRevision,
          ],
        );
        if (!row) throw new Error('ACTIVITY_HISTORY_SYNC_STATE_WRITE_LOST');
        return mapSyncState(row, input.userId, input.sync.lastSuccessAt);
      });
    },

    recordSyncFailure(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<ActivityHistorySyncRow>(
          client,
          `insert into integration.user_activity_history_sync_state (
             tenant_id, user_id, coverage_status, last_error_code
           ) values ($1, $2, 'UNSYNCED', $3)
           on conflict (tenant_id, user_id) do update set
             last_error_code = excluded.last_error_code,
             updated_at = now()
           returning ${SYNC_COLUMNS}`,
          [input.tenantId, input.userId, input.errorCode],
        );
        if (!row) throw new Error('ACTIVITY_HISTORY_SYNC_FAILURE_WRITE_LOST');
        return mapSyncState(row, input.userId, new Date().toISOString());
      });
    },
  };
}
