import type { ConfirmChannel } from 'amqplib';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { publishOutboxRows, type OutboxRow } from './outbox-event-publisher.js';

export async function publishOutboxBatch(options: {
  readonly pool: Pool;
  readonly channel: ConfirmChannel;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly batchSize?: number;
  readonly confirmTimeoutMs: number;
}): Promise<number> {
  const client = await options.pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [options.tenantId]);
    const result = await client.query<OutboxRow>(
      `select id, event_type, aggregate_id, tenant_id, correlation_id, occurred_at, payload
         from audit.outbox_events
        where published_at is null
          and tenant_id = $1
        order by occurred_at, id
        for update skip locked
        limit $2`,
      [options.tenantId, options.batchSize ?? 50],
    );

    if (result.rowCount && result.rowCount > 0) {
      await publishOutboxRows({
        channel: options.channel,
        rows: result.rows,
        confirmTimeoutMs: options.confirmTimeoutMs,
      });
      await client.query(
        'update audit.outbox_events set published_at = now() where id = any($1::uuid[])',
        [result.rows.map((row) => row.id)],
      );
    }
    await client.query('commit');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('rollback');
    options.logger.error({ error }, 'outbox publish cycle failed');
    throw error;
  } finally {
    client.release();
  }
}
