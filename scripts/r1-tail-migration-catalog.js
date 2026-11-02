// Concrete tail catalog, reusing the existing PostgreSQL16 semantic serializer.
// No business values, statistics, OIDs or raw database URLs are returned.
import { NOTIFICATION_CATALOG_SQL } from './notification-migration-catalog.js';
import { CLOSED_APPLICATION_CATALOG_SQL } from './closed-application-migration-catalog.js';
export const R1_TAIL_TABLES = Object.freeze([
  'public.schema_migrations',
  'identity.tenants',
  'identity.users',
  'identity.refresh_sessions',
  'identity.external_subject_link_commands',
  'locations.profiles',
  'integration.external_entity_map',
  'integration.game_create_location_bindings',
  'games.command_idempotency',
  'games.games',
  'games.participations',
  'games.seat_reservations',
  'games.payment_confirmation_evidence',
  'eligibility.decisions',
  'eligibility.payment_snapshots',
  'games.managed_self_leave_attempts',
  'games.managed_self_leave_command_links',
  'booking.training_registration_attempts',
  'booking.tournament_local_attempts',
  'games.quarter_create_attempts',
  'notifications.intents',
  'notifications.deliveries',
  'notifications.station_message_sources',
  'notifications.station_message_facts',
  'notifications.station_message_recipient_outbox',
  'notifications.tournament_message_sources',
  'notifications.tournament_message_facts',
  'notifications.tournament_message_recipient_outbox',
  'commerce.monthly_purchase_attempts',
  'commerce.monthly_purchase_launches',
]);
const oldTargets =
  "targets as (select name,pg_catalog.to_regclass(name) as oid, name=any($1::text[]) as fresh\n   from unnest($1::text[]||array['notifications.deliveries','support.tickets','support.messages']) t(name))";
const oldFunctions =
  "where (n.nspname,p.proname) in (('notifications','scenario_version_immutable'),\n    ('notifications','guard_extended_scenario'),('support','guard_internal_task'))";
if (
  !NOTIFICATION_CATALOG_SQL.includes(oldTargets) ||
  !NOTIFICATION_CATALOG_SQL.includes(oldFunctions)
)
  throw Error('R1_TAIL_CATALOG_BASE_DRIFT');
const semantic = NOTIFICATION_CATALOG_SQL.replace(
  oldTargets,
  `targets as (select name,pg_catalog.to_regclass(name) as oid,true as fresh
    from (select distinct unnest($1::text[]) as name) t)`,
).replace(
  oldFunctions,
  `where exists(select 1 from pg_catalog.pg_trigger tr
    where tr.tgfoid=p.oid and tr.tgrelid in(select oid from targets) and not tr.tgisinternal)`,
);

// Reuse the independently established storage/rules/index-storage/lineage serializer too.
// Targets are deduplicated because deliveries is both in the fixed tail and historical extras.
const anchor = ' target_scope as ';
const suffixOffset = CLOSED_APPLICATION_CATALOG_SQL.indexOf(anchor);
if (suffixOffset < 0 || CLOSED_APPLICATION_CATALOG_SQL.indexOf(anchor, suffixOffset + 1) !== -1)
  throw Error('R1_TAIL_CATALOG_STORAGE_BASE_DRIFT');
const historicalTarget =
  "from unnest($1::text[]||array['notifications.deliveries','support.tickets','support.messages']) t(name)";
const suffix = CLOSED_APPLICATION_CATALOG_SQL.slice(suffixOffset);
if (!suffix.includes(historicalTarget)) throw Error('R1_TAIL_CATALOG_STORAGE_BASE_DRIFT');
export const R1_TAIL_CATALOG_SQL = `with frozen_base as (${semantic}),
${suffix.replace(
  'target_scope as (select name,pg_catalog.to_regclass(name) as oid',
  'target_scope as (select distinct name,pg_catalog.to_regclass(name) as oid',
)}`;
