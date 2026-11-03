import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import {
  closedApplicationAclSql,
  closedApplicationAclPlan,
} from '../../../scripts/closed-application-migration-acl.js';
import type { ClosedApplicationAclRow } from '../../../scripts/closed-application-migration-acl.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { PoolClient, QueryConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import original from '../../../deploy/timeweb/notification-migration-catalogs.v1.json';
import reviewed from '../../../deploy/timeweb/r1-tail108-119-catalogs.v1.json';
import closed from '../../../deploy/timeweb/closed-application-migrations-0103-0104.v1.json';
import {
  CLOSED_APPLICATION_CATALOG_SQL,
  CLOSED_APPLICATION_CATALOG_TABLES,
  CLOSED_APPLICATION_EDITOR_ACL,
} from '../../../scripts/closed-application-migration-catalog.js';
import {
  R1_TAIL,
  r1Encode,
  r1Hash,
  r1LedgerCount,
} from '../../../scripts/r1-tail-migration-profile.js';
import type { R1TailCatalogs, R1TailTarget } from '../../../scripts/r1-tail-migration-profile.js';
import { R1_TAIL_CATALOG_SQL, R1_TAIL_TABLES } from '../../../scripts/r1-tail-migration-catalog.js';
import {
  R1_TAIL_ACL_SQL,
  r1TailPreparationPlan,
  r1TailAclTransaction,
} from '../../../scripts/r1-tail-migration-acl.js';
import type { R1AclRow } from '../../../scripts/r1-tail-migration-acl.js';
import { ownedClosedSchemaLocalFixtureUrl } from '../../../scripts/owned-closed-schema-test-target.js';
import { applyR1TailSteps, assertR1TailRole, readR1TailLedger } from './r1-tail-migration.js';
import {
  assessR1RuntimePrivileges,
  r1RuntimePrivilegeQuery,
  r1RuntimePrivilegeRequirements,
} from '../../../scripts/r1-runtime-privilege-audit.js';
import type {
  R1RuntimeComponent,
  R1RuntimePrivilegeCapture,
} from '../../../scripts/r1-runtime-privilege-audit.js';

import {
  R1_RUNTIME_GRANT_CATALOG_SQL,
  planR1RuntimeGrants119,
  r1RuntimeGrantTransaction119,
} from '../../../scripts/r1-runtime-grants119.js';
import type { R1Grant119Capture } from '../../../scripts/r1-runtime-grants119.js';

// This suite is registered by the existing explicit, owned PG16 CI contour.
// No normal DATABASE_URL is accepted. Catalog exports contain pg_catalog metadata only.
function ownedTarget(): string | undefined {
  if (process.env.CLOSED_SINGLE_MIGRATION_PG_TESTS !== '1') return undefined;
  const raw = process.env.CLOSED_SINGLE_MIGRATION_DATABASE_URL;
  if (!raw) throw Error('R1_TAIL_SYNTHETIC_DATABASE_REQUIRED');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.search ||
    url.hash
  )
    throw Error('R1_TAIL_SYNTHETIC_TARGET');
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.APP_ENV === 'ci' && url.port === '5432')
    return url.toString();
  return ownedClosedSchemaLocalFixtureUrl(process.env);
}
const target = ownedTarget();
const rolePasswords = {
  phub_beta: 'synthetic_beta_only',
  phub_migrator: 'synthetic_migrator_only',
  phub_runtime: 'synthetic_runtime_only',
};
const quote = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw Error('R1_TAIL_SYNTHETIC_IDENTIFIER');
  return '"' + name + '"';
};
const qualified = (name: string) => name.split('.').map(quote).join('.');

