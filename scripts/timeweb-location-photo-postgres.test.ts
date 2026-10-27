import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  LOCATION_PHOTO_MIGRATOR_PROBE_SOURCE,
  locationPhotoStateSql,
  validateLocationPhotoMigratorReadback,
  validateLocationPhotoState,
} from './timeweb-location-photo-profile.js';

const root = resolve(import.meta.dirname, '..');
const migration = '0102_location_recommendation_photos.sql';

function ciDatabase(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment.GITHUB_ACTIONS !== 'true' || environment.APP_ENV !== 'ci') return undefined;
  if (!environment.DATABASE_URL) return undefined;
  const url = new URL(environment.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.port !== '5432' ||
    url.search ||
    url.hash
  )
    throw new Error('LOCATION_PHOTO_CI_DATABASE_TARGET_INVALID');
  return url.toString();
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('LOCATION_PHOTO_TEST_IDENTIFIER_INVALID');
  return `"${value}"`;
}

async function runOrdinaryMigrator(cwd: string, url: string) {
  return promisify(execFile)(
    process.execPath,
    [
      '--import',
      resolve(root, 'node_modules/tsx/dist/loader.mjs'),
      resolve(root, 'apps/migrator/src/main.ts'),
    ],
    {
      cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: url,
        TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.json'),
        MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
        CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
      },
    },
  );
}

async function runMigratorProbe(url: string, phase: 'pre' | 'bootstrap', roles: Roles) {
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', LOCATION_PHOTO_MIGRATOR_PROBE_SOURCE, phase],
    {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: url,
        MIGRATOR_ADVISORY_LOCK_TIMEOUT_MS: '30000',
      },
    },
  );
  return JSON.parse(
    result.stdout
      .replaceAll(roles.owner, 'phub_beta')
      .replaceAll(roles.migrator, 'phub_migrator')
      .replaceAll(roles.runtime, 'phub_runtime'),
  ) as unknown;
}

async function migrationFixture(include0102: boolean): Promise<string> {
  const fixture = await mkdtemp(resolve(tmpdir(), 'location-photo-0102-'));
  const source = resolve(root, 'packages/database/migrations');
  const target = resolve(fixture, 'migrations');
  await mkdir(target, { recursive: true });
  for (const filename of (await readdir(source)).filter((name) => name.endsWith('.sql')).sort()) {
    if (filename > migration) continue;
    if (include0102 || filename !== migration)
      await copyFile(resolve(source, filename), resolve(target, filename));
  }
  return fixture;
}

type Roles = { owner: string; migrator: string; runtime: string };
type QueryRows = { rows?: Array<Record<string, unknown>> };
type Queryable = { query(sql: string): Promise<unknown> };

async function state(
  pool: Queryable,
  phase: 'pre' | 'bootstrap' | 'post' | 'cleanup',
  roles: Roles,
  manageTransaction = true,
) {
  let sql = locationPhotoStateSql(phase)
    .replaceAll("'phub_migrator'", `'${roles.migrator}'`)
    .replaceAll("'phub_runtime'", `'${roles.runtime}'`);
  if (!manageTransaction)
    sql = sql
      .replace(/^begin isolation level repeatable read read only;\n/, '')
      .replace(/\nrollback;$/, '');
  const output: unknown = await pool.query(sql);
  for (const result of (Array.isArray(output) ? output : [output]) as QueryRows[]) {
    for (const row of result.rows ?? []) {
      const encoded = Object.values(row)[0];
      if (typeof encoded !== 'string') continue;
      return JSON.parse(
        encoded
          .replaceAll(roles.owner, 'phub_beta')
          .replaceAll(roles.migrator, 'phub_migrator')
          .replaceAll(roles.runtime, 'phub_runtime'),
      ) as unknown;
    }
  }
  throw new Error('LOCATION_PHOTO_TEST_STATE_MISSING');
}

