import { createHash } from 'node:crypto';

import {
  buildHomeProjection,
  homeProjectionComponentPayloadSchema,
  normalizeHomeProjectionComponentPayload,
  type HomeProjectionComponent,
  type HomeProjectionEvent,
} from '@phub/home-projection';
import type { Pool, QueryResultRow } from 'pg';

const CONSUMER_NAME = 'home-projector-v1';

interface ComponentRow extends QueryResultRow {
  readonly component: HomeProjectionComponent;
  readonly component_revision: string;
  readonly payload: unknown;
  readonly payload_checksum: string;
  readonly occurred_at: Date | string;
}

interface RevisionRow extends QueryResultRow {
  readonly source_revision: string;
}

export type HomeProjectionApplyResult =
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'unchanged'; readonly component: HomeProjectionComponent }
  | { readonly outcome: 'superseded'; readonly component: HomeProjectionComponent }
  | { readonly outcome: 'revision_conflict'; readonly component: HomeProjectionComponent }
  | {
      readonly outcome: 'waiting';
      readonly component: HomeProjectionComponent;
      readonly missing: readonly HomeProjectionComponent[];
      readonly reason: 'missing_components' | 'viva_source_batch';
    }
  | {
      readonly outcome: 'projected';
      readonly component: HomeProjectionComponent;
      readonly sourceRevision: string;
      readonly snapshotVersion: string;
    };

