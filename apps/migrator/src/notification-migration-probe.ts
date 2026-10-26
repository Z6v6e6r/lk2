import { Client } from 'pg';
import {
  notificationCatalog,
  catalogDigest,
  notificationDefaultAcls,
  validateNotificationDefaults,
  verifyNotificationCatalog,
  notificationRole,
  verifyNotificationTableSecurity,
} from './notification-migration.js';
import { notificationLedgerCheckpoint } from '../../../scripts/notification-migration-package.js';
import { NOTIFICATION_NEW_TABLES } from '../../../scripts/notification-migration-catalog.js';

const kind = process.argv[2];
const phase = process.argv[3];
let client: Client | undefined;
try {
  if (!['runtime', 'migrator'].includes(kind ?? '')) throw new Error();
  if (!['pre', 'post'].includes(phase ?? '') || process.argv.length !== 4) throw new Error();
  const url = new URL(process.env.DATABASE_URL ?? '');
  const wireRoleName = decodeURIComponent(url.username);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    wireRoleName !== `phub_${kind === 'runtime' ? 'runtime' : 'migrator'}`
  )
    throw new Error();
  client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
  });
  await client.connect();
  await client.query('begin isolation level repeatable read read only');
  const identity = (
    await client.query<
      Record<string, unknown>
    >(`select current_user as "currentRoleName", session_user as "sessionRoleName",
    current_setting('role') as "roleOverride", current_database() as "databaseName",
    (select system_identifier::text from pg_catalog.pg_control_system()) as "systemIdentifier",
    current_setting('transaction_read_only') as "readOnly",pg_catalog.pg_is_in_recovery() as recovery,
    r.rolsuper as superuser,r.rolbypassrls as "bypassRls",r.rolcreaterole as "createRole",r.rolcreatedb as "createDatabase",r.rolreplication as replication,
    r.rolinherit as inherit,
    has_database_privilege(current_user,current_database(),'CREATE') as "databaseCreate",
    exists(select 1 from pg_catalog.pg_auth_members where member in ('phub_migrator'::regrole,'phub_runtime'::regrole)
      or roleid in ('phub_migrator'::regrole,'phub_runtime'::regrole)) as "roleMembershipsPresent",
    exists(select 1 from pg_catalog.pg_roles o where o.oid<>r.oid and pg_catalog.pg_has_role(r.oid,o.oid,'MEMBER')
      and (o.rolsuper or o.rolbypassrls or o.rolcreaterole or o.rolcreatedb or o.rolreplication or left(o.rolname,3)='pg_')) as "privilegedMembership",
    pg_catalog.pg_has_role('phub_runtime','phub_migrator','MEMBER') as "runtimeCanAssumeMigrator",
    exists(select 1 from pg_catalog.pg_namespace n where left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
      and pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) as "businessCreate",
    exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p') and left(n.nspname,3)<>'pg_' and n.nspname<>'information_schema'
      and (pg_catalog.pg_has_role(current_user,c.relowner,'USAGE') or pg_catalog.has_table_privilege(current_user,c.oid,'TRUNCATE')
        or pg_catalog.has_table_privilege(current_user,c.oid,'TRIGGER'))) as "businessDdlControl"
    from pg_catalog.pg_roles r where r.rolname=current_user`)
  ).rows;
  if (identity.length !== 1) throw new Error();
  const observed = identity[0]!;
  if (
    observed.currentRoleName !== wireRoleName ||
    observed.sessionRoleName !== wireRoleName ||
    observed.roleOverride !== 'none' ||
    observed.readOnly !== 'on' ||
    observed.recovery !== false ||
    observed.inherit !== true ||
    [
      'superuser',
      'bypassRls',
      'createRole',
      'createDatabase',
      'replication',
      'roleMembershipsPresent',
      'privilegedMembership',
      'runtimeCanAssumeMigrator',
    ].some((k) => observed[k] !== false)
  )
    throw new Error();
  if (
    kind === 'runtime' &&
    ['databaseCreate', 'businessCreate', 'businessDdlControl'].some((k) => observed[k] !== false)
  )
    throw new Error();
  let capabilities: Record<string, boolean> | null = null;
  let defaultAcls: Awaited<ReturnType<typeof notificationDefaultAcls>> | null = null;
  let catalog: { count: number; sha256: string } | null = null;
  if (kind === 'migrator') {
    await notificationRole(client);
    const caps = (
      await client.query<Record<string, boolean>>(`select
      has_schema_privilege(current_user,'identity','USAGE') and has_schema_privilege(current_user,'identity','CREATE') as identity,
      has_schema_privilege(current_user,'notifications','USAGE') and has_schema_privilege(current_user,'notifications','CREATE') as notifications,
      has_schema_privilege(current_user,'support','USAGE') and has_schema_privilege(current_user,'support','CREATE') as support,
      has_language_privilege(current_user,'plpgsql','USAGE') as plpgsql,has_function_privilege(current_user,'pg_catalog.gen_random_uuid()','EXECUTE') as uuid,
      has_table_privilege(current_user,'public.schema_migrations','SELECT') and has_table_privilege(current_user,'public.schema_migrations','INSERT') as ledger,
      (select bool_and(pg_has_role(current_user,c.relowner,'USAGE')) from pg_class c where c.oid in
       ('notifications.deliveries'::regclass,'support.tickets'::regclass,'support.messages'::regclass)) as owners,
      has_column_privilege(current_user,'identity.local_email_credentials','tenant_id','REFERENCES') and has_column_privilege(current_user,'identity.local_email_credentials','id','REFERENCES') and has_column_privilege(current_user,'identity.local_email_credentials','user_id','REFERENCES') as credentials,
      has_column_privilege(current_user,'identity.tenants','id','REFERENCES') as tenants,
      has_column_privilege(current_user,'identity.users','tenant_id','REFERENCES') and has_column_privilege(current_user,'identity.users','id','REFERENCES') as users,
      has_column_privilege(current_user,'notifications.templates','tenant_id','REFERENCES') and has_column_privilege(current_user,'notifications.templates','id','REFERENCES') as templates,
      has_column_privilege(current_user,'notifications.intents','tenant_id','REFERENCES') and has_column_privilege(current_user,'notifications.intents','id','REFERENCES') as intents,
      has_column_privilege(current_user,'support.tickets','tenant_id','REFERENCES') and has_column_privilege(current_user,'support.tickets','id','REFERENCES') as tickets`)
    ).rows;
    if (caps.length !== 1) throw new Error();
    capabilities = caps[0]!;
    if (Object.values(capabilities).some((v) => v !== true)) throw new Error();
    defaultAcls = await notificationDefaultAcls(client);
    validateNotificationDefaults(defaultAcls);
    const rows = (
      await client.query<{ filename: string; checksum: string }>(
        'select filename,checksum from public.schema_migrations order by filename',
      )
    ).rows;
    const count = notificationLedgerCheckpoint(rows);
    if (count !== (phase === 'pre' ? 102 : 105)) throw new Error();
    await verifyNotificationCatalog(client, count);
    catalog = { count, sha256: catalogDigest(await notificationCatalog(client)) };
  }
  if (phase === 'post') await verifyNotificationTableSecurity(client, NOTIFICATION_NEW_TABLES);
  await client.query('rollback');
  process.stdout.write(
    `${JSON.stringify({ schema: 'PHUB_NOTIFICATION_MIGRATION_ROLE_READBACK_V1', kind, phase, wireRoleName, ...identity[0], capabilities, defaultAcls, catalog })}\n`,
  );
} catch {
  process.stderr.write('NOTIFICATION_ROLE_PROOF_UNKNOWN\n');
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
