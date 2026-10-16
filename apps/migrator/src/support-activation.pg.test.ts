import { resolve } from 'node:path';
import { Client } from 'pg';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  readSupportPackagedMigrations,
  runSupportActivation,
  supportLedgerSha256,
  SUPPORT_ACTIVATION_CONFIRMATION,
  type SupportActivationBinding,
  type SupportActivationClient,
} from './support-activation-runner.js';
import {
  openSupportTicketRuntimePool,
  SUPPORT_DATABASE_OWNER_ROLE,
  inspectSupportRuntimePrivilegeInventory,
  assertSupportRuntimePrivilegeInventory,
} from '@phub/database/support-activation';
const connectionString = process.env.SUPPORT_ACTIVATION_PG_URL;
const authorized = process.env.SUPPORT_ACTIVATION_PG_WRITES === 'AUTHORIZED';
const runtime = 'support_fixture_activation';
const ownerName = SUPPORT_DATABASE_OWNER_ROLE;
const packaged = await readSupportPackagedMigrations(resolve('packages/database/migrations'));
function assertAuthority() {
  if (!authorized || !connectionString) throw new Error('SUPPORT_ACTIVATION_PG_AUTHORITY');
  const url = new URL(connectionString);
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '65439' ||
    url.pathname !== '/phub_support_activation_verify' ||
    url.username !== 'fixture_admin' ||
    url.search ||
    url.hash
  )
    throw new Error('SUPPORT_ACTIVATION_PG_TARGET');
}
describe.skipIf(!authorized || !connectionString)(
  'support activation PostgreSQL16 owned fixture',
  () => {
    let admin: Client;
    let systemIdentifier: string;
    const binding = (count: 99 | 101): SupportActivationBinding => ({
      schema: 'PHUB_SUPPORT_DATABASE_ACTIVATION_V1',
      executorKind: 'EXISTING_PRIVILEGED_BOOTSTRAP',
      bootstrapRoleName: 'fixture_admin',
      databaseHost: '127.0.0.1',
      databasePort: '65439',
      databaseName: 'phub_support_activation_verify',
      systemIdentifier,
      runtimeRoleName: runtime,
      migratorRoleName: ownerName,
      preLedgerCount: count,
      preLedgerSha256: supportLedgerSha256(packaged.slice(0, count)),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      confirmation: SUPPORT_ACTIVATION_CONFIRMATION,
    });
    const ledger = async () =>
      (
        await admin.query<{ filename: string; checksum: string }>(
          'select filename,checksum from public.schema_migrations order by filename',
        )
      ).rows;
    const inject =
      (needle: string) =>
      (url: string): SupportActivationClient => {
        const client = new Client({ connectionString: url });
        const original = client.query.bind(client);
        return {
          connect: () => client.connect(),
          end: () => client.end(),
          query: (async (sql: string, values?: unknown[]) => {
            const result = await original(sql, values);
            if (sql.includes(needle)) throw new Error('SYNTHETIC_POST_QUERY_FAILURE');
            return result;
          }) as unknown as SupportActivationClient['query'],
        };
      };
    beforeAll(async () => {
      assertAuthority();
      admin = new Client({ connectionString });
      await admin.connect();
      const initial = (
        await admin.query<{
          systemIdentifier: string;
          ledger: string | null;
          namespaces: number;
          version: number;
        }>(`select (select system_identifier::text from pg_control_system()) as "systemIdentifier",to_regclass('public.schema_migrations')::text as ledger,
   (select count(*)::int from pg_namespace where nspname not in ('public','information_schema') and left(nspname,3)<>'pg_') as namespaces,current_setting('server_version_num')::int as version`)
      ).rows[0];
      if (
        !initial ||
        initial.ledger !== null ||
        initial.namespaces !== 0 ||
        initial.version < 160000 ||
        initial.version >= 170000
      )
        throw Error('SUPPORT_ACTIVATION_PG_NOT_FRESH');
      systemIdentifier = initial.systemIdentifier;
      await admin.query('begin');
      try {
        await admin.query(
          'create table public.schema_migrations(filename text primary key,checksum text not null,applied_at timestamptz not null default now())',
        );
        for (const migration of packaged.slice(0, 99)) {
          await admin.query(migration.sql);
          await admin.query(
            'insert into public.schema_migrations(filename,checksum) values($1,$2)',
            [migration.filename, migration.checksum],
          );
        }
        const roles = (
          await admin.query<{ name: string; login: boolean; unsafe: boolean; memberships: number }>(
            `select rolname as name,rolcanlogin as login,(rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication) as unsafe,
            (select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid) as memberships
            from pg_roles r where rolname=any($1::text[])`,
            [[ownerName, runtime]],
          )
        ).rows;
        if (
          roles.length !== 2 ||
          roles.some(
            (row) => row.unsafe || row.memberships !== 0 || row.login !== (row.name === runtime),
          )
        )
          throw Error('SUPPORT_ACTIVATION_PG_ROLE_PRECONDITION');
        await admin.query(
          `grant create on database phub_support_activation_verify to "${ownerName}"`,
        );
        await admin.query(`grant usage on schema identity to "${ownerName}"`);
        await admin.query(`grant references(id) on identity.tenants to "${ownerName}"`);
        await admin.query(`grant references(tenant_id,id) on identity.users to "${ownerName}"`);
        await admin.query('commit');
      } catch (error) {
        await admin.query('rollback');
        throw error;
      }
    }, 60000);
    afterAll(async () => {
      await admin?.end();
    });
    it('separates compatibility 99→101 and refuses to run support migration at99', async () => {
      await expect(
        runSupportActivation('migrate', binding(99), connectionString!, packaged),
      ).rejects.toThrow('PRECONDITION');
      expect((await ledger()).length).toBe(99);
      const result = await runSupportActivation(
        'compatibility',
        binding(99),
        connectionString!,
        packaged,
      );
      expect(result.ledgerCount).toBe(101);
      expect(
        (
          await admin.query<{ schema: string | null }>(
            "select to_regnamespace('support')::text as schema",
          )
        ).rows[0].schema,
      ).toBeNull();
    });
    it('rolls back schema creation and ledger after post-DDL failure', async () => {
      await expect(
        runSupportActivation(
          'migrate',
          binding(101),
          connectionString!,
          packaged,
          inject('create schema if not exists support'),
        ),
      ).rejects.toThrow('SYNTHETIC_POST_QUERY_FAILURE');
      expect((await ledger()).length).toBe(101);
      expect(
        (
          await admin.query<{ schema: string | null }>(
            "select to_regnamespace('support')::text as schema",
          )
        ).rows[0].schema,
      ).toBeNull();
    });
    it('bounds a real identity-table lock and rolls back 0098 on lock timeout', async () => {
      const blocker = new Client({ connectionString });
      await blocker.connect();
      await blocker.query('begin');
      await blocker.query('lock table identity.users in access exclusive mode');
      const start = Date.now();
      try {
        await expect(
          runSupportActivation('migrate', binding(101), connectionString!, packaged),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await blocker.query('rollback');
        await blocker.end();
      }
      expect(Date.now() - start).toBeLessThan(10000);
      expect((await ledger()).length).toBe(101);
      expect(
        (
          await admin.query<{ schema: string | null }>(
            "select to_regnamespace('support')::text as schema",
          )
        ).rows[0].schema,
      ).toBeNull();
    }, 15000);
    it('applies only0098 as NOLOGIN support owner and writes ledger using explicit bootstrap', async () => {
      const result = await runSupportActivation(
        'migrate',
        binding(101),
        connectionString!,
        packaged,
      );
      expect(result.ledgerCount).toBe(102);
      const ownership = (
        await admin.query<{ nspname: string; owner: string }>(
          "select n.nspname,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid in ('support.tickets'::regclass,'profile.contacts'::regclass,'identity.local_email_credentials'::regclass) order by n.nspname",
        )
      ).rows;
      expect(ownership.find((row) => row.nspname === 'support')?.owner).toBe(ownerName);
      expect(
        ownership
          .filter((row) => row.nspname !== 'support')
          .every((row) => row.owner === 'fixture_admin'),
      ).toBe(true);
    });
    it('rolls back partially applied dependency grants before a later ACL failure', async () => {
      await expect(
        runSupportActivation(
          'acl',
          binding(101),
          connectionString!,
          packaged,
          inject('grant usage on schema identity'),
        ),
      ).rejects.toThrow('SYNTHETIC_POST_QUERY_FAILURE');
      assertSupportRuntimePrivilegeInventory(
        await inspectSupportRuntimePrivilegeInventory(admin, runtime),
        'pre',
      );
      expect(
        (
          await admin.query<{ allowed: boolean }>(
            "select has_column_privilege($1,'identity.user_access_profiles','permissions','UPDATE') as allowed",
            [runtime],
          )
        ).rows[0].allowed,
      ).toBe(false);
    });
    it('commits exact ACL and proves a real restricted LOGIN startup without granting identity permission writes', async () => {
      await runSupportActivation('acl', binding(101), connectionString!, packaged);
      await runSupportActivation('verify', binding(101), connectionString!, packaged);
      const supportUrl = new URL(connectionString!);
      supportUrl.username = runtime;
      supportUrl.password = 'synthetic-local-support-fixture';
      const pool = await openSupportTicketRuntimePool(connectionString!, supportUrl.toString());
      expect(pool).toBeDefined();
      try {
        const client = await pool!.connect();
        try {
          expect(
            (await client.query<{ current_user: string }>('select current_user')).rows[0]
              .current_user,
          ).toBe(runtime);
          for (const [table, column] of [
            ['identity.users', 'status'],
            ['identity.user_access_profiles', 'permissions'],
            ['identity.user_access_profiles', 'roles'],
          ])
            expect(
              (
                await client.query<{ allowed: boolean }>(
                  "select has_column_privilege(current_user,$1,$2,'UPDATE') as allowed",
                  [table, column],
                )
              ).rows[0].allowed,
            ).toBe(false);
          expect(
            (
              await client.query<{ total: number }>(
                'select count(*)::int as total from support.tickets',
              )
            ).rows[0].total,
          ).toBe(0);
        } finally {
          client.release();
        }
      } finally {
        await pool?.end();
      }
    });
  },
);
