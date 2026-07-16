-- Expand per-operation client routing without changing the safe tenant default.
-- Existing plans and command history receive an empty direct-read allowlist.

alter table integration.client_routing_plans
  add column direct_read_operations text[] not null default '{}';

alter table integration.client_routing_plans
  add constraint client_routing_plans_direct_operations_valid check (
    cardinality(direct_read_operations) <= 5
    and direct_read_operations <@ array[
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'subscriptions.read',
      'schedule.read'
    ]::text[]
  );

alter table integration.client_routing_plan_commands
  add column requested_operations text[] not null default '{}';

alter table integration.client_routing_plan_commands
  add constraint client_routing_plan_commands_operations_valid check (
    cardinality(requested_operations) <= 5
    and requested_operations <@ array[
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'subscriptions.read',
      'schedule.read'
    ]::text[]
  );
