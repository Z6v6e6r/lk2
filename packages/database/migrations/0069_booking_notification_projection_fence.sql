-- A per-booking delivery fence for at-least-once booking notification source events.
-- This expand-only migration deliberately creates no tenant configuration or notification rules.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table notifications.booking_notification_projection_fences (
  tenant_id uuid not null references identity.tenants(id),
  booking_id uuid not null,
  lifecycle_revision numeric not null check (lifecycle_revision::text ~ '^[1-9][0-9]*$'),
  lifecycle_event_type text not null check (
    lifecycle_event_type in ('booking.confirmed.v1', 'booking.changed.v1', 'booking.cancelled.v1')
  ),
  lifecycle_fingerprint text not null check (lifecycle_fingerprint ~ '^[0-9a-f]{64}$'),
  reminder_hours_24_fingerprint text check (reminder_hours_24_fingerprint ~ '^[0-9a-f]{64}$'),
  reminder_hours_2_fingerprint text check (reminder_hours_2_fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, booking_id)
);

alter table notifications.booking_notification_projection_fences enable row level security;

create policy booking_notification_projection_fences_tenant_isolation
  on notifications.booking_notification_projection_fences
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table notifications.booking_notification_projection_fences force row level security;
