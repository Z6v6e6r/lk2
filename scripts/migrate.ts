import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createDatabasePool } from '@phub/database';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for migrations');

const migrationsDirectory = resolve(process.cwd(), 'packages/database/migrations');
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();
const pool = createDatabasePool(connectionString);
const client = await pool.connect();

try {
  await client.query('select pg_advisory_lock($1)', [7_140_221]);
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);

  for (const filename of migrationFiles) {
    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ checksum: string }>(
      'select checksum from public.schema_migrations where filename = $1',
      [filename],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration ${filename} was modified`);
      }
      continue;
    }

    await client.query('begin');
    try {
      await client.query(sql);
      await client.query(
        'insert into public.schema_migrations (filename, checksum) values ($1, $2)',
        [filename, checksum],
      );
      await client.query('commit');
      process.stdout.write(`Applied ${filename}\n`);
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