// pg supports per-query query_timeout; @types/pg exposes it only on ClientConfig.
const cleanupQuery = (
  text: string,
  values: string[] = [],
  timeout = 1000,
): QueryConfig<string[]> & { query_timeout: number } => ({ text, values, query_timeout: timeout });
async function waitForOwnedDatabaseDisconnect(admin: Pool, name: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const remaining = await admin.query<{ count: number }>(
      cleanupQuery(
        'select count(*)::int as count from pg_catalog.pg_stat_activity where datname=$1',
        [name],
      ),
    );
    if (remaining.rows[0]!.count === 0) return;
    if (Date.now() >= deadline) throw Error('R1_TAIL_SYNTHETIC_CONNECTIONS_NOT_CLOSED');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const originalRole = (name: string) =>
  name === 'MIGRATOR' ? 'phub_migrator' : name === 'RUNTIME' ? 'phub_runtime' : name;
type Metadata = { key: string; value: string };
type Point = { sha256: string; rowCount: number };
async function acl(client: Pick<PoolClient, 'query'>): Promise<R1AclRow[]> {
  return (await client.query<{ value: R1AclRow[] }>(`select (${R1_TAIL_ACL_SQL})as value`)).rows[0]!
    .value;
}
async function catalog(client: Pick<PoolClient, 'query'>): Promise<Metadata[]> {
  await client.query("set search_path='pg_catalog'");
  return (await client.query<Metadata>(R1_TAIL_CATALOG_SQL, [R1_TAIL_TABLES])).rows;
}
const point = (rows: Metadata[]): Point => ({
  sha256: r1Hash(r1Encode(rows)),
  rowCount: rows.length,
});
const packaged = await Promise.all(
  R1_TAIL.inventory.map(async (row) => ({
    ...row,
    sql: await readFile(resolve('packages/database/migrations', row.filename), 'utf8'),
  })),
);
const exported: Record<string, Record<string, { prepared: Point; cleaned: Point }>> = {};

(target ? describe.sequential : describe.skip)(
  'fixed R1 tail on explicitly owned synthetic PostgreSQL16',
  () => {
    it.each(['DORMANT', 'SCENARIO_EDITOR_V1'] as const)(
      'rehearses real-role SQL, all partial commits and ACL recovery for%s',
      async (variant) => {
        const admin = new Pool({ connectionString: target, max: 2 });
        const ownedRoles: string[] = [];
        const databases: string[] = [];
        const pools: Pool[] = [];
        const url = (database: string, role?: keyof typeof rolePasswords) => {
          const value = new URL(target!);
          value.pathname = '/' + database;
          if (role) {
            value.username = role;
            value.password = rolePasswords[role];
          }
          return value.toString();
        };
        async function fixture(): Promise<{ name: string; root: Pool; migrator: Pool }> {
          const name = 'r1_tail_' + randomUUID().replaceAll('-', '').slice(0, 20);
          await admin.query(`create database ${quote(name)}`);
          databases.push(name);
          const root = new Pool({ connectionString: url(name), max: 2 });
          pools.push(root);
          const client = await root.connect();
          try {
            await client.query(
              'create table public.schema_migrations(filename text primary key,checksum text not null,applied_at timestamptz not null default now())',
            );
            for (const migration of packaged.slice(0, 106)) {
              await client.query('begin');
              try {
                await client.query(migration.sql);
                await client.query(
                  'insert into public.schema_migrations(filename,checksum)values($1,$2)',
                  [migration.filename, migration.checksum],
                );
                await client.query('commit');
              } catch (error) {
                await client.query('rollback');
                throw error;
              }
            }
            // Reconstruct a source-derived synthetic pre108 owner/ACL fixture, never live data.
            const relations = (
              await client.query<{
                name: string;
              }>(`select n.nspname||'.'||c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where left(n.nspname,3)<>'pg_'and n.nspname<>'information_schema'and c.relkind in('r','p')order by 1`)
            ).rows;
            for (const { name: relation } of relations)
              await client.query(`alter table ${qualified(relation)} owner to phub_beta`);
            const schemas = (
              await client.query<{ name: string }>(
                `select nspname as name from pg_namespace where left(nspname,3)<>'pg_'and nspname not in('information_schema','public')order by 1`,
              )
            ).rows;
            for (const { name: schema } of schemas)
              await client.query(`alter schema ${quote(schema)} owner to phub_beta`);
            for (const row of original.checkpoints['105'].rows) {
              const value = JSON.parse(row.value) as {
                owner?: string;
                acl?: [string, string, string, boolean][];
              };
              if (
                (row.key.startsWith('relation:') || row.key.startsWith('parent:')) &&
                value.owner
              ) {
                const relation = row.key.startsWith('relation:')
                  ? row.key.slice(9)
                  : row.key.split(':')[1]!;
                await client.query(
                  `alter table ${qualified(relation)} owner to ${quote(originalRole(value.owner))}`,
                );
              }
            }
            for (const row of original.checkpoints['105'].rows) {
              const value = JSON.parse(row.value) as {
                owner?: string;
                acl?: [string, string, string, boolean][];
              };
              if (row.key.startsWith('relation:'))
                for (const [grantee, , privilege, grantable] of value.acl ?? []) {
                  if (
                    grantable ||
                    ![
                      'SELECT',
                      'INSERT',
                      'UPDATE',
                      'DELETE',
                      'TRUNCATE',
                      'REFERENCES',
                      'TRIGGER',
                    ].includes(privilege)
                  )
                    throw Error('R1_TAIL_SYNTHETIC_GRANT');
                  if (originalRole(grantee) !== originalRole(value.owner!))
                    await client.query(
                      `grant ${privilege} on ${qualified(row.key.slice(9))} to ${quote(originalRole(grantee))}`,
                    );
                }
              if (row.key.startsWith('column:'))
                for (const [grantee, , privilege, grantable] of value.acl ?? []) {
                  if (privilege !== 'REFERENCES' || grantable)
                    throw Error('R1_TAIL_SYNTHETIC_COLUMN_GRANT');
                  const [, relation, column] = row.key.split(':');
                  await client.query(
                    `grant references(${quote(column!)})on ${qualified(relation!)} to ${quote(originalRole(grantee))}`,
                  );
                }
              if (row.key.startsWith('function:') && value.owner) {
                const fn = row.key.slice(9);
                if (!/^[a-z_.]+\(\)$/.test(fn)) throw Error('R1_TAIL_SYNTHETIC_FUNCTION');
                await client.query(
                  `alter function ${fn} owner to ${quote(originalRole(value.owner))}`,
                );
              }
            }
            await client.query(`alter table public.schema_migrations owner to phub_migrator;
     grant usage on schema public,identity,profile,notifications,support,games,locations,integration,eligibility,booking,commerce to phub_migrator,phub_runtime;
     grant execute on function pg_catalog.pg_control_system()to phub_migrator,phub_runtime;
     alter default privileges for role phub_migrator in schema identity grant select,insert,update,delete on tables to phub_runtime`);
            if (variant === 'SCENARIO_EDITOR_V1') {
              await client.query('set role phub_migrator');
              try {
                for (const [table, privilege] of CLOSED_APPLICATION_EDITOR_ACL)
                  await client.query(`grant ${privilege} on ${qualified(table)} to phub_runtime`);
              } finally {
                await client.query('reset role');
              }
            }
            // Exercise106→107→108 using the actual119 package and existing one-step hooks.
            // Target metadata here identifies only this explicitly owned synthetic database.
            const actualId = (
              await client.query<{ id: string }>(
                'select system_identifier::text as id from pg_catalog.pg_control_system()',
              )
            ).rows[0]!.id;
            const source = resolve('packages/database/migrations'),
              stage = await mkdtemp(resolve(tmpdir(), 'r1-prefix119-'));
            const sourceRoot = process.cwd();
            try {
              await symlink(source, resolve(stage, 'migrations'), 'dir');
              for (const profile of ['game_start_0103', 'subject_link_0104'] as const) {
                const before = (
                  await client.query<{ acl: ClosedApplicationAclRow[] }>(
                    `select (${closedApplicationAclSql(profile)})as acl`,
                  )
                ).rows[0]!.acl;
                const preparation = closedApplicationAclPlan(profile, before);
                await client.query(preparation.bootstrapSql);
                const explicitArgument =
                  profile === 'game_start_0103'
                    ? '--r1-game-start-migration-0103'
                    : '--r1-subject-link-migration-0104';
                const encoded = Buffer.from(
                  JSON.stringify({
                    databaseName: name,
                    systemIdentifier: actualId,
                    catalogVariant: variant,
                  }),
                ).toString('base64');
                await promisify(execFile)(
                  process.execPath,
                  [
                    '--import',
                    resolve(sourceRoot, 'node_modules/tsx/dist/loader.mjs'),
                    resolve(sourceRoot, 'apps/migrator/src/main.ts'),
                    explicitArgument,
                    encoded,
                  ],
                  {
                    cwd: stage,
                    timeout: 45000,
                    maxBuffer: 200000,
                    env: {
                      PATH: process.env.PATH ?? '',
                      DATABASE_URL: url(name, 'phub_migrator'),
                      TSX_TSCONFIG_PATH: resolve(sourceRoot, 'tsconfig.json'),
                    },
                  },
                );
                await client.query(preparation.cleanupSql);
                const rows = (
                  await client.query<{ filename: string; checksum: string }>(
                    'select filename,checksum from public.schema_migrations order by filename',
                  )
                ).rows;
                expect(rows).toHaveLength(profile === 'game_start_0103' ? 107 : 108);
                expect(
                  rows.some((row) => row.filename === '0105_game_create_location_bindings.sql'),
                ).toBe(false);
              }
            } finally {
              await rm(stage, { recursive: true, force: true });
            }
            await client.query("set search_path='pg_catalog'");
            const closedRows = (
              await client.query<Metadata>(CLOSED_APPLICATION_CATALOG_SQL, [
                CLOSED_APPLICATION_CATALOG_TABLES,
              ])
            ).rows;
            expect(r1Hash(r1Encode(closedRows))).toBe(
              closed.checkpoints['108'].catalogs[variant].sha256,
            );
            // The historical catalog records intents only as a parent, without its ACL.
            // Keep the null-ACL guard, then reconstruct the independently observed split-owner
            // shape using synthetic grants, issued by the original owner to preserve grantors.
            const missingIntentsAcl = await acl(client);
            expect(() => r1TailPreparationPlan(missingIntentsAcl)).toThrow(
              'R1_TAIL_ACL_NULL_OWNER_RECOVERY_UNSUPPORTED',
            );
            await client.query('set role phub_beta');
            try {
              await client.query(`grant select,insert,update,delete on notifications.intents to phub_runtime;
                grant references(tenant_id,id)on notifications.intents to phub_migrator`);
            } finally {
              await client.query('reset role');
            }
            const tailAcl = await acl(client);
            for (const [table, owner] of [
              ['notifications.intents', 'phub_beta'],
              ['notifications.deliveries', 'phub_migrator'],
            ])
              expect(tailAcl.find((row) => row.key === 'table:' + table)).toEqual({
                key: 'table:' + table,
                owner,
                aclIsNull: false,
                props: { rls: true, force: true },
                acl: [
                  ...[
                    'DELETE',
                    'INSERT',
                    'REFERENCES',
                    'SELECT',
                    'TRIGGER',
                    'TRUNCATE',
                    'UPDATE',
                  ].map((privilege) => [owner, owner, privilege, false]),
                  ...['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((privilege) => [
                    owner,
                    'phub_runtime',
                    privilege,
                    false,
                  ]),
                ],
              });
            expect(
              tailAcl.filter((row) => row.key.startsWith('column:notifications.intents:')),
            ).toEqual(
              ['id', 'tenant_id'].map((column) => ({
                key: 'column:notifications.intents:' + column,
                owner: 'phub_beta',
                aclIsNull: false,
                props: { REFERENCES: true },
                acl: [['phub_beta', 'phub_migrator', 'REFERENCES', false]],
              })),
            );
          } finally {
            client.release();
          }
          const migrator = new Pool({ connectionString: url(name, 'phub_migrator'), max: 2 });
          pools.push(migrator);
          return { name, root, migrator };
        }
        try {
          expect(
            (
              await admin.query<{ major: number }>(
                "select current_setting('server_version_num')::int/10000 as major",
              )
            ).rows[0]!.major,
          ).toBe(16);
          for (const [role, password] of Object.entries(rolePasswords))
            if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
              await admin.query(
                `create role ${quote(role)}login password '${password}'nosuperuser nobypassrls nocreatedb nocreaterole noreplication`,
              );
              ownedRoles.push(role);
            }
          const reference = await fixture(),
            root = await reference.root.connect(),
            migrator = await reference.migrator.connect();
          const checkpoints: Record<string, { prepared: Point; cleaned: Point }> = {};
          try {
            const preimage = await acl(root),
              preparation = r1TailPreparationPlan(preimage);
            // Actual wire login is restricted; the missing intents owner must be refused.
            await expect(assertR1TailRole(migrator)).rejects.toThrow('R1_TAIL_ROLE_OWNERSHIP');
            for (let count = 108; count <= 119; count++) {
              const cleaned = point(await catalog(root));
              await root.query(r1TailAclTransaction(preparation, 'bootstrap', await acl(root)));
              await assertR1TailRole(migrator);
              const prepared = point(await catalog(root));
              checkpoints[String(count)] = { prepared, cleaned };
              // Verify exact table and column grantor restoration on every prefix.
              await root.query(r1TailAclTransaction(preparation, 'cleanup', await acl(root)));
              expect(await acl(root)).toEqual(preimage);
              if (count === 119) break;
              await root.query(r1TailAclTransaction(preparation, 'bootstrap', await acl(root)));
              const migration = packaged[count]!;
              await migrator.query('begin');
              try {
                await migrator.query(
                  "set local lock_timeout='5s';set local statement_timeout='30s'",
                );
                await migrator.query(migration.sql);
                await migrator.query(
                  'insert into public.schema_migrations(filename,checksum)values($1,$2)',
                  [migration.filename, migration.checksum],
                );
                await migrator.query('commit');
              } catch (error) {
                await migrator.query('rollback');
                throw error;
              }
              // Return to the real split-owner preimage before capturing this next cleaned checkpoint.
              await root.query(r1TailAclTransaction(preparation, 'cleanup', await acl(root)));
            }
          } finally {
            migrator.release();
            root.release();
          }
          exported[variant] = checkpoints;
          const fixtureCatalogs: R1TailCatalogs = {
            schema: 'PHUB_R1_TAIL_CATALOGS_V1',
            status: 'REHEARSED_REVIEWED',
            inventorySha256: r1Hash(r1Encode(R1_TAIL)),
            builderSha256: r1Hash(R1_TAIL_CATALOG_SQL),
            variants: { [variant]: checkpoints },
          };
          const execution = await fixture(),
            executor = await execution.migrator.connect(),
            owner = await execution.root.connect();
          try {
            const preparation = r1TailPreparationPlan(await acl(owner));
            await owner.query(r1TailAclTransaction(preparation, 'bootstrap', await acl(owner)));
            const initialTarget: R1TailTarget = {
              databaseName: 'phub_beta',
              systemIdentifier: '7679125609183186977',
              fromCount: 108,
              catalogVariant: variant,
              catalogsSha256: '0'.repeat(64),
            };
            await executor.query(
              "select set_config('lock_timeout',$1,false),set_config('statement_timeout',$2,false)",
              [`${R1_TAIL.budgets.lockMs}ms`, `${R1_TAIL.budgets.statementMs}ms`],
            );
            await owner.query('begin;lock table public.schema_migrations in access exclusive mode');
            try {
              await expect(
                applyR1TailSteps(executor, packaged, initialTarget, fixtureCatalogs, () => {}),
              ).rejects.toThrow(/lock timeout/i);
            } finally {
              await owner.query('rollback');
            }
            expect(r1LedgerCount(await readR1TailLedger(executor))).toBe(108);
            await owner.query(
              'alter table identity.users add constraint r1_tail_synthetic_drift check(true)',
            );
            try {
              await expect(
                applyR1TailSteps(executor, packaged, initialTarget, fixtureCatalogs, () => {}),
              ).rejects.toThrow('R1_TAIL_CATALOG');
            } finally {
              await owner.query(
                'alter table identity.users drop constraint r1_tail_synthetic_drift',
              );
            }
            expect(r1LedgerCount(await readR1TailLedger(executor))).toBe(108);
            let fromCount = 108;
            // Each injected post-commit lost ACK leaves a real durable prefix, then a fresh exact suffix resumes.
            for (let stopCount = 109; stopCount <= 118; stopCount++) {
              const syntheticTarget: R1TailTarget = {
                databaseName: 'phub_beta',
                systemIdentifier: '7679125609183186977',
                fromCount,
                catalogVariant: variant,
                catalogsSha256: '0'.repeat(64),
              };
              await expect(
                applyR1TailSteps(
                  executor,
                  packaged,
                  syntheticTarget,
                  fixtureCatalogs,
                  (progress) => {
                    if (progress.count === stopCount)
                      throw Error('SYNTHETIC_LOST_ACK_AFTER_COMMIT');
                  },
                ),
              ).rejects.toThrow('SYNTHETIC_LOST_ACK_AFTER_COMMIT');
              expect(r1LedgerCount(await readR1TailLedger(executor))).toBe(stopCount);
              expect(point(await catalog(owner))).toEqual(checkpoints[String(stopCount)]!.prepared);
              fromCount = stopCount;
            }
            const syntheticTarget: R1TailTarget = {
              databaseName: 'phub_beta',
              systemIdentifier: '7679125609183186977',
              fromCount,
              catalogVariant: variant,
              catalogsSha256: '0'.repeat(64),
            };
            await applyR1TailSteps(executor, packaged, syntheticTarget, fixtureCatalogs, () => {});
            expect(r1LedgerCount(await readR1TailLedger(executor))).toBe(119);
            await owner.query(r1TailAclTransaction(preparation, 'cleanup', await acl(owner)));
            expect(await acl(owner)).toEqual(preparation.preimage);
            expect(point(await catalog(owner))).toEqual(checkpoints['119']!.cleaned);
            // Catalog evidence above stays unchanged. Exercise the new diagnostic only in
            // this already-owned disposable119 fixture, after all golden comparisons.
            const runtime = new Pool({
              connectionString: url(execution.name, 'phub_runtime'),
              max: 1,
            });
            pools.push(runtime);
            async function inspect(component: R1RuntimeComponent) {
              const connection = await runtime.connect();
              try {
                await connection.query(
                  'begin transaction isolation level repeatable read read only',
                );
                await connection.query("set local search_path='pg_catalog'");
                const query = r1RuntimePrivilegeQuery(component);
                const result = await connection.query<{ capture: R1RuntimePrivilegeCapture }>(
                  query,
                );
                expect(result.rows).toHaveLength(1);
                return assessR1RuntimePrivileges(result.rows[0]!.capture, {
                  component,
                  databaseName: execution.name,
                  roleName: 'phub_runtime',
                });
              } finally {
                await connection.query('rollback');
                connection.release();
              }
            }
            expect((await inspect('api')).status).toBe('BLOCKED');
            expect((await inspect('worker')).issues).toContainEqual(
              expect.objectContaining({
                code: 'PRIVILEGE_MISSING',
                relation: 'notifications.station_message_sources',
              }),
            );
            async function runtimeAcl() {
              const result = await owner.query<{ capture: R1Grant119Capture }>(
                `select (${R1_RUNTIME_GRANT_CATALOG_SQL}) as capture`,
              );
              return result.rows[0]!.capture;
            }
            // The golden fixture is a schema/ACL migration snapshot, not a full runtime
            // parent privilege baseline. Supply synthetic parent capabilities separately;
            // the new transaction must preserve them and never generate parent grants.
            for (const component of ['api', 'worker'] as const) {
              for (const requirement of r1RuntimePrivilegeRequirements(component).filter(
                (r) => !r.tenantTable,
              )) {
                const column = (
                  await owner.query<{ name: string }>(
                    'select attname as name from pg_catalog.pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum limit 1',
                    [requirement.relation],
                  )
                ).rows[0]!.name;
                await owner.query(
                  `grant select,update(${quote(column)}) on ${qualified(requirement.relation)} to phub_runtime`,
                );
              }
            }
            const grantPreimage = await runtimeAcl();
            const grantPlan = planR1RuntimeGrants119(grantPreimage);
            await owner.query(r1RuntimeGrantTransaction119(grantPlan, 'apply'));
            expect(await runtimeAcl()).toEqual(grantPlan.postimage);
            await expect(
              owner.query(r1RuntimeGrantTransaction119(grantPlan, 'apply')),
            ).rejects.toThrow('R1_RUNTIME_GRANT_PREIMAGE_DRIFT');
            await owner.query('rollback');
            await owner.query(r1RuntimeGrantTransaction119(grantPlan, 'recover'));
            expect(await runtimeAcl()).toEqual(grantPreimage);
            await owner.query(r1RuntimeGrantTransaction119(grantPlan, 'apply'));
            for (const component of ['api', 'worker'] as const) {
              expect(await inspect(component)).toMatchObject({
                status: 'SATISFIED',
                activationAllowed: false,
                issues: [],
              });
            }
            await owner.query(
              'revoke update(completed_at) on identity.external_subject_link_commands from phub_runtime',
            );
            expect((await inspect('api')).issues).toContainEqual(
              expect.objectContaining({
                code: 'COLUMN_UPDATE_MISSING',
                relation: 'identity.external_subject_link_commands',
                privilege: 'completed_at',
              }),
            );
            await owner.query(
              'grant update(completed_at) on identity.external_subject_link_commands to phub_runtime',
            );
            // Prove that incomplete column grants request review, never an automatic grant.
            await owner.query('revoke update on games.quarter_create_attempts from phub_runtime');
            await owner.query(
              'grant update(state) on games.quarter_create_attempts to phub_runtime',
            );
            expect((await inspect('api')).issues).toContainEqual(
              expect.objectContaining({
                code: 'COLUMN_SCOPE_REVIEW_REQUIRED',
                relation: 'games.quarter_create_attempts',
                privilege: 'UPDATE',
                review: true,
              }),
            );
            // Revoked CREATE does not remove an owner's ALTER/DROP/regrant authority.
            await owner.query('alter schema commerce owner to phub_runtime');
            await owner.query('revoke create on schema commerce from phub_runtime');
            expect(
              (
                await owner.query<{ allowed: boolean }>(
                  "select has_schema_privilege('phub_runtime','commerce','CREATE') as allowed",
                )
              ).rows[0]!.allowed,
            ).toBe(false);
            expect((await inspect('api')).issues).toContainEqual(
              expect.objectContaining({
                code: 'UNSAFE_SCHEMA_OR_OWNER_OR_DDL',
                relation: 'commerce.monthly_purchase_attempts',
              }),
            );
          } finally {
            executor.release();
            owner.release();
          }
        } finally {
          try {
            await Promise.all(pools.map((pool) => pool.end()));
            await admin.query(cleanupQuery("set statement_timeout='1s';set lock_timeout='1s'"));
            for (const name of databases.reverse()) {
              // pg-pool can resolve end() before every closing socket has left PostgreSQL.
              // FORCE races those sockets and emits unhandled57P01 after passing tests.
              await waitForOwnedDatabaseDisconnect(admin, name);
              // Never terminate an unexpected connection to make cleanup pass.
              await admin.query(cleanupQuery(`drop database ${quote(name)}`, [], 2000));
            }
            for (const role of ownedRoles.reverse())
              await admin.query(cleanupQuery(`drop role ${quote(role)}`, [], 2000));
          } finally {
            await admin.end();
          }
        }
      },
      150000,
    );
    it('exports only independently reviewable synthetic metadata after both variants', async () => {
      expect(Object.keys(exported).sort()).toEqual(['DORMANT', 'SCENARIO_EDITOR_V1']);
      const value = {
        schema: 'PHUB_R1_TAIL_CATALOGS_V1',
        status: 'REHEARSED_UNREVIEWED',
        inventorySha256: r1Hash(r1Encode(R1_TAIL)),
        builderSha256: r1Hash(R1_TAIL_CATALOG_SQL),
        variants: exported,
      };
      // Regeneration must reproduce the independently reviewed source checkpoints exactly.
      expect({ ...value, status: 'REHEARSED_REVIEWED' }).toEqual(reviewed);
      // Never rewrite an admitted source file or export a URL, credential, dump or business row.
      const directory = resolve('.ci-artifacts/test-and-coverage');
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, 'r1-tail108-119-catalogs.v1.json'),
        JSON.stringify(value, null, 2) + '\n',
        { mode: 0o600 },
      );
    });
  },
);
