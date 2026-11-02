import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import frozenCatalogs from '../../../deploy/timeweb/r1-tail108-119-catalogs.v1.json';
import type { PoolClient } from 'pg';
import { createDatabasePool } from '@phub/database';
import { parseStrictJson } from '../../../scripts/strict-json.js';
import {
  R1_TAIL,
  R1_TAIL_TARGET,
  r1Encode,
  r1Hash,
  r1LedgerCount,
  r1PackagedInventory,
  r1Same,
  r1Stop,
  parseR1TailTarget,
  validateR1TailCatalogs,
  validateR1TailCatalog,
  type R1MigrationRow,
  type R1TailCatalogs,
  type R1TailTarget,
} from '../../../scripts/r1-tail-migration-profile.js';
import { R1_TAIL_CATALOG_SQL, R1_TAIL_TABLES } from '../../../scripts/r1-tail-migration-catalog.js';
import { R1_TAIL_SAFE_ROLES_SQL } from '../../../scripts/r1-tail-migration-state.js';

type Client = Pick<PoolClient, 'query'>;
type Migration = R1MigrationRow & { sql: string };
export const R1_TAIL_ROLE_SQL = `select current_user='phub_migrator' and session_user=current_user
  and current_setting('role')='none' and not pg_catalog.pg_is_in_recovery()
  and current_setting('server_version_num')::int/10000=16
  and (${R1_TAIL_SAFE_ROLES_SQL})
  and (select count(*)=2 and bool_and(c.relowner='phub_migrator'::regrole and c.relrowsecurity and c.relforcerowsecurity)
    from pg_catalog.pg_class c where c.oid in('notifications.intents'::regclass,'notifications.deliveries'::regclass))
  as ok`;
