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
}

export interface BookingScreenMappingRepository {
  resolve(input: {
    readonly tenantId: string;
    readonly bookingExternalIds: readonly string[];
    readonly exerciseAssociationIds: readonly string[];
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
      ].slice(0, 100);
      if (bookingExternalIds.length === 0 && exerciseAssociationIds.length === 0) {
        return Promise.resolve({ bookings: [], games: [] });
      }
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const [bookings, games] = await Promise.all([
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
              ),
          exerciseAssociationIds.length === 0
            ? Promise.resolve({ rows: [] as GameMappingRow[] })
            : client.query<GameMappingRow>(
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
                [input.tenantId, exerciseAssociationIds],
              ),
        ]);
        return {
          bookings: bookings.rows.map((row) => ({
            externalId: row.external_id,
            bookingId: row.internal_id,
          })),
          games: games.rows.map((row) => ({
            associationId: row.external_id,
            gameId: row.internal_id,
          })),
        };
      });
    },
  };
}
