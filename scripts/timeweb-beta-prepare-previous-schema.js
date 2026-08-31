#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const databaseUrl = new URL(connectionString);
if (
  !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
  databaseUrl.hostname !== 'postgres' ||
  databaseUrl.username !== 'phub' ||
  databaseUrl.pathname !== '/phub_previous'
)
  throw new Error('previous-schema fixture requires the isolated phub_previous database');

const migrationsDirectory = resolve(process.cwd(), 'migrations');
const filenames = (await readdir(migrationsDirectory))
  .filter((filename) => /^\d+.*\.sql$/u.test(filename))
  .sort();
if (filenames.length < 2) throw new Error('at least two migrations are required');
const previousFilenames = filenames.slice(0, -1);
const latestFilename = filenames.at(-1);
const migrations = await Promise.all(
  previousFilenames.map(async (filename) => {
    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
    return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }),
);

const pool = new Pool({ connectionString });
const client = await pool.connect();
try {
  const existing = await client.query(
    `select count(*)::integer as count
       from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname not in ('pg_catalog', 'information_schema')
        and namespace.nspname not like 'pg_toast%'
        and relation.relkind in ('r', 'p', 'v', 'm', 'S')`,
  );
  if (existing.rows[0]?.count !== 0)
    throw new Error('previous-schema fixture database is not empty');
  await client.query(`
    create table public.schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migration of migrations) {
    await client.query('begin');
    try {
      await client.query(migration.sql);
      await client.query(
        `insert into public.schema_migrations (filename, checksum)
         values ($1, $2)
         on conflict (filename) do update set checksum = excluded.checksum`,
        [migration.filename, migration.checksum],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
  const ledger = await client.query(
    'select count(*)::integer as count from public.schema_migrations',
  );
  process.stdout.write(
    `TIMEWEB_PREVIOUS_SCHEMA_PREPARED|ledger=${ledger.rows[0]?.count ?? 0}|next=${latestFilename}\n`,
  );
} finally {
  client.release();
  await pool.end();
}
