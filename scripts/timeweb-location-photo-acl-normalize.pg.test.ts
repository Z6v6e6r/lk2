import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const forward = readFileSync(
  resolve(root, 'deploy/timeweb/location-photo-acl-normalize-0102.sql'),
  'utf8',
);
const recover = readFileSync(
  resolve(root, 'deploy/timeweb/location-photo-acl-normalize-recover-0102.sql'),
  'utf8',
);

function ciDatabase(environment: NodeJS.ProcessEnv): string | undefined {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.APP_ENV !== 'ci' ||
    !environment.DATABASE_URL
  )
    return undefined;
  const url = new URL(environment.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.password !== 'ci-password' ||
    url.port !== '5432' ||
    url.pathname !== '/phub' ||
    url.search ||
    url.hash
  ) {
    throw new Error('PHOTO_ACL_DISPOSABLE_DATABASE_REQUIRED');
  }
  return url.toString();
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('PHOTO_ACL_TEST_IDENTIFIER');
  return `"${value}"`;
}

const schemaSnapshot = `select jsonb_agg(s.value order by s.name collate "C") snapshot
  from (select n.nspname name, jsonb_build_object('schema',n.nspname,'owner',pg_get_userbyid(n.nspowner),
    'acl',(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
      'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by (case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end) collate "C",
        pg_get_userbyid(a.grantor) collate "C",a.privilege_type collate "C",a.is_grantable)
      from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a)) value
    from pg_namespace n where n.nspname in ('locations','public')) s`;

async function unrelatedSnapshot(client: PoolClient) {
  return (
    await client.query<{ value: unknown }>(`select jsonb_build_object(
    'relations',(select jsonb_agg(jsonb_build_array(oid,relowner,relacl::text) order by oid) from pg_class),
    'columns',(select jsonb_agg(jsonb_build_array(attrelid,attnum,attacl::text) order by attrelid,attnum) from pg_attribute where attacl is not null),
    'defaults',(select jsonb_agg(jsonb_build_array(oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl::text) order by oid) from pg_default_acl),
    'ledger',(select jsonb_agg(jsonb_build_array(filename,checksum) order by filename) from public.schema_migrations)) value`)
  ).rows[0]!.value;
}

async function rejected(client: PoolClient, sql: string, code: string) {
  try {
    await expect(client.query(sql)).rejects.toThrow(code);
  } finally {
    await client.query('rollback');
  }
}

describe('location photo ACL normalization closed source', () => {
  it('has exactly two reviewed ACL commands in each guarded transaction', () => {
    for (const sql of [forward, recover]) {
      expect(sql).toContain('pg_try_advisory_xact_lock(7140221)');
      expect(sql).toContain("current_database() <> 'phub_beta'");
      expect(sql).toContain('7679125609183186977');
      expect(sql).toContain('7bd0476427e40967f4531972829a86f578d0e9d844ab9e92f16637b868e207fd');
      expect(sql).toContain('LOCATION_PHOTO_ACL_UNRELATED_SECURITY_DRIFT');
      expect(sql).toContain('ledger_valid is distinct from true');
      expect(sql).not.toMatch(/\bcascade\b|\b(?:insert|update|delete|alter)\s|\bcreate\s+table/i);
    }
    expect([...forward.matchAll(/^\s*(grant|revoke)\s+.*;$/gim)].map((r) => r[0].trim())).toEqual([
      'grant usage on schema locations to phub_migrator;',
      'revoke create on schema public from phub_migrator restrict;',
    ]);
    expect([...recover.matchAll(/^\s*(grant|revoke)\s+.*;$/gim)].map((r) => r[0].trim())).toEqual([
      'revoke usage on schema locations from phub_migrator restrict;',
      'grant create on schema public to phub_migrator;',
    ]);
  });

  it('does not inherit a local/shared database and refuses widened CI URLs', () => {
    expect(
      ciDatabase({ DATABASE_URL: 'postgresql://phub:ci-password@localhost:5432/phub' }),
    ).toBeUndefined();
    for (const value of [
      'postgresql://phub:ci-password@db.internal:5432/phub',
      'postgresql://runtime:ci-password@localhost:5432/phub',
      'postgresql://phub:ci-password@localhost:5432/phub?sslmode=require',
    ]) {
      expect(() =>
        ciDatabase({ GITHUB_ACTIONS: 'true', APP_ENV: 'ci', DATABASE_URL: value }),
      ).toThrow('PHOTO_ACL_DISPOSABLE_DATABASE_REQUIRED');
    }
  });
});

