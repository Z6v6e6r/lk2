import { HOME_PROJECTION_COMPONENT_EVENT, homeLocationSchema } from '@phub/home-projection';
import { locationGalleryImageSchema, type LocationProfileChangedEvent } from '@phub/locations';
import type { Pool, QueryResultRow } from 'pg';
import { z } from 'zod';

const CONSUMER_NAME = 'location-home-fanout-v1';

interface LocationHomeRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly short_title: string | null;
  readonly court_count: number;
  readonly gallery: unknown;
}

interface UserRow extends QueryResultRow {
  readonly user_id: string;
}

export type LocationHomeFanoutResult =
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'queued'; readonly userCount: number; readonly locationCount: number };

export async function fanOutLocationHomeComponent(input: {
  readonly pool: Pool;
  readonly event: LocationProfileChangedEvent;
}): Promise<LocationHomeFanoutResult> {
  const client = await input.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [input.event.tenantId]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `location-home:${input.event.tenantId}:${input.event.payload.componentRevision}`,
    ]);
    const inbox = await client.query(
      `insert into audit.inbox_events (consumer_name, event_id, tenant_id)
       values ($1, $2, $3)
       on conflict (consumer_name, event_id) do nothing
       returning event_id`,
      [CONSUMER_NAME, input.event.id, input.event.tenantId],
    );
    if (inbox.rowCount === 0) {
      await client.query('commit');
      return { outcome: 'duplicate' };
    }

    const locations = await client.query<LocationHomeRow>(
      `select id, title, short_title, court_count, gallery
         from locations.profiles
        where tenant_id = $1
          and publication_status = 'PUBLISHED'
          and show_on_home = true
        order by sort_order, title, id
        limit 8`,
      [input.event.tenantId],
    );
    const value = locations.rows.map((row) => {
      const gallery = z.array(locationGalleryImageSchema).max(12).parse(row.gallery);
      return homeLocationSchema.parse({
        id: row.id,
        title: row.short_title ?? row.title,
        courtCount: row.court_count,
        imageUrl: gallery.find((image) => image.isCover)?.url ?? null,
        route: `/locations/${row.id}`,
      });
    });
    const users = await client.query<UserRow>(
      `select distinct user_id
         from home.dashboard_components
        where tenant_id = $1 and component = 'profile'
        order by user_id`,
      [input.event.tenantId],
    );
    if (users.rows.length > 0) {
      await client.query(
        `insert into audit.outbox_events (
           tenant_id, event_type, aggregate_id, correlation_id, payload
         )
         select $1, $2, source.user_id, $3,
                jsonb_build_object(
                  'userId', source.user_id,
                  'component', 'locations',
                  'componentRevision', $4::text,
                  'value', $5::jsonb
                )
           from unnest($6::uuid[]) as source(user_id)`,
        [
          input.event.tenantId,
          HOME_PROJECTION_COMPONENT_EVENT,
          input.event.correlationId,
          input.event.payload.componentRevision,
          JSON.stringify(value),
          users.rows.map((row) => row.user_id),
        ],
      );
    }
    await client.query(
      `update audit.inbox_events
          set processed_at = now()
        where consumer_name = $1 and event_id = $2`,
      [CONSUMER_NAME, input.event.id],
    );
    await client.query('commit');
    return { outcome: 'queued', userCount: users.rows.length, locationCount: value.length };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
