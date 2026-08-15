import {
  BOOKING_NOTIFICATION_REQUEST_HASH,
  BOOKING_NOTIFICATION_RULESET_VERSION,
  type BookingNotificationSourceEvent,
} from '@phub/notifications';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  reconcileBookingReminderSchedules,
  runBookingReminderSchedulerBatch,
} from './booking-reminder-scheduler.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const bookingId = '92222222-2222-4222-8222-222222222222';
const userId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const claimToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reminderEventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const currentRuntimeRow = {
  booking_reminders_enabled: true,
  booking_reminder_ruleset_version: BOOKING_NOTIFICATION_RULESET_VERSION,
  booking_reminder_contract_hash: BOOKING_NOTIFICATION_REQUEST_HASH,
};
const disabledRuntimeRow = {
  booking_reminders_enabled: false,
  booking_reminder_ruleset_version: null,
  booking_reminder_contract_hash: null,
};
const legacyRuntimeRow = {
  booking_reminders_enabled: true,
  booking_reminder_ruleset_version: 'booking.ru-ru.v2',
  booking_reminder_contract_hash: 'a'.repeat(64),
};

const lifecycleEvent = (
  type:
    'booking.confirmed.v1' | 'booking.changed.v1' | 'booking.cancelled.v1' = 'booking.changed.v1',
): BookingNotificationSourceEvent =>
  ({
    id: '91111111-1111-4111-8111-111111111111',
    type,
    aggregateId: bookingId,
    tenantId,
    occurredAt: '2026-08-14T12:00:00.000Z',
    correlationId: 'booking-reminder-scheduler-test',
    payload: {
      bookingId,
      revision: '3',
      recipientUserIds: [userId],
      serviceTitle: 'Падел',
      startsAt: '2026-08-15T19:00:00+03:00',
      timezone: 'Europe/Moscow',
      locationName: 'ПаделхАБ',
      ...(type === 'booking.changed.v1' ? { changedFields: ['STARTS_AT'] as const } : {}),
      ...(type === 'booking.cancelled.v1' ? { reasonCode: 'USER_REQUEST' as const } : {}),
    },
  }) as BookingNotificationSourceEvent;

describe('booking reminder schedule reconciliation', () => {
  it('atomically replaces both reminder kinds from an accepted lifecycle snapshot', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    await reconcileBookingReminderSchedules({
      client: { query } as never,
      event: lifecycleEvent('booking.changed.v1') as never,
      eventIdFactory: () => ids.shift() as string,
    });

    expect(query).toHaveBeenCalledTimes(3);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("'HOURS_24'");
    expect(sql).toContain("'HOURS_2'");
    expect(sql).toContain('on conflict (tenant_id, booking_id, reminder_kind) do update');
    expect(sql).toContain("state = 'PENDING'");
    expect(sql).toContain('claim_token = null');
    expect(values).toContain('11111111-1111-4111-8111-111111111111');
    expect(values).toContain('22222222-2222-4222-8222-222222222222');
    expect(values).toContain('2026-08-15T19:00:00+03:00');
    const [deleteSql] = query.mock.calls[1] as unknown as [string];
    expect(deleteSql).toContain('delete from notifications.booking_reminder_recipients');
    const [recipientSql, recipientValues] = query.mock.calls[2] as unknown as [string, unknown[]];
    expect(recipientSql).toContain('with ordinality');
    expect(recipientSql).toContain("values ('HOURS_24'::text), ('HOURS_2'::text)");
    expect(recipientValues[2]).toEqual([userId]);
  });

  it('cancels only pending schedules and clears their leases', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
    await reconcileBookingReminderSchedules({
      client: { query } as never,
      event: lifecycleEvent('booking.cancelled.v1') as never,
    });

    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).toContain("case when state = 'PENDING' then 'CANCELLED' else state end");
    expect(sql).toContain('claim_token = null');
    expect(sql).not.toContain('insert into');
  });
});

function transactionClient(
  operation: (
    text: string,
    values: readonly unknown[],
  ) =>
    | { rows: unknown[]; rowCount: number }
    | Promise<{
        rows: unknown[];
        rowCount: number;
      }>,
) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'") ||
      text.includes("set_config('lock_timeout'")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return operation(text, values);
  });
  return { query, release: vi.fn() };
}

