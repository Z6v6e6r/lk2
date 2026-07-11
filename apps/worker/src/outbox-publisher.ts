import type { ConfirmChannel } from 'amqplib';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

interface OutboxRow {
  readonly id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly occurred_at: Date;
  readonly payload: Record<string, unknown>;
}

export async function publishOutboxBatch(options: {
  readonly pool: Pool;
  readonly channel: ConfirmChannel;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly batchSize?: number;
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
        order by occurred_at
        for update skip locked
        limit $2`,
      [options.tenantId, options.batchSize ?? 50],
    );

    for (const row of result.rows) {
      const body = Buffer.from(
        JSON.stringify({
          id: row.id,
          type: row.event_type,
          aggregateId: row.aggregate_id,
          tenantId: row.tenant_id,
          occurredAt: row.occurred_at.toISOString(),
          correlationId: row.correlation_id,
          payload: row.payload,
        }),
      );
      options.channel.publish('phub.events', row.event_type, body, {
        persistent: true,
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        messageId: row.id,
        correlationId: row.correlation_id,
        timestamp: row.occurred_at.getTime(),
        headers: { tenantId: row.tenant_id },
      });
    }

    if (result.rowCount && result.rowCount > 0) {
      await options.channel.waitForConfirms();
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
