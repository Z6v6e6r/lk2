import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import descriptor from '../../../deploy/timeweb/closed-application-migrations-0103-0104.v1.json';
import {
  notificationLedgerDigest,
  type MigrationRow,
} from '../../../scripts/notification-migration-package.js';
import {
  CLOSED_APPLICATION_CATALOG_SQL,
  CLOSED_APPLICATION_CATALOG_TABLES,
  CLOSED_APPLICATION_NEW_TABLES,
  CLOSED_APPLICATION_CATALOG_VERSION,
} from '../../../scripts/closed-application-migration-catalog.js';
import {
  notificationDefaultAcls,
  parseNotificationTarget,
  validateNotificationDefaults,
  verifyNotificationTableSecurity,
  type NotificationTarget,
} from './notification-migration.js';

type Client = Pick<PoolClient, 'query'>;
export const closedSingleMode = 'closed_single_application_migration' as const;
export type ClosedSingleProfile = keyof typeof descriptor.profiles;
export type ClosedCatalogVariant = 'DORMANT' | 'SCENARIO_EDITOR_V1';
export type ClosedSingleTarget = NotificationTarget & { catalogVariant: ClosedCatalogVariant };
export const closedSingleArguments = Object.freeze({
  '--game-start-migration-0103': 'game_start_0103',
  '--subject-link-migration-0104': 'subject_link_0104',
} as const);
export const closedNewTables = CLOSED_APPLICATION_NEW_TABLES;
const fail = (code: string): never => {
  throw new Error(`CLOSED_APPLICATION_MIGRATION_${code}`);
};
const isVariant = (value: unknown): value is ClosedCatalogVariant =>
  value === 'DORMANT' || value === 'SCENARIO_EDITOR_V1';
