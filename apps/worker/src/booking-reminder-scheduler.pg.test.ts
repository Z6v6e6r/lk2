import { withTenantTransaction } from '@phub/database';
import {
  BOOKING_NOTIFICATION_AUDIENCE_SELECTOR,
  BOOKING_NOTIFICATION_LOCALE,
  BOOKING_NOTIFICATION_REQUEST_HASH,
  BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE,
  BOOKING_NOTIFICATION_RULESET_VERSION,
  BOOKING_NOTIFICATION_TEMPLATE_CHANNELS,
  BOOKING_NOTIFICATION_TEMPLATE_DEEP_LINK,
  BOOKING_NOTIFICATION_TEMPLATE_VERSION,
  type BookingNotificationSourceEvent,
} from '@phub/notifications';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertCanonicalBookingReminderReady } from '../../../scripts/booking-notification-contract.js';
import {
  reconcileBookingReminderSchedules,
  runBookingReminderSchedulerBatch,
} from './booking-reminder-scheduler.js';

const connectionString = process.env.BOOKING_REMINDER_PG_VERIFY_URL;
const describeDatabase = connectionString ? describe : describe.skip;

const tenantA = 'a1000000-0000-4000-8000-000000000001';
const tenantB = 'b1000000-0000-4000-8000-000000000001';
const userA = 'a2000000-0000-4000-8000-000000000001';
const userB = 'b2000000-0000-4000-8000-000000000001';
const takeoverToken = 'c1000000-0000-4000-8000-000000000002';
const loadClaimToken = 'c1000000-0000-4000-8000-000000000003';
const fingerprint = 'a'.repeat(64);

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('BOOKING_REMINDER_PG_VERIFY_URL_PROTOCOL_INVALID');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('BOOKING_REMINDER_PG_VERIFY_URL_OPTIONS_FORBIDDEN');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('BOOKING_REMINDER_PG_VERIFY_URL_NOT_LOOPBACK');
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database.endsWith('_verify')) {
    throw new Error('BOOKING_REMINDER_PG_VERIFY_DATABASE_NOT_DISPOSABLE');
  }
}

