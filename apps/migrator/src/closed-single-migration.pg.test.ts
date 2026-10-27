import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import frozen from '../../../deploy/timeweb/notification-migration-catalogs.v1.json';
import {
  NOTIFICATION_CATALOG_SQL,
  NOTIFICATION_NEW_TABLES,
} from '../../../scripts/notification-migration-catalog.js';
import { closedNewTables } from './closed-single-migration.js';
import { ownedClosedSchemaLocalFixtureUrl } from '../../../scripts/owned-closed-schema-test-target.js';

const root = resolve(import.meta.dirname, '../../..');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function disposableTarget(): string | undefined {
  if (process.env.CLOSED_SINGLE_MIGRATION_PG_TESTS !== '1') return undefined;
  const raw = process.env.CLOSED_SINGLE_MIGRATION_DATABASE_URL;
  if (!raw) throw Error('CLOSED_SINGLE_TEST_DATABASE_REQUIRED');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.search ||
    url.hash
  )
    throw Error('CLOSED_SINGLE_TEST_TARGET');
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.APP_ENV === 'ci' && url.port === '5432')
    return url.toString();
  return ownedClosedSchemaLocalFixtureUrl(process.env);
}
const disposable = disposableTarget();
const ident = (value: string) => {
  if (!/^[a-z_][a-z0-9_.]*$/.test(value)) throw Error('CLOSED_SINGLE_TEST_IDENTIFIER');
  return value;
};
const roleName = (value: string) => {
  const names: Record<string, string> = {
    MIGRATOR: 'phub_migrator',
    RUNTIME: 'phub_runtime',
    PUBLIC: 'PUBLIC',
    phub_beta: 'phub_beta',
  };
  const name = names[value];
  if (!name) throw Error('CLOSED_SINGLE_TEST_ROLE');
  return name;
};
const rolePasswords = {
  phub_beta: 'synthetic_beta_only',
  phub_migrator: 'synthetic_migrator_only',
  phub_runtime: 'synthetic_runtime_only',
};