async function roleGuard(pool: Pool, filename: string, roles: Roles) {
  const source = await readFile(resolve(root, 'deploy/timeweb', filename), 'utf8');
  await pool.query(
    source
      .replace(/^\\set ON_ERROR_STOP on\n/m, '')
      .replaceAll('phub_beta', roles.owner)
      .replaceAll('phub_migrator', roles.migrator)
      .replaceAll('phub_runtime', roles.runtime),
  );
}

async function parentReferenceAcl(pool: Pool, roles: Roles) {
  const result = await pool.query<{
    relation: string;
    column: string;
    grantor: string;
    grantee: string;
    privilege: string;
    grantable: boolean;
  }>(
    `select a.attrelid::regclass::text relation,a.attname "column",pg_get_userbyid(x.grantor) grantor,
            pg_get_userbyid(x.grantee) grantee,x.privilege_type privilege,x.is_grantable grantable
       from pg_attribute a cross join lateral aclexplode(a.attacl) x
      where a.attrelid in ('locations.profiles'::regclass,'locations.media_assets'::regclass)
        and a.attnum>0 and not a.attisdropped and x.grantee=$1::regrole
      order by a.attrelid::regclass::text collate "C",a.attname collate "C"`,
    [roles.migrator],
  );
  return result.rows;
}

async function parentColumnAclObjects(pool: Pool) {
  const result = await pool.query<{ relation: string; column: string }>(
    `select a.attrelid::regclass::text relation,a.attname "column"
       from pg_attribute a
      where a.attrelid in ('locations.profiles'::regclass,'locations.media_assets'::regclass)
        and a.attnum>0 and not a.attisdropped and a.attacl is not null
      order by a.attrelid::regclass::text collate "C",a.attname collate "C"`,
  );
  return result.rows;
}

describe('location photo physical PostgreSQL target guard', () => {
  it('never inherits a local or shared database outside the exact Actions service', () => {
    expect(
      ciDatabase({ DATABASE_URL: 'postgresql://phub:synthetic@localhost:5432/phub' }),
    ).toBeUndefined();
    for (const databaseUrl of [
      'postgresql://phub:synthetic@db.internal:5432/phub',
      'postgresql://phub:synthetic@localhost:5432/phub?sslmode=require',
      'postgresql://runtime:synthetic@localhost:5432/phub',
    ])
      expect(() =>
        ciDatabase({ GITHUB_ACTIONS: 'true', APP_ENV: 'ci', DATABASE_URL: databaseUrl }),
      ).toThrow('LOCATION_PHOTO_CI_DATABASE_TARGET_INVALID');
  });
});

const disposableUrl = ciDatabase(process.env);
const physical = disposableUrl ? describe.sequential : describe.skip;

