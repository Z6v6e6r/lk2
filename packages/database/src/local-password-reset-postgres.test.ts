import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLocalPasswordLoginRepository } from './local-password-login-repository.js';
import { withTenantTransaction } from './connection.js';
import {
  createLocalPasswordResetRepository,
  type PasswordResetCommit,
} from './local-password-reset-repository.js';

function ciDatabase(): string | undefined {
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
    throw new Error('RESET_TEST_DISPOSABLE_DATABASE_REQUIRED');
  return url.toString();
}
const url = ciDatabase();
const suite = url ? describe : describe.skip;
const digest = (): string => createHash('sha256').update(randomUUID()).digest('hex');
const encoded = (value: number): string =>
  'phub-scrypt-v1$131072$8$1$' +
  Buffer.alloc(16, value).toString('base64url') +
  '$' +
  Buffer.alloc(64, value).toString('base64url');
suite('internal password reset on disposable non-owner PostgreSQL', () => {
  const admin = new Pool({ connectionString: url, max: 5 });
  const tenantId = randomUUID();
  const otherTenant = randomUUID();
  const role = `reset_test_${randomUUID().replaceAll('-', '')}`;
  let runtime: Pool;
  let repository: ReturnType<typeof createLocalPasswordResetRepository>;
  beforeAll(async () => {
    const rolePassword = randomUUID();
    await admin.query<Record<string, unknown>>(
      `create role ${role} login password '${rolePassword}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query<Record<string, unknown>>(
      `grant usage on schema identity, integration, profile, audit to ${role}`,
    );
    await admin.query<Record<string, unknown>>(
      `grant select, update(updated_at) on identity.users to ${role}`,
    );
    await admin.query<Record<string, unknown>>(
      `grant select, update(password_hash, generation, updated_at) on identity.local_email_credentials to ${role}`,
    );
    await admin.query<Record<string, unknown>>(
      `grant select, insert, update(status, attempts, delivered_at, consumed_at) on identity.local_password_reset_proofs to ${role}`,
    );
    await admin.query<Record<string, unknown>>(
      `grant select, insert on identity.local_password_reset_receipts to ${role}`,
    );
    await admin.query<Record<string, unknown>>(
      `grant select, update(revoked_at, revoke_reason) on identity.refresh_sessions to ${role}`,
    );
    await admin.query<Record<string, unknown>>(
      `grant select, update(revoked_at, revoke_reason, updated_at) on integration.user_delegations to ${role}`,
    );
    await admin.query<Record<string, unknown>>(`grant insert on audit.audit_log to ${role}`);
    const runtimeUrl = new URL(url!);
    runtimeUrl.username = role;
    runtimeUrl.password = rolePassword;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 5 });
    repository = createLocalPasswordResetRepository(runtime);
    await admin.query<Record<string, unknown>>(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1,$2,'Synthetic reset'),($3,$4,'Other synthetic reset')`,
      [tenantId, `reset-${tenantId}`, otherTenant, `reset-${otherTenant}`],
    );
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    for (const tenant of [tenantId, otherTenant])
      await withTenantTransaction(admin, tenant, async (client) => {
        for (const table of [
          'identity.local_password_reset_receipts',
          'identity.local_password_reset_proofs',
          'identity.local_password_login_receipts',
          'audit.audit_log',
          'integration.user_delegations',
        ])
          await client.query<Record<string, unknown>>(`delete from ${table} where tenant_id = $1`, [
            tenant,
          ]);
        await client.query<Record<string, unknown>>(
          'update identity.refresh_sessions set parent_session_id = null, replaced_by_session_id = null where tenant_id = $1',
          [tenant],
        );
        for (const table of [
          'identity.refresh_sessions',
          'identity.local_email_credentials',
          'profile.user_summaries',
          'identity.users',
        ])
          await client.query<Record<string, unknown>>(`delete from ${table} where tenant_id = $1`, [
            tenant,
          ]);
      });
    await admin.query<Record<string, unknown>>('delete from identity.tenants where id in ($1,$2)', [
      tenantId,
      otherTenant,
    ]);
    await admin.query<Record<string, unknown>>(`drop owned by ${role}`);
    await admin.query<Record<string, unknown>>(`drop role ${role}`);
    await admin.end();
  });
  async function account() {
    const userId = randomUUID(),
      credentialId = randomUUID();
    const emailKey = `${userId}@example.test`;
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query<Record<string, unknown>>(
        'insert into identity.users (tenant_id,id) values ($1,$2)',
        [tenantId, userId],
      );
      await client.query<Record<string, unknown>>(
        "insert into profile.user_summaries (tenant_id,user_id,display_name) values ($1,$2,'Synthetic')",
        [tenantId, userId],
      );
      await client.query<Record<string, unknown>>(
        'insert into identity.local_email_credentials (id,tenant_id,user_id,email_key,password_hash,email_verified_at) values ($1,$2,$3,$4,$5,now())',
        [credentialId, tenantId, userId, emailKey, encoded(1)],
      );
    });
    return { userId, credentialId, emailKey };
  }
  async function prepared() {
    const owner = await account();
    const command = {
      tenantId,
      proofId: randomUUID(),
      tokenHash: digest(),
      commandKeyHash: digest(),
    };
    expect(await repository.prepare({ ...command, emailKey: owner.emailKey })).toEqual({
      outcome: 'prepared',
      emailKey: owner.emailKey,
    });
    return { ...command, owner };
  }
  async function ready(): Promise<
    PasswordResetCommit & { owner: Awaited<ReturnType<typeof account>> }
  > {
    const value = await prepared();
    expect(await repository.activate(value)).toBe(true);
    const snapshot = await repository.inspect(value);
    expect(snapshot).toBeDefined();
    return {
      ...value,
      snapshot: snapshot!,
      newPasswordHash: encoded(2),
      correlationId: 'synthetic-reset-pg',
    };
  }
  function replayInput(input: PasswordResetCommit): PasswordResetCommit {
    const { newPasswordHash, ...replay } = input;
    expect(newPasswordHash).toBeDefined();
    return replay;
  }
  async function state(input: Awaited<ReturnType<typeof ready>>) {
    return withTenantTransaction(
      admin,
      tenantId,
      async (client) =>
        (
          await client.query<Record<string, unknown>>(
            `select
      (select generation from identity.local_email_credentials where tenant_id=$1 and id=$2) as generation,
      (select password_hash from identity.local_email_credentials where tenant_id=$1 and id=$2) as password_hash,
      (select status from identity.local_password_reset_proofs where tenant_id=$1 and id=$3) as status,
      (select count(*)::int from identity.local_password_reset_receipts where tenant_id=$1 and proof_id=$3) as receipts,
      (select count(*)::int from audit.audit_log where tenant_id=$1 and resource_id=$2 and action='AUTH_LOCAL_PASSWORD_RESET') as audits`,
            [tenantId, input.owner.credentialId, input.proofId],
          )
        ).rows[0],
    );
  }
  async function seedSession(
    userId: string,
    options: { expired?: boolean; revoked?: boolean } = {},
  ) {
    const id = randomUUID();
    await withTenantTransaction(admin, tenantId, async (client) =>
      client.query<Record<string, unknown>>(
        `insert into identity.refresh_sessions (id,tenant_id,user_id,family_id,token_hash,created_at,expires_at,revoked_at,revoke_reason)
      values ($1,$2,$3,$1,$4,now() - interval '2 days',now() + $5::interval,case when $6 then now() else null end,case when $6 then 'LOGOUT' else null end)`,
        [
          id,
          tenantId,
          userId,
          digest(),
          options.expired ? '-1 hour' : '1 day',
          options.revoked ?? false,
        ],
      ),
    );
    return id;
  }
  it('consumes proof, changes generation, revokes every family/delegation and audits on one transaction', async () => {
    const input = await ready();
    await seedSession(input.owner.userId);
    await seedSession(input.owner.userId, { expired: true });
    await seedSession(input.owner.userId, { revoked: true });
    await withTenantTransaction(admin, tenantId, async (client) =>
      client.query<Record<string, unknown>>(
        `insert into integration.user_delegations (tenant_id,user_id,provider,issuer,subject,refresh_token_ciphertext,encryption_key_version)
      values ($1,$2,'VIVA','https://synthetic.example.test',$3,'synthetic-not-a-token','synthetic')`,
        [tenantId, input.owner.userId, `synthetic-subject-${input.owner.userId}`],
      ),
    );
    expect(await repository.commit(input)).toBe('changed');
    expect(await state(input)).toEqual({
      generation: 2,
      password_hash: encoded(2),
      status: 'CONSUMED',
      receipts: 1,
      audits: 1,
    });
    await withTenantTransaction(admin, tenantId, async (client) => {
      const sessions = (
        await client.query<Record<string, unknown>>(
          'select revoked_at, revoke_reason from identity.refresh_sessions where tenant_id=$1 and user_id=$2',
          [tenantId, input.owner.userId],
        )
      ).rows;
      expect(sessions).toHaveLength(3);
      expect(sessions.every((s) => s.revoked_at)).toBe(true);
      expect(sessions.map((s) => s.revoke_reason).sort()).toEqual([
        'CREDENTIAL_RESET',
        'CREDENTIAL_RESET',
        'LOGOUT',
      ]);
      const delegation = (
        await client.query<Record<string, unknown>>(
          'select revoked_at, revoke_reason from integration.user_delegations where tenant_id=$1 and user_id=$2',
          [tenantId, input.owner.userId],
        )
      ).rows[0];
      expect(delegation?.revoke_reason).toBe('CREDENTIAL_RESET');
      expect(delegation?.revoked_at).toBeInstanceOf(Date);
      expect(
        (
          await client.query<Record<string, unknown>>(
            "select actor_id, old_value, new_value from audit.audit_log where tenant_id=$1 and resource_id=$2 and action='AUTH_LOCAL_PASSWORD_RESET'",
            [tenantId, input.owner.credentialId],
          )
        ).rows[0],
      ).toEqual({ actor_id: null, old_value: null, new_value: null });
    });
  });
  it('serializes concurrent identical resets, then permits exact read-only replay', async () => {
    const input = await ready();
    expect(
      (await Promise.all([repository.commit(input), repository.commit(input)])).sort(),
    ).toEqual(['changed', 'retry']);
    const snapshot = await repository.inspect(input);
    const replay = replayInput(input);
    expect(await repository.commit({ ...replay, snapshot: snapshot! })).toBe('replayed');
    expect(await state(input)).toMatchObject({ generation: 2, receipts: 1, audits: 1 });
  });
  it('never consumes a pending or cancelled delivery and never reactivates it', async () => {
    const input = await prepared();
    expect(await repository.inspect(input)).toBeUndefined();
    await repository.cancel(input);
    expect(await repository.activate(input)).toBe(false);
    expect(await repository.inspect(input)).toBeUndefined();
  });
  it('cancels an ambiguously activated proof but never undoes a completed reset', async () => {
    const pending = await ready();
    await repository.cancel(pending);
    expect(await repository.inspect(pending)).toBeUndefined();
    expect(await repository.commit(pending)).toBe('invalid');
    const completed = await ready();
    await repository.commit(completed);
    await repository.cancel(completed);
    expect(await state(completed)).toMatchObject({
      generation: 2,
      status: 'CONSUMED',
      receipts: 1,
      audits: 1,
    });
  });
  it('serializes cancel versus consume with no partial credential or receipt writes', async () => {
    const input = await ready();
    const [, outcome] = await Promise.all([repository.cancel(input), repository.commit(input)]);
    const current = await state(input);
    if (outcome === 'changed')
      expect(current).toMatchObject({ generation: 2, status: 'CONSUMED', receipts: 1, audits: 1 });
    else {
      expect(outcome).toBe('invalid');
      expect(current).toMatchObject({ generation: 1, status: 'CANCELLED', receipts: 0, audits: 0 });
    }
  });
  it('blocks proof after five wrong tokens without consuming a credential', async () => {
    const input = await ready();
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await repository.inspect({ ...input, tokenHash: digest() })).toBeUndefined();
    expect(await repository.inspect(input)).toBeUndefined();
    expect(await repository.commit(input)).toBe('invalid');
    expect(await state(input)).toMatchObject({
      generation: 1,
      status: 'BLOCKED',
      receipts: 0,
      audits: 0,
    });
  });
  it.each([
    'expired',
    'disabled-user',
    'disabled-method',
    'generation',
    'hash',
    'wrong-key',
    'wrong-tenant',
    'wrong-owner',
  ] as const)('rejects stale or mismatched proof without writes (%s)', async (kind) => {
    const input = await ready();
    await withTenantTransaction(admin, tenantId, async (client) => {
      if (kind === 'expired')
        await client.query<Record<string, unknown>>(
          "update identity.local_password_reset_proofs set expires_at=created_at + interval '1 microsecond' where tenant_id=$1 and id=$2",
          [tenantId, input.proofId],
        );
      if (kind === 'disabled-user')
        await client.query<Record<string, unknown>>(
          "update identity.users set status='DISABLED' where tenant_id=$1 and id=$2",
          [tenantId, input.owner.userId],
        );
      if (kind === 'disabled-method')
        await client.query<Record<string, unknown>>(
          "update identity.local_email_credentials set status='DISABLED' where tenant_id=$1 and id=$2",
          [tenantId, input.owner.credentialId],
        );
      if (kind === 'generation')
        await client.query<Record<string, unknown>>(
          'update identity.local_email_credentials set generation=2 where tenant_id=$1 and id=$2',
          [tenantId, input.owner.credentialId],
        );
      if (kind === 'hash')
        await client.query<Record<string, unknown>>(
          'update identity.local_email_credentials set password_hash=$3 where tenant_id=$1 and id=$2',
          [tenantId, input.owner.credentialId, encoded(3)],
        );
    });
    const changed = {
      ...input,
      ...(kind === 'wrong-key' ? { commandKeyHash: digest() } : {}),
      ...(kind === 'wrong-tenant' ? { tenantId: otherTenant } : {}),
      ...(kind === 'wrong-owner' ? { snapshot: { ...input.snapshot, userId: randomUUID() } } : {}),
    };
    expect(await repository.commit(changed)).toBe('invalid');
    expect(await state(input)).toMatchObject({ status: 'DELIVERED', receipts: 0, audits: 0 });
  });
  it('rejects replay after a later credential reset, including a newly logged in family', async () => {
    const input = await ready();
    await repository.commit(input);
    const snapshot = (await repository.inspect(input))!;
    await withTenantTransaction(admin, tenantId, async (client) =>
      client.query<Record<string, unknown>>(
        'update identity.local_email_credentials set generation=3,password_hash=$3 where tenant_id=$1 and id=$2',
        [tenantId, input.owner.credentialId, encoded(3)],
      ),
    );
    const session = await seedSession(input.owner.userId);
    const replay = replayInput(input);
    expect(await repository.commit({ ...replay, snapshot })).toBe('invalid');
    expect(await repository.inspect(input)).toBeUndefined();
    expect(
      (
        await admin.query<Record<string, unknown>>(
          'select revoked_at from identity.refresh_sessions where id=$1',
          [session],
        )
      ).rows[0]?.revoked_at,
    ).toBeNull();
  });
  it.each(['audit', 'receipt', 'delegation'] as const)(
    'rolls all changes back if %s fails',
    async (kind) => {
      const input = await ready();
      const session = await seedSession(input.owner.userId);
      const table =
        kind === 'audit'
          ? 'audit.audit_log'
          : kind === 'receipt'
            ? 'identity.local_password_reset_receipts'
            : 'integration.user_delegations';
      const permission =
        kind === 'delegation' ? 'update(revoked_at, revoke_reason, updated_at)' : 'insert';
      await admin.query<Record<string, unknown>>(`revoke ${permission} on ${table} from ${role}`);
      try {
        await expect(repository.commit(input)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await admin.query<Record<string, unknown>>(`grant ${permission} on ${table} to ${role}`);
      }
      expect(await state(input)).toMatchObject({
        generation: 1,
        status: 'DELIVERED',
        receipts: 0,
        audits: 0,
      });
      expect(
        (
          await admin.query<Record<string, unknown>>(
            'select revoked_at from identity.refresh_sessions where id=$1',
            [session],
          )
        ).rows[0]?.revoked_at,
      ).toBeNull();
    },
  );
  it('invalidates a password verification snapshot made before reset', async () => {
    const input = await ready();
    const login = createLocalPasswordLoginRepository(admin);
    const stale = await login.findCredential(tenantId, input.owner.emailKey);
    await repository.commit(input);
    expect(
      await login.commitLogin({
        tenantId,
        emailKey: input.owner.emailKey,
        credential: stale!,
        commandKeyHash: digest(),
        requestHash: digest(),
        sessionId: randomUUID(),
        tokenHash: digest(),
        expiresAt: new Date(Date.now() + 86400000),
        correlationId: 'synthetic-stale-login',
      }),
    ).toEqual({ outcome: 'invalid' });
  });
  it('rejects receipt ownership and purpose substitutions at the SQL boundary', async () => {
    const input = await prepared();
    const another = await account();
    await expect(
      withTenantTransaction(admin, tenantId, (client) =>
        client.query<Record<string, unknown>>(
          `insert into identity.local_password_reset_receipts
      (tenant_id,command_key_hash,proof_id,user_id,credential_id,credential_generation,resulting_generation) values ($1,$2,$3,$4,$5,1,2)`,
          [tenantId, input.commandKeyHash, input.proofId, another.userId, another.credentialId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTenantTransaction(admin, tenantId, (client) =>
        client.query<Record<string, unknown>>(
          "update identity.local_password_reset_proofs set purpose='ENROLL_EMAIL' where tenant_id=$1 and id=$2",
          [tenantId, input.proofId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('enforces account cooldown and prevents same-key challenge replacement', async () => {
    const input = await prepared();
    expect(await repository.prepare({ ...input, emailKey: input.owner.emailKey })).toEqual({
      outcome: 'conflict',
    });
    expect(
      await repository.prepare({
        ...input,
        proofId: randomUUID(),
        commandKeyHash: digest(),
        emailKey: input.owner.emailKey,
      }),
    ).toEqual({ outcome: 'limited' });
  });
  it('enforces FORCE RLS/default deny and keeps writer credential enrollment forbidden', async () => {
    const input = await prepared();
    expect(
      (
        await runtime.query<Record<string, unknown>>(
          'select id from identity.local_password_reset_proofs where id=$1',
          [input.proofId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await withTenantTransaction(runtime, otherTenant, (client) =>
          client.query<Record<string, unknown>>(
            'select id from identity.local_password_reset_proofs where id=$1',
            [input.proofId],
          ),
        )
      ).rows,
    ).toEqual([]);
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query("update identity.users set status='ACTIVE' where tenant_id=$1 and id=$2", [
          tenantId,
          input.owner.userId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, otherTenant, (client) =>
        client.query<Record<string, unknown>>(
          `insert into identity.local_password_reset_receipts
      (tenant_id,command_key_hash,proof_id,user_id,credential_id,credential_generation,resulting_generation) values ($1,$2,$3,$4,$5,1,2)`,
          [
            tenantId,
            input.commandKeyHash,
            input.proofId,
            input.owner.userId,
            input.owner.credentialId,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query<Record<string, unknown>>(
          'update identity.local_email_credentials set email_key=$3 where tenant_id=$1 and id=$2',
          [tenantId, input.owner.credentialId, 'other@example.test'],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withTenantTransaction(runtime, tenantId, (client) =>
        client.query<Record<string, unknown>>(
          'insert into identity.local_email_credentials (id,tenant_id,user_id,email_key,password_hash,email_verified_at) values ($1,$2,$3,$4,$5,now())',
          [randomUUID(), tenantId, input.owner.userId, 'forbidden@example.test', encoded(1)],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await admin.query<Record<string, unknown>>(
          `select relrowsecurity,relforcerowsecurity from pg_class where oid in ('identity.local_password_reset_proofs'::regclass,'identity.local_password_reset_receipts'::regclass)`,
        )
      ).rows,
    ).toEqual([
      { relrowsecurity: true, relforcerowsecurity: true },
      { relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(
      (
        await admin.query<Record<string, unknown>>(
          'select rolsuper,rolbypassrls,rolinherit from pg_roles where rolname=$1',
          [role],
        )
      ).rows[0],
    ).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false });
  });
  it('applies canonical 0097→0098, preserves credentials/sessions, rejects drift and reapplies as no-op', async () => {
    const database = `reset_rehearsal_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(resolve(tmpdir(), 'kya04-reset-migrations-'));
    const migrations = resolve(directory, 'packages/database/migrations');
    const fixtureUrl = new URL(url!);
    fixtureUrl.pathname = `/${database}`;
    let fixture: Pool | undefined;
    let created = false;
    const name = '0098_local_password_reset_proofs.sql';
    try {
      await admin.query<Record<string, unknown>>(`create database ${database}`);
      created = true;
      fixture = new Pool({ connectionString: fixtureUrl.toString(), max: 2 });
      await mkdir(migrations, { recursive: true });
      const source = resolve(process.cwd(), 'packages/database/migrations');
      const files = (await readdir(source))
        .filter((file) => /^\d+.*\.sql$/.test(file) && file < name)
        .sort();
      expect(files.at(-1)).toBe('0097_local_email_password_login.sql');
      for (const file of files) await copyFile(resolve(source, file), resolve(migrations, file));
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
            timeout: 120000,
            maxBuffer: 1000000,
            env: {
              PATH: process.env.PATH ?? '',
              DATABASE_URL: fixtureUrl.toString(),
              TSX_TSCONFIG_PATH: resolve(process.cwd(), 'tsconfig.json'),
              CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1',
            },
          },
        );
      await migrate();
      const legacyTenant = randomUUID(),
        legacyUser = randomUUID(),
        legacyCredential = randomUUID(),
        legacySession = randomUUID();
      await fixture.query<Record<string, unknown>>(
        "insert into identity.tenants (id,tenant_key,display_name) values ($1,$2,'Synthetic reset upgrade')",
        [legacyTenant, `reset-upgrade-${legacyTenant}`],
      );
      await fixture.query<Record<string, unknown>>(
        'insert into identity.users (tenant_id,id) values ($1,$2)',
        [legacyTenant, legacyUser],
      );
      await fixture.query<Record<string, unknown>>(
        'insert into identity.local_email_credentials (id,tenant_id,user_id,email_key,password_hash,email_verified_at) values ($1,$2,$3,$4,$5,now())',
        [legacyCredential, legacyTenant, legacyUser, `${legacyUser}@example.test`, encoded(1)],
      );
      await fixture.query<Record<string, unknown>>(
        "insert into identity.refresh_sessions (id,tenant_id,user_id,family_id,token_hash,expires_at) values ($1,$2,$3,$1,$4,now()+interval '1 day')",
        [legacySession, legacyTenant, legacyUser, digest()],
      );
      const legacy = async () =>
        (
          await fixture!.query<Record<string, unknown>>(`select
        (select jsonb_agg(to_jsonb(c)) from identity.local_email_credentials c) as credentials,
        (select jsonb_agg(to_jsonb(s)) from identity.refresh_sessions s) as sessions`)
        ).rows;
      const original = await legacy();
      const before = (
        await fixture.query<Record<string, unknown>>(
          'select filename,checksum,applied_at from schema_migrations order by filename',
        )
      ).rows;
      expect(
        (
          await fixture.query<Record<string, unknown>>(
            "select to_regclass('identity.local_password_reset_proofs') as proof",
          )
        ).rows[0]?.proof,
      ).toBeNull();
      await copyFile(resolve(source, name), resolve(migrations, name));
      await fixture.query<Record<string, unknown>>(
        'create table identity.local_password_reset_receipts (wrong integer)',
      );
      await expect(migrate()).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await fixture.query<Record<string, unknown>>(
            "select to_regclass('identity.local_password_reset_proofs') as proof",
          )
        ).rows[0]?.proof,
      ).toBeNull();
      expect(
        (
          await fixture.query<Record<string, unknown>>(
            'select filename,checksum,applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(before);
      await fixture.query<Record<string, unknown>>(
        'drop table identity.local_password_reset_receipts',
      );
      expect((await migrate()).stdout.trim()).toBe(`Applied ${name}`);
      expect(await legacy()).toEqual(original);
      const checksum = createHash('sha256')
        .update(await readFile(resolve(source, name)))
        .digest('hex');
      const ledger = (
        await fixture.query<Record<string, unknown>>(
          'select filename,checksum,applied_at from schema_migrations order by filename',
        )
      ).rows;
      const applied = ledger.filter((row) => row.filename === name);
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatchObject({ filename: name, checksum });
      expect(applied[0]?.applied_at).toBeInstanceOf(Date);
      expect((await migrate()).stdout.trim()).toBe('');
      expect(
        (
          await fixture.query<Record<string, unknown>>(
            'select filename,checksum,applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(ledger);
      await writeFile(
        resolve(migrations, '9999_owned_reset_failure.sql'),
        'create table identity.owned_reset_failure(id integer); select 1 / 0;',
      );
      await expect(migrate()).rejects.toMatchObject({ code: 1 });
      expect(
        (
          await fixture.query<Record<string, unknown>>(
            "select to_regclass('identity.owned_reset_failure') as failed",
          )
        ).rows[0]?.failed,
      ).toBeNull();
      expect(
        (
          await fixture.query<Record<string, unknown>>(
            'select filename,checksum,applied_at from schema_migrations order by filename',
          )
        ).rows,
      ).toEqual(ledger);
    } finally {
      if (fixture) await fixture.end();
      if (created) await admin.query<Record<string, unknown>>(`drop database ${database}`);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
