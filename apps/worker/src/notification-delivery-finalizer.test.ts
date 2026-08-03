import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { finalizeNotificationDelivery } from './notification-delivery-finalizer.js';

const job = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  deliveryId: '22222222-2222-4222-8222-222222222222',
  intentId: '33333333-3333-4333-8333-333333333333',
  providerAccountId: '44444444-4444-4444-8444-444444444444',
  endpointId: '55555555-5555-4555-8555-555555555555',
  attemptNo: 2,
  startedAt: '2026-08-03T12:00:00.000Z',
};

function result(rows: readonly unknown[] = [], rowCount = rows.length): QueryResult<never> {
  return {
    command: '',
    rowCount,
    oid: 0,
    fields: [],
    rows: [...rows] as never[],
  };
}

function fakePool(
  updateRowCount: number,
  providerLink: 'inserted' | 'exact-replay' | 'conflict' = 'inserted',
) {
  const queries: { readonly text: string; readonly values?: readonly unknown[] }[] = [];
  const query = vi.fn((text: string, values?: readonly unknown[]) => {
    queries.push({ text, ...(values ? { values } : {}) });
    if (text.includes("set state = 'DEAD'") && text.includes('last_error_code')) {
      return Promise.resolve(result([], 1));
    }
    if (text.includes('update notifications.deliveries')) {
      return Promise.resolve(result([], updateRowCount));
    }
    if (text.includes('insert into integration.notification_provider_links')) {
      return Promise.resolve(
        result(
          providerLink === 'inserted' ? [{ delivery_id: job.deliveryId }] : [],
          providerLink === 'inserted' ? 1 : 0,
        ),
      );
    }
    if (text.includes('from integration.notification_provider_links')) {
      return Promise.resolve(
        result(providerLink === 'exact-replay' ? [{ delivery_id: job.deliveryId }] : []),
      );
    }
    if (text.includes('select state') && text.includes('notifications.deliveries')) {
      return Promise.resolve(result([{ state: 'SENT' }]));
    }
    return Promise.resolve(result());
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as Pool;
  return { pool, queries, release };
}

describe('notification delivery finalizer', () => {
  it('treats an expired/lost lease as stale and appends no attempt, receipt or outbox', async () => {
    const { pool, queries } = fakePool(0);

    await expect(
      finalizeNotificationDelivery({
        pool,
        job,
        result: { outcome: 'accepted', externalMessageId: 'provider-message-stale' },
        platform: 'WEB',
        transport: 'WEB_PUSH',
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe('stale');

    const sql = queries.map((entry) => entry.text).join('\n');
    expect(sql).toContain('lease_expires_at > now()');
    expect(sql).not.toContain('delivery_attempts');
    expect(sql).not.toContain('delivery_receipts');
    expect(sql).not.toContain('notification_provider_links');
    expect(sql).not.toContain('outbox_events');
  });

  it('persists an opaque provider ID only in integration storage and writes safe evidence', async () => {
    const externalMessageId = 'opaque-provider-message-42';
    const { pool, queries } = fakePool(1);

    await expect(
      finalizeNotificationDelivery({
        pool,
        job,
        result: { outcome: 'accepted', externalMessageId },
        platform: 'WEB',
        transport: 'WEB_PUSH',
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe('sent');

    const providerLink = queries.find((entry) =>
      entry.text.includes('integration.notification_provider_links'),
    );
    expect(providerLink?.values).toContain(externalMessageId);
    for (const entry of queries.filter(
      (candidate) => !candidate.text.includes('integration.notification_provider_links'),
    )) {
      expect(JSON.stringify(entry.values ?? [])).not.toContain(externalMessageId);
      expect(entry.text).not.toContain(externalMessageId);
    }
    expect(queries.some((entry) => entry.text.includes('notifications.delivery_receipts'))).toBe(
      true,
    );
    expect(queries.some((entry) => entry.text.includes('notifications.delivery_attempts'))).toBe(
      true,
    );
    const outbox = queries.find((entry) => entry.text.includes('audit.outbox_events'));
    expect(outbox?.values).toContain(JSON.stringify({ deliveryId: job.deliveryId, state: 'SENT' }));
  });

  it('records a safe terminal outcome when an existing provider link conflicts', async () => {
    const externalMessageId = 'different-provider-message';
    const { pool, queries } = fakePool(1, 'conflict');

    await expect(
      finalizeNotificationDelivery({
        pool,
        job,
        result: { outcome: 'accepted', externalMessageId },
        platform: 'WEB',
        transport: 'WEB_PUSH',
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe('dead');

    expect(queries.some((entry) => entry.text === 'rollback')).toBe(false);
    expect(queries.some((entry) => entry.text.includes('delivery_receipts'))).toBe(false);
    expect(queries.some((entry) => entry.text.includes('delivery_attempts'))).toBe(true);
    const outbox = queries.find((entry) => entry.text.includes('outbox_events'));
    expect(outbox?.values).toContain(
      JSON.stringify({
        deliveryId: job.deliveryId,
        state: 'DEAD',
        errorCode: 'NOTIFICATION_PROVIDER_MESSAGE_LINK_CONFLICT',
      }),
    );
    for (const entry of queries.filter(
      (candidate) => !candidate.text.includes('integration.notification_provider_links'),
    )) {
      expect(JSON.stringify(entry.values ?? [])).not.toContain(externalMessageId);
      expect(entry.text).not.toContain(externalMessageId);
    }
  });

  it('accepts an exact provider-link replay', async () => {
    const { pool } = fakePool(1, 'exact-replay');

    await expect(
      finalizeNotificationDelivery({
        pool,
        job,
        result: { outcome: 'accepted', externalMessageId: 'same-provider-message' },
        platform: 'WEB',
        transport: 'WEB_PUSH',
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe('sent');
  });
});