function checksum(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const VIVA_HOME_SOURCE_COMPONENTS = ['profile', 'upcoming', 'subscriptions'] as const;

export function isVivaHomeSourceBatchCoherent(
  rows: readonly Pick<ComponentRow, 'component' | 'occurred_at'>[],
): boolean {
  const sourceRows = VIVA_HOME_SOURCE_COMPONENTS.map((component) =>
    rows.find((row) => row.component === component),
  );
  if (sourceRows.some((row) => !row)) return true;
  return (
    new Set(sourceRows.map((row) => new Date(row?.occurred_at ?? Number.NaN).getTime())).size === 1
  );
}

export async function applyHomeProjectionEvent(options: {
  readonly pool: Pool;
  readonly event: HomeProjectionEvent;
  readonly ttlSeconds: number;
  readonly now?: Date;
}): Promise<HomeProjectionApplyResult> {
  const { event } = options;
  const client = await options.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [event.tenantId]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      event.payload.userId,
    ]);

    const inbox = await client.query(
      `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
       values ($1, $2, $3)
       on conflict (consumer_name, event_id) do nothing
       returning event_id`,
      [CONSUMER_NAME, event.id, event.tenantId],
    );
    if (inbox.rowCount === 0) {
      await client.query('commit');
      return { outcome: 'duplicate' };
    }

    const valueChecksum = checksum(event.payload.value);
    const applied = await client.query<ComponentRow>(
      `insert into home.dashboard_components (
         tenant_id, user_id, component, component_revision, source_event_id,
         payload, payload_checksum, occurred_at
       ) values ($1, $2, $3, $4::bigint, $5, $6::jsonb, $7, $8)
       on conflict (tenant_id, user_id, component) do update set
         component_revision = excluded.component_revision,
         source_event_id = excluded.source_event_id,
         payload = excluded.payload,
         payload_checksum = excluded.payload_checksum,
         occurred_at = excluded.occurred_at,
         updated_at = now()
       where excluded.component_revision > home.dashboard_components.component_revision
       returning component, component_revision::text as component_revision,
                 payload, payload_checksum, occurred_at`,
      [
        event.tenantId,
        event.payload.userId,
        event.payload.component,
        event.payload.componentRevision,
        event.id,
        JSON.stringify(event.payload.value),
        valueChecksum,
        event.occurredAt,
      ],
    );

    if (applied.rowCount === 0) {
      const current = await client.query<ComponentRow>(
        `select component, component_revision::text as component_revision,
                payload, payload_checksum, occurred_at
           from home.dashboard_components
          where tenant_id = $1 and user_id = $2 and component = $3`,
        [event.tenantId, event.payload.userId, event.payload.component],
      );
      const currentComponent = current.rows[0];
      let outcome: 'unchanged' | 'superseded' | 'revision_conflict';
      if (currentComponent?.component_revision === event.payload.componentRevision) {
        outcome =
          currentComponent.payload_checksum === valueChecksum ? 'unchanged' : 'revision_conflict';
      } else {
        outcome = 'superseded';
      }
      await client.query(
        `update audit.inbox_events
            set processed_at = now()
          where consumer_name = $1 and event_id = $2`,
        [CONSUMER_NAME, event.id],
      );
      await client.query('commit');
      return { outcome, component: event.payload.component };
    }

    const rows = await client.query<ComponentRow>(
      `select component, component_revision::text as component_revision,
              payload, payload_checksum, occurred_at
         from home.dashboard_components
        where tenant_id = $1 and user_id = $2
        order by component`,
      [event.tenantId, event.payload.userId],
    );
    const components = rows.rows.map((row) =>
      homeProjectionComponentPayloadSchema.parse(
        normalizeHomeProjectionComponentPayload({
          userId: event.payload.userId,
          component: row.component,
          componentRevision: row.component_revision,
          value: row.payload,
        }),
      ),
    );

    if (!isVivaHomeSourceBatchCoherent(rows.rows)) {
      await client.query(
        `update audit.inbox_events
            set processed_at = now()
          where consumer_name = $1 and event_id = $2`,
        [CONSUMER_NAME, event.id],
      );
      await client.query('commit');
      return {
        outcome: 'waiting',
        component: event.payload.component,
        missing: [],
        reason: 'viva_source_batch',
      };
    }

    const currentSnapshot = await client.query<RevisionRow>(
      `select source_revision::text as source_revision
         from home.dashboard_snapshots
        where tenant_id = $1 and user_id = $2
        for update`,
      [event.tenantId, event.payload.userId],
    );
    const nextRevision = (BigInt(currentSnapshot.rows[0]?.source_revision ?? '0') + 1n).toString();
    const projection = buildHomeProjection({
      components,
      sourceRevision: nextRevision,
      generatedAt: options.now ?? new Date(),
      ttlSeconds: options.ttlSeconds,
    });
    if (!projection.ready) {
      await client.query(
        `update audit.inbox_events
            set processed_at = now()
          where consumer_name = $1 and event_id = $2`,
        [CONSUMER_NAME, event.id],
      );
      await client.query('commit');
      return {
        outcome: 'waiting',
        component: event.payload.component,
        missing: projection.missing,
        reason: 'missing_components',
      };
    }

    const dashboard = projection.dashboard;
    const payloadChecksum = checksum(dashboard);
    await client.query(
      `insert into home.dashboard_snapshots (
         tenant_id, user_id, source_revision, source_event_id, producer,
         snapshot_version, payload, payload_checksum, generated_at, stale_at
       ) values ($1, $2, $3::bigint, $4, 'HOME_PROJECTOR', $5, $6::jsonb, $7, $8, $9)
       on conflict (tenant_id, user_id) do update set
         source_revision = excluded.source_revision,
         source_event_id = excluded.source_event_id,
         producer = excluded.producer,
         snapshot_version = excluded.snapshot_version,
         payload = excluded.payload,
         payload_checksum = excluded.payload_checksum,
         generated_at = excluded.generated_at,
         stale_at = excluded.stale_at,
         updated_at = now()`,
      [
        event.tenantId,
        event.payload.userId,
        nextRevision,
        event.id,
        dashboard.snapshot.version,
        JSON.stringify(dashboard),
        payloadChecksum,
        dashboard.snapshot.generatedAt,
        dashboard.snapshot.staleAt,
      ],
    );
    await client.query(
      `insert into audit.audit_log (
         tenant_id, action, resource_type, resource_id, result, correlation_id, new_value
       ) values ($1, 'HOME_DASHBOARD_PROJECTED', 'HOME_DASHBOARD_PROJECTION', $2,
                 'SUCCESS', $3, $4::jsonb)`,
      [
        event.tenantId,
        event.payload.userId,
        event.correlationId,
        JSON.stringify({
          sourceRevision: nextRevision,
          sourceEventId: event.id,
          producer: 'HOME_PROJECTOR',
          snapshotVersion: dashboard.snapshot.version,
          payloadChecksum,
        }),
      ],
    );
    await client.query(
      `update audit.inbox_events
          set processed_at = now()
        where consumer_name = $1 and event_id = $2`,
      [CONSUMER_NAME, event.id],
    );
    await client.query('commit');
    return {
      outcome: 'projected',
      component: event.payload.component,
      sourceRevision: nextRevision,
      snapshotVersion: dashboard.snapshot.version,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