const disposable = ciDatabase(process.env);
const physical = disposable ? describe.sequential : describe.skip;
physical('photo ACL baseline on owned disposable PostgreSQL 16', () => {
  it('rehearses exact delta, grantors, inverse, mismatch rejection and lost-ACK classification', async () => {
    const admin = new Pool({ connectionString: disposable, max: 2 });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const database = `photo_acl_${suffix}`;
    // Preserve the production ACL-name sort order after replacing the owner with CI's phub.
    const migrator = `z_photo_acl_m_${suffix}`;
    const runtime = `z_photo_acl_r_${suffix}`;
    const owner = new URL(disposable!).username;
    const ownedRoles: string[] = [];
    let databaseCreated = false;
    let target: Pool | undefined;
    let client: PoolClient | undefined;
    try {
      for (const role of [migrator, runtime]) {
        await admin.query(
          `create role ${identifier(role)} login password '${randomUUID()}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication`,
        );
        ownedRoles.push(role);
      }
      await admin.query(`create database ${identifier(database)} owner ${identifier(owner)}`);
      databaseCreated = true;
      const targetUrl = new URL(disposable!);
      targetUrl.pathname = `/${database}`;
      target = new Pool({ connectionString: targetUrl.toString(), max: 2 });
      client = await target.connect();
      expect(
        Number(
          (
            await client.query<{ major: string }>(
              "select current_setting('server_version_num')::int/10000 major",
            )
          ).rows[0]!.major,
        ),
      ).toBe(16);
      const system = (
        await client.query<{ id: string }>(
          'select system_identifier::text id from pg_control_system()',
        )
      ).rows[0]!.id;
      await client.query(`create schema locations authorization ${identifier(owner)};
        create table locations.profiles(id int);
        create table locations.media_assets(id int);
        create table public.schema_migrations(filename text primary key,checksum text not null);
        create table public.unrelated_acl_probe(value int);
        grant select on public.unrelated_acl_probe to ${identifier(runtime)};
        grant update(value) on public.unrelated_acl_probe to ${identifier(runtime)};
        alter default privileges in schema locations grant select on tables to ${identifier(runtime)};
        grant usage on schema locations to ${identifier(runtime)};
        grant usage on schema public to ${identifier(runtime)};
        grant usage,create on schema public to ${identifier(migrator)};`);
      const rows = readdirSync(resolve(root, 'packages/database/migrations'))
        .filter((f) => f.endsWith('.sql') && f <= '0101_notification_lifecycle_channels.sql')
        .sort()
        .map((filename) => ({
          filename,
          checksum: createHash('sha256')
            .update(readFileSync(resolve(root, 'packages/database/migrations', filename)))
            .digest('hex'),
        }));
      expect(rows).toHaveLength(105);
      await client.query(
        'insert into public.schema_migrations select * from unnest($1::text[],$2::text[])',
        [rows.map((r) => r.filename), rows.map((r) => r.checksum)],
      );
      // Rewriting applies only to a copy of the fixed production SQL in this disposable test.
      // No runtime switch or production bypass is added to the shipped SQL.
      const fixtureSql = (sql: string) =>
        sql
          .replace(/^\\set ON_ERROR_STOP on\n/, '')
          .replace("current_database() <> 'phub_beta'", `current_database() <> '${database}'`)
          .replaceAll('phub_beta', owner)
          .replaceAll('phub_migrator', migrator)
          .replaceAll('phub_runtime', runtime)
          .replaceAll('7679125609183186977', system);
      const applySql = fixtureSql(forward),
        recoverSql = fixtureSql(recover);
      const before = (await client.query<{ snapshot: unknown }>(schemaSnapshot)).rows[0]!.snapshot;
      const unrelated = await unrelatedSnapshot(client);
      await rejected(client, applySql.replaceAll(system, '1'), 'LOCATION_PHOTO_ACL_SYSTEM');
      await client.query(
        "update public.schema_migrations set checksum=repeat('0',64) where filename=$1",
        [rows[0]!.filename],
      );
      await rejected(client, applySql, 'LOCATION_PHOTO_ACL_LEDGER');
      await client.query('update public.schema_migrations set checksum=$1 where filename=$2', [
        rows[0]!.checksum,
        rows[0]!.filename,
      ]);
      // Hash canonicalization removes formatting spaces; reject spaces inside row values first.
      // Otherwise these malformed rows could have the same digest as the approved ledger.
      await client.query('update public.schema_migrations set checksum=$1 where filename=$2', [
        ` ${rows[0]!.checksum}`,
        rows[0]!.filename,
      ]);
      await rejected(client, applySql, 'LOCATION_PHOTO_ACL_LEDGER');
      await client.query('update public.schema_migrations set checksum=$1 where filename=$2', [
        rows[0]!.checksum,
        rows[0]!.filename,
      ]);
      await client.query('update public.schema_migrations set filename=$1 where filename=$2', [
        `${rows[0]!.filename} `,
        rows[0]!.filename,
      ]);
      await rejected(client, applySql, 'LOCATION_PHOTO_ACL_LEDGER');
      await client.query('update public.schema_migrations set filename=$1 where filename=$2', [
        rows[0]!.filename,
        `${rows[0]!.filename} `,
      ]);
      await client.query(`grant create on schema locations to ${identifier(runtime)}`);
      await rejected(client, applySql, 'LOCATION_PHOTO_ACL_SCHEMA_PREIMAGE');
      await client.query(`revoke create on schema locations from ${identifier(runtime)} restrict`);
      const blocker = await target.connect();
      try {
        await blocker.query('begin');
        await blocker.query('select pg_advisory_xact_lock(7140221)');
        await rejected(client, applySql, 'LOCATION_PHOTO_ACL_LOCK');
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
      expect((await client.query<{ snapshot: unknown }>(schemaSnapshot)).rows[0]!.snapshot).toEqual(
        before,
      );
      await client.query(applySql);
      const after = (await client.query<{ snapshot: unknown }>(schemaSnapshot)).rows[0]!.snapshot;
      expect(after).not.toEqual(before);
      expect(
        (
          await client.query<{ usage: boolean; create: boolean }>(
            `select has_schema_privilege($1,'locations','USAGE') usage,has_schema_privilege($1,'public','CREATE') "create"`,
            [migrator],
          )
        ).rows,
      ).toEqual([{ usage: true, create: false }]);
      expect(await unrelatedSnapshot(client)).toEqual(unrelated);
      // A lost ACK is classified from readback; forward SQL is never blindly replayed.
      await rejected(client, applySql, 'LOCATION_PHOTO_ACL_SCHEMA_PREIMAGE');
      expect((await client.query<{ snapshot: unknown }>(schemaSnapshot)).rows[0]!.snapshot).toEqual(
        after,
      );
      await client.query('create table locations.recommendation_card_photos(id int)');
      await rejected(client, recoverSql, 'LOCATION_PHOTO_ACL_LEDGER');
      await client.query('drop table locations.recommendation_card_photos');
      await client.query(recoverSql);
      expect((await client.query<{ snapshot: unknown }>(schemaSnapshot)).rows[0]!.snapshot).toEqual(
        before,
      );
      expect(await unrelatedSnapshot(client)).toEqual(unrelated);
      await rejected(client, recoverSql, 'LOCATION_PHOTO_ACL_SCHEMA_PREIMAGE');
    } finally {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      if (target) await target.end();
      if (databaseCreated) await admin.query(`drop database ${identifier(database)} with (force)`);
      for (const role of ownedRoles.reverse()) await admin.query(`drop role ${identifier(role)}`);
      await admin.end();
    }
  }, 30_000);
});
