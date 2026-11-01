import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  deferNotificationDeliveryWithoutAttempt,
  finalizeNotificationDelivery,
} from './notification-delivery-finalizer.js';

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
    if (text.includes('update integration.notification_endpoints')) {
      return Promise.resolve(result([], 1));
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
  it.each(['APNS', 'YANDEX_SMTP'] as const)(
    'never retries %s after an ambiguous dispatch',
    async (transport) => {
      const { pool, queries } = fakePool(1);
      const code = transport === 'APNS' ? 'APNS_OUTCOME_UNKNOWN' : 'SMTP_OUTCOME_UNKNOWN';
      expect(
        await finalizeNotificationDelivery({
          pool,
          job: { ...job, scenarioDelivery: true },
          transport,
          platform: transport === 'APNS' ? 'IOS' : null,
          result: { outcome: 'terminal_failure', errorCode: code, invalidate: false },
          maxAttempts: 5,
          retryBaseMs: 1000,
        }),
      ).toBe('dead');
      const update = queries.find((q) => q.text.includes("set state = 'DEAD'"));
      expect(update?.text).not.toContain('scenario_dispatch_started_at = null');
      expect(update?.values).toContain(code);
      expect(queries.some((q) => q.text.includes('delivery_receipts'))).toBe(false);
    },
  );
  it('makes a proven SMTP rejection reclaimable while preserving v2 parking', async () => {
    const { pool, queries } = fakePool(1);
    expect(
      await finalizeNotificationDelivery({
        pool,
        job: { ...job, scenarioDelivery: true },
        transport: 'YANDEX_SMTP',
        platform: null,
        result: { outcome: 'retryable_failure', errorCode: 'SMTP_PROVIDER_RETRYABLE' },
        maxAttempts: 5,
        retryBaseMs: 1000,
      }),
    ).toBe('retry');
    const update = queries.find((q) => q.text.includes("set state = 'PENDING'"));
    expect(update?.text).toContain('scenario_dispatch_started_at = null');
    expect(update?.text).toContain('scenario_v2_available_at = case');
    expect(update?.text).toContain("next_attempt_at='infinity'");
  });

  it('defers an expired but unreclaimed circuit-suppressed claim without attempt evidence', async () => {
    const { pool, queries } = fakePool(1);

    await expect(
      deferNotificationDeliveryWithoutAttempt({
        pool,
        job,
        retryAfterMs: 30_000,
        errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
      }),
    ).resolves.toBe('retry');

    const update = queries.find((entry) => entry.text.includes("set state = 'PENDING'"));
    expect(update?.text).toContain('attempt_count = $3 - 1');
    expect(update?.text).toContain("state = 'SENDING' and attempt_count = $3");
    expect(update?.text).not.toContain('lease_expires_at > now()');
    expect(update?.values).toEqual([
      job.tenantId,
      job.deliveryId,
      job.attemptNo,
      30_000,
      'WEB_PUSH_CIRCUIT_OPEN',
    ]);
    const sql = queries.map((entry) => entry.text).join('\n');
    expect(sql).not.toContain('delivery_attempts');
    expect(sql).not.toContain('outbox_events');
    expect(sql).not.toContain('select state');
  });

  it('keeps a deferred scenario invisible to old workers after an open circuit', async () => {
    const { pool, queries } = fakePool(1);
    expect(
      await deferNotificationDeliveryWithoutAttempt({
        pool,
        job: { ...job, scenarioDelivery: true },
        retryAfterMs: 30_000,
        errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
      }),
    ).toBe('retry');
    const sql = queries.find((entry) => entry.text.includes("set state = 'PENDING'"))?.text;
    expect(sql).toContain("next_attempt_at='infinity'::timestamptz");
    expect(sql).toContain('attempt_count = $3 - 1');
  });
  it('keeps a retryable scenario invisible to old workers after a provider error', async () => {
    const { pool, queries } = fakePool(1);
    expect(
      await finalizeNotificationDelivery({
        pool,
        job: { ...job, scenarioDelivery: true },
        transport: 'WEB_PUSH',
        platform: 'WEB',
        result: { outcome: 'retryable_failure', errorCode: 'WEB_PUSH_TIMEOUT' },
        maxAttempts: 5,
        retryBaseMs: 1000,
      }),
    ).toBe('retry');
    expect(queries.find((entry) => entry.text.includes("set state = 'PENDING'"))?.text).toContain(
      "next_attempt_at='infinity'::timestamptz",
    );
  });
  it('does not decrement a circuit-suppressed attempt after a newer claim fenced it out', async () => {
    const { pool, queries } = fakePool(0);

    await expect(
      deferNotificationDeliveryWithoutAttempt({
        pool,
        job,
        retryAfterMs: 30_000,
        errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
      }),
    ).resolves.toBe('stale');

    const update = queries.find((entry) => entry.text.includes("set state = 'PENDING'"));
    expect(update?.text).toContain("state = 'SENDING' and attempt_count = $3");
    expect(update?.values).toContain(job.attemptNo);
    const sql = queries.map((entry) => entry.text).join('\n');
    expect(sql).not.toContain('delivery_attempts');
    expect(sql).not.toContain('outbox_events');
  });

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

  it('suspends a policy-denied Web Push endpoint without marking it provider-invalid', async () => {
    const { pool, queries } = fakePool(1);

    await expect(
      finalizeNotificationDelivery({
        pool,
        job,
        result: {
          outcome: 'terminal_failure',
          errorCode: 'WEB_PUSH_EGRESS_BLOCKED',
          invalidate: false,
          suspendPolicy: true,
        },
        platform: 'WEB',
        transport: 'WEB_PUSH',
        maxAttempts: 5,
        retryBaseMs: 5_000,
      }),
    ).resolves.toBe('dead');

    const endpointUpdate = queries.find((entry) =>
      entry.text.includes('update integration.notification_endpoints'),
    );
    expect(endpointUpdate?.text).toContain("status = 'ACTIVE'");
    expect(endpointUpdate?.values).toContain('SUSPENDED_POLICY');
    expect(endpointUpdate?.values).not.toContain('INVALID');
    const audit = queries.find((entry) => entry.text.includes('insert into audit.audit_log'));
    expect(audit?.values).toContain('WEB_PUSH_ENDPOINT_POLICY_SUSPENDED');
    expect(audit?.values).toContain(JSON.stringify({ status: 'SUSPENDED_POLICY' }));
  });
});

