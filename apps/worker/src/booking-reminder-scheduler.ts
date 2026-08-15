import { randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@phub/database';
import {
  BOOKING_NOTIFICATION_REQUEST_HASH,
  BOOKING_NOTIFICATION_RULESET_VERSION,
  type BookingNotificationSourceEvent,
} from '@phub/notifications';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

type LifecycleBookingEvent = BookingNotificationSourceEvent & {
  readonly type: 'booking.confirmed.v1' | 'booking.changed.v1' | 'booking.cancelled.v1';
};

interface RuntimeRow extends QueryResultRow {
  readonly booking_reminders_enabled: boolean;
  readonly booking_reminder_ruleset_version: string | null;
  readonly booking_reminder_contract_hash: string | null;
}

interface BookingIdRow extends QueryResultRow {
  readonly booking_id: string;
}

interface ClaimedRow extends QueryResultRow {
  readonly booking_id: string;
  readonly reminder_kind: 'HOURS_24' | 'HOURS_2';
}

interface FinalizationRow extends QueryResultRow {
  readonly booking_id: string;
  readonly reminder_kind: 'HOURS_24' | 'HOURS_2';
  readonly lifecycle_revision: string;
  readonly lifecycle_event_type: LifecycleBookingEvent['type'];
  readonly source_correlation_id: string;
  readonly event_id: string;
  readonly recipient_user_ids: string[];
  readonly service_title: string;
  readonly starts_at: Date;
  readonly timezone: string;
  readonly location_name: string;
  readonly eligible: boolean;
  readonly expired: boolean;
  readonly fence_revision: string | null;
  readonly fence_event_type: LifecycleBookingEvent['type'] | null;
}

export interface BookingReminderSchedulerResult {
  readonly claimed: number;
  readonly emitted: number;
  readonly missed: number;
  readonly cancelled: number;
  readonly superseded: number;
  readonly released: number;
}

export interface BookingReminderSchedulerVerificationHooks {
  readonly afterClaim?: (claimedCount: number) => void | Promise<void>;
}

const EMPTY_RESULT: BookingReminderSchedulerResult = {
  claimed: 0,
  emitted: 0,
  missed: 0,
  cancelled: 0,
  superseded: 0,
  released: 0,
};

const CONTRACT_MISMATCH_ERROR = 'BOOKING_REMINDER_RUNTIME_CONTRACT_MISMATCH';

function runtimeBindingState(row: RuntimeRow | undefined): 'DISABLED' | 'CURRENT' | 'MISMATCH' {
  if (row?.booking_reminders_enabled !== true) return 'DISABLED';
  return row.booking_reminder_ruleset_version === BOOKING_NOTIFICATION_RULESET_VERSION &&
    row.booking_reminder_contract_hash === BOOKING_NOTIFICATION_REQUEST_HASH
    ? 'CURRENT'
    : 'MISMATCH';
}

const expirySql = (scheduleAlias: string): string => `least(
  ${scheduleAlias}.due_at + (
    case ${scheduleAlias}.reminder_kind
      when 'HOURS_24' then $2::integer
      when 'HOURS_2' then $3::integer
    end * interval '1 millisecond'
  ),
  ${scheduleAlias}.starts_at - case ${scheduleAlias}.reminder_kind
    when 'HOURS_24' then interval '2 hours'
    when 'HOURS_2' then interval '0 hours'
  end
)`;

async function configureSchedulerTransaction(
  client: Pick<PoolClient, 'query'>,
  databaseTimeoutMs: number,
): Promise<void> {
  const lockTimeoutMs = Math.min(2_000, databaseTimeoutMs);
  await client.query(
    `select set_config('lock_timeout', $1, true),
            set_config('statement_timeout', $2, true)`,
    [`${lockTimeoutMs}ms`, `${databaseTimeoutMs}ms`],
  );
}

function assertSingleScheduleTransition(rowCount: number | null, state: string): void {
  if (rowCount !== 1) {
    throw new Error(`BOOKING_REMINDER_${state}_CLAIM_LOST`);
  }
}

export async function reconcileBookingReminderSchedules(options: {
  readonly client: Pick<PoolClient, 'query'>;
  readonly event: LifecycleBookingEvent;
  readonly eventIdFactory?: () => string;
}): Promise<void> {
  const { client, event } = options;
  if (event.type === 'booking.cancelled.v1') {
    await client.query(
      `update notifications.booking_reminder_schedules
          set lifecycle_revision = $3::numeric,
              lifecycle_event_type = $4,
              source_event_id = $5,
              source_correlation_id = $6,
              state = case when state = 'PENDING' then 'CANCELLED' else state end,
              claim_token = null,
              claim_expires_at = null,
              completed_at = case when state = 'PENDING' then clock_timestamp() else completed_at end,
              updated_at = clock_timestamp()
        where tenant_id = $1 and booking_id = $2`,
      [
        event.tenantId,
        event.aggregateId,
        event.payload.revision,
        event.type,
        event.id,
        event.correlationId,
      ],
    );
    return;
  }

  const eventIdFactory = options.eventIdFactory ?? randomUUID;
  const hours24EventId = eventIdFactory();
  const hours2EventId = eventIdFactory();
  await client.query(
    `insert into notifications.booking_reminder_schedules (
       tenant_id, booking_id, reminder_kind, lifecycle_revision, lifecycle_event_type,
       source_event_id, source_correlation_id, event_id, service_title,
       starts_at, timezone, location_name, due_at, state
     ) values
       ($1, $2, 'HOURS_24', $3::numeric, $4, $5, $6, $7, $9,
        $10::timestamptz, $11, $12, $10::timestamptz - interval '24 hours', 'PENDING'),
       ($1, $2, 'HOURS_2', $3::numeric, $4, $5, $6, $8, $9,
        $10::timestamptz, $11, $12, $10::timestamptz - interval '2 hours', 'PENDING')
     on conflict (tenant_id, booking_id, reminder_kind) do update set
       lifecycle_revision = excluded.lifecycle_revision,
       lifecycle_event_type = excluded.lifecycle_event_type,
       source_event_id = excluded.source_event_id,
       source_correlation_id = excluded.source_correlation_id,
       event_id = excluded.event_id,
       service_title = excluded.service_title,
       starts_at = excluded.starts_at,
       timezone = excluded.timezone,
       location_name = excluded.location_name,
       due_at = excluded.due_at,
       state = 'PENDING',
       claim_token = null,
       claim_expires_at = null,
       claim_attempts = 0,
       completed_at = null,
       updated_at = clock_timestamp()`,
    [
      event.tenantId,
      event.aggregateId,
      event.payload.revision,
      event.type,
      event.id,
      event.correlationId,
      hours24EventId,
      hours2EventId,
      event.payload.serviceTitle,
      event.payload.startsAt,
      event.payload.timezone,
      event.payload.locationName,
    ],
  );
  await client.query(
    `delete from notifications.booking_reminder_recipients
      where tenant_id = $1 and booking_id = $2`,
    [event.tenantId, event.aggregateId],
  );
  await client.query(
    `insert into notifications.booking_reminder_recipients (
       tenant_id, booking_id, reminder_kind, recipient_position, user_id
     )
     select $1, $2, kinds.reminder_kind, recipient.ordinality::smallint, recipient.user_id
       from unnest($3::uuid[]) with ordinality as recipient(user_id, ordinality)
       cross join (
         values ('HOURS_24'::text), ('HOURS_2'::text)
       ) as kinds(reminder_kind)`,
    [event.tenantId, event.aggregateId, event.payload.recipientUserIds],
  );
}

async function claimDueSchedules(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly claimToken: string;
  readonly batchSize: number;
  readonly claimTtlMs: number;
  readonly databaseTimeoutMs: number;
  readonly maxHours24LatenessMs: number;
  readonly maxHours2LatenessMs: number;
}): Promise<{ readonly claimed: readonly ClaimedRow[]; readonly missed: number }> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await configureSchedulerTransaction(client, options.databaseTimeoutMs);
    const runtime = await client.query<RuntimeRow>(
      `select booking_reminders_enabled, booking_reminder_ruleset_version,
              booking_reminder_contract_hash
         from notifications.tenant_runtime_settings
        where tenant_id = $1
        for share`,
      [options.tenantId],
    );
    const bindingState = runtimeBindingState(runtime.rows[0]);
    if (bindingState === 'DISABLED') {
      return { claimed: [], missed: 0 };
    }
    if (bindingState === 'MISMATCH') throw new Error(CONTRACT_MISMATCH_ERROR);
    const missed = await client.query<ClaimedRow>(
      `with db_clock as (select clock_timestamp() as now_at),
       candidates as (
         select schedule.booking_id, schedule.reminder_kind
           from notifications.booking_reminder_schedules schedule
           cross join db_clock
          where schedule.tenant_id = $1
            and schedule.state = 'PENDING'
            and db_clock.now_at >= ${expirySql('schedule')}
          order by schedule.due_at, schedule.booking_id, schedule.reminder_kind
          for update of schedule skip locked
          limit $4
       )
       update notifications.booking_reminder_schedules schedule
          set state = 'MISSED',
              claim_token = null,
              claim_expires_at = null,
              completed_at = db_clock.now_at,
              updated_at = db_clock.now_at
         from candidates, db_clock
        where schedule.tenant_id = $1
          and schedule.booking_id = candidates.booking_id
          and schedule.reminder_kind = candidates.reminder_kind
       returning schedule.booking_id, schedule.reminder_kind`,
      [
        options.tenantId,
        options.maxHours24LatenessMs,
        options.maxHours2LatenessMs,
        options.batchSize,
      ],
    );
    const missedCount = missed.rowCount ?? 0;
    const remainingBatchSize = Math.max(0, options.batchSize - missedCount);
    if (remainingBatchSize === 0) {
      return { claimed: [], missed: missedCount };
    }

    const claimed = await client.query<ClaimedRow>(
      `with db_clock as (select clock_timestamp() as now_at),
       candidates as (
         select schedule.booking_id, schedule.reminder_kind
           from notifications.booking_reminder_schedules schedule
           join notifications.booking_notification_projection_fences fence
             on fence.tenant_id = schedule.tenant_id
            and fence.booking_id = schedule.booking_id
           cross join db_clock
          where schedule.tenant_id = $1
            and schedule.state = 'PENDING'
            and schedule.due_at <= db_clock.now_at
            and db_clock.now_at < ${expirySql('schedule')}
            and (
              schedule.claim_token is null
              or schedule.claim_expires_at <= db_clock.now_at
            )
            and fence.lifecycle_revision = schedule.lifecycle_revision
            and fence.lifecycle_event_type <> 'booking.cancelled.v1'
          order by schedule.due_at, schedule.booking_id, schedule.reminder_kind
          for update of schedule skip locked
          limit $4
       )
       update notifications.booking_reminder_schedules schedule
          set claim_token = $5::uuid,
              claim_expires_at = clock_timestamp() + ($6::integer * interval '1 millisecond'),
              claim_attempts = schedule.claim_attempts + 1,
              updated_at = clock_timestamp()
         from candidates
        where schedule.tenant_id = $1
          and schedule.booking_id = candidates.booking_id
          and schedule.reminder_kind = candidates.reminder_kind
       returning schedule.booking_id, schedule.reminder_kind`,
      [
        options.tenantId,
        options.maxHours24LatenessMs,
        options.maxHours2LatenessMs,
        remainingBatchSize,
        options.claimToken,
        options.claimTtlMs,
      ],
    );
    return { claimed: claimed.rows, missed: missedCount };
  });
}

