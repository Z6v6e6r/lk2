import { createHash } from 'node:crypto';

import type { Pool, QueryResultRow } from 'pg';

import { withTenantTransaction } from './connection.js';

export interface BookingScreenCanonicalMappings {
  readonly bookings: readonly {
    readonly externalId: string;
    readonly bookingId: string;
  }[];
  readonly games: readonly {
    readonly associationId: string;
    readonly gameId: string;
  }[];
  readonly stations: readonly {
    readonly externalId: string;
    readonly stationId: string;
  }[];
}

export interface BookingScreenMappingRepository {
  resolve(input: {
    readonly tenantId: string;
    readonly bookingExternalIds: readonly string[];
    readonly exerciseAssociationIds: readonly string[];
    readonly stationExternalIds?: readonly string[];
  }): Promise<BookingScreenCanonicalMappings>;
  /**
   * Proves that relayed booking references belong to the current user using the
   * fresh worker-owned Viva Home snapshot. Browser-written projections are not
   * an ownership authority.
   */
  resolveOwnedBookingExercises?(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly candidates: readonly {
      readonly bookingExternalId: string;
      readonly exerciseExternalId: string;
      readonly exerciseAssociationIds: readonly string[];
    }[];
    readonly maxAgeSeconds: number;
  }): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
  /** Integration-only Viva identity lookup; provider IDs are never serialized to clients. */
  resolveVivaProfileIds?(input: {
    readonly tenantId: string;
    readonly externalClientIds: readonly string[];
  }): Promise<ReadonlyMap<string, string>>;
  /** Trusted roster fallback; returns only display names that identify exactly one active user. */
  resolveUniqueProfileIdsByDisplayNames?(input: {
    readonly tenantId: string;
    readonly displayNames: readonly string[];
  }): Promise<ReadonlyMap<string, string>>;
}

interface BookingMappingRow extends QueryResultRow {
  readonly external_id: string;
  readonly internal_id: string;
}

interface GameMappingRow extends QueryResultRow {
  readonly external_id: string;
  readonly internal_id: string;
}

