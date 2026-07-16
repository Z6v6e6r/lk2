import { createHash } from 'node:crypto';

import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface HomeDashboardProjectionRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly sourceRevision: string;
  readonly sourceEventId: string;
  readonly producer: string;
  readonly snapshotVersion: string;
  readonly payload: unknown;
  readonly payloadChecksum: string;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly updatedAt: string;
}

export interface UpsertHomeDashboardProjectionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly sourceRevision: string;
  readonly sourceEventId: string;
  readonly producer: string;
  readonly snapshotVersion: string;
  readonly payload: unknown;
  readonly generatedAt: string;
  readonly staleAt: string;
  readonly correlationId: string;
}

export type UpsertHomeDashboardProjectionResult =
  | { readonly outcome: 'applied'; readonly sourceRevision: string }
  | { readonly outcome: 'unchanged'; readonly sourceRevision: string }
  | { readonly outcome: 'superseded'; readonly sourceRevision: string }
  | { readonly outcome: 'revision_conflict'; readonly sourceRevision: string };

export interface HomeDashboardProjectionRepository {
  get(tenantId: string, userId: string): Promise<HomeDashboardProjectionRecord | undefined>;
  upsert(input: UpsertHomeDashboardProjectionInput): Promise<UpsertHomeDashboardProjectionResult>;
}

interface HomeDashboardProjectionRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly source_revision: string;
  readonly source_event_id: string;
  readonly producer: string;
  readonly snapshot_version: string;
  readonly payload: unknown;
  readonly payload_checksum: string;
  readonly generated_at: Date | string;
  readonly stale_at: Date | string;
  readonly updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProjection(row: HomeDashboardProjectionRow): HomeDashboardProjectionRecord {
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
    staleAt: timestamp(row.stale_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function checksum(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const projectionColumns = `
  tenant_id,
  user_id,
  source_revision::text as source_revision,
  source_event_id,
  producer,
  snapshot_version,
  payload,
  payload_checksum,
  generated_at,
  stale_at,
  updated_at
`;

export function createHomeDashboardProjectionRepository(
  pool: Pool,
): HomeDashboardProjectionRepository {
  return {
    get(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const row = await queryOne<HomeDashboardProjectionRow>(
          client,
          `select ${projectionColumns}
             from home.dashboard_snapshots
            where tenant_id = $1 and user_id = $2`,
          [tenantId, userId],
        );
        return row ? mapProjection(row) : undefined;
      });
    },

    upsert(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const payloadChecksum = checksum(input.payload);
        const applied = await queryOne<HomeDashboardProjectionRow>(
          client,
          `insert into home.dashboard_snapshots (
             tenant_id, user_id, source_revision, source_event_id, producer,
             snapshot_version, payload, payload_checksum, generated_at, stale_at
           ) values ($1, $2, $3::bigint, $4, $5, $6, $7::jsonb, $8, $9, $10)
           on conflict (tenant_id, user_id) do update set
             source_revision = excluded.source_revision,
             source_event_id = excluded.source_event_id,
             producer = excluded.producer,
             snapshot_version = excluded.snapshot_version,
             payload = excluded.payload,
             payload_checksum = excluded.payload_checksum,
             generated_at = excluded.generated_at,
             stale_at = excluded.stale_at,
             updated_at = now()
           where excluded.source_revision > home.dashboard_snapshots.source_revision
           returning ${projectionColumns}`,
          [
            input.tenantId,
            input.userId,
            input.sourceRevision,
            input.sourceEventId,
            input.producer,
            input.snapshotVersion,
            JSON.stringify(input.payload),
            payloadChecksum,
            input.generatedAt,
            input.staleAt,
          ],
        );

        if (applied) {
          await client.query(
            `insert into audit.audit_log (
               tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
             ) values ($1, 'HOME_DASHBOARD_PROJECTED', 'HOME_DASHBOARD_PROJECTION', $2,
                       'SUCCESS', $3, $4::jsonb)`,
            [
              input.tenantId,
              input.userId,
              input.correlationId,
              JSON.stringify({
                sourceRevision: input.sourceRevision,
                sourceEventId: input.sourceEventId,
                producer: input.producer,
                snapshotVersion: input.snapshotVersion,
                payloadChecksum,
              }),
            ],
          );
          return { outcome: 'applied', sourceRevision: applied.source_revision };
        }

        const current = await queryOne<HomeDashboardProjectionRow>(
          client,
          `select ${projectionColumns}
             from home.dashboard_snapshots
            where tenant_id = $1 and user_id = $2`,
          [input.tenantId, input.userId],
        );
        if (!current) throw new Error('HOME_PROJECTION_WRITE_LOST');
        if (current.source_revision === input.sourceRevision) {
          return current.payload_checksum === payloadChecksum
            ? { outcome: 'unchanged', sourceRevision: current.source_revision }
            : { outcome: 'revision_conflict', sourceRevision: current.source_revision };
        }
        return { outcome: 'superseded', sourceRevision: current.source_revision };
      });
    },
  };
}
