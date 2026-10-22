import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import frozen from '../../../deploy/timeweb/notification-migration-catalogs.v1.json';
import {
  afterNotificationSql,
  beforeNotificationStep,
  catalogDigest,
  notificationBuilderSha256,
  notificationCatalog,
  notificationDefaultAcls,
  notificationLedger,
  notificationModeArgument,
  notificationRole,
  notificationPackageSha256,
  verifyNotificationTableSecurity,
  type CatalogRow,
} from './notification-migration.js';
import {
  NOTIFICATION_CATALOG_VERSION,
  NOTIFICATION_NEW_TABLES,
} from '../../../scripts/notification-migration-catalog.js';
import { notificationLedgerCheckpoint } from '../../../scripts/notification-migration-package.js';

function disposableUrl(): string | undefined {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.DATABASE_URL
  )
    return undefined;
  const value = new URL(process.env.DATABASE_URL);
  if (
    !['127.0.0.1', 'localhost'].includes(value.hostname) ||
    value.username !== 'phub' ||
    value.port !== '5432' ||
    value.pathname !== '/phub'
  )
    throw new Error('NOTIFICATION_TEST_DISPOSABLE_DATABASE_REQUIRED');
  return value.toString();
}
const url = disposableUrl();
(url ? describe : describe.skip)(
  'notification package on exact mixed-owner disposable PG16',
  () => {
    it('rehearses role bootstrap, atomic ACL protection, every failed step, independent catalog and the strict runner', async () => {
      const admin = new Pool({ connectionString: url, max: 2 });
      const directory = await mkdtemp(resolve(tmpdir(), 'notification-migration-'));
      const source = resolve(process.cwd(), 'packages/database/migrations');
      const all = (await readdir(source)).filter((f) => f.endsWith('.sql')).sort();
      const passwords = {
        phub_beta: randomUUID(),
        phub_runtime: randomUUID(),
        phub_migrator: randomUUID(),
      };
      const ownedRoles: string[] = [],
        databases: string[] = [];
      const pools: Pool[] = [];
      const checkpoints: Record<string, { sha256: string; rows: CatalogRow[] }> = {};
      const frozenReady = Object.keys(frozen.checkpoints).length === 4;
      const cli = (cwd: string, connectionString: string, args: string[] = []) =>
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            resolve('node_modules/tsx/dist/loader.mjs'),
            resolve('apps/migrator/src/main.ts'),
            ...args,
          ],
          {
            cwd,
            timeout: 120000,
            maxBuffer: 1000000,
            env: {
              PATH: process.env.PATH ?? '',
              DATABASE_URL: connectionString,
              TSX_TSCONFIG_PATH: resolve('tsconfig.json'),
              CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
            },
          },
        );
      async function securityRestoreRehearsal(db: Pool, database: string) {
        const sql = await readFile(resolve('scripts/notification-backup-security.sql'), 'utf8');
        const source = await db.connect();
        let security: Record<string, unknown> | undefined;
        try {
          await source.query('begin read only');
          await source.query("set local search_path='pg_catalog'");
          security = (await source.query<Record<string, unknown>>(sql)).rows[0];
        } finally {
          await source.query('rollback');
          source.release();
        }
        // The single json column is driver-decoded by pg.
        const value = Object.values(security!)[0];
        const preparation = execFileSync(
          'python3',
          [
            '-I',
            '-S',
            '-B',
            '-c',
            "import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('backup','scripts/control-timeweb-database-backup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);sys.stdout.write(m.notification_restore_prerequisites(json.load(sys.stdin)))",
          ],
          { input: JSON.stringify(value), encoding: 'utf8', timeout: 10000, maxBuffer: 4000000 },
        );
        const sourceIds = execFileSync(
          'docker',
          ['ps', '-q', '--no-trunc', '--filter', 'ancestor=postgres:16-alpine'],
          { encoding: 'utf8', timeout: 10000 },
        )
          .trim()
          .split('\n');
        if (sourceIds.length !== 1 || !/^[a-f0-9]{64}$/.test(sourceIds[0]!))
          throw Error('NOTIFICATION_CI_POSTGRES_IDENTITY');
        const sourceId = sourceIds[0]!,
          imageId = execFileSync('docker', ['inspect', '--format', '{{.Image}}', sourceId], {
            encoding: 'utf8',
            timeout: 10000,
          }).trim();
        const dump = execFileSync(
          'docker',
          [
            'exec',
            sourceId,
            'pg_dump',
            '--username=phub',
            '--dbname=' + database,
            '--format=custom',
            '--serializable-deferrable',
          ],
          { timeout: 30000, maxBuffer: 16000000 },
        );
        const name = 'notification-security-' + randomUUID();
        let id: string | undefined;
        try {
          id = execFileSync(
            'docker',
            [
              'create',
              '--pull',
              'never',
              '--name',
              name,
              '--network',
              'none',
              '--read-only',
              '--restart',
              'no',
              '--user',
              'postgres',
              '--cap-drop',
              'ALL',
              '--security-opt',
              'no-new-privileges:true',
              '--pids-limit',
              '128',
              '--memory',
              '1g',
              '--memory-swap',
              '1g',
              '--cpus',
              '1',
              '--tmpfs',
              '/var/lib/postgresql/data:rw,nosuid,nodev,mode=1777,size=536870912',
              '--tmpfs',
              '/var/run/postgresql:rw,nosuid,nodev,mode=1777,size=16777216',
              '--tmpfs',
              '/tmp:rw,nosuid,nodev,mode=1777,size=16777216',
              '--env',
              'PGDATA=/var/lib/postgresql/data/restore',
              '--env',
              'POSTGRES_USER=phub_restore',
              '--env',
              'POSTGRES_DB=phub_restore',
              '--env',
              'POSTGRES_HOST_AUTH_METHOD=trust',
              imageId,
            ],
            { encoding: 'utf8', timeout: 10000 },
          ).trim();
          execFileSync('docker', ['start', id], { timeout: 10000, stdio: 'pipe' });
          let ready = false;
          for (let i = 0; i < 45; i++) {
            try {
              execFileSync(
                'docker',
                [
                  'exec',
                  id,
                  'pg_isready',
                  '--host=127.0.0.1',
                  '--username=phub_restore',
                  '--dbname=phub_restore',
                ],
                { timeout: 3000, stdio: 'pipe' },
              );
              ready = true;
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 200));
            }
          }
          if (!ready) throw Error('NOTIFICATION_CI_RESTORE_READY');
          const psql = [
            'exec',
            '-i',
            id,
            'psql',
            '-X',
            '--username=phub_restore',
            '--dbname=phub_restore',
            '--no-psqlrc',
            '-qAt',
            '--set=ON_ERROR_STOP=1',
          ];
          execFileSync('docker', psql, {
            input: preparation,
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          execFileSync(
            'docker',
            [
              'exec',
              '-i',
              id,
              'pg_restore',
              '--username=phub_restore',
              '--dbname=phub_restore',
              '--exit-on-error',
              '--single-transaction',
            ],
            { input: dump, timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] },
          );
          const ownerSql = execFileSync(
            'python3',
            [
              '-I',
              '-S',
              '-B',
              '-c',
              "import importlib.util,json,sys;spec=importlib.util.spec_from_file_location('backup','scripts/control-timeweb-database-backup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);sys.stdout.write(m.notification_restore_extension_owners(json.load(sys.stdin)))",
            ],
            { input: JSON.stringify(value), encoding: 'utf8', timeout: 10000, maxBuffer: 4000000 },
          );
          execFileSync('docker', psql, {
            input: ownerSql,
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const restored = JSON.parse(
            execFileSync('docker', psql, {
              input: "set search_path='pg_catalog';\n" + sql,
              encoding: 'utf8',
              timeout: 15000,
              maxBuffer: 4000000,
            }),
          ) as unknown;
          expect(restored).toEqual(value);
        } finally {
          if (id)
            execFileSync('docker', ['rm', '--force', '--volumes', id], {
              timeout: 15000,
              stdio: 'pipe',
            });
        }
      }
      async function setup(suffix: string) {
        const database = `notification_${suffix}_${randomUUID().replaceAll('-', '')}`;
        await admin.query(`create database ${database}`);
        databases.push(database);
        const cwd = resolve(directory, suffix);
        await mkdir(resolve(cwd, 'migrations'), { recursive: true });
        for (const file of all.slice(0, 102))
          await copyFile(resolve(source, file), resolve(cwd, 'migrations', file));
        const adminUrl = new URL(url!);
        adminUrl.pathname = `/${database}`;
        await cli(cwd, adminUrl.toString());
        const db = new Pool({ connectionString: adminUrl.toString(), max: 2 });
        pools.push(db);
        // Preserve synthetic pre-existing identity/support data as well as their original ACLs.
        const tenant = randomUUID(),
          user = randomUUID(),
          credential = randomUUID(),
          session = randomUUID(),
          ticket = randomUUID();
        await db.query(
          "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic migration')",
          [tenant, `notification-${tenant}`],
        );
        await db.query('insert into identity.users(tenant_id,id) values($1,$2)', [tenant, user]);
        const encoded =
          'phub-scrypt-v1$131072$8$1$' +
          Buffer.alloc(16, 1).toString('base64url') +
          '$' +
          Buffer.alloc(64, 1).toString('base64url');
        await db.query(
          'insert into identity.local_email_credentials(id,tenant_id,user_id,email_key,password_hash,email_verified_at) values($1,$2,$3,$4,$5,now())',
          [credential, tenant, user, `${user}@example.test`, encoded],
        );
        await db.query(
          "insert into identity.refresh_sessions(id,tenant_id,user_id,family_id,token_hash,expires_at) values($1,$2,$3,$1,$4,now()+interval '1 day')",
          [session, tenant, user, createHash('sha256').update(session).digest('hex')],
        );
        await db.query(
          "insert into support.tickets(tenant_id,id,owner_user_id,subject,category) values($1,$2,$3,'Synthetic migration','ACCOUNT')",
          [tenant, ticket, user],
        );
        await db.query(
          "insert into support.messages(tenant_id,ticket_id,body,author_id,author_role) values($1,$2,'Synthetic preserved message',$3,'USER')",
          [tenant, ticket, user],
        );
        const template = randomUUID(),
          intent = randomUUID();
        await db.query(
          `insert into notifications.templates(tenant_id,id,template_key,version,category,channels,title_template,body_template)
          values($1,$2,'synthetic.migration',1,'SYSTEM',array['IN_APP'],'Synthetic','Preserved')`,
          [tenant, template],
        );
        await db.query(
          `insert into notifications.intents(tenant_id,id,recipient_user_id,source_event_id,template_id,dedupe_key,rendered_title,rendered_body)
          values($1,$2,$3,$4,$5,$6,'Synthetic','Preserved')`,
          [tenant, intent, user, randomUUID(), template, randomUUID()],
        );
        await db.query(
          `insert into notifications.deliveries(tenant_id,intent_id,channel) values($1,$2,'IN_APP')`,
          [tenant, intent],
        );
        await db.query('alter schema notifications owner to phub_beta');
        for (const name of [
          'identity.tenants',
          'identity.users',
          'notifications.templates',
          'notifications.intents',
          'notifications.deliveries',
        ])
          await db.query(`alter table ${name} owner to phub_beta`);
        for (const name of [
          'public.schema_migrations',
          'identity.local_email_credentials',
          'support.tickets',
          'support.messages',
        ])
          await db.query(`alter table ${name} owner to phub_migrator`);
        await db.query('grant usage,create on schema public,identity,support to phub_migrator');
        await db.query(
          'grant usage on schema identity,profile,notifications,support to phub_runtime',
        );
        await db.query('grant references (id) on identity.tenants to phub_migrator');
        await db.query('grant references (tenant_id,id) on identity.users to phub_migrator');
        await db.query(
          'grant execute on function pg_catalog.pg_control_system() to phub_migrator,phub_runtime',
        );
        const betaUrl = new URL(adminUrl);
        betaUrl.username = 'phub_beta';
        betaUrl.password = passwords.phub_beta;
        const beta = new Pool({ connectionString: betaUrl.toString(), max: 1 });
        pools.push(beta);
        await beta.query(
          'grant select,insert,update,delete on notifications.deliveries to phub_runtime',
        );
        const migratorUrl = new URL(adminUrl);
        migratorUrl.username = 'phub_migrator';
        migratorUrl.password = passwords.phub_migrator;
        const migrator = new Pool({ connectionString: migratorUrl.toString(), max: 1 });
        pools.push(migrator);
        await migrator.query(
          'grant select,insert,update,delete on support.tickets,support.messages,identity.local_email_credentials to phub_runtime',
        );
        await migrator.query(
          'alter default privileges in schema identity grant select,insert,update,delete on tables to phub_runtime',
        );
        const runtimeUrl = new URL(adminUrl);
        runtimeUrl.username = 'phub_runtime';
        runtimeUrl.password = passwords.phub_runtime;
        const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
        pools.push(runtime);
        for (const file of all.slice(102))
          await copyFile(resolve(source, file), resolve(cwd, 'migrations', file));
        const target = {
          databaseName: database,
          systemIdentifier: (
            await db.query<{ id: string }>(
              'select system_identifier::text as id from pg_control_system()',
            )
          ).rows[0]!.id,
        };
        const args = [
          notificationModeArgument,
          Buffer.from(JSON.stringify(target)).toString('base64'),
        ];
        const baseline = async () =>
          (
            await db.query<Record<string, unknown>>(`select
        (select jsonb_agg(to_jsonb(c)) from identity.local_email_credentials c) as credentials,
        (select jsonb_agg(to_jsonb(s)) from identity.refresh_sessions s) as sessions,
        (select jsonb_agg(to_jsonb(t)-'internal_only') from support.tickets t) as tickets,
        (select jsonb_agg(to_jsonb(m)) from support.messages m) as messages,
        (select jsonb_agg(to_jsonb(d)-array['scenario_available_at','scenario_dispatch_started_at','scenario_v2_available_at']) from notifications.deliveries d) as deliveries,
        (select relacl::text from pg_class where oid='identity.local_email_credentials'::regclass) as credential_acl`)
          ).rows;
        if (suffix === 'backup') await securityRestoreRehearsal(db, database);
        const bootstrap = await readFile(
          resolve('deploy/timeweb/notification-role-bootstrap-0105.sql'),
          'utf8',
        );
        for (const grant of [
          'grant phub_migrator to notification_outside',
          'grant notification_outside to phub_migrator',
        ]) {
          await db.query(grant);
          try {
            await expect(beta.query(bootstrap)).rejects.toMatchObject({
              message: 'NOTIFICATION_BOOTSTRAP_ROLE',
            });
            await beta.query('rollback');
          } finally {
            await db.query(grant.replace('grant ', 'revoke ').replace(' to ', ' from '));
          }
        }
        await beta.query(bootstrap);
        const inverse = await readFile(
          resolve('deploy/timeweb/notification-role-bootstrap-0105-inverse.sql'),
          'utf8',
        );
        await beta.query(inverse);
        await beta.query(bootstrap);
        for (const grant of [
          'grant phub_migrator to notification_outside',
          'grant notification_outside to phub_migrator',
        ]) {
          await db.query(grant);
          try {
            await expect(notificationRole(migrator)).rejects.toThrow('NOTIFICATION_MIGRATION_ROLE');
          } finally {
            await db.query(grant.replace('grant ', 'revoke ').replace(' to ', ' from '));
          }
        }
        await beta.query(
          'grant references (tenant_id) on notifications.templates to phub_migrator with grant option',
        );
        await expect(notificationRole(migrator)).rejects.toThrow('NOTIFICATION_MIGRATION_ROLE');
        await beta.query(
          'revoke grant option for references (tenant_id) on notifications.templates from phub_migrator',
        );
        await migrator.query(
          'alter default privileges in schema notifications grant execute on functions to phub_runtime',
        );
        await expect(notificationRole(migrator)).rejects.toThrow('NOTIFICATION_MIGRATION_ROLE');
        await migrator.query(
          'alter default privileges in schema notifications revoke execute on functions from phub_runtime',
        );
        await notificationRole(migrator);
        await expect(
          beta.query(
            await readFile(resolve('deploy/timeweb/notification-role-bootstrap-0105.sql'), 'utf8'),
          ),
        ).rejects.toMatchObject({ message: 'NOTIFICATION_BOOTSTRAP_OWNER_PREIMAGE' });
        await beta.query('rollback');
        return {
          db,
          beta,
          migrator,
          runtime,
          cwd,
          args,
          target,
          baseline,
          migratorUrl: migratorUrl.toString(),
          betaUrl: betaUrl.toString(),
        };
      }
      try {
        // Reverse relative role creation order to catch accidental OID ordering in golden ACL arrays.
        for (const name of ['phub_beta', 'phub_runtime', 'phub_migrator'] as const) {
          expect(
            (await admin.query('select 1 from pg_roles where rolname=$1', [name])).rowCount,
          ).toBe(0);
          await admin.query(
            `create role ${name} login password '${passwords[name]}' ${name === 'phub_beta' ? 'superuser bypassrls createdb createrole' : 'nosuperuser nobypassrls nocreatedb nocreaterole'} inherit`,
          );
          ownedRoles.push(name);
        }
        await admin.query('create role notification_outside nologin');
        ownedRoles.push('notification_outside');
        const f = await setup('reference');
        const original = await f.baseline();
        const defaults = await notificationDefaultAcls(f.migrator);
        const capture = async (count: number) => {
          const client = await f.migrator.connect();
          await client.query('begin read only');
          try {
            const rows = await notificationCatalog(client);
            checkpoints[String(count)] = { rows, sha256: catalogDigest(rows) };
          } finally {
            await client.query('rollback');
            client.release();
          }
        };
        await capture(102);
        await expect(cli(f.cwd, f.migratorUrl)).rejects.toThrow(
          'NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED',
        );
        await expect(cli(f.cwd, f.betaUrl)).rejects.toThrow(
          'NOTIFICATION_MIGRATION_CONTROLLER_REQUIRED',
        );
        for (const position of ['afterRevoke', 'afterSql', 'afterRestore'] as const) {
          const client = await f.migrator.connect();
          await client.query('begin');
          try {
            const pre = await beforeNotificationStep(client, all[102]!);
            if (position !== 'afterRevoke')
              await client.query(await readFile(resolve(source, all[102]!), 'utf8'));
            if (position === 'afterRestore') await afterNotificationSql(client, all[102]!, pre);
            await expect(client.query('select 1/0')).rejects.toMatchObject({ code: '22012' });
          } finally {
            await client.query('rollback');
            client.release();
          }
          expect(await notificationDefaultAcls(f.migrator)).toEqual(defaults);
          expect(notificationLedgerCheckpoint(await notificationLedger(f.db))).toBe(102);
          expect(
            (
              await f.db.query<{ relation: string | null }>(
                "select to_regclass('identity.local_password_reset_proofs') as relation",
              )
            ).rows[0]?.relation,
          ).toBeNull();
        }
        for (const [i, collision] of [
          'identity.local_password_reset_receipts',
          'notifications.scenario_runs',
          'notifications.scenario_source_sync',
        ].entries()) {
          const filename = all[102 + i]!,
            sql = await readFile(resolve(source, filename), 'utf8');
          const ledger = (
            await f.db.query<Record<string, unknown>>(
              'select filename,checksum,applied_at from schema_migrations order by filename',
            )
          ).rows;
          await f.db.query(`create table ${collision}(wrong integer)`);
          const client = await f.migrator.connect();
          await client.query('begin');
          const beforeFailure = await notificationCatalog(client);
          try {
            await beforeNotificationStep(client, filename);
            await expect(client.query(sql)).rejects.toMatchObject({ code: '42P07' });
          } finally {
            await client.query('rollback');
            client.release();
          }
          const check = await f.migrator.connect();
          await check.query('begin read only');
          try {
            expect(await notificationCatalog(check)).toEqual(beforeFailure);
          } finally {
            await check.query('rollback');
            check.release();
          }
          expect(
            (
              await f.db.query(
                'select filename,checksum,applied_at from schema_migrations order by filename',
              )
            ).rows,
          ).toEqual(ledger);
          expect(await notificationDefaultAcls(f.migrator)).toEqual(defaults);
          await f.db.query(`drop table ${collision}`);
          const step = await f.migrator.connect();
          await step.query('begin');
          try {
            const pre = await beforeNotificationStep(step, filename);
            await step.query(sql);
            await afterNotificationSql(step, filename, pre);
            await step.query(
              'insert into public.schema_migrations(filename,checksum) values($1,$2)',
              [filename, createHash('sha256').update(sql).digest('hex')],
            );
            expect(notificationLedgerCheckpoint(await notificationLedger(step))).toBe(103 + i);
            await step.query('commit');
          } catch (error) {
            await step.query('rollback');
            throw error;
          } finally {
            step.release();
          }
          await capture(103 + i);
          expect(await f.baseline()).toEqual(original);
          if (i > 0)
            expect(
              (
                await f.db.query(`select count(*)::int as count from notifications.deliveries
            where scenario_available_at is not null or scenario_dispatch_started_at is not null ${i > 1 ? 'or scenario_v2_available_at is not null' : ''}`)
              ).rows,
            ).toEqual([{ count: 0 }]);
          expect(await notificationDefaultAcls(f.migrator)).toEqual(defaults);
          if (i < 2)
            await expect(cli(f.cwd, f.migratorUrl, f.args)).rejects.toThrow(
              'PARTIAL_REQUIRES_OWNER_RECONCILIATION',
            );
        }
        await verifyNotificationTableSecurity(f.migrator, NOTIFICATION_NEW_TABLES);
        for (const table of NOTIFICATION_NEW_TABLES)
          await expect(f.runtime.query(`select 1 from ${table} limit 1`)).rejects.toMatchObject({
            code: '42501',
          });
        const generated = {
          schema: 'PHUB_NOTIFICATION_MIGRATION_CATALOGS_V1',
          postgresMajor: 16,
          packageDescriptorSha256: notificationPackageSha256,
          builderVersion: NOTIFICATION_CATALOG_VERSION,
          builderSha256: notificationBuilderSha256,
          checkpoints,
        };
        if (!frozenReady) {
          const bytes = Buffer.from(JSON.stringify(generated)).toString('base64');
          for (let i = 0; i < bytes.length; i += 20000)
            console.log(`NOTIFICATION_GOLDEN_CHUNK_${i / 20000}:${bytes.slice(i, i + 20000)}`);
          console.log(
            `NOTIFICATION_GOLDEN_COMPLETE:${createHash('sha256').update(JSON.stringify(generated)).digest('hex')}`,
          );
          await expect(cli(f.cwd, f.migratorUrl, f.args)).rejects.toThrow('GOLDEN');
        } else {
          expect(generated).toEqual(frozen);
          const r = await setup('runner');
          const preserved = await r.baseline();
          await expect(
            cli(r.cwd, r.migratorUrl, [
              notificationModeArgument,
              Buffer.from(JSON.stringify({ ...r.target, systemIdentifier: '1' })).toString(
                'base64',
              ),
            ]),
          ).rejects.toThrow('NOTIFICATION_MIGRATION_TARGET');
          await expect(cli(r.cwd, r.betaUrl, r.args)).rejects.toThrow(
            'NOTIFICATION_MIGRATION_ROLE',
          );
          const changed = resolve(r.cwd, 'migrations', all[103]!);
          const originalSql = await readFile(changed, 'utf8');
          await writeFile(changed, originalSql + '\n-- owned checksum drift\n');
          await expect(cli(r.cwd, r.migratorUrl, r.args)).rejects.toMatchObject({ code: 1 });
          await writeFile(changed, originalSql);
          const extra = resolve(r.cwd, 'migrations', '0102_unexpected.sql');
          await writeFile(extra, 'select 1;');
          await expect(cli(r.cwd, r.migratorUrl, r.args)).rejects.toMatchObject({ code: 1 });
          await rm(extra);
          expect((await cli(r.cwd, r.migratorUrl, r.args)).stdout.trim().split('\n')).toHaveLength(
            3,
          );
          expect(notificationLedgerCheckpoint(await notificationLedger(r.db))).toBe(105);
          const ledger = (
            await r.db.query<Record<string, unknown>>(
              'select filename,checksum,applied_at from schema_migrations order by filename',
            )
          ).rows;
          expect((await cli(r.cwd, r.migratorUrl, r.args)).stdout.trim()).toBe('');
          expect(
            (
              await r.db.query(
                'select filename,checksum,applied_at from schema_migrations order by filename',
              )
            ).rows,
          ).toEqual(ledger);
          expect(await r.baseline()).toEqual(preserved);
          await verifyNotificationTableSecurity(r.migrator, NOTIFICATION_NEW_TABLES);
          for (const table of NOTIFICATION_NEW_TABLES)
            await expect(r.runtime.query(`select 1 from ${table} limit 1`)).rejects.toMatchObject({
              code: '42501',
            });
        }
        // Keep both independent acceptance checks: emit the SQL catalog before the full restore
        // rehearsal, so a restore failure retains useful reference diagnostics without a live GO.
        await setup('backup');
      } finally {
        await Promise.all(pools.map((p) => p.end()));
        for (const database of databases.reverse()) await admin.query(`drop database ${database}`);
        for (const role of ownedRoles.reverse()) await admin.query(`drop role ${role}`);
        await admin.end();
        await rm(directory, { recursive: true, force: true });
      }
    }, 120000);
  },
);