describe('ordinary-only advisory deferral', () => {
  it('restores only the exact still-live ordinary claim and retains immutable identity predicates', async () => {
    const { pool, queries } = fakePool(1);
    expect(
      await deferNotificationDeliveryWithoutAttempt({
        pool,
        job,
        ordinaryOnly: true,
        retryAfterMs: 30000,
        errorCode: 'FCM_ROLLOUT_GATE_BUSY',
      }),
    ).toBe('retry');
    const update = queries.find((x) => x.text.includes('update notifications.deliveries'))!;
    expect(update.values).toEqual([
      job.tenantId,
      job.deliveryId,
      job.attemptNo,
      30000,
      'FCM_ROLLOUT_GATE_BUSY',
      job.intentId,
      job.endpointId,
    ]);
    for (const predicate of [
      'intent_id=$6',
      'endpoint_id=$7',
      'lease_expires_at>clock_timestamp()',
      'scenario_available_at is null',
      'scenario_v2_available_at is null',
      'scenario_dispatch_started_at is null',
      "not (i.render_data ? 'scenarioRunId')",
    ])
      expect(update.text).toContain(predicate);
    expect(
      queries.some((x) => /delivery_attempts|delivery_receipts|outbox_events/u.test(x.text)),
    ).toBe(false);
  });
  it('a nonmatching current generation/lease/marker is stale, never forced back to pending', async () => {
    const { pool, queries } = fakePool(0);
    expect(
      await deferNotificationDeliveryWithoutAttempt({
        pool,
        job,
        ordinaryOnly: true,
        retryAfterMs: 30000,
        errorCode: 'FCM_ROLLOUT_GATE_BUSY',
      }),
    ).toBe('stale');
    expect(queries.filter((x) => x.text.startsWith('update'))).toHaveLength(1);
  });
  it('refuses an explicitly retained scenario job before any scheduling mutation', async () => {
    const { pool, queries } = fakePool(1);
    expect(
      await deferNotificationDeliveryWithoutAttempt({
        pool,
        job: { ...job, scenarioDelivery: true },
        ordinaryOnly: true,
        retryAfterMs: 30000,
        errorCode: 'FCM_ROLLOUT_GATE_BUSY',
      }),
    ).toBe('stale');
    expect(queries).toHaveLength(0);
  });
  it('omitted option preserves prior circuit and scenario deferral SQL', async () => {
    const { pool, queries } = fakePool(1);
    await deferNotificationDeliveryWithoutAttempt({
      pool,
      job: { ...job, scenarioDelivery: true },
      retryAfterMs: 30000,
      errorCode: 'FCM_CIRCUIT_OPEN',
    });
    const update = queries.find((x) => x.text.startsWith('update'))!;
    expect(update.text).toContain("next_attempt_at='infinity'::timestamptz");
    expect(update.text).not.toContain('intent_id=$6');
    expect(update.values).toHaveLength(5);
  });
});