physical('location photo 0102 closed profile on disposable PostgreSQL 16', () => {
  it('executes 105 to 106 and rejects canonical catalog tampering', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const database = `photo_0102_${suffix}`;
    const roles: Roles = {
      owner: new URL(disposableUrl!).username,
      migrator: `photo_migrator_${suffix}`,
      runtime: `photo_runtime_${suffix}`,
    };
    const password = randomUUID();
    const admin = new Pool({ connectionString: disposableUrl, max: 2 });
    const fixture105 = await migrationFixture(false);
    const fixture106 = await migrationFixture(true);
    let target: Pool | undefined;
    try {
      await admin.query(
        `create role ${identifier(roles.migrator)} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication`,
      );
      await admin.query(
        `create role ${identifier(roles.runtime)} login password '${randomUUID()}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication`,
      );
      await admin.query(`create database ${identifier(database)}`);
      const targetUrl = new URL(disposableUrl!);
      targetUrl.pathname = `/${database}`;
      target = new Pool({ connectionString: targetUrl.toString(), max: 2 });

      const publishedSources = await Promise.all(
        ['apps/migrator/src/main.ts', 'apps/migrator/src/migration-runner.ts'].map(async (path) => {
          const result = await promisify(execFile)(
            'git',
            ['show', `4256e733a1f904d051a96492645f5767e4346ce1:${path}`],
            { cwd: root, maxBuffer: 1024 * 1024 },
          );
          return [path, result.stdout] as const;
        }),
      );
      for (const [path, published] of publishedSources)
        expect(await readFile(resolve(root, path))).toEqual(Buffer.from(published));

      const baseline = await runOrdinaryMigrator(fixture105, targetUrl.toString());
      expect(baseline.stdout).not.toContain(migration);
      expect(
        (
          await target.query<{ count: number }>(
            'select count(*)::int as count from public.schema_migrations',
          )
        ).rows[0]?.count,
      ).toBe(105);

      for (const relation of [
        'notifications.scenarios',
        'notifications.scenario_versions',
        'notifications.scenario_commands',
        'notifications.scenario_runs',
        'notifications.scenario_staff_tasks',
      ])
        await target.query(`alter table ${relation} owner to ${identifier(roles.migrator)}`);
      await target.query(
        `grant usage on schema locations, notifications to ${identifier(roles.migrator)}, ${identifier(roles.runtime)};
           grant select, insert on public.schema_migrations to ${identifier(roles.migrator)};
           grant select on locations.profiles, locations.media_assets to ${identifier(roles.runtime)};
           grant select, insert, update on notifications.scenarios to ${identifier(roles.runtime)};
           grant insert on notifications.scenario_versions to ${identifier(roles.runtime)};
           grant select, insert on notifications.scenario_commands to ${identifier(roles.runtime)};
           grant select, update on notifications.scenario_runs to ${identifier(roles.runtime)};
           grant select on notifications.scenario_staff_tasks to ${identifier(roles.runtime)}`,
      );

      const physicalTarget = (
        await target.query<{ databaseName: string; systemIdentifier: string }>(
          `select current_database() "databaseName",
                  (select system_identifier::text from pg_control_system()) "systemIdentifier"`,
        )
      ).rows[0]!;

      const physicalPreReadback = await state(target, 'pre', roles);
      expect(() => validateLocationPhotoState(physicalPreReadback, 'pre')).toThrow('STATE');
      const lockingClient = await target.connect();
      try {
        await lockingClient.query('begin');
        await lockingClient.query('lock table locations.profiles in row exclusive mode');
        await expect(async () =>
          validateLocationPhotoState(await state(target!, 'pre', roles), 'pre', physicalTarget),
        ).rejects.toThrow('STATE');
      } finally {
        await lockingClient.query('rollback');
        lockingClient.release();
      }
      const preState = validateLocationPhotoState(physicalPreReadback, 'pre', physicalTarget) as {
        target: { databaseName: string; systemIdentifier: string };
      };
      const migratorUrl = new URL(targetUrl);
      migratorUrl.username = roles.migrator;
      migratorUrl.password = password;
      expect(
        validateLocationPhotoMigratorReadback(
          await runMigratorProbe(migratorUrl.toString(), 'pre', roles),
          'pre',
          preState.target,
        ),
      ).toBeTruthy();
      expect(await parentReferenceAcl(target, roles)).toEqual([]);
      expect(await parentColumnAclObjects(target)).toEqual([]);
      await roleGuard(target, 'location-photo-role-bootstrap-0102.sql', roles);
      const bootstrapReadback = (await state(target, 'bootstrap', roles)) as {
        privileges: Record<string, unknown>;
        hazards: Record<string, unknown>;
      };
      expect(bootstrapReadback.privileges).toEqual({
        migratorUsage: true,
        migratorCreate: true,
        migratorPublicUsage: true,
        migratorPublicCreate: true,
        migratorProfilesReferenceColumns: ['id', 'tenant_id'],
        migratorMediaReferenceColumns: ['id', 'tenant_id'],
        migratorParentReferenceAcl: [
          ['locations.media_assets', 'id'],
          ['locations.media_assets', 'tenant_id'],
          ['locations.profiles', 'id'],
          ['locations.profiles', 'tenant_id'],
        ].map(([relation, column]) => ({
          relation,
          column,
          grantor: 'phub_beta',
          grantee: 'phub_migrator',
          privilege: 'REFERENCES',
          grantable: false,
        })),
        parentColumnAclCount: 4,
        runtimeUsage: true,
        runtimeProfilesSelect: true,
        runtimeMediaSelect: true,
      });
      expect(bootstrapReadback.hazards).toEqual({
        migrationLockHeld: false,
        longTransactions: 0,
        conflictingLocks: 0,
      });
      const bootstrapState = validateLocationPhotoState(
        bootstrapReadback,
        'bootstrap',
        physicalTarget,
      ) as {
        target: { databaseName: string; systemIdentifier: string };
      };
      expect(bootstrapState).toBeTruthy();
      expect(
        validateLocationPhotoMigratorReadback(
          await runMigratorProbe(migratorUrl.toString(), 'bootstrap', roles),
          'bootstrap',
          bootstrapState.target,
        ),
      ).toBeTruthy();
      expect(await parentReferenceAcl(target, roles)).toEqual(
        [
          ['locations.media_assets', 'id'],
          ['locations.media_assets', 'tenant_id'],
          ['locations.profiles', 'id'],
          ['locations.profiles', 'tenant_id'],
        ].map(([relation, column]) => ({
          relation,
          column,
          grantor: roles.owner,
          grantee: roles.migrator,
          privilege: 'REFERENCES',
          grantable: false,
        })),
      );
      expect(await parentColumnAclObjects(target)).toEqual([
        { relation: 'locations.media_assets', column: 'id' },
        { relation: 'locations.media_assets', column: 'tenant_id' },
        { relation: 'locations.profiles', column: 'id' },
        { relation: 'locations.profiles', column: 'tenant_id' },
      ]);

      // The failed-migration recovery path must remove every temporary privilege at ledger 105.
      await roleGuard(target, 'location-photo-role-cleanup-0102.sql', roles);
      expect(
        validateLocationPhotoState(await state(target, 'pre', roles), 'pre', physicalTarget),
      ).toBeTruthy();
      expect(await parentReferenceAcl(target, roles)).toEqual([]);
      expect(await parentColumnAclObjects(target)).toEqual([]);

      // A new operation can bootstrap the same exact clean preimage before the ordinary runner.
      await roleGuard(target, 'location-photo-role-bootstrap-0102.sql', roles);
      expect(
        validateLocationPhotoState(
          await state(target, 'bootstrap', roles),
          'bootstrap',
          physicalTarget,
        ),
      ).toBeTruthy();

      const applied = await runOrdinaryMigrator(fixture106, migratorUrl.toString());
      expect(applied.stdout).toContain(`Applied ${migration}`);
      const postReadback = (await state(target, 'post', roles)) as {
        ledger: Array<{ filename: string; checksum: string }>;
      };
      expect(postReadback.ledger).toHaveLength(106);
      expect(postReadback.ledger.at(-1)).toEqual({
        filename: migration,
        checksum: '8817a4dab03e78d27023d4b3ee72a12bfa8f2ffe4599e4e78df1d3a3893366f0',
      });
      expect(
        createHash('sha256')
          .update(
            JSON.stringify(postReadback.ledger.map((row) => [row.filename, row.checksum])) + '\n',
          )
          .digest('hex'),
      ).toBe('ff74c193b5e5253f929818b1550d0e5c0264a9818cb0ee5437d49d5aa043904e');
      expect(validateLocationPhotoState(postReadback, 'post', physicalTarget)).toBeTruthy();

      const privileges = await target.query<Record<string, boolean>>(
        `select has_table_privilege($1,'locations.recommendation_card_photos','SELECT') as select,
                  has_table_privilege($1,'locations.recommendation_card_photos','INSERT') as insert,
                  has_table_privilege($1,'locations.recommendation_card_photos','UPDATE') as update,
                  has_table_privilege($1,'locations.recommendation_card_photos','DELETE') as delete,
                  has_table_privilege($1,'locations.recommendation_card_photos','TRUNCATE') as truncate,
                  has_table_privilege($1,'locations.recommendation_card_photos','REFERENCES') as references,
                  has_table_privilege($1,'locations.recommendation_card_photos','TRIGGER') as trigger`,
        [roles.runtime],
      );
      expect(privileges.rows[0]).toEqual({
        select: false,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      });

      await roleGuard(target, 'location-photo-role-cleanup-0102.sql', roles);
      expect(
        validateLocationPhotoState(
          await state(target, 'cleanup', roles),
          'cleanup',
          physicalTarget,
        ),
      ).toBeTruthy();
      expect(await parentReferenceAcl(target, roles)).toEqual([]);
      expect(await parentColumnAclObjects(target)).toEqual([]);

      const rejectsCatalog = async (tamper: string) => {
        const client = await target!.connect();
        try {
          await client.query('begin');
          await client.query(tamper);
          await expect(async () =>
            validateLocationPhotoState(
              await state(client, 'cleanup', roles, false),
              'cleanup',
              physicalTarget,
            ),
          ).rejects.toThrow('PHOTO_CATALOG');
        } finally {
          await client.query('rollback');
          client.release();
        }
      };
      await rejectsCatalog(
        'alter table locations.recommendation_card_photos alter column is_active set default true',
      );
      await rejectsCatalog(
        `alter table locations.recommendation_card_photos drop constraint recommendation_card_photos_sort_order_check;
           alter table locations.recommendation_card_photos add constraint recommendation_card_photos_sort_order_check check (sort_order between 0 and 98)`,
      );
      await rejectsCatalog(
        `drop policy location_recommendation_card_photos_tenant_isolation on locations.recommendation_card_photos;
           create policy location_recommendation_card_photos_tenant_isolation on locations.recommendation_card_photos using (tenant_id = nullif(current_setting('app.other_tenant_id',true),'')::uuid) with check (tenant_id = nullif(current_setting('app.other_tenant_id',true),'')::uuid)`,
      );
      await rejectsCatalog(
        `drop index locations.locations_recommendation_card_photos_read_idx;
           create index locations_recommendation_card_photos_read_idx on locations.recommendation_card_photos (tenant_id,location_id,event_type,sort_order,asset_id)`,
      );
      await rejectsCatalog(
        `alter table locations.recommendation_card_photos drop constraint recommendation_card_photos_tenant_id_asset_id_fkey;
           alter table locations.recommendation_card_photos add constraint recommendation_card_photos_tenant_id_asset_id_fkey foreign key (tenant_id,asset_id) references locations.media_assets(tenant_id,id) on delete cascade`,
      );
      await rejectsCatalog(
        'alter table locations.recommendation_card_photos add column generated_tamper integer generated always as (sort_order + 1) stored',
      );
      await rejectsCatalog(
        'create rule recommendation_card_photos_insert_tamper as on insert to locations.recommendation_card_photos do instead nothing',
      );
      expect(
        validateLocationPhotoState(
          await state(target, 'cleanup', roles),
          'cleanup',
          physicalTarget,
        ),
      ).toBeTruthy();
    } finally {
      if (target) await target.end();
      await admin
        .query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',
          [database],
        )
        .catch(() => undefined);
      await admin.query(`drop database if exists ${identifier(database)}`).catch(() => undefined);
      await admin.query(`drop role if exists ${identifier(roles.runtime)}`).catch(() => undefined);
      await admin.query(`drop role if exists ${identifier(roles.migrator)}`).catch(() => undefined);
      await admin.end();
      await rm(fixture105, { recursive: true, force: true });
      await rm(fixture106, { recursive: true, force: true });
    }
  }, 150_000);
});
