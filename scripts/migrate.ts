import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { assertMigrationLedgerCompatible, createDatabasePool } from '@phub/database';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for migrations');

const migrationsDirectory = resolve(process.cwd(), 'packages/database/migrations');
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();
const packagedMigrations = await Promise.all(
  migrationFiles.map(async (filename) => {
    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
    return {
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  }),
);
const pool = createDatabasePool(connectionString);
const client = await pool.connect();

try {
  await client.query('select pg_advisory_lock($1)', [7_140_221]);
  const ledgerExists = await client.query<{ ledger: string | null }>(
    "select to_regclass('public.schema_migrations')::text as ledger",
  );
  const applied = ledgerExists.rows[0]?.ledger
    ? (
        await client.query<{ filename: string; checksum: string }>(
          'select filename, checksum from public.schema_migrations order by filename',
        )
      ).rows
    : [];

  assertMigrationLedgerCompatible({ applied, packaged: packagedMigrations });

  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const appliedFilenames = new Set(applied.map((entry) => entry.filename));
  for (const { filename, sql, checksum } of packagedMigrations) {
    if (appliedFilenames.has(filename)) continue;

    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into public.schema_migrations (filename, checksum) values ($1, $2)',
        [filename, checksum],
      );
      await client.query('commit');
      process.stdout.write(`Applied ${filename}\n`);
      const refreshedApplied = await client.query<{ filename: string }>(
        'select filename from public.schema_migrations order by filename',
      );
      appliedFilenames.clear();
      for (const entry of refreshedApplied.rows) appliedFilenames.add(entry.filename);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
} finally {
  await client.query('select pg_advisory_unlock($1)', [7_140_221]).catch(() => undefined);
  client.release();
  await pool.end();
}
