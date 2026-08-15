-- Expand-only durable booking reminder schedules. Lifecycle producers and both runtime gates
-- remain disabled by default; this migration neither derives bookings nor activates delivery.
-- phub:reviewed-new-table-index

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table notifications.tenant_runtime_settings
  add column booking_reminders_enabled boolean not null default false,
  add column booking_reminder_ruleset_version text,
  add column booking_reminder_contract_hash text,
  add constraint tenant_runtime_booking_reminder_binding_check check (
    (
      booking_reminders_enabled = false
      and booking_reminder_ruleset_version is null
      and booking_reminder_contract_hash is null
    )
    or
    (
      booking_reminders_enabled = true
      and booking_reminder_ruleset_version is not null
      and char_length(booking_reminder_ruleset_version) between 1 and 128
      and booking_reminder_contract_hash is not null
      and booking_reminder_contract_hash ~ '^[0-9a-f]{64}$'
    )
  );

create table notifications.booking_reminder_schedules (
  tenant_id uuid not null references identity.tenants(id),
  booking_id uuid not null,
  reminder_kind text not null check (reminder_kind in ('HOURS_24', 'HOURS_2')),
  lifecycle_revision numeric not null check (lifecycle_revision::text ~ '^[1-9][0-9]*$'),
  lifecycle_event_type text not null check (
    lifecycle_event_type in ('booking.confirmed.v1', 'booking.changed.v1', 'booking.cancelled.v1')
  ),
  source_event_id uuid not null,
  source_correlation_id text not null check (char_length(source_correlation_id) between 8 and 128),
  event_id uuid not null default gen_random_uuid(),
  service_title text not null check (char_length(service_title) between 1 and 160),
  starts_at timestamptz not null,
  timezone text not null check (char_length(timezone) between 1 and 64),
  location_name text not null check (char_length(location_name) between 1 and 160),
  due_at timestamptz not null,
  state text not null default 'PENDING'
    check (state in ('PENDING', 'EMITTED', 'CANCELLED', 'MISSED', 'SUPERSEDED')),
  claim_token uuid,
  claim_expires_at timestamptz,
  claim_attempts integer not null default 0 check (claim_attempts >= 0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, booking_id, reminder_kind),
  unique (event_id),
  check (
    due_at = starts_at - case reminder_kind
      when 'HOURS_24' then interval '24 hours'
      when 'HOURS_2' then interval '2 hours'
    end
  ),
  check (
    (
      state = 'PENDING'
      and completed_at is null
      and (
        (claim_token is null and claim_expires_at is null)
        or (claim_token is not null and claim_expires_at is not null)
      )
    )
    or (
      state in ('EMITTED', 'CANCELLED', 'MISSED', 'SUPERSEDED')
      and completed_at is not null
      and claim_token is null
      and claim_expires_at is null
    )
  )
);

create table notifications.booking_reminder_recipients (
  tenant_id uuid not null,
  booking_id uuid not null,
  reminder_kind text not null check (reminder_kind in ('HOURS_24', 'HOURS_2')),
  recipient_position smallint not null check (recipient_position between 1 and 50),
  user_id uuid not null,
  primary key (tenant_id, booking_id, reminder_kind, recipient_position),
  unique (tenant_id, booking_id, reminder_kind, user_id),
  foreign key (tenant_id, booking_id, reminder_kind)
    references notifications.booking_reminder_schedules (
      tenant_id, booking_id, reminder_kind
    ) on delete cascade,
  foreign key (tenant_id, user_id) references identity.users(tenant_id, id)
);

create index booking_reminder_schedules_due_idx
  on notifications.booking_reminder_schedules (
    tenant_id, due_at, booking_id, reminder_kind
  )
  where state = 'PENDING';

create index booking_reminder_schedules_claim_idx
  on notifications.booking_reminder_schedules (
    tenant_id, claim_token, booking_id, reminder_kind
  )
  where state = 'PENDING' and claim_token is not null;

create index booking_reminder_schedules_missed_idx
  on notifications.booking_reminder_schedules (tenant_id, completed_at desc)
  where state = 'MISSED';

alter table notifications.booking_reminder_schedules enable row level security;
alter table notifications.booking_reminder_recipients enable row level security;

create policy booking_reminder_schedules_tenant_isolation
  on notifications.booking_reminder_schedules
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create policy booking_reminder_recipients_tenant_isolation
  on notifications.booking_reminder_recipients
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.booking_reminder_schedules force row level security;
alter table notifications.booking_reminder_recipients force row level security;