function claimedSchedule(overrides: Record<string, unknown> = {}) {
  return {
    booking_id: bookingId,
    reminder_kind: 'HOURS_2',
    lifecycle_revision: '3',
    lifecycle_event_type: 'booking.changed.v1',
    source_correlation_id: 'booking-reminder-scheduler-test',
    event_id: reminderEventId,
    recipient_user_ids: [userId],
    service_title: 'Падел',
    starts_at: new Date('2026-08-15T16:00:00.000Z'),
    timezone: 'Europe/Moscow',
    location_name: 'ПаделхАБ',
    eligible: true,
    expired: false,
    fence_revision: '3',
    fence_event_type: 'booking.changed.v1',
    ...overrides,
  };
}

describe('booking reminder scheduler', () => {
  it('runs in a separate tenant-fair cycle with independent readiness and metrics', () => {
    const workerMain = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

    expect(workerMain).toContain('const runBookingReminderCycle = async');
    expect(workerMain).toContain('startOffset: bookingReminderTenantCycleStartOffset');
    expect(workerMain).toContain('runBookingReminderSchedulerBatch({');
    expect(workerMain).toContain('bookingReminderForwardProgress: bookingReminderProgress?.ready');
    expect(workerMain).toContain('recordBookingReminderSchedulerCycle(');
    expect(workerMain.indexOf('const runBookingReminderCycle')).toBeGreaterThan(
      workerMain.indexOf('const runCycle'),
    );
  });

  it('uses a leased half-open claim and atomically emits one canonical outbox event', async () => {
    const claimClient = transactionClient((text) => {
      if (text.includes("set state = 'MISSED'")) return { rows: [], rowCount: 0 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('with db_clock') && text.includes('for update of schedule skip locked')) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_2' }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query: ${text}`);
    });
    const finalizeClient = transactionClient((text) => {
      if (text.includes('select distinct booking_id')) {
        return { rows: [{ booking_id: bookingId }], rowCount: 1 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('left join notifications.booking_notification_projection_fences')) {
        return { rows: [claimedSchedule()], rowCount: 1 };
      }
      if (text.includes('insert into audit.outbox_events')) return { rows: [], rowCount: 1 };
      if (text.includes("set state = 'EMITTED'")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected finalize query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 20,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).resolves.toEqual({
      claimed: 1,
      emitted: 1,
      missed: 0,
      cancelled: 0,
      superseded: 0,
      released: 0,
    });

    const claimSql = claimClient.query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes('set claim_token = $5::uuid')) as string;
    expect(claimSql).toContain('schedule.due_at <= db_clock.now_at');
    expect(claimSql).toContain('db_clock.now_at < least(');
    expect(claimSql).toContain('schedule.claim_expires_at <= db_clock.now_at');
    expect(
      claimClient.query.mock.calls.some(
        ([text, values]) =>
          String(text).includes("set_config('lock_timeout'") &&
          JSON.stringify(values) === JSON.stringify(['2000ms', '5000ms']),
      ),
    ).toBe(true);
    const outboxCall = finalizeClient.query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    ) as unknown as [string, unknown[]];
    expect(outboxCall[1][0]).toBe(reminderEventId);
    expect(outboxCall[1][3]).toBe('booking-reminder-scheduler-test');
    expect(JSON.parse(String(outboxCall[1][4]))).toEqual({
      bookingId,
      revision: '3',
      recipientUserIds: [userId],
      serviceTitle: 'Падел',
      startsAt: '2026-08-15T16:00:00.000Z',
      timezone: 'Europe/Moscow',
      locationName: 'ПаделхАБ',
      reminderKind: 'HOURS_2',
    });
  });

  it('marks rows at the expiry boundary missed without claiming or emitting', async () => {
    const client = transactionClient((text) => {
      if (text.includes("set state = 'MISSED'")) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_24' }], rowCount: 1 };
      }
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('for update of schedule skip locked')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 20,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).resolves.toEqual({
      ...{
        claimed: 0,
        emitted: 0,
        missed: 1,
        cancelled: 0,
        superseded: 0,
        released: 0,
      },
    });
    const expirySql = client.query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("set state = 'MISSED'")) as string;
    expect(expirySql).toContain('db_clock.now_at >= least(');
    expect(expirySql).toContain('for update of schedule skip locked');
    expect(expirySql).toContain('limit $4');
    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it('leaves pending schedules untouched while the tenant gate is disabled', async () => {
    const client = transactionClient((text) => {
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [disabledRuntimeRow], rowCount: 1 };
      }
      throw new Error(`Unexpected mutation while gate is disabled: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 1,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).resolves.toEqual({
      claimed: 0,
      emitted: 0,
      missed: 0,
      cancelled: 0,
      superseded: 0,
      released: 0,
    });
    expect(
      client.query.mock.calls.some(([text]) =>
        String(text).includes('notifications.booking_reminder_schedules'),
      ),
    ).toBe(false);
  });

  it('rejects a legacy enabled binding before expired sweep or claim mutation', async () => {
    const client = transactionClient((text) => {
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [legacyRuntimeRow], rowCount: 1 };
      }
      throw new Error(`Unexpected mutation with a legacy binding: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 1,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).rejects.toThrow('BOOKING_REMINDER_RUNTIME_CONTRACT_MISMATCH');
    expect(
      client.query.mock.calls.some(([text]) =>
        String(text).includes('notifications.booking_reminder_schedules'),
      ),
    ).toBe(false);
  });

  it('shares one batch budget between expired terminalization and due claims', async () => {
    const client = transactionClient((text) => {
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes("set state = 'MISSED'")) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_24' }], rowCount: 1 };
      }
      throw new Error(`Batch budget permitted an extra query: ${text}`);
    });
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 1,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).resolves.toMatchObject({ claimed: 0, missed: 1 });
    expect(
      client.query.mock.calls.some(([text]) => String(text).includes('set claim_token = $5::uuid')),
    ).toBe(false);
  });

  it('releases a claim when the tenant gate turns off before finalization', async () => {
    const claimClient = transactionClient((text) => {
      if (text.includes("set state = 'MISSED'")) return { rows: [], rowCount: 0 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('for update of schedule skip locked')) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_2' }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query: ${text}`);
    });
    const finalizeClient = transactionClient((text) => {
      if (text.includes('select distinct booking_id')) {
        return { rows: [{ booking_id: bookingId }], rowCount: 1 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [disabledRuntimeRow], rowCount: 1 };
      }
      if (text.includes('set claim_token = null')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected finalize query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 1,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).resolves.toMatchObject({ claimed: 1, emitted: 0, released: 1 });
    expect(
      finalizeClient.query.mock.calls.some(([text]) =>
        String(text).includes('insert into audit.outbox_events'),
      ),
    ).toBe(false);
  });

  it('commits claim release and reports degradation when the binding changes before finalize', async () => {
    const claimClient = transactionClient((text) => {
      if (text.includes("set state = 'MISSED'")) return { rows: [], rowCount: 0 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('for update of schedule skip locked')) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_2' }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query: ${text}`);
    });
    const finalizeClient = transactionClient((text) => {
      if (text.includes('select distinct booking_id')) {
        return { rows: [{ booking_id: bookingId }], rowCount: 1 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [legacyRuntimeRow], rowCount: 1 };
      }
      if (text.includes('set claim_token = null')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected finalize query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 1,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).rejects.toThrow('BOOKING_REMINDER_RUNTIME_CONTRACT_MISMATCH');
    expect(finalizeClient.query).toHaveBeenCalledWith('commit');
    expect(
      finalizeClient.query.mock.calls.some(([text]) =>
        String(text).includes('insert into audit.outbox_events'),
      ),
    ).toBe(false);
  });

  it.each([
    ['CANCELLED', { fence_event_type: 'booking.cancelled.v1' }, 'CANCELLED'],
    ['SUPERSEDED', { fence_revision: '4' }, 'SUPERSEDED'],
  ] as const)('terminally suppresses a %s claimed schedule', async (_label, overrides, state) => {
    const claimClient = transactionClient((text) => {
      if (text.includes("set state = 'MISSED'")) return { rows: [], rowCount: 0 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('for update of schedule skip locked')) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_2' }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query: ${text}`);
    });
    const finalizeClient = transactionClient((text, values) => {
      if (text.includes('select distinct booking_id')) {
        return { rows: [{ booking_id: bookingId }], rowCount: 1 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('left join notifications.booking_notification_projection_fences')) {
        return { rows: [claimedSchedule(overrides)], rowCount: 1 };
      }
      if (text.includes('set state = $5')) {
        expect(values[4]).toBe(state);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected finalize query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };
    const result = await runBookingReminderSchedulerBatch({
      pool: pool as never,
      tenantId,
      batchSize: 1,
      claimTtlMs: 60_000,
      databaseTimeoutMs: 5_000,
      maxHours24LatenessMs: 7_200_000,
      maxHours2LatenessMs: 900_000,
      claimTokenFactory: () => claimToken,
    });
    expect(result).toMatchObject({
      emitted: 0,
      cancelled: state === 'CANCELLED' ? 1 : 0,
      superseded: state === 'SUPERSEDED' ? 1 : 0,
    });
    expect(
      finalizeClient.query.mock.calls.some(([text]) =>
        String(text).includes('insert into audit.outbox_events'),
      ),
    ).toBe(false);
  });

  it('rolls back both outbox and schedule state when finalization fails', async () => {
    const claimClient = transactionClient((text) => {
      if (text.includes("set state = 'MISSED'")) return { rows: [], rowCount: 0 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('for update of schedule skip locked')) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_2' }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query: ${text}`);
    });
    const finalizeClient = transactionClient((text) => {
      if (text.includes('select distinct booking_id')) {
        return { rows: [{ booking_id: bookingId }], rowCount: 1 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes('left join notifications.booking_notification_projection_fences')) {
        return { rows: [claimedSchedule()], rowCount: 1 };
      }
      if (text.includes('insert into audit.outbox_events')) return { rows: [], rowCount: 1 };
      if (text.includes("set state = 'EMITTED'")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected finalize query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 1,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).rejects.toThrow('BOOKING_REMINDER_EMITTED_CLAIM_LOST');
    expect(finalizeClient.query).toHaveBeenCalledWith('rollback');
    expect(
      finalizeClient.query.mock.calls.some(([text]) =>
        String(text).includes('insert into audit.outbox_events'),
      ),
    ).toBe(true);
  });

  it('commits a bounded missed transition before a separate claimed finalization fails', async () => {
    const claimClient = transactionClient((text) => {
      if (text.includes('select booking_reminders_enabled')) {
        return { rows: [currentRuntimeRow], rowCount: 1 };
      }
      if (text.includes("set state = 'MISSED'")) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_24' }], rowCount: 1 };
      }
      if (text.includes('set claim_token = $5::uuid')) {
        return { rows: [{ booking_id: bookingId, reminder_kind: 'HOURS_2' }], rowCount: 1 };
      }
      throw new Error(`Unexpected claim query: ${text}`);
    });
    const finalizeClient = transactionClient((text) => {
      if (text.includes('select distinct booking_id')) {
        throw new Error('synthetic finalize failure');
      }
      throw new Error(`Unexpected finalize query: ${text}`);
    });
    const pool = {
      connect: vi.fn().mockResolvedValueOnce(claimClient).mockResolvedValueOnce(finalizeClient),
    };

    await expect(
      runBookingReminderSchedulerBatch({
        pool: pool as never,
        tenantId,
        batchSize: 2,
        claimTtlMs: 60_000,
        databaseTimeoutMs: 5_000,
        maxHours24LatenessMs: 7_200_000,
        maxHours2LatenessMs: 900_000,
        claimTokenFactory: () => claimToken,
      }),
    ).rejects.toThrow('synthetic finalize failure');
    expect(claimClient.query).toHaveBeenCalledWith('commit');
    expect(finalizeClient.query).toHaveBeenCalledWith('rollback');
  });
});