(disposable ? describe.sequential : describe.skip)(
  'fixed application migration modes on owned PG16',
  () => {
    it('fences ordinary paths and applies only one exact step with bounded rollback and ACL preservation', async () => {
      const admin = new Pool({ connectionString: disposable, max: 2 });
      const database = `closed_single_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const directory = await mkdtemp(resolve(tmpdir(), 'closed-single-pg-'));
      const ownedRoles: string[] = [];
      let created = false;
      let db: Pool | undefined;
      try {
        expect(
          (
            await admin.query<{ major: number }>(
              "select current_setting('server_version_num')::int/10000 as major",
            )
          ).rows[0]?.major,
        ).toBe(16);
        for (const [role, password] of Object.entries(rolePasswords)) {
          const present = (await admin.query('select 1 from pg_roles where rolname=$1', [role]))
            .rowCount;
          if (present === 0) {
            await admin.query(
              `create role ${role} login password '${password}' nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
            );
            ownedRoles.push(role);
          }
        }
        await admin.query(`create database ${database}`);
        created = true;
        const adminUrl = new URL(disposable!);
        adminUrl.pathname = '/' + database;
        db = new Pool({ connectionString: adminUrl.toString(), max: 2 });
        const client = await db.connect();
        try {
          await client.query(
            'create table public.schema_migrations(filename text primary key,checksum text not null,applied_at timestamptz not null default now())',
          );
          const source = resolve(root, 'packages/database/migrations');
          const files = (await readdir(source)).filter((x) => x.endsWith('.sql')).sort();
          for (const filename of files.slice(0, 106)) {
            const sql = await readFile(resolve(source, filename), 'utf8');
            await client.query('begin');
            try {
              await client.query(sql);
              await client.query(
                'insert into public.schema_migrations(filename,checksum) values($1,$2)',
                [filename, hash(sql)],
              );
              await client.query('commit');
            } catch (error) {
              await client.query('rollback');
              throw error;
            }
          }
          // Restore the independent105 golden ownership/ACL baseline without copying business data.
          const rows = frozen.checkpoints['105'].rows;
          for (const row of rows) {
            const value = JSON.parse(row.value) as { owner: string };
            if (row.key.startsWith('relation:') || row.key.startsWith('parent:')) {
              const name = row.key.startsWith('relation:')
                ? row.key.slice(9)
                : row.key.split(':')[1]!;
              await client.query(`alter table ${ident(name)} owner to ${roleName(value.owner)}`);
            }
          }
          for (const row of rows) {
            const value = JSON.parse(row.value) as {
              owner: string;
              acl?: [string, string, string, boolean][];
            };
            if (row.key.startsWith('relation:'))
              for (const [grantee, , privilege, grantable] of value.acl ?? []) {
                if (roleName(grantee) === roleName(value.owner)) continue;
                if (
                  ![
                    'SELECT',
                    'INSERT',
                    'UPDATE',
                    'DELETE',
                    'REFERENCES',
                    'TRIGGER',
                    'TRUNCATE',
                  ].includes(privilege) ||
                  grantable
                )
                  throw Error('CLOSED_SINGLE_TEST_GRANT');
                await client.query(
                  `grant ${privilege} on ${ident(row.key.slice(9))} to ${roleName(grantee)}`,
                );
              }
            if (row.key.startsWith('column:'))
              for (const [grantee, , privilege, grantable] of value.acl ?? []) {
                if (privilege !== 'REFERENCES' || grantable)
                  throw Error('CLOSED_SINGLE_TEST_COLUMN_GRANT');
                const [, relation, column] = row.key.split(':');
                await client.query(
                  `grant references (${ident(column!)}) on ${ident(relation!)} to ${roleName(grantee)}`,
                );
              }
            if (row.key.startsWith('function:')) {
              const name = row.key.slice(9);
              if (!/^[a-z_.]+\(\)$/.test(name)) throw Error('CLOSED_SINGLE_TEST_FUNCTION');
              await client.query(`alter function ${name} owner to ${roleName(value.owner)}`);
            }
          }
          await client.query(`alter table public.schema_migrations owner to phub_migrator;
          grant usage on schema public,identity,profile,notifications,support,games,locations to phub_migrator,phub_runtime;
          grant execute on function pg_catalog.pg_control_system() to phub_migrator,phub_runtime;
          alter default privileges for role phub_migrator in schema identity grant select,insert,update,delete on tables to phub_runtime`);
          await client.query("set search_path='pg_catalog'");
          const baseline = (
            await client.query(NOTIFICATION_CATALOG_SQL, [[...NOTIFICATION_NEW_TABLES]])
          ).rows;
          expect(hash(`${JSON.stringify(baseline)}\n`)).toBe(frozen.checkpoints['105'].sha256);
        } finally {
          client.release();
        }
        await symlink(
          resolve(root, 'packages/database/migrations'),
          resolve(directory, 'migrations'),
        );
        const roleUrl = new URL(adminUrl);
        roleUrl.username = 'phub_migrator';
        roleUrl.password = rolePasswords.phub_migrator;
        const target = (
          await db.query<{ databaseName: string; systemIdentifier: string }>(
            'select current_database() as "databaseName",system_identifier::text as "systemIdentifier" from pg_control_system()',
          )
        ).rows[0]!;
        const encoded = Buffer.from(JSON.stringify(target)).toString('base64');
        const main = 'apps/migrator/src/main.ts',
          game = ['--game-start-migration-0103', encoded],
          subject = ['--subject-link-migration-0104', encoded];
        const cli = (entry: string, args: string[] = [], cwd = directory) =>
          promisify(execFile)(
            process.execPath,
            [
              '--import',
              resolve(root, 'node_modules/tsx/dist/loader.mjs'),
              resolve(root, entry),
              ...args,
            ],
            {
              cwd,
              timeout: 45000,
              maxBuffer: 200000,
              env: {
                PATH: process.env.PATH ?? '',
                DATABASE_URL: roleUrl.toString(),
                TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.json'),
                MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '10000',
              },
            },
          );
        const denied = async (code: string, entry = main, args: string[] = [], cwd = directory) => {
          await expect(cli(entry, args, cwd)).rejects.toMatchObject({
            stderr: expect.stringContaining(code) as unknown,
          });
        };
        const count = async () =>
          (await db!.query<{ n: number }>('select count(*)::int n from public.schema_migrations'))
            .rows[0]!.n;
        const catalog = async () =>
          (
            await db!.query<{ key: string; value: string }>(NOTIFICATION_CATALOG_SQL, [
              [...NOTIFICATION_NEW_TABLES, ...closedNewTables],
            ])
          ).rows;
        const acls = async () =>
          JSON.stringify(
            (
              await db!
                .query(`select 'schema:'||nspname item,coalesce(nspacl::text,'') acl from pg_namespace where nspname in ('identity','notifications') union all
        select 'column:'||attrelid::regclass::text||':'||attname,coalesce(attacl::text,'') from pg_attribute where attrelid in ('identity.tenants'::regclass,'identity.users'::regclass,'games.games'::regclass) and attnum>0 and not attisdropped union all
        select 'default:'||coalesce(n.nspname,'GLOBAL'),d.defaclacl::text from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where d.defaclrole='phub_migrator'::regrole order by item`)
            ).rows,
          );
        const pre = await catalog(),
          aclPreimage = await acls();
        await denied('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
        await denied(
          'CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED',
          'scripts/migrate.ts',
          [],
          root,
        );
        await denied('CLOSED_APPLICATION_MIGRATION_LEDGER', main, subject);
        await denied('CLOSED_APPLICATION_MIGRATION_TARGET', main, [
          '--game-start-migration-0103',
          Buffer.from(JSON.stringify({ ...target, systemIdentifier: '1' })).toString('base64'),
        ]);
        await denied('permission denied', main, game);
        expect(await count()).toBe(106);
        expect(await catalog()).toEqual(pre);
        await db.query(
          'grant create on schema notifications to phub_migrator;grant references(id) on identity.tenants to phub_migrator;grant references(tenant_id,id) on identity.users,games.games to phub_migrator',
        );
        const blocker = await db.connect(),
          started = Date.now();
        try {
          await blocker.query(
            'begin;lock table notifications.scenario_runs in access exclusive mode',
          );
          await denied('lock timeout', main, game);
        } finally {
          await blocker.query('rollback');
          blocker.release();
        }
        expect(Date.now() - started).toBeLessThan(20000);
        expect(await count()).toBe(106);
        expect(await catalog()).toEqual(pre);
        expect((await cli(main, game)).stdout.trim()).toBe(
          'Applied 0103_game_start_notification_scenarios.sql',
        );
        expect(await count()).toBe(107);
        expect(
          (
            await db.query<{ relation: string | null }>(
              "select to_regclass('identity.external_subject_link_commands') as relation",
            )
          ).rows[0]?.relation,
        ).toBeNull();
        await db.query(
          'revoke create on schema notifications from phub_migrator;revoke references(id) on identity.tenants from phub_migrator;revoke references(tenant_id,id) on identity.users,games.games from phub_migrator',
        );
        expect(await acls()).toBe(aclPreimage);
        await denied('CLOSED_APPLICATION_MIGRATION_LEDGER', main, game);
        await denied('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
        await db.query(
          'alter table notifications.legacy_game_reminder_sources disable row level security',
        );
        await denied('CLOSED_APPLICATION_MIGRATION_CATALOG', main, subject);
        await db.query(
          'alter table notifications.legacy_game_reminder_sources enable row level security',
        );
        await db.query(
          'grant create on schema identity to phub_migrator;grant references(tenant_id,id) on identity.users to phub_migrator',
        );
        expect((await cli(main, subject)).stdout.trim()).toBe(
          'Applied 0104_identity_external_subject_link_commands.sql',
        );
        expect(await count()).toBe(108);
        await db.query(
          'revoke create on schema identity from phub_migrator;revoke references(tenant_id,id) on identity.users from phub_migrator',
        );
        expect(await acls()).toBe(aclPreimage);
        expect(
          (
            await db.query<{ access: boolean }>(
              `select exists(select 1 from unnest($1::text[]) t(name) cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege) where has_table_privilege('phub_runtime',name,privilege)) as access`,
              [[...closedNewTables]],
            )
          ).rows[0]?.access,
        ).toBe(false);
        await denied('CLOSED_APPLICATION_MIGRATION_LEDGER', main, subject);
      } finally {
        await db?.end();
        if (created) await admin.query(`drop database ${database} with(force)`);
        for (const role of ownedRoles.reverse()) await admin.query(`drop role ${role}`);
        await admin.end();
        await rm(directory, { recursive: true, force: true });
      }
    }, 120000);
  },
);
