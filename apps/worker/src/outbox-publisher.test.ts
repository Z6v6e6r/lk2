import { describe, expect, it, vi } from 'vitest';

import { publishOutboxBatch } from './outbox-publisher.js';
import type { OutboxRow } from './outbox-event-publisher.js';

describe('transactional outbox publisher compatibility', () => {
  it('keeps the default publisher independent of lease columns and preserves its commit flow', async () => {
    const row: OutboxRow = {
      id: '10000000-0000-4000-8000-000000000001',
      event_type: 'notifications.intent.created.v1',
      aggregate_id: '20000000-0000-4000-8000-000000000001',
      tenant_id: '30000000-0000-4000-8000-000000000001',
      correlation_id: 'correlation-1',
      occurred_at: new Date('2026-07-19T09:00:00.000Z'),
      payload: { notificationId: 'safe-id' },
    };
    const timeline: string[] = [];
    const client = {
      query: vi.fn((text: string) => {
        if (text.includes('from audit.outbox_events')) {
          timeline.push('database:select');
          expect(text).not.toContain('publish_claim_');
          return Promise.resolve({ rows: [row], rowCount: 1 });
        }
        if (text.startsWith('update audit.outbox_events')) {
          timeline.push('database:published');
          expect(text).not.toContain('publish_claim_');
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (text === 'commit') timeline.push('database:commit');
        return Promise.resolve({ rows: [], rowCount: null });
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const channel = {
      publish: vi.fn(() => {
        timeline.push('rabbit:publish');
        return true;
      }),
      waitForConfirms: vi.fn(() => {
        timeline.push('rabbit:confirmed');
        return Promise.resolve();
      }),
    };
    const logger = { error: vi.fn() };

    await expect(
      publishOutboxBatch({
        pool: pool as never,
        channel: channel as never,
        logger: logger as never,
        tenantId: row.tenant_id,
        confirmTimeoutMs: 10_000,
      }),
    ).resolves.toBe(1);

    expect(timeline).toEqual([
      'database:select',
      'rabbit:publish',
      'rabbit:confirmed',
      'database:published',
      'database:commit',
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rolls back and releases the database lock when RabbitMQ confirms time out', async () => {
    vi.useFakeTimers();
    try {
      const row: OutboxRow = {
        id: '10000000-0000-4000-8000-000000000001',
        event_type: 'notifications.intent.created.v1',
        aggregate_id: '20000000-0000-4000-8000-000000000001',
        tenant_id: '30000000-0000-4000-8000-000000000001',
        correlation_id: 'correlation-1',
        occurred_at: new Date('2026-07-19T09:00:00.000Z'),
        payload: { notificationId: 'safe-id' },
      };
      const client = {
        query: vi.fn((text: string) => {
          if (text.includes('from audit.outbox_events')) {
            return Promise.resolve({ rows: [row], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: null });
        }),
        release: vi.fn(),
      };
      const logger = { error: vi.fn() };
      const publishPromise = publishOutboxBatch({
        pool: { connect: vi.fn().mockResolvedValue(client) } as never,
        channel: {
          publish: vi.fn().mockReturnValue(true),
          waitForConfirms: vi.fn(() => new Promise<void>(() => undefined)),
        } as never,
        logger: logger as never,
        tenantId: row.tenant_id,
        confirmTimeoutMs: 1_000,
      });
      const assertion = expect(publishPromise).rejects.toMatchObject({
        code: 'OUTBOX_CONFIRM_TIMEOUT',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(client.query).toHaveBeenCalledWith('rollback');
      expect(client.query).not.toHaveBeenCalledWith('commit');
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