function bookingUuid(index: number, tenant: 'a' | 'b'): string {
  return `${tenant}3000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

function eventUuid(index: number, tenant: 'a' | 'b'): string {
  return `${tenant}4000000-0000-4000-8000-${index.toString().padStart(12, '0')}`;
}

describe('booking reminder PostgreSQL verifier guard', () => {
  it('accepts only query-free loopback URLs for a disposable database', () => {
    expect(() =>
      assertDisposableDatabaseUrl('postgresql://verify@127.0.0.1:55443/padlhub_verify'),
    ).not.toThrow();
  });

  it.each([
    ['BOOKING_REMINDER_PG_VERIFY_URL_PROTOCOL_INVALID', 'https://127.0.0.1/padlhub_verify'],
    [
      'BOOKING_REMINDER_PG_VERIFY_URL_OPTIONS_FORBIDDEN',
      'postgresql://verify@127.0.0.1/padlhub_verify?host=remote.example',
    ],
    [
      'BOOKING_REMINDER_PG_VERIFY_URL_OPTIONS_FORBIDDEN',
      'postgresql://verify@127.0.0.1/padlhub_verify#override',
    ],
    [
      'BOOKING_REMINDER_PG_VERIFY_URL_NOT_LOOPBACK',
      'postgresql://verify@database.example/padlhub_verify',
    ],
    ['BOOKING_REMINDER_PG_VERIFY_DATABASE_NOT_DISPOSABLE', 'postgresql://verify@127.0.0.1/padlhub'],
  ])('rejects %s', (code, value) => {
    expect(() => assertDisposableDatabaseUrl(value)).toThrow(code);
  });
});

describeDatabase.sequential('booking reminder scheduler PostgreSQL verification', () => {
  let pool: Pool;
  let baseNow: Date;

  beforeAll(async () => {
    assertDisposableDatabaseUrl(connectionString as string);
    pool = new Pool({ connectionString: connectionString as string, max: 8 });
    const clock = await pool.query<{ now_at: Date }>('select clock_timestamp() as now_at');
    baseNow = clock.rows[0]?.now_at as Date;

    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, 'booking-reminder-a-verify', 'Booking Reminder A Verify'),
              ($2, 'booking-reminder-b-verify', 'Booking Reminder B Verify')`,
      [tenantA, tenantB],
    );
    await pool.query(
      `insert into identity.users (id, tenant_id)
       values ($1, $2), ($3, $4)`,
      [userA, tenantA, userB, tenantB],
    );
    await pool.query(
      `insert into notifications.tenant_runtime_settings (
         tenant_id, in_app_enabled, booking_reminders_enabled,
         booking_reminder_ruleset_version, booking_reminder_contract_hash
       ) values ($1, true, true, $3, $4), ($2, true, true, $3, $4)`,
      [tenantA, tenantB, BOOKING_NOTIFICATION_RULESET_VERSION, BOOKING_NOTIFICATION_REQUEST_HASH],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('delete from audit.outbox_events where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await pool.query(
      'delete from notifications.booking_reminder_recipients where tenant_id = any($1::uuid[])',
      [[tenantA, tenantB]],
    );
    await pool.query(
      'delete from notifications.booking_reminder_schedules where tenant_id = any($1::uuid[])',
      [[tenantA, tenantB]],
    );
    await pool.query(
      'delete from notifications.booking_notification_projection_fences where tenant_id = any($1::uuid[])',
      [[tenantA, tenantB]],
    );
    await pool.query('delete from notifications.trigger_rules where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await pool.query(
      'delete from notifications.ruleset_provision_commands where tenant_id = any($1::uuid[])',
      [[tenantA, tenantB]],
    );
    await pool.query('delete from notifications.templates where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await pool.query(
      'delete from notifications.tenant_runtime_settings where tenant_id = any($1::uuid[])',
      [[tenantA, tenantB]],
    );
    await pool.query('delete from identity.users where tenant_id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await pool.query('delete from identity.tenants where id = any($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await pool.end();
  });

  async function seedSchedule(options: {
    tenantId: string;
    bookingId: string;
    eventId: string;
    userId?: string;
    startsAt: Date;
    lifecycleRevision?: string;
    lifecycleEventType?: 'booking.changed.v1' | 'booking.cancelled.v1';
    claimToken?: string;
    claimExpiresAt?: Date;
  }): Promise<void> {
    const revision = options.lifecycleRevision ?? '3';
    const lifecycleEventType = options.lifecycleEventType ?? 'booking.changed.v1';
    await pool.query(
      `insert into notifications.booking_notification_projection_fences (
         tenant_id, booking_id, lifecycle_revision, lifecycle_event_type, lifecycle_fingerprint
       ) values ($1, $2, $3::numeric, $4, $5)`,
      [options.tenantId, options.bookingId, revision, lifecycleEventType, fingerprint],
    );
    await pool.query(
      `insert into notifications.booking_reminder_schedules (
         tenant_id, booking_id, reminder_kind, lifecycle_revision, lifecycle_event_type,
         source_event_id, source_correlation_id, event_id, service_title, starts_at,
         timezone, location_name, due_at, claim_token, claim_expires_at
       ) values (
         $1, $2, 'HOURS_2', $3::numeric, $4, $5, 'booking-pg-verify-correlation', $6,
         'PG Verify', $7, 'Europe/Moscow', 'PadlHub Verify', $7::timestamptz - interval '2 hours',
         $8::uuid, $9::timestamptz
       )`,
      [
        options.tenantId,
        options.bookingId,
        revision,
        lifecycleEventType,
        options.eventId,
        options.eventId,
        options.startsAt,
        options.claimToken ?? null,
        options.claimExpiresAt ?? null,
      ],
    );
    if (options.userId) {
      await pool.query(
        `insert into notifications.booking_reminder_recipients (
           tenant_id, booking_id, reminder_kind, recipient_position, user_id
         ) values ($1, $2, 'HOURS_2', 1, $3)`,
        [options.tenantId, options.bookingId, options.userId],
      );
    }
  }

  const scheduler = (
    tenantId: string,
    batchSize: number,
    hooks?: { afterClaim(): Promise<void> },
  ) =>
    runBookingReminderSchedulerBatch({
      pool,
      tenantId,
      batchSize,
      claimTtlMs: 60_000,
      databaseTimeoutMs: 5_000,
      maxHours24LatenessMs: 7_200_000,
      maxHours2LatenessMs: 900_000,
      ...(hooks ? { verificationHooks: hooks } : {}),
    });

  it('proves bounded concurrent progress, takeover, cancellation fencing, tenant FK and indexes', async () => {
    const expiredStartsAt = new Date(baseNow.getTime() + 30 * 60_000);
    const eligibleStartsAt = new Date(baseNow.getTime() + 2 * 60 * 60_000);
    for (let index = 1; index <= 5; index += 1) {
      await seedSchedule({
        tenantId: tenantA,
        bookingId: bookingUuid(index, 'a'),
        eventId: eventUuid(index, 'a'),
        startsAt: expiredStartsAt,
      });
    }
    const tenantBProgressBooking = bookingUuid(1, 'b');
    await seedSchedule({
      tenantId: tenantB,
      bookingId: tenantBProgressBooking,
      eventId: eventUuid(1, 'b'),
      userId: userB,
      startsAt: eligibleStartsAt,
    });

    const locker = await pool.connect();
    let lockerOpen = false;
    try {
      await locker.query('begin');
      lockerOpen = true;
      await locker.query(`select set_config('app.tenant_id', $1, true)`, [tenantA]);
      await locker.query(
        `select 1
             from notifications.booking_reminder_schedules
            where tenant_id = $1 and booking_id = $2 and reminder_kind = 'HOURS_2'
            for update`,
        [tenantA, bookingUuid(1, 'a')],
      );
      const startedAt = Date.now();
      const [firstA, secondA, progressB] = await Promise.all([
        scheduler(tenantA, 2),
        scheduler(tenantA, 2),
        scheduler(tenantB, 1),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(firstA.missed + secondA.missed).toBe(4);
      expect(firstA.claimed + secondA.claimed).toBe(0);
      expect(progressB).toMatchObject({ claimed: 1, emitted: 1 });
      const whileLocked = await pool.query<{ state: string }>(
        `select state
             from notifications.booking_reminder_schedules
            where tenant_id = $1 and booking_id = $2 and reminder_kind = 'HOURS_2'`,
        [tenantA, bookingUuid(1, 'a')],
      );
      expect(whileLocked.rows[0]?.state).toBe('PENDING');
      await locker.query('commit');
      lockerOpen = false;
    } finally {
      if (lockerOpen) await locker.query('rollback').catch(() => undefined);
      locker.release();
    }
    await expect(scheduler(tenantA, 2)).resolves.toMatchObject({ missed: 1 });

    await expect(
      pool.query(
        `insert into notifications.booking_reminder_recipients (
             tenant_id, booking_id, reminder_kind, recipient_position, user_id
           ) values ($1, $2, 'HOURS_2', 1, $3)`,
        [tenantA, bookingUuid(1, 'a'), userB],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const takeoverBooking = bookingUuid(2, 'b');
    await seedSchedule({
      tenantId: tenantB,
      bookingId: takeoverBooking,
      eventId: eventUuid(2, 'b'),
      userId: userB,
      startsAt: eligibleStartsAt,
      claimToken: takeoverToken,
      claimExpiresAt: new Date(baseNow.getTime() - 60_000),
    });
    await expect(scheduler(tenantB, 1)).resolves.toMatchObject({ claimed: 1, emitted: 1 });

    const cancelledBooking = bookingUuid(3, 'b');
    const cancelledEventId = eventUuid(3, 'b');
    await seedSchedule({
      tenantId: tenantB,
      bookingId: cancelledBooking,
      eventId: cancelledEventId,
      userId: userB,
      startsAt: eligibleStartsAt,
    });
    const cancellationEvent = {
      id: eventUuid(30, 'b'),
      type: 'booking.cancelled.v1',
      aggregateId: cancelledBooking,
      tenantId: tenantB,
      occurredAt: baseNow.toISOString(),
      correlationId: 'booking-pg-cancel-correlation',
      payload: {
        bookingId: cancelledBooking,
        revision: '4',
        recipientUserIds: [userB],
        serviceTitle: 'PG Verify',
        startsAt: eligibleStartsAt.toISOString(),
        timezone: 'Europe/Moscow',
        locationName: 'PadlHub Verify',
        reasonCode: 'USER_REQUEST',
      },
    } satisfies BookingNotificationSourceEvent;
    const cancelled = await scheduler(tenantB, 1, {
      afterClaim: async () => {
        await withTenantTransaction(pool, tenantB, async (client) => {
          await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `${tenantB}:${cancelledBooking}`,
          ]);
          await client.query(
            `update notifications.booking_notification_projection_fences
                  set lifecycle_revision = 4,
                      lifecycle_event_type = 'booking.cancelled.v1',
                      updated_at = clock_timestamp()
                where tenant_id = $1 and booking_id = $2`,
            [tenantB, cancelledBooking],
          );
          await reconcileBookingReminderSchedules({ client, event: cancellationEvent });
        });
      },
    });
    expect(cancelled).toMatchObject({ claimed: 1, emitted: 0 });
    const cancelledState = await pool.query<{ state: string }>(
      `select state
           from notifications.booking_reminder_schedules
          where tenant_id = $1 and booking_id = $2 and reminder_kind = 'HOURS_2'`,
      [tenantB, cancelledBooking],
    );
    expect(cancelledState.rows[0]?.state).toBe('CANCELLED');
    const cancelledOutbox = await pool.query<{ count: string }>(
      'select count(*)::text as count from audit.outbox_events where id = $1',
      [cancelledEventId],
    );
    expect(cancelledOutbox.rows[0]?.count).toBe('0');

    await pool.query(
      `insert into notifications.booking_notification_projection_fences (
           tenant_id, booking_id, lifecycle_revision, lifecycle_event_type, lifecycle_fingerprint
         )
         select $1, md5('booking-reminder-load-' || item)::uuid, 3,
                'booking.changed.v1', $2
           from generate_series(1, 5000) item`,
      [tenantA, fingerprint],
    );
    await pool.query(
      `with db_clock as (select clock_timestamp() as now_at)
         insert into notifications.booking_reminder_schedules (
           tenant_id, booking_id, reminder_kind, lifecycle_revision, lifecycle_event_type,
           source_event_id, source_correlation_id, event_id, service_title, starts_at,
           timezone, location_name, due_at, claim_token, claim_expires_at
         )
         select $1,
                md5('booking-reminder-load-' || item)::uuid,
                'HOURS_2', 3, 'booking.changed.v1',
                md5('booking-reminder-load-source-' || item)::uuid,
                'booking-pg-load-correlation',
                md5('booking-reminder-load-event-' || item)::uuid,
                'PG Load',
                db_clock.now_at + case when item <= 100 then interval '2 hours' else interval '5 hours' end,
                'Europe/Moscow', 'PadlHub Verify',
                db_clock.now_at + case when item <= 100 then interval '0 hours' else interval '3 hours' end,
                case when item <= 50 then $2::uuid else null end,
                case when item <= 50 then db_clock.now_at + interval '1 minute' else null end
           from generate_series(1, 5000) item
           cross join db_clock`,
      [tenantA, loadClaimToken],
    );
    await pool.query('analyze notifications.booking_reminder_schedules');
    const claimPlan = await pool.query<{ 'QUERY PLAN': unknown }>(
      `explain (analyze, buffers, format json)
         select booking_id
           from notifications.booking_reminder_schedules
          where tenant_id = $1 and state = 'PENDING' and claim_token = $2::uuid
          order by booking_id`,
      [tenantA, loadClaimToken],
    );
    expect(JSON.stringify(claimPlan.rows)).toContain('booking_reminder_schedules_claim_idx');
    const duePlan = await pool.query<{ 'QUERY PLAN': unknown }>(
      `explain (analyze, buffers, format json)
         select booking_id
           from notifications.booking_reminder_schedules
          where tenant_id = $1 and state = 'PENDING' and due_at <= clock_timestamp()
          order by due_at, booking_id
          limit 20`,
      [tenantA],
    );
    expect(JSON.stringify(duePlan.rows)).toContain('booking_reminder_schedules_due_idx');
  }, 30_000);

  it('rejects non-canonical, channel-incompatible and unprovisioned reminder activation rows', async () => {
    await withTenantTransaction(pool, tenantA, async (client) => {
      const template = await client.query<{ id: string }>(
        `insert into notifications.templates (
           tenant_id, template_key, version, locale, category, channels,
           title_template, body_template, deep_link_template, active, created_by_user_id
         ) values ($1, 'booking.reminder', $2, $3, 'BOOKING', $4::text[],
                   'Напоминание о записи',
                   '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}',
                   $5, true, $6)
         returning id`,
        [
          tenantA,
          BOOKING_NOTIFICATION_TEMPLATE_VERSION,
          BOOKING_NOTIFICATION_LOCALE,
          [...BOOKING_NOTIFICATION_TEMPLATE_CHANNELS],
          BOOKING_NOTIFICATION_TEMPLATE_DEEP_LINK,
          userA,
        ],
      );
      const templateId = template.rows[0]?.id;
      expect(templateId).toBeDefined();
      await client.query(
        `insert into notifications.trigger_rules (
           tenant_id, rule_key, source_event_type, template_id, audience_selector,
           channel_override, mandatory, active, created_by_user_id
         ) values ($1, 'booking.reminder.default', 'booking.reminder.due.v1', $2,
                   $3::jsonb, $4::text[], false, true, $5)`,
        [
          tenantA,
          templateId,
          JSON.stringify(BOOKING_NOTIFICATION_AUDIENCE_SELECTOR),
          [...BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE],
          userA,
        ],
      );
      const idempotencyKey = 'booking-reminder-activation-verify';
      await client.query(
        `insert into notifications.ruleset_provision_commands (
           tenant_id, idempotency_key, ruleset_version, request_hash, actor_user_id, result
         ) values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
        [
          tenantA,
          idempotencyKey,
          BOOKING_NOTIFICATION_RULESET_VERSION,
          BOOKING_NOTIFICATION_REQUEST_HASH,
          userA,
        ],
      );

      await expect(
        assertCanonicalBookingReminderReady(
          client,
          tenantA,
          { inAppEnabled: true, webPushEnabled: false },
          true,
        ),
      ).resolves.toBeUndefined();

      await client.query(
        `update notifications.trigger_rules
            set channel_override = array['PUSH']::text[]
          where tenant_id = $1 and rule_key = 'booking.reminder.default'`,
        [tenantA],
      );
      await expect(
        assertCanonicalBookingReminderReady(
          client,
          tenantA,
          { inAppEnabled: true, webPushEnabled: false },
          true,
        ),
      ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_CHANNEL_NOT_READY');
      await client.query(
        `update notifications.trigger_rules
            set channel_override = $2::text[]
          where tenant_id = $1 and rule_key = 'booking.reminder.default'`,
        [tenantA, [...BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE]],
      );

      await client.query(
        `update notifications.templates
            set body_template = 'Устаревший текст'
          where tenant_id = $1 and id = $2`,
        [tenantA, templateId],
      );
      await expect(
        assertCanonicalBookingReminderReady(
          client,
          tenantA,
          { inAppEnabled: true, webPushEnabled: true },
          true,
        ),
      ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
      await client.query(
        `update notifications.templates
            set body_template = '{{serviceTitle}} начнётся {{startsAt}}, {{locationName}}'
          where tenant_id = $1 and id = $2`,
        [tenantA, templateId],
      );

      await client.query(
        `insert into notifications.trigger_rules (
           tenant_id, rule_key, source_event_type, template_id, audience_selector,
           channel_override, mandatory, active, created_by_user_id
         ) values ($1, 'booking.reminder.custom', 'booking.reminder.due.v1', $2,
                   $3::jsonb, $4::text[], false, true, $5)`,
        [
          tenantA,
          templateId,
          JSON.stringify(BOOKING_NOTIFICATION_AUDIENCE_SELECTOR),
          [...BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE],
          userA,
        ],
      );
      await expect(
        assertCanonicalBookingReminderReady(
          client,
          tenantA,
          { inAppEnabled: true, webPushEnabled: true },
          true,
        ),
      ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
      await client.query(
        `delete from notifications.trigger_rules
          where tenant_id = $1 and rule_key = 'booking.reminder.custom'`,
        [tenantA],
      );

      await client.query(
        `delete from notifications.ruleset_provision_commands
          where tenant_id = $1 and idempotency_key = $2`,
        [tenantA, idempotencyKey],
      );
      await expect(
        assertCanonicalBookingReminderReady(
          client,
          tenantA,
          { inAppEnabled: true, webPushEnabled: true },
          true,
        ),
      ).rejects.toThrow('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
      await client.query(
        `insert into notifications.ruleset_provision_commands (
           tenant_id, idempotency_key, ruleset_version, request_hash, actor_user_id, result
         ) values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
        [
          tenantA,
          idempotencyKey,
          BOOKING_NOTIFICATION_RULESET_VERSION,
          BOOKING_NOTIFICATION_REQUEST_HASH,
          userA,
        ],
      );
    });
  });

  it('binds scheduler mutations to the locked canonical v3 activation', async () => {
    const legacyHash = 'b'.repeat(64);
    const bindingBooking = bookingUuid(6001, 'a');
    const bindingEvent = eventUuid(6001, 'a');
    const eligibleStartsAt = new Date(baseNow.getTime() + 2 * 60 * 60_000);

    await pool.query('delete from audit.outbox_events where tenant_id = $1', [tenantA]);
    await pool.query('delete from notifications.booking_reminder_recipients where tenant_id = $1', [
      tenantA,
    ]);
    await pool.query('delete from notifications.booking_reminder_schedules where tenant_id = $1', [
      tenantA,
    ]);
    await pool.query(
      'delete from notifications.booking_notification_projection_fences where tenant_id = $1',
      [tenantA],
    );
    await pool.query(
      `insert into notifications.ruleset_provision_commands (
         tenant_id, idempotency_key, ruleset_version, request_hash, actor_user_id, result
       ) values ($1, 'booking-reminder-v2-legacy-verify', 'booking.ru-ru.v2', $2, $3, '{}'::jsonb)`,
      [tenantA, legacyHash, userA],
    );
    await pool.query(
      `update notifications.tenant_runtime_settings
          set booking_reminders_enabled = true,
              booking_reminder_ruleset_version = 'booking.ru-ru.v2',
              booking_reminder_contract_hash = $2
        where tenant_id = $1`,
      [tenantA, legacyHash],
    );
    await seedSchedule({
      tenantId: tenantA,
      bookingId: bindingBooking,
      eventId: bindingEvent,
      userId: userA,
      startsAt: eligibleStartsAt,
    });

    await expect(scheduler(tenantA, 1)).rejects.toThrow(
      'BOOKING_REMINDER_RUNTIME_CONTRACT_MISMATCH',
    );
    const untouched = await pool.query<{ state: string; claim_token: string | null }>(
      `select state, claim_token
         from notifications.booking_reminder_schedules
        where tenant_id = $1 and booking_id = $2 and reminder_kind = 'HOURS_2'`,
      [tenantA, bindingBooking],
    );
    expect(untouched.rows[0]).toEqual({ state: 'PENDING', claim_token: null });
    const beforeActivationOutbox = await pool.query<{ count: string }>(
      'select count(*)::text as count from audit.outbox_events where id = $1',
      [bindingEvent],
    );
    expect(beforeActivationOutbox.rows[0]?.count).toBe('0');

    const activateV3 = () =>
      withTenantTransaction(pool, tenantA, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `notification-runtime:${tenantA}`,
        ]);
        await assertCanonicalBookingReminderReady(
          client,
          tenantA,
          { inAppEnabled: true, webPushEnabled: false },
          true,
        );
        await client.query(
          `update notifications.tenant_runtime_settings
              set booking_reminders_enabled = true,
                  booking_reminder_ruleset_version = $2,
                  booking_reminder_contract_hash = $3
            where tenant_id = $1`,
          [tenantA, BOOKING_NOTIFICATION_RULESET_VERSION, BOOKING_NOTIFICATION_REQUEST_HASH],
        );
      });
    await activateV3();

    await expect(
      scheduler(tenantA, 1, {
        afterClaim: async () => {
          await pool.query(
            `update notifications.tenant_runtime_settings
                set booking_reminder_ruleset_version = 'booking.ru-ru.v2',
                    booking_reminder_contract_hash = $2
              where tenant_id = $1`,
            [tenantA, legacyHash],
          );
        },
      }),
    ).rejects.toThrow('BOOKING_REMINDER_RUNTIME_CONTRACT_MISMATCH');
    const released = await pool.query<{ state: string; claim_token: string | null }>(
      `select state, claim_token
         from notifications.booking_reminder_schedules
        where tenant_id = $1 and booking_id = $2 and reminder_kind = 'HOURS_2'`,
      [tenantA, bindingBooking],
    );
    expect(released.rows[0]).toEqual({ state: 'PENDING', claim_token: null });
    const afterBindingFlipOutbox = await pool.query<{ count: string }>(
      'select count(*)::text as count from audit.outbox_events where id = $1',
      [bindingEvent],
    );
    expect(afterBindingFlipOutbox.rows[0]?.count).toBe('0');

    await activateV3();
    await expect(scheduler(tenantA, 1)).resolves.toMatchObject({ claimed: 1, emitted: 1 });
    const emitted = await pool.query<{ state: string }>(
      `select state
         from notifications.booking_reminder_schedules
        where tenant_id = $1 and booking_id = $2 and reminder_kind = 'HOURS_2'`,
      [tenantA, bindingBooking],
    );
    expect(emitted.rows[0]?.state).toBe('EMITTED');

    await pool.query(
      `update notifications.tenant_runtime_settings
          set booking_reminders_enabled = false,
              booking_reminder_ruleset_version = null,
              booking_reminder_contract_hash = null
        where tenant_id = $1`,
      [tenantA],
    );
    await expect(
      pool.query(
        `update notifications.tenant_runtime_settings
            set booking_reminders_enabled = true
          where tenant_id = $1`,
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `update notifications.tenant_runtime_settings
            set booking_reminders_enabled = true,
                booking_reminder_ruleset_version = $2,
                booking_reminder_contract_hash = null
          where tenant_id = $1`,
        [tenantA, BOOKING_NOTIFICATION_RULESET_VERSION],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `update notifications.tenant_runtime_settings
            set booking_reminder_ruleset_version = $2,
                booking_reminder_contract_hash = $3
          where tenant_id = $1`,
        [tenantA, BOOKING_NOTIFICATION_RULESET_VERSION, BOOKING_NOTIFICATION_REQUEST_HASH],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
