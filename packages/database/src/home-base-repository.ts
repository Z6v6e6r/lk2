import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface HomeBaseProjectionRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly sourceRevision: string;
  readonly sourceEventId: string;
  readonly producer: string;
  readonly snapshotVersion: string;
  readonly payload: unknown;
  readonly payloadChecksum: string;
  readonly generatedAt: string;
  readonly checkedAt: string;
  readonly updatedAt: string;
}

export interface HomeBaseProjectionRepository {
  get(tenantId: string, userId: string): Promise<HomeBaseProjectionRecord | undefined>;
}

interface HomeBaseProjectionRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly source_revision: string;
  readonly source_event_id: string;
  readonly producer: string;
  readonly snapshot_version: string;
  readonly payload: unknown;
  readonly payload_checksum: string;
  readonly generated_at: Date | string;
  readonly checked_at: Date | string;
  readonly updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProjection(row: HomeBaseProjectionRow): HomeBaseProjectionRecord {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    sourceRevision: row.source_revision,
    sourceEventId: row.source_event_id,
    producer: row.producer,
    snapshotVersion: row.snapshot_version,
    payload: row.payload,
    payloadChecksum: row.payload_checksum,
    generatedAt: timestamp(row.generated_at),
    checkedAt: timestamp(row.checked_at),
    updatedAt: timestamp(row.updated_at),
  };
}

export function createHomeBaseProjectionRepository(pool: Pool): HomeBaseProjectionRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<HomeBaseProjectionRow>(
          client,
          `select tenant_id, user_id, source_revision::text as source_revision,
                  source_event_id, producer, snapshot_version, payload, payload_checksum,
                  generated_at, checked_at, updated_at
             from home.base_snapshots
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row ? mapProjection(row) : undefined;
      });
    },
  };
}
