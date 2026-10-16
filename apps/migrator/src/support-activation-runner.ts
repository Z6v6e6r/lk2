import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, type PoolClient } from 'pg';
import { assertMigrationExecutionAllowed, assertMigrationLedgerCompatible } from '@phub/database';
import {
  assertSupportRuntimePrerequisites,
  inspectSupportRuntimePrerequisites,
  assertSupportTicketAclBoundary,
  inspectSupportTicketAclBoundary,
  assertSupportTicketAclProvisioningBoundary,
  supportTicketRuntimeGrantStatements,
  supportRuntimePrerequisiteGrantStatements,
  assertSupportRuntimePrivilegeInventory,
  inspectSupportRuntimePrivilegeInventory,
  SUPPORT_DATABASE_OWNER_ROLE,
  assertSupportOwnerObjectBoundary,
} from '@phub/database/support-activation';

export const SUPPORT_ACTIVATION_LEDGER_SHA256 =
  'b9bfd91a3985de51b323d9955325b5edabc22b42cfc350bddebe811ca42c2f85';
export const SUPPORT_ACTIVATION_CONFIRMATION = 'ACTIVATE_SUPPORT_0098_V1';
export type SupportActivationMode = 'preflight' | 'compatibility' | 'migrate' | 'acl' | 'verify';
type Ledger = readonly { readonly filename: string; readonly checksum: string }[];
export interface SupportActivationBinding {
  readonly schema: 'PHUB_SUPPORT_DATABASE_ACTIVATION_V1';
  readonly executorKind: 'EXISTING_PRIVILEGED_BOOTSTRAP';
  readonly bootstrapRoleName: string;
  readonly databaseHost: string;
  readonly databasePort: string;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly runtimeRoleName: string;
  readonly migratorRoleName: string;
  readonly preLedgerCount: 99 | 101;
  readonly preLedgerSha256: string;
  readonly expiresAt: string;
  readonly confirmation: string;
}
export type SupportActivationClient = Pick<PoolClient, 'query'> & {
  connect(): Promise<unknown>;
  end(): Promise<void>;
};
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export const supportLedgerSha256 = (ledger: Ledger): string =>
  sha256(`${JSON.stringify(ledger.map((row) => [row.filename, row.checksum]))}\n`);
const fail = (code: string): never => {
  throw new Error(`SUPPORT_ACTIVATION_${code}`);
};
const role = /^[a-z_][a-z0-9_]{0,62}$/;
export function validateSupportActivationBinding(
  binding: SupportActivationBinding,
  at = Date.now(),
): void {
  const keys = [
    'schema',
    'executorKind',
    'bootstrapRoleName',
    'databaseHost',
    'databasePort',
    'databaseName',
    'systemIdentifier',
    'runtimeRoleName',
    'migratorRoleName',
    'preLedgerCount',
    'preLedgerSha256',
    'expiresAt',
    'confirmation',
  ];
  if (
    !binding ||
    Object.keys(binding).sort().join(',') !== keys.sort().join(',') ||
    binding.schema !== 'PHUB_SUPPORT_DATABASE_ACTIVATION_V1' ||
    binding.executorKind !== 'EXISTING_PRIVILEGED_BOOTSTRAP' ||
    !role.test(binding.bootstrapRoleName) ||
    !['postgres', '127.0.0.1', 'localhost'].includes(binding.databaseHost) ||
    !/^[1-9][0-9]{0,4}$/.test(binding.databasePort) ||
    Number(binding.databasePort) > 65535 ||
    !role.test(binding.databaseName) ||
    !/^[0-9]{1,20}$/.test(binding.systemIdentifier) ||
    !role.test(binding.runtimeRoleName) ||
    !role.test(binding.migratorRoleName) ||
    binding.runtimeRoleName === binding.migratorRoleName ||
    binding.migratorRoleName !== SUPPORT_DATABASE_OWNER_ROLE ||
    binding.bootstrapRoleName === binding.runtimeRoleName ||
    binding.bootstrapRoleName === binding.migratorRoleName ||
    ![99, 101].includes(binding.preLedgerCount) ||
    !/^[a-f0-9]{64}$/.test(binding.preLedgerSha256) ||
    !Number.isFinite(Date.parse(binding.expiresAt)) ||
    new Date(binding.expiresAt).toISOString() !== binding.expiresAt ||
    Date.parse(binding.expiresAt) <= at ||
    Date.parse(binding.expiresAt) - at > 4 * 60 * 60 * 1000 ||
    binding.confirmation !== SUPPORT_ACTIVATION_CONFIRMATION
  )
    fail('BINDING');
}
export function assertSupportActivationLedger(
  ledger: Ledger,
  packaged: Ledger,
  phase: 'pre' | 'post',
  binding: SupportActivationBinding,
): void {
  assertMigrationLedgerCompatible({ applied: ledger, packaged });
  if (
    packaged.length !== 102 ||
    supportLedgerSha256(packaged) !== SUPPORT_ACTIVATION_LEDGER_SHA256 ||
    ledger.length !== (phase === 'pre' ? binding.preLedgerCount : 102) ||
    supportLedgerSha256(ledger) !==
      (phase === 'pre' ? binding.preLedgerSha256 : SUPPORT_ACTIVATION_LEDGER_SHA256) ||
    supportLedgerSha256(ledger) !== supportLedgerSha256(packaged.slice(0, ledger.length))
  )
    fail('LEDGER');
}
export async function readSupportPackagedMigrations(directory: string) {
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      return { filename, sql, checksum: sha256(sql) };
    }),
  );
}
/** Bootstrap is explicitly privileged; it is not a bounded migrator credential.
 * Roles/passwords are pre-enrolled separately. This command cannot create roles or operator grants. */