interface StationMappingRow extends QueryResultRow {
  readonly external_id: string;
  readonly internal_id: string;
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

/**
 * Reads only mappings previously established by a trusted worker/import path.
 * Client-relayed identifiers can never create or update integration mappings.
 */
export function createBookingScreenMappingRepository(pool: Pool): BookingScreenMappingRepository {
  return {
    resolve(input) {
      const bookingExternalIds = [...new Set(input.bookingExternalIds.filter(Boolean))].slice(
        0,
        50,
      );
      const exerciseAssociationIds = [
        ...new Set(input.exerciseAssociationIds.filter(Boolean)),
      ].slice(0, 1_000);
      const stationExternalIds = [
        ...new Set((input.stationExternalIds ?? []).filter(Boolean)),
      ].slice(0, 500);
      if (
        bookingExternalIds.length === 0 &&
        exerciseAssociationIds.length === 0 &&
        stationExternalIds.length === 0
      ) {
        return Promise.resolve({ bookings: [], games: [], stations: [] });
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const bookings =
          bookingExternalIds.length === 0
            ? Promise.resolve({ rows: [] as BookingMappingRow[] })
            : client.query<BookingMappingRow>(
                `select external_id, internal_id
                   from integration.external_entity_map
                  where tenant_id = $1
                    and external_system = 'VIVA'
                    and entity_type = 'booking'
                    and external_id = any($2::text[])`,
                [input.tenantId, bookingExternalIds],
              );
        const gamePages: GameMappingRow[] = [];
        for (const page of chunks(exerciseAssociationIds, 100)) {
          const result = await client.query<GameMappingRow>(
            `select mapping.external_id, mapping.internal_id
                   from integration.external_entity_map mapping
                   join games.games game
                     on game.tenant_id = mapping.tenant_id
                    and game.id = mapping.internal_id
                  where mapping.tenant_id = $1
                    and mapping.external_system = 'VIVA'
                    and mapping.entity_type = 'exercise'
                    and mapping.external_id = any($2::text[])
                    and game.lifecycle_state in ('SCHEDULED', 'IN_PROGRESS')`,
            [input.tenantId, page],
          );
          gamePages.push(...result.rows);
        }
        const stationPages: StationMappingRow[] = [];
        for (const page of chunks(stationExternalIds, 100)) {
          const result = await client.query<StationMappingRow>(
            `select mapping.external_id, mapping.internal_id
               from integration.external_entity_map mapping
               join locations.profiles station
                 on station.tenant_id = mapping.tenant_id
                and station.id = mapping.internal_id
              where mapping.tenant_id = $1
                and mapping.external_system = 'LK_LEGACY_SNAPSHOT'
                and mapping.entity_type = 'game_station'
                and mapping.external_id = any($2::text[])
                and station.publication_status = 'PUBLISHED'`,
            [input.tenantId, page],
          );
          stationPages.push(...result.rows);
        }
        const bookingRows = await bookings;
        return {
          bookings: bookingRows.rows.map((row) => ({
            externalId: row.external_id,
            bookingId: row.internal_id,
          })),
          games: gamePages.map((row) => ({
            associationId: row.external_id,
            gameId: row.internal_id,
          })),
          stations: stationPages.map((row) => ({
            externalId: row.external_id,
            stationId: row.internal_id,
          })),
        };
      });
    },
    resolveOwnedBookingExercises(input) {
      const candidates = [
        ...new Map(
          input.candidates.map((candidate) => [
            `${candidate.bookingExternalId}\u0000${candidate.exerciseExternalId}`,
            {
              bookingExternalId: candidate.bookingExternalId,
              exerciseExternalId: candidate.exerciseExternalId,
            },
          ]),
        ).values(),
      ].slice(0, 100);
      if (candidates.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<
          QueryResultRow & {
            readonly booking_external_id: string;
            readonly exercise_external_id: string;
          }
        >(
          `with candidates as (
             select *
               from unnest($3::text[], $4::text[])
                 as candidate(booking_external_id, exercise_external_id)
           )
           select distinct candidate.booking_external_id, candidate.exercise_external_id
             from candidates candidate
             join integration.viva_home_booking_ownership ownership
               on ownership.tenant_id = $1
              and ownership.user_id = $2
              and ownership.booking_external_id = candidate.booking_external_id
              and ownership.exercise_external_id = candidate.exercise_external_id
              and ownership.fetched_at >= now() - make_interval(secs => $5)`,
          [
            input.tenantId,
            input.userId,
            candidates.map((candidate) => candidate.bookingExternalId),
            candidates.map((candidate) => candidate.exerciseExternalId),
            input.maxAgeSeconds,
          ],
        );
        const bindings = new Map<string, Set<string>>();
        for (const row of result.rows) {
          const exerciseIds = bindings.get(row.booking_external_id) ?? new Set<string>();
          exerciseIds.add(row.exercise_external_id);
          bindings.set(row.booking_external_id, exerciseIds);
        }
        return bindings;
      });
    },
    resolveVivaProfileIds(input) {
      const externalClientIds = [...new Set(input.externalClientIds.filter(Boolean))].slice(0, 100);
      if (externalClientIds.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const associationByExternalId = new Map(
          externalClientIds.map((externalId) => [
            externalId,
            createHash('sha256')
              .update(`phub-local-public-clone-v1:player:${externalId}`)
              .digest('hex'),
          ]),
        );
        const directMappings = await client.query<
          QueryResultRow & { readonly external_id: string; readonly internal_id: string }
        >(
          `select mapping.external_id, mapping.internal_id
             from integration.external_entity_map mapping
             join identity.users identity_user
               on identity_user.tenant_id = mapping.tenant_id
              and identity_user.id = mapping.internal_id
            where mapping.tenant_id = $1
              and mapping.external_system = 'VIVA'
              and mapping.entity_type = 'viva_profile'
              and mapping.external_id = any($2::text[])
              and identity_user.status = 'ACTIVE'`,
          [input.tenantId, externalClientIds],
        );
        const legacyMappings = await client.query<
          QueryResultRow & { readonly external_id: string; readonly internal_id: string }
        >(
          `select mapping.external_id, mapping.internal_id
             from integration.external_entity_map mapping
             join identity.users identity_user
               on identity_user.tenant_id = mapping.tenant_id
              and identity_user.id = mapping.internal_id
            where mapping.tenant_id = $1
              and mapping.external_system = 'LK_LEGACY_SNAPSHOT'
              and mapping.entity_type = 'game_player'
              and mapping.external_id = any($2::text[])
              and identity_user.status = 'ACTIVE'`,
          [input.tenantId, [...associationByExternalId.values()]],
        );
        const result = new Map(
          directMappings.rows.map((row) => [row.external_id, row.internal_id]),
        );
        const externalIdByAssociation = new Map(
          [...associationByExternalId].map(([externalId, associationId]) => [
            associationId,
            externalId,
          ]),
        );
        for (const mapping of legacyMappings.rows) {
          const externalId = externalIdByAssociation.get(mapping.external_id);
          if (externalId && !result.has(externalId)) result.set(externalId, mapping.internal_id);
        }
        return result;
      });
    },
    resolveUniqueProfileIdsByDisplayNames(input) {
      const displayNames = [
        ...new Set(input.displayNames.map((name) => name.trim()).filter(Boolean)),
      ].slice(0, 100);
      if (displayNames.length === 0) return Promise.resolve(new Map());
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const result = await client.query<
          QueryResultRow & { readonly display_name: string; readonly user_ids: readonly string[] }
        >(
          `select summary.display_name, array_agg(summary.user_id) as user_ids
             from profile.user_summaries summary
             join identity.users identity_user
               on identity_user.tenant_id = summary.tenant_id
              and identity_user.id = summary.user_id
            where summary.tenant_id = $1
              and summary.display_name = any($2::text[])
              and identity_user.status = 'ACTIVE'
            group by summary.display_name
           having count(*) = 1`,
          [input.tenantId, displayNames],
        );
        return new Map(
          result.rows.flatMap((row) =>
            row.user_ids[0] ? [[row.display_name, row.user_ids[0]] as const] : [],
          ),
        );
      });
    },
  };
}
