import { describe, expect, it, vi } from 'vitest';

import { publishLeasedOutboxBatch } from './leased-outbox-publisher.js';
import type { OutboxRow } from './outbox-event-publisher.js';

const tenantId = '30000000-0000-4000-8000-000000000001';
const claimToken = '40000000-0000-4000-8000-000000000001';
const row: OutboxRow = {
  id: '10000000-0000-4000-8000-000000000001',
  event_type: 'notifications.intent.created.v1',
  aggregate_id: '20000000-0000-4000-8000-000000000001',
  tenant_id: tenantId,
  correlation_id: 'correlation-1',
  occurred_at: new Date('2026-07-19T09:00:00.000Z'),
  payload: { notificationId: 'safe-id' },
};

function transactionClient(options: {
  readonly name: string;
  readonly timeline?: string[];
  readonly operation: (text: string, values: readonly unknown[]) => unknown;
}) {
  return {
    query: vi.fn((text: string, values: readonly unknown[] = []) => {
      options.timeline?.push(`${options.name}:${text.trim().split(/\s+/).slice(0, 2).join(' ')}`);
      if (text === 'begin' || text === 'commit' || text === 'rollback') {
        return Promise.resolve({ rows: [], rowCount: null });
      }
      if (text.includes("set_config('app.tenant_id'")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve(options.operation(text, values));
    }),
    release: vi.fn(),
  };
}

function runtimeOptions(pool: unknown, channel: unknown, logger: unknown) {
  return {
    pool: pool as never,
    channel: channel as never,
    logger: logger as never,
    tenantId,
    batchSize: 50,
    claimTtlMs: 60_000,
    confirmTimeoutMs: 10_000,
    failureBackoffMs: 5_000,
    claimTokenFactory: () => claimToken,
  };
}

describe('leased outbox publisher', () => {
  it('commits the claim before publishing and finalizes only after RabbitMQ confirms', async () => {
    const timeline: string[] = [];
    const claimClient = transactionClient({
      name: 'claim',
      timeline,
      operation: (text, values) => {
        expect(text).toContain('for update skip locked');
        expect(text).toContain('publish_claim_expires_at <= clock_timestamp()');
        expect(text).toContain('publish_attempts = event.publish_attempts + 1');
        expect(values).toEqual([tenantId, 50, claimToken, 60_000]);
        return { rows: [row], rowCount: 1 };
      },
    });
    const finalizeClient = transactionClient({
      name: 'finalize',
      timeline,
      operation: (text, values) => {
        expect(text).toContain('set published_at = clock_timestamp()');
        expect(values).toEqual([tenantId, claimToken, [row.id]]);
        return { rows: [{ id: row.id }], rowCount: 1 };
      },
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };
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
      publishLeasedOutboxBatch({
        ...runtimeOptions(pool, channel, logger),
        verificationHooks: {
          afterClaim: () => {
            timeline.push('hook:after-claim');
          },
          afterConfirm: () => {
            timeline.push('hook:after-confirm');
          },
        },
      }),
    ).resolves.toBe(1);

    expect(timeline.indexOf('claim:commit')).toBeLessThan(timeline.indexOf('rabbit:publish'));
    expect(timeline.indexOf('claim:commit')).toBeLessThan(timeline.indexOf('hook:after-claim'));
    expect(timeline.indexOf('hook:after-claim')).toBeLessThan(timeline.indexOf('rabbit:publish'));
    expect(timeline.indexOf('rabbit:confirmed')).toBeLessThan(
      timeline.findIndex((entry) => entry.startsWith('finalize:update audit.outbox_events')),
    );
    expect(timeline.indexOf('rabbit:confirmed')).toBeLessThan(
      timeline.indexOf('hook:after-confirm'),
    );
    expect(timeline.indexOf('hook:after-confirm')).toBeLessThan(
      timeline.findIndex((entry) => entry.startsWith('finalize:update audit.outbox_events')),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('backs off the same claim after publish failure without marking it published', async () => {
    const claimClient = transactionClient({
      name: 'claim',
      operation: () => ({ rows: [row], rowCount: 1 }),
    });
    const deferredSql: string[] = [];
    const deferClient = transactionClient({
      name: 'defer',
      operation: (text, values) => {
        deferredSql.push(text);
        expect(text).toContain('set publish_claim_expires_at');
        expect(text).not.toContain('set published_at');
        expect(values).toEqual([tenantId, claimToken, [row.id], 5_000]);
        return { rows: [], rowCount: 1 };
      },
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(deferClient),
    };
    const brokerError = new Error('broker unavailable');
    const channel = {
      publish: vi.fn().mockReturnValue(true),
      waitForConfirms: vi.fn().mockRejectedValue(brokerError),
    };
    const logger = { error: vi.fn() };

    await expect(publishLeasedOutboxBatch(runtimeOptions(pool, channel, logger))).rejects.toBe(
      brokerError,
    );

    expect(deferredSql).toHaveLength(1);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: brokerError, tenantId, count: 1 }),
      'leased outbox publish failed',
    );
  });

  it('fails closed when a confirmed claim can no longer be finalized', async () => {
    const claimClient = transactionClient({
      name: 'claim',
      operation: () => ({ rows: [row], rowCount: 1 }),
    });
    const finalizeClient = transactionClient({
      name: 'finalize',
      operation: () => ({ rows: [], rowCount: 0 }),
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };
    const channel = {
      publish: vi.fn().mockReturnValue(true),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };
    const logger = { error: vi.fn() };

    await expect(
      publishLeasedOutboxBatch(runtimeOptions(pool, channel, logger)),
    ).rejects.toMatchObject({ code: 'OUTBOX_CLAIM_LOST_AFTER_CONFIRM' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, claimedCount: 1, finalizedCount: 0 }),
      'leased outbox claim lost after RabbitMQ confirm',
    );
  });
});
