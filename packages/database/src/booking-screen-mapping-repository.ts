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
  };
}
