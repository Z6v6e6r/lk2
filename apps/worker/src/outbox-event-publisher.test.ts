import { describe, expect, it, vi } from 'vitest';

import { publishOutboxRows, type OutboxRow } from './outbox-event-publisher.js';

const row: OutboxRow = {
  id: '10000000-0000-4000-8000-000000000001',
  event_type: 'notifications.intent.created.v1',
  aggregate_id: '20000000-0000-4000-8000-000000000001',
  tenant_id: '30000000-0000-4000-8000-000000000001',
  correlation_id: 'correlation-1',
  occurred_at: new Date('2026-07-19T09:00:00.000Z'),
  payload: { notificationId: 'safe-id' },
};

describe('outbox event publisher', () => {
  it('preserves the existing durable event envelope and waits for broker confirms', async () => {
    const publish = vi.fn().mockReturnValue(true);
    const waitForConfirms = vi.fn().mockResolvedValue(undefined);

    await publishOutboxRows({
      channel: { publish, waitForConfirms } as never,
      rows: [row],
    });

    expect(publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, body, properties] = publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      Record<string, unknown>,
    ];
    expect(exchange).toBe('phub.events');
    expect(routingKey).toBe(row.event_type);
    expect(JSON.parse(body.toString('utf8'))).toEqual({
      id: row.id,
      type: row.event_type,
      aggregateId: row.aggregate_id,
      tenantId: row.tenant_id,
      occurredAt: row.occurred_at.toISOString(),
      correlationId: row.correlation_id,
      payload: row.payload,
    });
    expect(properties).toMatchObject({
      persistent: true,
      messageId: row.id,
      correlationId: row.correlation_id,
      headers: { tenantId: row.tenant_id },
    });
    expect(waitForConfirms).toHaveBeenCalledTimes(1);
  });

  it('fails with a stable code when publisher confirms exceed the lease-safe timeout', async () => {
    vi.useFakeTimers();
    try {
      const publishPromise = publishOutboxRows({
        channel: {
          publish: vi.fn().mockReturnValue(true),
          waitForConfirms: vi.fn(() => new Promise<void>(() => undefined)),
        } as never,
        rows: [row],
        confirmTimeoutMs: 1_000,
      });
      const assertion = expect(publishPromise).rejects.toMatchObject({
        code: 'OUTBOX_CONFIRM_TIMEOUT',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