async function finalizeClaim(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly claimToken: string;
  readonly databaseTimeoutMs: number;
  readonly maxHours24LatenessMs: number;
  readonly maxHours2LatenessMs: number;
}): Promise<
  Omit<BookingReminderSchedulerResult, 'claimed'> & { readonly contractMismatch: boolean }
> {
  return withTenantTransaction(options.pool, options.tenantId, async (client) => {
    await configureSchedulerTransaction(client, options.databaseTimeoutMs);
    const claimedBookings = await client.query<BookingIdRow>(
      `select distinct booking_id
         from notifications.booking_reminder_schedules
        where tenant_id = $1 and state = 'PENDING' and claim_token = $2::uuid
        order by booking_id`,
      [options.tenantId, options.claimToken],
    );
    for (const row of claimedBookings.rows) {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${options.tenantId}:${row.booking_id}`,
      ]);
    }

    const runtime = await client.query<RuntimeRow>(
      `select booking_reminders_enabled, booking_reminder_ruleset_version,
              booking_reminder_contract_hash
         from notifications.tenant_runtime_settings
        where tenant_id = $1
        for share`,
      [options.tenantId],
    );
    const bindingState = runtimeBindingState(runtime.rows[0]);
    if (bindingState !== 'CURRENT') {
      const released = await client.query(
        `update notifications.booking_reminder_schedules
            set claim_token = null, claim_expires_at = null, updated_at = clock_timestamp()
          where tenant_id = $1 and state = 'PENDING' and claim_token = $2::uuid`,
        [options.tenantId, options.claimToken],
      );
      return {
        emitted: 0,
        missed: 0,
        cancelled: 0,
        superseded: 0,
        released: released.rowCount ?? 0,
        contractMismatch: bindingState === 'MISMATCH',
      };
    }

    const schedules = await client.query<FinalizationRow>(
      `with db_clock as (select clock_timestamp() as now_at)
       select schedule.booking_id, schedule.reminder_kind,
              schedule.lifecycle_revision::text as lifecycle_revision,
              schedule.lifecycle_event_type, schedule.source_correlation_id, schedule.event_id,
              recipients.recipient_user_ids, schedule.service_title, schedule.starts_at,
              schedule.timezone, schedule.location_name,
              schedule.due_at <= db_clock.now_at
                and db_clock.now_at < ${expirySql('schedule')} as eligible,
              db_clock.now_at >= ${expirySql('schedule')} as expired,
              fence.lifecycle_revision::text as fence_revision,
              fence.lifecycle_event_type as fence_event_type
         from notifications.booking_reminder_schedules schedule
         left join notifications.booking_notification_projection_fences fence
           on fence.tenant_id = schedule.tenant_id and fence.booking_id = schedule.booking_id
         join lateral (
           select array_agg(recipient.user_id order by recipient.recipient_position)
                    as recipient_user_ids
             from notifications.booking_reminder_recipients recipient
            where recipient.tenant_id = schedule.tenant_id
              and recipient.booking_id = schedule.booking_id
              and recipient.reminder_kind = schedule.reminder_kind
           having count(*) between 1 and 50
         ) recipients on true
         cross join db_clock
        where schedule.tenant_id = $1
          and schedule.state = 'PENDING'
          and schedule.claim_token = $4::uuid
        order by schedule.booking_id, schedule.reminder_kind
        for update of schedule`,
      [
        options.tenantId,
        options.maxHours24LatenessMs,
        options.maxHours2LatenessMs,
        options.claimToken,
      ],
    );

    let emitted = 0;
    let missed = 0;
    let cancelled = 0;
    let superseded = 0;
    let released = 0;
    for (const schedule of schedules.rows) {
      const currentCancellation = schedule.fence_event_type === 'booking.cancelled.v1';
      const currentRevision = schedule.fence_revision === schedule.lifecycle_revision;
      if (currentCancellation || !currentRevision) {
        const state = currentCancellation ? 'CANCELLED' : 'SUPERSEDED';
        const terminal = await client.query(
          `update notifications.booking_reminder_schedules
              set state = $5,
                  claim_token = null,
                  claim_expires_at = null,
                  completed_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            where tenant_id = $1 and booking_id = $2 and reminder_kind = $3
              and state = 'PENDING' and claim_token = $4::uuid`,
          [
            options.tenantId,
            schedule.booking_id,
            schedule.reminder_kind,
            options.claimToken,
            state,
          ],
        );
        assertSingleScheduleTransition(terminal.rowCount, state);
        if (currentCancellation) cancelled += 1;
        else superseded += 1;
        continue;
      }
      if (schedule.expired) {
        const terminal = await client.query(
          `update notifications.booking_reminder_schedules
              set state = 'MISSED',
                  claim_token = null,
                  claim_expires_at = null,
                  completed_at = clock_timestamp(),
                  updated_at = clock_timestamp()
            where tenant_id = $1 and booking_id = $2 and reminder_kind = $3
              and state = 'PENDING' and claim_token = $4::uuid`,
          [options.tenantId, schedule.booking_id, schedule.reminder_kind, options.claimToken],
        );
        assertSingleScheduleTransition(terminal.rowCount, 'MISSED');
        missed += 1;
        continue;
      }
      if (!schedule.eligible) {
        const release = await client.query(
          `update notifications.booking_reminder_schedules
              set claim_token = null, claim_expires_at = null, updated_at = clock_timestamp()
            where tenant_id = $1 and booking_id = $2 and reminder_kind = $3
              and state = 'PENDING' and claim_token = $4::uuid`,
          [options.tenantId, schedule.booking_id, schedule.reminder_kind, options.claimToken],
        );
        assertSingleScheduleTransition(release.rowCount, 'RELEASE');
        released += 1;
        continue;
      }

      await client.query(
        `insert into audit.outbox_events (
           id, tenant_id, event_type, aggregate_id, correlation_id, payload, occurred_at
         ) values ($1, $2, 'booking.reminder.due.v1', $3, $4, $5::jsonb, clock_timestamp())`,
        [
          schedule.event_id,
          options.tenantId,
          schedule.booking_id,
          schedule.source_correlation_id,
          JSON.stringify({
            bookingId: schedule.booking_id,
            revision: schedule.lifecycle_revision,
            recipientUserIds: schedule.recipient_user_ids,
            serviceTitle: schedule.service_title,
            startsAt: schedule.starts_at.toISOString(),
            timezone: schedule.timezone,
            locationName: schedule.location_name,
            reminderKind: schedule.reminder_kind,
          }),
        ],
      );
      const terminal = await client.query(
        `update notifications.booking_reminder_schedules
            set state = 'EMITTED',
                claim_token = null,
                claim_expires_at = null,
                completed_at = clock_timestamp(),
                updated_at = clock_timestamp()
          where tenant_id = $1 and booking_id = $2 and reminder_kind = $3
            and state = 'PENDING' and claim_token = $4::uuid`,
        [options.tenantId, schedule.booking_id, schedule.reminder_kind, options.claimToken],
      );
      assertSingleScheduleTransition(terminal.rowCount, 'EMITTED');
      emitted += 1;
    }
    return { emitted, missed, cancelled, superseded, released, contractMismatch: false };
  });
}

export async function runBookingReminderSchedulerBatch(options: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly batchSize: number;
  readonly claimTtlMs: number;
  readonly databaseTimeoutMs: number;
  readonly maxHours24LatenessMs: number;
  readonly maxHours2LatenessMs: number;
  readonly claimTokenFactory?: () => string;
  readonly verificationHooks?: BookingReminderSchedulerVerificationHooks;
}): Promise<BookingReminderSchedulerResult> {
  const claimToken = (options.claimTokenFactory ?? randomUUID)();
  const claim = await claimDueSchedules({ ...options, claimToken });
  if (claim.claimed.length === 0) {
    return { ...EMPTY_RESULT, missed: claim.missed };
  }
  await options.verificationHooks?.afterClaim?.(claim.claimed.length);
  const finalized = await finalizeClaim({ ...options, claimToken });
  if (finalized.contractMismatch) throw new Error(CONTRACT_MISMATCH_ERROR);
  return {
    claimed: claim.claimed.length,
    emitted: finalized.emitted,
    missed: claim.missed + finalized.missed,
    cancelled: finalized.cancelled,
    superseded: finalized.superseded,
    released: finalized.released,
  };
}
