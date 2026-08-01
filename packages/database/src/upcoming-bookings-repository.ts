import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface UpcomingBookingProjectionItem {
  readonly id: string;
  readonly kind: 'game' | 'training' | 'tournament';
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly venue: string;
  readonly status: 'confirmed' | 'waitlist' | 'payment_required';
  readonly route: string;
}

export interface UpcomingBookingsProjection {
  readonly tenantId: string;
  readonly userId: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly items: readonly UpcomingBookingProjectionItem[];
  readonly updatedAt: string;
}

export interface UpcomingBookingsRepository {
  get(tenantId: string, userId: string): Promise<UpcomingBookingsProjection | undefined>;
  replace(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly version: string;
    readonly generatedAt: string;
    readonly staleAt: string;
    readonly items: readonly UpcomingBookingProjectionItem[];
  }): Promise<UpcomingBookingsProjection>;
}

interface UpcomingBookingsRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly version: string;
  readonly generated_at: Date | string;
  readonly stale_at: Date | string;
  readonly items: unknown;
  readonly updated_at: Date | string;
}

const columns = `
  tenant_id, user_id, version, generated_at, stale_at, items, updated_at
`;

function timestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

function items(value: unknown): readonly UpcomingBookingProjectionItem[] {
  if (!Array.isArray(value)) throw new Error('UPCOMING_BOOKINGS_PROJECTION_INVALID');
  return value as readonly UpcomingBookingProjectionItem[];
}

function mapProjection(row: UpcomingBookingsRow): UpcomingBookingsProjection {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    version: row.version,
    generatedAt: timestamp(row.generated_at),
    staleAt: timestamp(row.stale_at),
    items: items(row.items),
    updatedAt: timestamp(row.updated_at),
  };
}

export function createUpcomingBookingsRepository(pool: Pool): UpcomingBookingsRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<UpcomingBookingsRow>(
          client,
          `select ${columns}
             from booking.upcoming_booking_projection
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row ? mapProjection(row) : undefined;
      });
    },

    replace(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<UpcomingBookingsRow>(
          client,
          `insert into booking.upcoming_booking_projection (
             tenant_id, user_id, version, generated_at, stale_at, items
           ) values ($1, $2, $3, $4, $5, $6::jsonb)
           on conflict (tenant_id, user_id) do update set
             version = excluded.version,
             generated_at = excluded.generated_at,
             stale_at = excluded.stale_at,
             items = excluded.items,
             updated_at = now()
           returning ${columns}`,
          [
            input.tenantId,
            input.userId,
            input.version,
            input.generatedAt,
            input.staleAt,
            JSON.stringify(input.items),
          ],
        );
        if (!row) throw new Error('UPCOMING_BOOKINGS_PROJECTION_WRITE_LOST');
        return mapProjection(row);
      });
    },
  };
}
