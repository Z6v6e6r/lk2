import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import descriptor from '../../../deploy/timeweb/notification-migrations-0099-0101.v1.json';
import golden from '../../../deploy/timeweb/notification-migration-catalogs.v1.json';
import { parseStrictJson } from '../../../scripts/strict-json.js';
import {
  notificationLedgerCheckpoint,
  validateNotificationMigrationCatalog,
  type MigrationRow,
} from '../../../scripts/notification-migration-package.js';
import {
  NOTIFICATION_CATALOG_SQL,
  NOTIFICATION_DEFAULT_ACL_SQL,
  NOTIFICATION_NEW_TABLES,
  NOTIFICATION_NEW_TABLE_SECURITY_SQL,
  NOTIFICATION_CATALOG_VERSION,
  NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL,
  NOTIFICATION_REFERENCES_SAFE_SQL,
} from '../../../scripts/notification-migration-catalog.js';

type Client = Pick<PoolClient, 'query'>;
export const notificationMode = 'notification_0099_0101' as const;
export const notificationModeArgument = '--notification-migrations-0099-0101';
function fail(code: string): never {
  throw new Error(`NOTIFICATION_MIGRATION_${code}`);
}
export type CatalogRow = { key: string; value: string };
export type NotificationTarget = { databaseName: string; systemIdentifier: string };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const notificationPackageSha256 = hash(`${JSON.stringify(descriptor, null, 2)}\n`);
export const notificationBuilderSha256 = hash(
  [
    NOTIFICATION_CATALOG_VERSION,
    JSON.stringify(NOTIFICATION_NEW_TABLES),
    NOTIFICATION_CATALOG_SQL,
    NOTIFICATION_DEFAULT_ACL_SQL,
    NOTIFICATION_NEW_TABLE_SECURITY_SQL,
    NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL,
    NOTIFICATION_REFERENCES_SAFE_SQL,
  ].join('\n'),
);
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  )
    throw new Error('NOTIFICATION_MIGRATION_SHAPE');
}
export function parseNotificationTarget(value: unknown): NotificationTarget {
  object(value, ['databaseName', 'systemIdentifier']);
  if (
    typeof value.databaseName !== 'string' ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(value.databaseName) ||
    typeof value.systemIdentifier !== 'string' ||
    !/^[1-9][0-9]*$/.test(value.systemIdentifier)
  )
    throw new Error('NOTIFICATION_MIGRATION_TARGET');
  return { databaseName: value.databaseName, systemIdentifier: value.systemIdentifier };
}
export function validateNotificationGolden(
  value: unknown,
): Record<string, { sha256: string; rows: CatalogRow[] }> {
  object(value, [
    'schema',
    'postgresMajor',
    'packageDescriptorSha256',
    'builderVersion',
    'builderSha256',
    'checkpoints',
  ]);
  if (
    value.schema !== 'PHUB_NOTIFICATION_MIGRATION_CATALOGS_V1' ||
    value.postgresMajor !== 16 ||
    value.packageDescriptorSha256 !== notificationPackageSha256 ||
    value.builderVersion !== NOTIFICATION_CATALOG_VERSION ||
    value.builderSha256 !== notificationBuilderSha256
  )
    throw new Error('NOTIFICATION_MIGRATION_GOLDEN_BINDING');
  object(value.checkpoints, ['102', '103', '104', '105']);
  const output: Record<string, { sha256: string; rows: CatalogRow[] }> = {};
  for (const count of ['102', '103', '104', '105']) {
    const entry = value.checkpoints[count];
    object(entry, ['sha256', 'rows']);
    if (
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Array.isArray(entry.rows) ||
      entry.rows.length === 0
    )
      throw new Error('NOTIFICATION_MIGRATION_GOLDEN_CATALOG_REQUIRED');
    let prior = '';
    const rows: CatalogRow[] = [];
    for (const row of entry.rows) {
      object(row, ['key', 'value']);
      if (
        typeof row.key !== 'string' ||
        !row.key ||
        row.key <= prior ||
        typeof row.value !== 'string'
      )
        throw new Error('NOTIFICATION_MIGRATION_GOLDEN_ROWS');
      const parsed = parseStrictJson(row.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('NOTIFICATION_MIGRATION_GOLDEN_ROWS');
      rows.push({ key: row.key, value: row.value });
      prior = row.key;
    }
    if (catalogDigest(rows) !== entry.sha256)
      throw new Error('NOTIFICATION_MIGRATION_GOLDEN_DIGEST');
    output[count] = { sha256: entry.sha256, rows };
  }
  return output;
}
export const catalogDigest = (rows: readonly CatalogRow[]) =>
  createHash('sha256')
    .update(`${JSON.stringify(rows)}\n`)
    .digest('hex');
export async function notificationCatalog(client: Client): Promise<CatalogRow[]> {
  await client.query("set local search_path='pg_catalog'");
  const version = (
    await client.query<{ major: number }>(
      "select current_setting('server_version_num')::int/10000 as major",
    )
  ).rows[0];
  if (version?.major !== 16) fail('POSTGRES_MAJOR');
  return (await client.query<CatalogRow>(NOTIFICATION_CATALOG_SQL, [[...NOTIFICATION_NEW_TABLES]]))
    .rows;
}
export async function verifyNotificationCatalog(client: Client, count: number): Promise<string> {
  if (Object.keys(golden.checkpoints).length !== 4) fail('GOLDEN_CATALOG_REQUIRED');
  const checkpoints = validateNotificationGolden(golden);
  const expected = checkpoints[String(count)];
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    catalogDigest(expected.rows) !== expected.sha256
  )
    fail('GOLDEN_CATALOG_REQUIRED');
  const actual = await notificationCatalog(client);
  if (
    catalogDigest(actual) !== expected.sha256 ||
    JSON.stringify(actual) !== JSON.stringify(expected.rows)
  )
    fail('CATALOG_DRIFT');
  return expected.sha256;
}
export async function notificationRole(client: Client): Promise<void> {
  const value = (
    await client.query<{
      ok: boolean;
    }>(`select current_user='phub_migrator' and session_user=current_user
    and current_setting('role')='none'
    and (select count(*)=2 and bool_and(not (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication) and r.rolinherit)
      from pg_catalog.pg_roles r where r.rolname in ('phub_migrator','phub_runtime'))
    and not exists(select 1 from pg_catalog.pg_auth_members where member in ('phub_migrator'::regrole,'phub_runtime'::regrole) or roleid in ('phub_migrator'::regrole,'phub_runtime'::regrole))
    and not pg_catalog.pg_has_role('phub_runtime','phub_migrator','MEMBER')
    and pg_catalog.has_function_privilege('phub_runtime','pg_catalog.pg_control_system()','EXECUTE')
    and pg_catalog.has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE')
    and ${NOTIFICATION_FUNCTION_DEFAULTS_SAFE_SQL}
    and ${NOTIFICATION_REFERENCES_SAFE_SQL}
    and not pg_catalog.has_database_privilege('phub_runtime',current_database(),'CREATE')
    and not exists(select 1 from pg_catalog.pg_namespace n where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
      and pg_catalog.has_schema_privilege('phub_runtime',n.oid,'CREATE'))
    and (select bool_and(pg_catalog.has_schema_privilege(current_user,n,'USAGE') and pg_catalog.has_schema_privilege(current_user,n,'CREATE'))
      from unnest(array['identity','notifications','support']) n)
    and (select count(*)=3 and bool_and(pg_catalog.pg_has_role(current_user,c.relowner,'USAGE')) from pg_catalog.pg_class c
      where c.oid in ('notifications.deliveries'::regclass,'support.tickets'::regclass,'support.messages'::regclass))
    and (select bool_and(pg_catalog.has_column_privilege(current_user,t.name,t.col,'REFERENCES')) from (values
      ('identity.local_email_credentials','tenant_id'),('identity.local_email_credentials','id'),('identity.local_email_credentials','user_id'),
      ('identity.tenants','id'),('identity.users','tenant_id'),('identity.users','id'),
      ('notifications.templates','tenant_id'),('notifications.templates','id'),('notifications.intents','tenant_id'),('notifications.intents','id'),
      ('support.tickets','tenant_id'),('support.tickets','id')) t(name,col))
    and not exists(select 1 from pg_catalog.pg_attribute a where a.attnum>0 and not a.attisdropped and
      a.attrelid in ('notifications.templates'::regclass,'notifications.intents'::regclass) and a.attname not in ('tenant_id','id')
      and pg_catalog.has_column_privilege(current_user,a.attrelid,a.attnum,'REFERENCES'))
    and not exists(select 1 from pg_catalog.pg_default_acl d cross join lateral pg_catalog.aclexplode(d.defaclacl) a
      where d.defaclrole='phub_migrator'::regrole and d.defaclobjtype='r'
      and d.defaclnamespace='notifications'::regnamespace and a.grantee<>'phub_migrator'::regrole)
    and not exists(select 1 from pg_catalog.pg_namespace n cross join lateral pg_catalog.aclexplode(n.nspacl) a
      where n.nspname='notifications' and (a.is_grantable or (a.privilege_type='CREATE' and a.grantee not in ('phub_migrator'::regrole,'phub_beta'::regrole))))
    as ok`)
  ).rows[0];
  if (value?.ok !== true) fail('ROLE');
}
export async function notificationLedger(client: Client): Promise<MigrationRow[]> {
  return (
    await client.query<MigrationRow>(
      'select filename,checksum from public.schema_migrations order by filename',
    )
  ).rows;
}
export async function assertNotificationRun(
  client: Client,
  packaged: readonly MigrationRow[],
  expectedTarget: NotificationTarget,
): Promise<void> {
  validateNotificationMigrationCatalog(packaged);
  const target = parseNotificationTarget(expectedTarget);
  const observed = (
    await client.query<NotificationTarget>(
      `select current_database() as "databaseName",system_identifier::text as "systemIdentifier" from pg_catalog.pg_control_system()`,
    )
  ).rows;
  if (observed.length !== 1 || JSON.stringify(observed[0]) !== JSON.stringify(target))
    fail('TARGET');
  await notificationRole(client);
  validateNotificationDefaults(await notificationDefaultAcls(client));
  const count = notificationLedgerCheckpoint(await notificationLedger(client));
  if (count !== 102 && count !== 105) fail('PARTIAL_REQUIRES_OWNER_RECONCILIATION');
  await client.query('begin read only');
  try {
    await verifyNotificationCatalog(client, count);
  } finally {
    await client.query('rollback');
  }
}
type DefaultAcl = {
  scope: string;
  type: string;
  grantor: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
};
export async function notificationDefaultAcls(client: Client): Promise<DefaultAcl[]> {
  const rows = (await client.query<{ acl: DefaultAcl[] }>(NOTIFICATION_DEFAULT_ACL_SQL)).rows;
  if (rows.length !== 1) fail('DEFAULT_ACL_UNKNOWN');
  return rows[0]!.acl;
}
export function validateNotificationDefaults(acl: readonly DefaultAcl[]): void {
  // Schema-local defaults are additive: pg_default_acl stores only the four runtime grants.
  // Implicit owner privileges are checked on each resulting table, not invented in this preimage.
  if (
    acl.length !== 4 ||
    JSON.stringify(acl.map((r) => r.privilege).sort()) !==
      JSON.stringify(['DELETE', 'INSERT', 'SELECT', 'UPDATE']) ||
    acl.some(
      (r) =>
        r.scope !== 'identity' ||
        r.type !== 'r' ||
        r.grantor !== 'phub_migrator' ||
        r.grantee !== 'phub_runtime' ||
        r.grantable !== false,
    )
  )
    fail('DEFAULT_ACL_PREIMAGE');
}
export async function verifyNotificationTableSecurity(
  client: Client,
  names: readonly string[],
): Promise<void> {
  const rows = (
    await client.query<{
      name: string;
      owner: string;
      rls: boolean;
      force: boolean;
      nonOwnerGrants: number;
      columnAcls: number;
      runtimeAccess: boolean;
    }>(NOTIFICATION_NEW_TABLE_SECURITY_SQL, [[...names]])
  ).rows;
  if (
    rows.length !== names.length ||
    rows.some(
      (r) =>
        r.owner !== 'phub_migrator' ||
        r.rls !== true ||
        r.force !== true ||
        r.nonOwnerGrants !== 0 ||
        r.columnAcls !== 0 ||
        r.runtimeAccess !== false,
    )
  )
    fail('NEW_TABLE_ACL');
}
export async function beforeNotificationStep(
  client: Client,
  filename: string,
): Promise<string | null> {
  await notificationRole(client);
  const step = descriptor.steps.find((s) => s.filename === filename);
  if (
    !step ||
    notificationLedgerCheckpoint(await notificationLedger(client)) !== step.ledgerCount - 1
  )
    fail('STEP');
  if (step.ledgerCount !== 103) return null;
  const acl = await notificationDefaultAcls(client);
  validateNotificationDefaults(acl);
  await client.query(
    'alter default privileges for role phub_migrator in schema identity revoke select,insert,update,delete on tables from phub_runtime',
  );
  return JSON.stringify(acl);
}
export async function afterNotificationSql(
  client: Client,
  filename: string,
  preimage: string | null,
): Promise<void> {
  if (filename !== descriptor.steps[0]!.filename) return;
  if (preimage === null) fail('DEFAULT_ACL_PREIMAGE');
  await verifyNotificationTableSecurity(client, NOTIFICATION_NEW_TABLES.slice(0, 2));
  await client.query(
    'alter default privileges for role phub_migrator in schema identity grant select,insert,update,delete on tables to phub_runtime',
  );
  if (JSON.stringify(await notificationDefaultAcls(client)) !== preimage)
    fail('DEFAULT_ACL_NOT_RESTORED');
}
export async function afterNotificationStep(client: Client, filename: string): Promise<void> {
  const step = descriptor.steps.find((s) => s.filename === filename);
  if (!step || notificationLedgerCheckpoint(await notificationLedger(client)) !== step.ledgerCount)
    fail('CHECKPOINT');
  await verifyNotificationCatalog(client, step.ledgerCount);
  const names = NOTIFICATION_NEW_TABLES.slice(
    0,
    step.ledgerCount === 103 ? 2 : step.ledgerCount === 104 ? 7 : 10,
  );
  await verifyNotificationTableSecurity(client, names);
}
