import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIdentityAuthRepository,
  revokeAllRefreshSessionsForUserInTransaction,
} from './auth-repository.js';
import { withTenantTransaction } from './connection.js';
import {
  createLocalPasswordLoginRepository,
  type LocalPasswordLoginInput,
} from './local-password-login-repository.js';

function ciDatabase() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.DATABASE_URL
  )
    return undefined;
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.port !== '5432'
  )
    throw new Error('PASSWORD_TEST_DISPOSABLE_DATABASE_REQUIRED');
  return url.toString();
}
const url = ciDatabase();
const adminUrl = url;
const suite = url ? describe : describe.skip;
suite('LOCAL password login under non-owner PostgreSQL role', () => {
  const admin = new Pool({ connectionString: url, max: 5 });
  const tenantId = randomUUID();
  const otherTenant = randomUUID();
  const role = `password_test_${randomUUID().replaceAll('-', '')}`;
  const rolePassword = randomUUID();
  let runtime: Pool;
  let repository: ReturnType<typeof createLocalPasswordLoginRepository>;
  const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
  const encoded = 'phub-scrypt-v1$131072$8$1$' + 'A'.repeat(22) + '$' + 'A'.repeat(86);
  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${rolePassword}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(`grant usage on schema identity, profile, audit to ${role}`);
    await admin.query(
      `grant select on identity.local_email_credentials, profile.user_summaries to ${role}`,
    );
    await admin.query(`grant select, update on identity.users to ${role}`);
    await admin.query(`grant select, insert, update on identity.refresh_sessions to ${role}`);
    await admin.query(`grant select, insert on identity.local_password_login_receipts to ${role}`);
    await admin.query(`grant insert on audit.audit_log to ${role}`);
    const runtimeUrl = new URL(url!);
    runtimeUrl.username = role;
    runtimeUrl.password = rolePassword;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 4 });
    repository = createLocalPasswordLoginRepository(runtime);
    await admin.query(
      `insert into identity.tenants (id, tenant_key, display_name)
      values ($1, $2, 'Synthetic password'), ($3, $4, 'Other synthetic password')`,
      [tenantId, `pw-${tenantId}`, otherTenant, `pw-${otherTenant}`],
    );
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    for (const tenant of [tenantId, otherTenant])
      await withTenantTransaction(admin, tenant, async (client) => {
        await client.query(
          'delete from identity.local_password_login_receipts where tenant_id = $1',
          [tenant],
        );
        await client.query('delete from audit.audit_log where tenant_id = $1', [tenant]);
        await client.query(
          'update identity.refresh_sessions set parent_session_id = null, rotated_at = null, replaced_by_session_id = null where tenant_id = $1',
          [tenant],
        );
        await client.query('delete from identity.refresh_sessions where tenant_id = $1', [tenant]);
        await client.query('delete from identity.local_email_credentials where tenant_id = $1', [
          tenant,
        ]);
        await client.query('delete from profile.user_summaries where tenant_id = $1', [tenant]);
        await client.query('delete from identity.users where tenant_id = $1', [tenant]);
      });
    await admin.query('delete from identity.tenants where id in ($1, $2)', [tenantId, otherTenant]);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
    await admin.end();
  });
  async function account(tenant = tenantId) {
    const userId = randomUUID();
    const credentialId = randomUUID();
    const emailKey = `${userId}@example.test`;
    await withTenantTransaction(admin, tenant, async (client) => {
      await client.query('insert into identity.users (tenant_id, id) values ($1, $2)', [
        tenant,
        userId,
      ]);
      await client.query(
        "insert into profile.user_summaries (tenant_id, user_id, display_name) values ($1, $2, 'Synthetic')",
        [tenant, userId],
      );
      // Synthetic enrollment belongs exclusively to this disposable administrator fixture.
      await client.query(
        `insert into identity.local_email_credentials (id, tenant_id, user_id, email_key, password_hash, email_verified_at)
        values ($1, $2, $3, $4, $5, now())`,
        [credentialId, tenant, userId, emailKey, encoded],
      );
    });
    return {
      tenantId: tenant,
      emailKey,
      credential: { id: credentialId, userId, generation: 1, passwordHash: encoded },
    };
  }
  async function input(): Promise<LocalPasswordLoginInput> {
    return {
      ...(await account()),
      commandKeyHash: hash(),
      requestHash: hash(),
      sessionId: randomUUID(),
      tokenHash: hash(),
      expiresAt: new Date(Date.now() + 86400000),
      correlationId: 'synthetic-password-pg-test',
    };
  }
  async function counts(userId: string) {
    return withTenantTransaction(
      admin,
      tenantId,
      async (client) =>
        (
          await client.query<{ sessions: number; receipts: number; audits: number }>(
            `select
      (select count(*)::integer from identity.refresh_sessions where tenant_id = $1 and user_id = $2) as sessions,
      (select count(*)::integer from identity.local_password_login_receipts where tenant_id = $1 and user_id = $2) as receipts,
      (select count(*)::integer from audit.audit_log where tenant_id = $1 and actor_id = $2 and action = 'AUTH_PASSWORD_SESSION_CREATED') as audits`,
            [tenantId, userId],
          )
        ).rows[0]!,
    );
  }
  it('creates exactly one stable session/receipt/audit under identical concurrent requests', async () => {
    const command = await input();
    const results = await Promise.all([
      repository.commitLogin(command),
      repository.commitLogin(command),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'replayed']);
    expect(results[0]).toMatchObject({
      sessionId: command.sessionId,
      expiresAt: command.expiresAt.toISOString(),
      user: { id: command.credential.userId },
    });
    expect(results[1]).toMatchObject({
      sessionId: command.sessionId,
      expiresAt: command.expiresAt.toISOString(),
    });
    expect(await counts(command.credential.userId)).toEqual({
      sessions: 1,
      receipts: 1,
      audits: 1,
    });
    const audit = await withTenantTransaction(
      admin,
      tenantId,
      async (client) =>
        (
          await client.query<{
            actor_id: string;
            resource_id: string;
            reason: string;
            old_value: unknown;
            new_value: unknown;
          }>(
            'select actor_id, resource_id, reason, old_value, new_value from audit.audit_log where tenant_id = $1 and resource_id = $2',
            [tenantId, command.sessionId],
          )
        ).rows[0],
    );
    expect(audit).toEqual({
      actor_id: command.credential.userId,
      resource_id: command.sessionId,
      reason: 'LOCAL_PASSWORD',
      old_value: null,
      new_value: null,
    });
  });
  it('does not create a session for stale generation/hash or disabled account/method', async () => {
    for (const kind of ['generation', 'hash', 'user', 'method']) {
      const command = await input();
      await withTenantTransaction(admin, tenantId, async (client) => {
        if (kind === 'user')
          await client.query("update identity.users set status = 'DISABLED' where id = $1", [
            command.credential.userId,
          ]);
        else
          await client.query(
            `update identity.local_email_credentials set ${kind === 'generation' ? 'generation = 2' : kind === 'hash' ? "password_hash = replace(password_hash, 'AAAA', 'BBBB')" : "status = 'DISABLED'"} where id = $1`,
            [command.credential.id],
          );
      });
      expect(await repository.commitLogin(command)).toEqual({ outcome: 'invalid' });
      expect(await counts(command.credential.userId)).toEqual({
        sessions: 0,
        receipts: 0,
        audits: 0,
      });
    }
  });
  it('rejects request conflict and rolls back a cross-account same-key race', async () => {
    const first = await input();
    const second = { ...(await input()), commandKeyHash: first.commandKeyHash };
    const results = await Promise.all([
      repository.commitLogin(first),
      repository.commitLogin(second),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['conflict', 'created']);
    const winner = results[0].outcome === 'created' ? first : second;
    const loser = winner === first ? second : first;
    expect(await counts(loser.credential.userId)).toEqual({ sessions: 0, receipts: 0, audits: 0 });
    expect(await repository.commitLogin({ ...winner, requestHash: hash() })).toEqual({
      outcome: 'conflict',
    });
    expect(await counts(winner.credential.userId)).toEqual({ sessions: 1, receipts: 1, audits: 1 });
  });
  it.each(['rotate', 'revoke', 'expire', 'reset', 'key'] as const)(
    'never replays after %s',
    async (kind) => {
      const command = await input();
      await repository.commitLogin(command);
      if (kind === 'rotate') {
        expect(
          (
            await createIdentityAuthRepository(runtime).rotateRefreshSession({
              tenantId,
              currentTokenHash: command.tokenHash,
              nextTokenHash: hash(),
              nextExpiresAt: new Date(Date.now() + 86400000),
              correlationId: command.correlationId,
            })
          ).outcome,
        ).toBe('rotated');
      } else if (kind === 'revoke') {
        await withTenantTransaction(admin, tenantId, (client) =>
          revokeAllRefreshSessionsForUserInTransaction(client, {
            tenantId,
            userId: command.credential.userId,
            reason: 'SECURITY_REVOKE_ALL',
            correlationId: command.correlationId,
          }),
        );
      } else if (kind === 'expire') {
        await withTenantTransaction(admin, tenantId, (client) =>
          client.query(
            "update identity.refresh_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1",
            [command.sessionId],
          ),
        );
      } else if (kind === 'reset') {
        await withTenantTransaction(admin, tenantId, (client) =>
          client.query(
            'update identity.local_email_credentials set generation = generation + 1 where id = $1',
            [command.credential.id],
          ),
        );
      }
      expect(
        await repository.commitLogin(
          kind === 'key' ? { ...command, tokenHash: hash(), sessionId: randomUUID() } : command,
        ),
      ).toEqual({ outcome: 'invalid' });
      expect((await counts(command.credential.userId)).receipts).toBe(1);
    },
  );
  it.each(['audit', 'receipt'] as const)(
    'rolls session creation back on %s write failure',
    async (kind) => {
      const table = kind === 'audit' ? 'audit.audit_log' : 'identity.local_password_login_receipts';
      const command = await input();
      await admin.query(`revoke insert on ${table} from ${role}`);
      try {
        await expect(repository.commitLogin(command)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query(`grant insert on ${table} to ${role}`);
      }
      expect(await counts(command.credential.userId)).toEqual({
        sessions: 0,
        receipts: 0,
        audits: 0,
      });
    },
  );
  async function waitForLock() {
    for (let i = 0; i < 100; i++) {
      const result = await admin.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where usename = $1 and wait_event_type = 'Lock'",
        [role],
      );
      if ((result.rows[0]?.n ?? 0) >= 1) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error('PASSWORD_TEST_USER_LOCK_NOT_OBSERVED');
  }
  it('reset wins the user lock: rejects a previously verified password snapshot', async () => {
    const command = await input();
    const blocker = await admin.connect();
    let login: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await blocker.query('select id from identity.users where id = $1 for update', [
        command.credential.userId,
      ]);
      login = repository.commitLogin(command);
      await waitForLock();
      await blocker.query(
        'update identity.local_email_credentials set generation = generation + 1 where id = $1',
        [command.credential.id],
      );
      await revokeAllRefreshSessionsForUserInTransaction(blocker, {
        tenantId,
        userId: command.credential.userId,
        reason: 'CREDENTIAL_RESET',
        correlationId: command.correlationId,
      });
      await blocker.query('commit');
      expect(await login).toEqual({ outcome: 'invalid' });
      expect(await counts(command.credential.userId)).toEqual({
        sessions: 0,
        receipts: 0,
        audits: 0,
      });
    } finally {
      await blocker.query('rollback');
      blocker.release();
      if (login) await login;
    }
  });
  it('login wins the lock: later reset revokes its new family and old proof cannot replay', async () => {
    const command = await input();
    await repository.commitLogin(command);
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query('select id from identity.users where id = $1 for update', [
        command.credential.userId,
      ]);
      await client.query(
        'update identity.local_email_credentials set generation = generation + 1 where id = $1',
        [command.credential.id],
      );
      expect(
        await revokeAllRefreshSessionsForUserInTransaction(client, {
          tenantId,
          userId: command.credential.userId,
          reason: 'CREDENTIAL_RESET',
          correlationId: command.correlationId,
        }),
      ).toMatchObject({ revokedSessionCount: 1 });
    });
    expect(await repository.commitLogin(command)).toEqual({ outcome: 'invalid' });
  });
  it('enforces tenant RLS and forbids the login role from enrolling or resetting credentials', async () => {
    const own = await account();
    const other = await account(otherTenant);
    const flags = (
      await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean }>(
        'select rolsuper, rolbypassrls, rolinherit from pg_roles where rolname = current_user',
      )
    ).rows[0];
    expect(flags).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false });
    expect(
      (await runtime.query('select * from identity.local_email_credentials')).rows,
    ).toHaveLength(0);
    expect(
      (await runtime.query('select * from identity.local_password_login_receipts')).rows,
    ).toHaveLength(0);
    expect(await repository.findCredential(tenantId, other.emailKey)).toBeUndefined();
    expect(await repository.findCredential(tenantId, own.emailKey)).toMatchObject(own.credential);
    for (const sql of [
      'insert into identity.local_email_credentials (id) values (gen_random_uuid())',
      'update identity.local_email_credentials set generation = generation + 1',
    ])
      await expect(
        withTenantTransaction(runtime, tenantId, (client) => client.query(sql)),
      ).rejects.toMatchObject({ code: '42501' });
    const command = await input();
    await repository.commitLogin(command);
    const insert = `insert into identity.local_password_login_receipts
      (tenant_id, command_key_hash, request_hash, derivation_version, user_id, credential_id, credential_generation, session_id, expires_at)
      values ($1, $2, $3, 'LOCAL_PASSWORD_V1', $4, $5, 1, $6, $7)`;
    const values = [
      tenantId,
      hash(),
      command.requestHash,
      command.credential.userId,
      command.credential.id,
      command.sessionId,
      command.expiresAt,
    ];
    await expect(runtime.query(insert, values)).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, otherTenant, (client) => client.query(insert, values)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, otherTenant, (client) =>
        client.query(
          `insert into identity.local_password_login_receipts select tenant_id, $1, request_hash, derivation_version, user_id, credential_id, credential_generation, session_id, expires_at, created_at from identity.local_password_login_receipts where tenant_id = $2`,
          [hash(), tenantId],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    const catalog = (
      await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relname, relrowsecurity, relforcerowsecurity from pg_class where oid in ('identity.local_email_credentials'::regclass, 'identity.local_password_login_receipts'::regclass)",
      )
    ).rows;
    expect(catalog).toHaveLength(2);
    expect(catalog.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });
  it('rejects cross-user receipt/session ownership and later session reassignment', async () => {
    const first = await input();
    const second = await input();
    await repository.commitLogin(second);
    await expect(
      withTenantTransaction(admin, tenantId, (client) =>
        client.query(
          `insert into identity.local_password_login_receipts
      (tenant_id, command_key_hash, request_hash, derivation_version, user_id, credential_id, credential_generation, session_id, expires_at)
      values ($1, $2, $3, 'LOCAL_PASSWORD_V1', $4, $5, 1, $6, $7)`,
          [
            tenantId,
            first.commandKeyHash,
            first.requestHash,
            first.credential.userId,
            first.credential.id,
            second.sessionId,
            first.expiresAt,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withTenantTransaction(admin, tenantId, (client) =>
        client.query('update identity.refresh_sessions set user_id = $1 where id = $2', [
          first.credential.userId,
          second.sessionId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query('update identity.refresh_sessions set user_id = $1 where id = $2', [
        first.credential.userId,
        second.sessionId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects noncanonical binding/hash/generation and duplicate email enrollment', async () => {
    const command = await input();
    for (const value of [
      'A@example.test',
      'a@@example.test',
      'K@example.test',
      'a..b@example.test',
      'a@-example.test',
    ])
      await expect(
        withTenantTransaction(admin, tenantId, (client) =>
          client.query('update identity.local_email_credentials set email_key = $1 where id = $2', [
            value,
            command.credential.id,
          ]),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    for (const sql of ["password_hash = 'plaintext'", 'generation = 0'])
      await expect(
        withTenantTransaction(admin, tenantId, (client) =>
          client.query(`update identity.local_email_credentials set ${sql} where id = $1`, [
            command.credential.id,
          ]),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    const second = await input();
    await expect(
      withTenantTransaction(admin, tenantId, (client) =>
        client.query('update identity.local_email_credentials set email_key = $1 where id = $2', [
          command.emailKey,
          second.credential.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('upgrades 0096 with the canonical migrator, reapplies as no-op and rolls failed DDL back', async () => {
    // The connection is already restricted to the explicit local task fixture or Actions service.
    // Every destructive operation below names only this test-created random database.
    const database = `kya04_rehearsal_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(resolve(tmpdir(), 'kya04-migrations-'));
    const migrationDirectory = resolve(directory, 'packages/database/migrations');
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    let fixture: Pool | undefined;
    let created = false;
    const migration = '0097_local_email_password_login.sql';
    try {
      await admin.query(`create database ${database}`);
      created = true;
      fixture = new Pool({ connectionString: url.toString(), max: 2 });
      await mkdir(migrationDirectory, { recursive: true });
      const sourceDirectory = resolve(process.cwd(), 'packages/database/migrations');
      const predecessorFiles = (await readdir(sourceDirectory))
        .filter((name) => /^\d+.*\.sql$/.test(name) && name < migration)
        .sort();
      expect(predecessorFiles.at(-1)).toBe('0096_profile_contacts.sql');
      for (const filename of predecessorFiles) {
        await copyFile(resolve(sourceDirectory, filename), resolve(migrationDirectory, filename));
      }
      const migrate = () =>
        promisify(execFile)(
          process.execPath,
          [
            '--import',
            resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs'),
            resolve(process.cwd(), 'scripts/migrate.ts'),
          ],
          {
            cwd: directory,
            timeout: 120_000,
            maxBuffer: 1_000_000,
            env: {
              PATH: process.env.PATH ?? '',
              DATABASE_URL: url.toString(),
              TSX_TSCONFIG_PATH: resolve(process.cwd(), 'tsconfig.json'),
              CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
            },
          },
        );
      await migrate();
      expect(
        (
          await fixture.query<{ contacts: string | null }>(
            "select to_regclass('identity.local_email_credentials') as contacts",
          )
        ).rows[0]?.contacts,
      ).toBeNull();
      const before = (
        await fixture.query(
          'select filename, checksum, applied_at from schema_migrations order by filename',
        )
      ).rows;
      const legacyTenant = randomUUID();
      const legacyUser = randomUUID();
      const legacySession = randomUUID();
      await fixture.query(
        "insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, 'Synthetic upgrade')",
        [legacyTenant, `upgrade-${legacyTenant}`],
      );
      await fixture.query('insert into identity.users (tenant_id, id) values ($1, $2)', [
        legacyTenant,
        legacyUser,
      ]);
      await fixture.query(
        "insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164) values ($1, $2, 'Synthetic legacy', '+79990009997')",
        [legacyTenant, legacyUser],
      );
      await fixture.query(
        "insert into identity.external_identities (tenant_id, user_id, provider, issuer, subject) values ($1, $2, 'VIVA', 'https://synthetic.example.test', $3)",
        [legacyTenant, legacyUser, legacyUser],
      );
      await fixture.query(
        "insert into identity.refresh_sessions (tenant_id, user_id, id, family_id, token_hash, expires_at) values ($1, $2, $3, $3, $4, now() + interval '1 day')",
        [legacyTenant, legacyUser, legacySession, hash()],
      );
      const legacyState = async () =>
        (
          await fixture!.query<{
            users: unknown;
            sessions: unknown;
            mappings: unknown;
            phone_index: unknown;
          }>(`select
        (select jsonb_agg(to_jsonb(u)) from identity.users u) as users,
        (select jsonb_agg(to_jsonb(s)) from identity.refresh_sessions s) as sessions,
        (select jsonb_agg(to_jsonb(e)) from identity.external_identities e) as mappings,
        (select pg_get_indexdef(oid) from pg_class where relname = 'user_summaries_phone_lookup_idx') as phone_index`)
        ).rows;
      const originalLegacy = await legacyState();
      await copyFile(resolve(sourceDirectory, migration), resolve(migrationDirectory, migration));
      // Drift fails closed after the first CREATE, and the canonical transaction rolls it back.
      await fixture.query('create table identity.local_password_login_receipts (wrong integer)');
      await expect(migrate()).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await fixture.query<{ credentials: string | null }>(
            "select to_regclass('identity.local_email_credentials') as credentials",
          )
        ).rows[0]?.credentials,
      ).toBeNull();
      expect(
        (
          await fixture.query(
            'select filename, checksum, applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(before);
      await fixture.query('drop table identity.local_password_login_receipts');
      expect((await migrate()).stdout.trim()).toBe(`Applied ${migration}`);
      expect(await legacyState()).toEqual(originalLegacy);
      const catalog = (
        await fixture.query<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
          owner: string;
          policies: number;
        }>(`select c.relname, c.relrowsecurity, c.relforcerowsecurity,
        pg_get_userbyid(c.relowner) as owner, (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c where c.oid in ('identity.local_email_credentials'::regclass, 'identity.local_password_login_receipts'::regclass)`)
      ).rows;
      expect(catalog).toHaveLength(2);
      expect(
        catalog.every(
          (row) =>
            row.relrowsecurity &&
            row.relforcerowsecurity &&
            row.policies === 1 &&
            row.owner === 'phub',
        ),
      ).toBe(true);
      const checksum = createHash('sha256')
        .update(await readFile(resolve(sourceDirectory, migration)))
        .digest('hex');
      const after = (
        await fixture.query(
          'select filename, checksum, applied_at from schema_migrations order by filename',
        )
      ).rows;
      expect(after.slice(0, -1)).toEqual(before);
      expect(after.at(-1)).toMatchObject({ filename: migration, checksum });
      expect((await migrate()).stdout.trim()).toBe('');
      expect(await legacyState()).toEqual(originalLegacy);
      expect(
        (
          await fixture.query(
            'select filename, checksum, applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(after);
      await writeFile(
        resolve(migrationDirectory, '9999_kya04_failure.sql'),
        'create table profile.kya04_failure_probe (id integer); select 1 / 0;',
      );
      await expect(migrate()).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await fixture.query<{ probe: string | null }>(
            "select to_regclass('profile.kya04_failure_probe') as probe",
          )
        ).rows[0]?.probe,
      ).toBeNull();
      expect(
        (
          await fixture.query(
            'select filename, checksum, applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(after);
    } finally {
      if (fixture) await fixture.end();
      if (created) await admin.query(`drop database ${database}`);
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