export const supportActivationBindingSha256 = (binding: SupportActivationBinding): string =>
  sha256(
    `${JSON.stringify(Object.fromEntries(Object.entries(binding).sort(([a], [b]) => a.localeCompare(b))))}\n`,
  );
export async function runSupportActivation(
  mode: SupportActivationMode,
  binding: SupportActivationBinding,
  connectionString: string,
  migrations: readonly {
    readonly filename: string;
    readonly checksum: string;
    readonly sql: string;
  }[],
  createClient: (connectionString: string) => SupportActivationClient = (url) =>
    new Client({
      connectionString: url,
      application_name: 'phub-support-activation',
      connectionTimeoutMillis: 5000,
      query_timeout: 125000,
      statement_timeout: 120000,
      lock_timeout: 5000,
    }),
) {
  validateSupportActivationBinding(binding);
  if (!['preflight', 'compatibility', 'migrate', 'acl', 'verify'].includes(mode)) fail('MODE');
  if (
    (mode === 'compatibility' && binding.preLedgerCount !== 99) ||
    (mode === 'migrate' && binding.preLedgerCount !== 101)
  )
    fail('PRECONDITION');
  const url = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== binding.databaseHost ||
    (url.port || '5432') !== binding.databasePort ||
    decodeURIComponent(url.pathname) !== `/${binding.databaseName}` ||
    decodeURIComponent(url.username) !== binding.bootstrapRoleName ||
    url.search ||
    url.hash
  )
    fail('CONNECTION');
  const client = createClient(connectionString);
  await client.connect();
  let open = false;
  const mutating = ['compatibility', 'migrate', 'acl'].includes(mode);
  try {
    await client.query(
      mutating ? 'begin' : 'begin transaction isolation level repeatable read read only',
    );
    open = true;
    await client.query("set local search_path = 'pg_catalog'");
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '120s'");
    if (mutating) await client.query('select pg_advisory_xact_lock($1)', [7140221]);
    const identity = (
      await client.query<{
        databaseName: string;
        systemIdentifier: string;
        roleName: string;
        sessionRole: string;
        recovery: boolean;
      }>(
        `select current_database() as "databaseName",(select system_identifier::text from pg_control_system()) as "systemIdentifier",
       current_user as "roleName",session_user as "sessionRole",pg_is_in_recovery() as recovery`,
      )
    ).rows[0];
    if (
      !identity ||
      identity.databaseName !== binding.databaseName ||
      identity.systemIdentifier !== binding.systemIdentifier ||
      identity.roleName !== binding.bootstrapRoleName ||
      identity.sessionRole !== binding.bootstrapRoleName ||
      identity.recovery
    )
      fail('IDENTITY');
    const roles = (
      await client.query<{
        name: string;
        login: boolean;
        unsafe: boolean;
        membershipCount: number;
      }>(
        `select rolname as name,rolcanlogin as login,(rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication) as unsafe,
       (select count(*)::integer from pg_auth_members where member=r.oid or roleid=r.oid) as "membershipCount"
       from pg_roles r where rolname=any($1::text[])`,
        [[binding.runtimeRoleName, binding.migratorRoleName]],
      )
    ).rows;
    if (
      roles.length !== 2 ||
      roles.some(
        (row) =>
          row.unsafe ||
          row.membershipCount !== 0 ||
          row.login !== (row.name === binding.runtimeRoleName),
      )
    )
      fail('ROLE_BOUNDARY');
    await assertSupportOwnerObjectBoundary(
      client,
      binding.migratorRoleName,
      mode === 'acl' || mode === 'verify' ? 'post' : 'pre',
    );
    const readLedger = async () =>
      (
        await client.query<{ filename: string; checksum: string }>(
          'select filename,checksum from public.schema_migrations order by filename',
        )
      ).rows;
    const ledger = await readLedger();
    assertSupportActivationLedger(
      ledger,
      migrations,
      mode === 'verify' || mode === 'acl' ? 'post' : 'pre',
      binding,
    );
    if (mode === 'preflight' || mode === 'compatibility' || mode === 'migrate') {
      const namespace = (
        await client.query<{ present: boolean }>(
          "select to_regnamespace('support') is not null as present",
        )
      ).rows[0];
      if (!namespace || namespace.present) fail('NAMESPACE_DRIFT');
      assertSupportRuntimePrivilegeInventory(
        await inspectSupportRuntimePrivilegeInventory(client, binding.runtimeRoleName),
        'pre',
      );
    }
    if (mode === 'compatibility' || mode === 'migrate') {
      assertMigrationExecutionAllowed({
        appliedFilenames: new Set(ledger.map((row) => row.filename)),
        packagedFilenames: migrations.map((row) => row.filename),
      });
      const tail =
        mode === 'compatibility' ? migrations.slice(99, 101) : migrations.slice(101, 102);
      const defaults = (
        await client.query<{ unsafe: boolean }>(
          `select exists(select 1 from pg_default_acl d
        where d.defaclrole=$1::regrole and ($2::boolean or exists(select 1 from aclexplode(d.defaclacl) g where g.grantee<>d.defaclrole))) as unsafe`,
          [
            mode === 'migrate' ? binding.migratorRoleName : binding.bootstrapRoleName,
            mode === 'migrate',
          ],
        )
      ).rows[0];
      if (!defaults || defaults.unsafe) fail('DEFAULT_ACL');
      if (mode === 'migrate') {
        const capability = (
          await client.query<{ ready: boolean }>(
            `select has_database_privilege($1,current_database(),'CREATE') and
          has_schema_privilege($1,'identity','USAGE') and has_column_privilege($1,'identity.tenants','id','REFERENCES') and
          has_column_privilege($1,'identity.users','tenant_id','REFERENCES') and has_column_privilege($1,'identity.users','id','REFERENCES') and
          has_function_privilege($1,'pg_catalog.gen_random_uuid()','EXECUTE') and has_language_privilege($1,'plpgsql','USAGE') as ready`,
            [binding.migratorRoleName],
          )
        ).rows[0];
        if (!capability?.ready) fail('OWNER_CAPABILITY');
      }
      for (const migration of tail) {
        if (Date.now() >= Date.parse(binding.expiresAt)) fail('EXPIRED');
        if (mode === 'migrate') await client.query(`set local role "${binding.migratorRoleName}"`);
        await client.query(migration.sql);
        if (mode === 'migrate') await client.query('reset role');
        await client.query(
          'insert into public.schema_migrations(filename,checksum) values($1,$2)',
          [migration.filename, migration.checksum],
        );
      }
      const post = await readLedger();
      if (mode === 'migrate') {
        assertSupportActivationLedger(post, migrations, 'post', binding);
        await assertSupportOwnerObjectBoundary(client, binding.migratorRoleName, 'post');
        assertSupportRuntimePrivilegeInventory(
          await inspectSupportRuntimePrivilegeInventory(client, binding.runtimeRoleName),
          'pre',
        );
        assertSupportTicketAclProvisioningBoundary(
          await inspectSupportTicketAclBoundary(
            client,
            binding.runtimeRoleName,
            binding.migratorRoleName,
          ),
          { runtimeRoleName: binding.runtimeRoleName, migratorRoleName: binding.migratorRoleName },
        );
      } else if (
        post.length !== 101 ||
        supportLedgerSha256(post) !== supportLedgerSha256(migrations.slice(0, 101))
      )
        fail('LEDGER');
    }
    const expected = {
      runtimeRoleName: binding.runtimeRoleName,
      migratorRoleName: binding.migratorRoleName,
    };
    if (mode === 'acl') {
      assertSupportRuntimePrivilegeInventory(
        await inspectSupportRuntimePrivilegeInventory(client, binding.runtimeRoleName),
        'pre',
      );
      assertSupportTicketAclProvisioningBoundary(
        await inspectSupportTicketAclBoundary(
          client,
          binding.runtimeRoleName,
          binding.migratorRoleName,
        ),
        expected,
      );
      for (const sql of [
        ...supportRuntimePrerequisiteGrantStatements(binding.runtimeRoleName),
        ...supportTicketRuntimeGrantStatements(binding.runtimeRoleName),
      ])
        await client.query(sql);
    }
    if (mode === 'acl' || mode === 'verify') {
      assertSupportTicketAclBoundary(
        await inspectSupportTicketAclBoundary(
          client,
          binding.runtimeRoleName,
          binding.migratorRoleName,
        ),
        expected,
      );
      assertSupportRuntimePrerequisites(
        await inspectSupportRuntimePrerequisites(client, binding.runtimeRoleName),
      );
      assertSupportRuntimePrivilegeInventory(
        await inspectSupportRuntimePrivilegeInventory(client, binding.runtimeRoleName),
      );
    }
    if (mutating && Date.now() >= Date.parse(binding.expiresAt)) fail('EXPIRED');
    await client.query('commit');
    open = false;
    const count =
      mode === 'preflight' ? binding.preLedgerCount : mode === 'compatibility' ? 101 : 102;
    return {
      schema: 'PHUB_SUPPORT_DATABASE_RESULT_V1',
      bindingSha256: supportActivationBindingSha256(binding),
      mode,
      status: 'VERIFIED',
      databaseName: binding.databaseName,
      systemIdentifier: binding.systemIdentifier,
      bootstrapRoleName: binding.bootstrapRoleName,
      ledgerCount: count,
      ledgerSha256: supportLedgerSha256(migrations.slice(0, count)),
      observedAt: new Date().toISOString(),
    };
  } finally {
    if (open) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
