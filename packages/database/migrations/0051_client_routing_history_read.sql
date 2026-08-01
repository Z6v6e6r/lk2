-- Expand the fixed browser-assisted read vocabulary with one bounded history
-- page. This does not make the operation generally direct-contract ready.

alter table integration.client_routing_plans
  drop constraint client_routing_plans_direct_operations_valid;

alter table integration.client_routing_plans
  add constraint client_routing_plans_direct_operations_valid check (
    cardinality(direct_read_operations) <= 6
    and direct_read_operations <@ array[
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read'
    ]::text[]
  );

alter table integration.client_routing_plan_commands
  drop constraint client_routing_plan_commands_operations_valid;

alter table integration.client_routing_plan_commands
  add constraint client_routing_plan_commands_operations_valid check (
    cardinality(requested_operations) <= 6
    and requested_operations <@ array[
      'profile.read',
      'bookings.read',
      'bookings.details.read',
      'bookings.history.read',
      'subscriptions.read',
      'schedule.read'
    ]::text[]
  );