export async function readR1TailLedger(client: Client): Promise<R1MigrationRow[]> {
  return (
    await client.query<R1MigrationRow>(
      'select filename,checksum from public.schema_migrations order by filename',
    )
  ).rows;
}
export async function verifyR1TailCatalog(
  client: Client,
  catalogs: R1TailCatalogs,
  target: R1TailTarget,
  count: number,
): Promise<string> {
  const rows = (
    await client.query<{ key: string; value: string }>(R1_TAIL_CATALOG_SQL, [R1_TAIL_TABLES])
  ).rows;
  validateR1TailCatalog(rows, catalogs, target.catalogVariant, count);
  return r1Hash(r1Encode(rows));
}
export async function assertR1TailRole(client: Client): Promise<void> {
  if ((await client.query<{ ok: boolean }>(R1_TAIL_ROLE_SQL)).rows[0]?.ok !== true)
    r1Stop('ROLE_OWNERSHIP');
}
// Uses only a frozen packaged suffix. Each file + ledger insertion + post-catalog check is atomic.
export async function applyR1TailSteps(
  client: Client,
  migrations: readonly Migration[],
  target: R1TailTarget,
  catalogs: R1TailCatalogs,
  progress: (value: { count: number; ledgerSha256: string; catalogSha256: string }) => void,
  time: () => number = Date.now,
): Promise<void> {
  r1PackagedInventory(migrations.map(({ filename, checksum }) => ({ filename, checksum })));
  if (migrations.some(({ sql, checksum }) => r1Hash(sql) !== checksum)) r1Stop('SQL_CHECKSUM');
  const started = time();
  const withinBudget = () => {
    if (time() - started >= R1_TAIL.budgets.attemptMs) r1Stop('ATTEMPT_TIMEOUT');
  };
  const from = r1LedgerCount(await readR1TailLedger(client));
  if (from !== target.fromCount) r1Stop('PREFIX');
  await assertR1TailRole(client);
  await client.query('begin read only');
  try {
    await client.query("set local search_path='pg_catalog'");
    await verifyR1TailCatalog(client, catalogs, target, from);
  } finally {
    await client.query('rollback');
  }
  for (let i = from; i < 119; i++) {
    withinBudget();
    const migration = migrations[i];
    if (!migration) r1Stop('PACKAGE');
    await client.query('begin');
    try {
      await client.query("set local search_path='pg_catalog'");
      await client.query(
        "select set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
        [
          `${R1_TAIL.budgets.lockMs}ms`,
          `${Math.min(R1_TAIL.budgets.statementMs, R1_TAIL.budgets.attemptMs - (time() - started))}ms`,
        ],
      );
      await assertR1TailRole(client);
      if (r1LedgerCount(await readR1TailLedger(client)) !== i) r1Stop('PREFIX_DRIFT');
      await verifyR1TailCatalog(client, catalogs, target, i);
      await client.query(migration.sql);
      await client.query('insert into public.schema_migrations(filename,checksum) values($1,$2)', [
        migration.filename,
        migration.checksum,
      ]);
      const count = r1LedgerCount(await readR1TailLedger(client));
      if (count !== i + 1) r1Stop('POST_LEDGER');
      const catalogSha256 = await verifyR1TailCatalog(client, catalogs, target, count);
      withinBudget();
      await client.query('commit');
      // A lost log/ACK after this commit is reconciled from the retained container + exact state.
      progress({ count, ledgerSha256: R1_TAIL.checkpoints[String(count)]!, catalogSha256 });
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
}
export async function runR1TailMigration(value: unknown): Promise<void> {
  const target = parseR1TailTarget(value);
  const catalogsBytes = r1Encode(frozenCatalogs);
  const catalogs = validateR1TailCatalogs(
    parseStrictJson(catalogsBytes),
    catalogsBytes,
    target.catalogsSha256,
  );
  if (catalogs.builderSha256 !== r1Hash(R1_TAIL_CATALOG_SQL)) r1Stop('CATALOG_BUILDER');
  const directory = resolve(process.cwd(), 'migrations');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const migrations = await Promise.all(
    files.map(async (filename) => {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      return { filename, sql, checksum: r1Hash(sql) };
    }),
  );
  r1PackagedInventory(migrations.map(({ filename, checksum }) => ({ filename, checksum })));
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    return r1Stop('WIRE_ROLE');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.username) !== 'phub_migrator' ||
    url.pathname !== '/phub_beta'
  )
    r1Stop('WIRE_ROLE');
  // A hard process deadline complements server-side per-statement timeouts. On expiry
  // the process closes its own connection; reconciliation waits for the advisory lock
  // and transaction to disappear before any owned ACL recovery.
  const deadline = setTimeout(() => {
    process.stderr.write('R1_TAIL_ATTEMPT_TIMEOUT\n');
    process.exit(1);
  }, R1_TAIL.budgets.attemptMs);
  deadline.unref();
  const pool = createDatabasePool(url.toString());
  const client = await pool.connect();
  let locked = false;
  try {
    // Set before the blocking advisory acquisition, and never reset statement timeout to zero.
    await client.query(
      "select set_config('lock_timeout',$1,false),set_config('statement_timeout',$1,false)",
      [`${R1_TAIL.budgets.advisoryMs}ms`],
    );
    await client.query('select pg_advisory_lock($1)', [7_140_221]);
    locked = true;
    const actual = (
      await client.query<{ databaseName: string; systemIdentifier: string }>(
        `select current_database() as "databaseName",system_identifier::text as "systemIdentifier" from pg_catalog.pg_control_system()`,
      )
    ).rows;
    if (actual.length !== 1 || !r1Same(actual[0], R1_TAIL_TARGET)) r1Stop('DATABASE_TARGET');
    await applyR1TailSteps(client, migrations, target, catalogs, (progress) =>
      process.stdout.write(
        JSON.stringify({ schema: 'PHUB_R1_TAIL_PROGRESS_V1', ...progress }) + '\n',
      ),
    );
  } finally {
    if (locked)
      await client.query('select pg_advisory_unlock($1)', [7_140_221]).catch(() => undefined);
    client.release();
    await pool.end();
    clearTimeout(deadline);
  }
}