export function parseClosedSingleTarget(value: unknown): ClosedSingleTarget {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(['catalogVariant', 'databaseName', 'systemIdentifier'])
  )
    return fail('TARGET_SHAPE');
  const row = value as Record<string, unknown>;
  if (!isVariant(row.catalogVariant)) return fail('CATALOG_VARIANT');
  return {
    ...parseNotificationTarget({
      databaseName: row.databaseName,
      systemIdentifier: row.systemIdentifier,
    }),
    catalogVariant: row.catalogVariant,
  };
}
export function closedProfileArgument(value: string): ClosedSingleProfile | undefined {
  return Object.hasOwn(closedSingleArguments, value)
    ? closedSingleArguments[value as keyof typeof closedSingleArguments]
    : undefined;
}
export function closedProfile(profile: ClosedSingleProfile) {
  if (!Object.hasOwn(descriptor.profiles, profile)) return fail('PROFILE');
  return descriptor.profiles[profile];
}
export function assertClosedPackagedCatalog(packaged: readonly MigrationRow[]): void {
  if (descriptor.catalogSchema !== CLOSED_APPLICATION_CATALOG_VERSION) fail('CATALOG_SCHEMA');
  if (
    packaged.length !== descriptor.packagedCount ||
    notificationLedgerDigest(packaged) !== descriptor.packagedLedgerSha256
  )
    fail('SOURCE_CATALOG');
  for (const profile of Object.values(descriptor.profiles)) {
    if (
      packaged[profile.postCount - 1]?.filename !== profile.filename ||
      packaged[profile.postCount - 1]?.checksum !== profile.checksum
    )
      fail('SOURCE_STEP');
    for (const count of [profile.preCount, profile.postCount]) {
      const point = descriptor.checkpoints[String(count) as keyof typeof descriptor.checkpoints];
      if (notificationLedgerDigest(packaged.slice(0, count)) !== point.ledgerSha256)
        fail('SOURCE_PREFIX');
    }
  }
}
export function assertClosedLedger(rows: readonly MigrationRow[], count: number): void {
  const point = descriptor.checkpoints[String(count) as keyof typeof descriptor.checkpoints];
  if (!point || rows.length !== count || notificationLedgerDigest(rows) !== point.ledgerSha256)
    fail('LEDGER');
}
async function ledger(client: Client): Promise<MigrationRow[]> {
  return (
    await client.query<MigrationRow>(
      'select filename,checksum from public.schema_migrations order by filename',
    )
  ).rows;
}
export async function verifyClosedCatalog(
  client: Client,
  count: number,
  variant: ClosedCatalogVariant,
): Promise<void> {
  const point = descriptor.checkpoints[String(count) as keyof typeof descriptor.checkpoints];
  if (!point || !isVariant(variant)) fail('CATALOG_CHECKPOINT');
  const expected = point.catalogs[variant];
  await client.query("set local search_path='pg_catalog'");
  const rows = (
    await client.query<{ key: string; value: string }>(CLOSED_APPLICATION_CATALOG_SQL, [
      CLOSED_APPLICATION_CATALOG_TABLES,
    ])
  ).rows;
  if (
    rows.length !== expected.rowCount ||
    createHash('sha256')
      .update(`${JSON.stringify(rows)}\n`)
      .digest('hex') !== expected.sha256
  )
    fail('CATALOG');
}
async function roleAndTarget(client: Client, expectedTarget: ClosedSingleTarget): Promise<void> {
  const parsed = parseClosedSingleTarget(expectedTarget);
  const target = { databaseName: parsed.databaseName, systemIdentifier: parsed.systemIdentifier };
  const observed = (
    await client.query<NotificationTarget>(
      `select current_database() as "databaseName",system_identifier::text as "systemIdentifier" from pg_catalog.pg_control_system()`,
    )
  ).rows;
  if (observed.length !== 1 || JSON.stringify(observed[0]) !== JSON.stringify(target))
    fail('TARGET');
  const row = (
    await client.query<{
      ok: boolean;
    }>(`select current_user='phub_migrator' and session_user=current_user
    and current_setting('role')='none'
    and current_setting('server_version_num')::int/10000=16
    and (select count(*)=2 and bool_and(not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) and rolinherit)
      from pg_catalog.pg_roles where rolname in ('phub_migrator','phub_runtime'))
    and not exists(select 1 from pg_catalog.pg_auth_members where member in ('phub_migrator'::regrole,'phub_runtime'::regrole) or roleid in ('phub_migrator'::regrole,'phub_runtime'::regrole))
    and not pg_catalog.has_database_privilege('phub_runtime',current_database(),'CREATE')
    and not exists(select 1 from pg_catalog.pg_namespace n where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema' and pg_catalog.has_schema_privilege('phub_runtime',n.oid,'CREATE'))
    and not pg_catalog.has_schema_privilege('phub_migrator','public','CREATE')
    and not exists(select 1 from pg_catalog.pg_event_trigger where evtenabled<>'D') as ok`)
  ).rows[0];
  if (row?.ok !== true) fail('ROLE');
}
export async function assertClosedRun(
  client: Client,
  packaged: readonly MigrationRow[],
  profile: ClosedSingleProfile,
  target: ClosedSingleTarget,
): Promise<void> {
  assertClosedPackagedCatalog(packaged);
  await roleAndTarget(client, target);
  const step = closedProfile(profile);
  assertClosedLedger(await ledger(client), step.preCount);
  await client.query('begin read only');
  try {
    await verifyClosedCatalog(client, step.preCount, target.catalogVariant);
  } finally {
    await client.query('rollback');
  }
}
export async function beforeClosedStep(
  client: Client,
  profile: ClosedSingleProfile,
  target: ClosedSingleTarget,
): Promise<string> {
  await roleAndTarget(client, target);
  const step = closedProfile(profile);
  assertClosedLedger(await ledger(client), step.preCount);
  await verifyClosedCatalog(client, step.preCount, target.catalogVariant);
  const defaults = await notificationDefaultAcls(client);
  validateNotificationDefaults(defaults);
  if (profile === 'subject_link_0104')
    await client.query(
      'alter default privileges for role phub_migrator in schema identity revoke select,insert,update,delete on tables from phub_runtime',
    );
  return JSON.stringify(defaults);
}
export async function afterClosedSql(
  client: Client,
  profile: ClosedSingleProfile,
  defaultsPreimage: string,
): Promise<void> {
  await verifyNotificationTableSecurity(
    client,
    profile === 'game_start_0103' ? closedNewTables.slice(0, 3) : closedNewTables.slice(3),
  );
  if (profile === 'subject_link_0104')
    await client.query(
      'alter default privileges for role phub_migrator in schema identity grant select,insert,update,delete on tables to phub_runtime',
    );
  if (JSON.stringify(await notificationDefaultAcls(client)) !== defaultsPreimage)
    fail('DEFAULT_ACL_NOT_RESTORED');
}
export async function afterClosedStep(
  client: Client,
  profile: ClosedSingleProfile,
  variant: ClosedCatalogVariant,
): Promise<void> {
  const step = closedProfile(profile);
  assertClosedLedger(await ledger(client), step.postCount);
  await verifyClosedCatalog(client, step.postCount, variant);
}
