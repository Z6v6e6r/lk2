import { createHash, randomUUID } from 'node:crypto';

import { createIdentityAuthRepository, withTenantTransaction } from '@phub/database';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAuthRepository } from './postgres-auth-repository.js';

// Only the already migrated disposable GitHub Actions service. Never adopt an ambient local DB.
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
  ) {
    throw new Error('SESSION_TEST_DISPOSABLE_DATABASE_REQUIRED');
  }
  return url.toString();
}
const url = ciDatabase();
const suite = url ? describe : describe.skip;
suite('access sessions on PostgreSQL with a non-owner, non-bypass role', () => {
  const admin = new Pool({ connectionString: url, max: 6 });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const role = `session_test_${randomUUID().replaceAll('-', '')}`;
  const password = randomUUID();
  let runtime: Pool;
  let repository: PostgresAuthRepository;
  let identity: ReturnType<typeof createIdentityAuthRepository>;
  const expiresAt = () => new Date(Date.now() + 86400000);
  const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
  const correlationId = 'synthetic-access-session-test';

  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(`grant usage on schema identity, profile, audit to ${role}`);
    await admin.query(`grant select on identity.tenants, profile.user_summaries to ${role}`);
    await admin.query(`grant select, update on identity.users to ${role}`);
    await admin.query(`grant select, insert, update on identity.refresh_sessions to ${role}`);
    await admin.query(`grant insert on audit.audit_log to ${role}`);
    const runtimeUrl = new URL(url!);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 4 });
    repository = new PostgresAuthRepository(runtime);
    identity = createIdentityAuthRepository(runtime);
    await admin.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, 'Synthetic sessions'), ($3, $4, 'Other synthetic sessions')`,
      [tenantId, `session-${tenantId}`, otherTenantId, `session-${otherTenantId}`],
    );
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(`insert into identity.users (tenant_id, id) values ($1, $2), ($1, $3)`, [
        tenantId,
        userId,
        otherUserId,
      ]);
      await client.query(
        `insert into profile.user_summaries (tenant_id, user_id, display_name) values ($1, $2, 'Synthetic'), ($1, $3, 'Other')`,
        [tenantId, userId, otherUserId],
      );
    });
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query('delete from audit.audit_log where tenant_id = $1', [tenantId]);
      // Break successor FKs before deleting all test-owned rows.
      await client.query(
        'update identity.refresh_sessions set rotated_at = null, replaced_by_session_id = null, parent_session_id = null where tenant_id = $1',
        [tenantId],
      );
      await client.query('delete from identity.refresh_sessions where tenant_id = $1', [tenantId]);
      await client.query('delete from profile.user_summaries where tenant_id = $1', [tenantId]);
      await client.query('delete from identity.users where tenant_id = $1', [tenantId]);
    });
    await admin.query('delete from identity.tenants where id in ($1, $2)', [
      tenantId,
      otherTenantId,
    ]);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role if exists ${role}`);
    await admin.end();
  });
  async function family() {
    const sessionId = randomUUID();
    const tokenHash = hash();
    await identity.createRefreshSession({
      tenantId,
      userId,
      sessionId,
      tokenHash,
      expiresAt: expiresAt(),
      correlationId,
    });
    return { sessionId, tokenHash };
  }
  const check = (sessionId: string, tenant = tenantId, user = userId) =>
    repository.isAccessSessionActive({ tenantId: tenant, userId: user, sessionId });
  function rotate(tokenHash: string) {
    return identity.rotateRefreshSession({
      tenantId,
      currentTokenHash: tokenHash,
      nextTokenHash: hash(),
      nextExpiresAt: expiresAt(),
      correlationId,
    });
  }
  it('binds a live sid to its tenant/user and preserves old access across ordinary rotation', async () => {
    const original = await family();
    expect(await check(original.sessionId)).toBe(true);
    expect(await check(original.sessionId, otherTenantId)).toBe(false);
    expect(await check(original.sessionId, tenantId, otherUserId)).toBe(false);
    expect(await check(randomUUID())).toBe(false);
    const result = await rotate(original.tokenHash);
    expect(result.outcome).toBe('rotated');
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        "update identity.refresh_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where tenant_id = $1 and id = $2",
        [tenantId, original.sessionId],
      ),
    );
    expect(await check(original.sessionId)).toBe(true);
    if (result.outcome !== 'rotated') throw new Error('ROTATION_REQUIRED');
    expect(await check(result.session.id)).toBe(true);
    await identity.revokeRefreshSession({ tenantId, tokenHash: original.tokenHash, correlationId });
    expect(await check(original.sessionId)).toBe(false);
    expect(await check(result.session.id)).toBe(false);
  });
  it('rejects disabled users, expired sessions and families without a current leaf', async () => {
    const original = await family();
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(
        "update identity.users set status = 'DISABLED' where tenant_id = $1 and id = $2",
        [tenantId, userId],
      );
    });
    expect(await check(original.sessionId)).toBe(false);
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(
        "update identity.users set status = 'ACTIVE' where tenant_id = $1 and id = $2",
        [tenantId, userId],
      );
      await client.query(
        "update identity.refresh_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where tenant_id = $1 and id = $2",
        [tenantId, original.sessionId],
      );
    });
    expect(await check(original.sessionId)).toBe(false);
  });
  it('denies old and new access after refresh-token reuse revokes their family', async () => {
    const original = await family();
    const successor = await rotate(original.tokenHash);
    if (successor.outcome !== 'rotated') throw new Error('ROTATION_REQUIRED');
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        "update identity.refresh_sessions set rotated_at = now() - interval '1 minute' where tenant_id = $1 and id = $2",
        [tenantId, original.sessionId],
      ),
    );
    expect((await rotate(original.tokenHash)).outcome).toBe('reuse_detected');
    expect(await check(original.sessionId)).toBe(false);
    expect(await check(successor.session.id)).toBe(false);
  });
  async function waitForUserLocks(count: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ count: number }>(
        "select count(*)::integer as count from pg_stat_activity where usename = $1 and wait_event_type = 'Lock'",
        [role],
      );
      if (result.rows[0]?.count === count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('EXPECTED_CONCURRENT_USER_LOCK_WAIT');
  }
  it('rejects a family with an expired leaf or a revoked ancestor despite a live successor', async () => {
    const original = await family();
    const successor = await rotate(original.tokenHash);
    if (successor.outcome !== 'rotated') throw new Error('ROTATION_REQUIRED');
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        "update identity.refresh_sessions set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where tenant_id = $1 and id = $2",
        [tenantId, successor.session.id],
      ),
    );
    expect(await check(original.sessionId)).toBe(false);
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(
        "update identity.refresh_sessions set expires_at = now() + interval '1 day' where tenant_id = $1 and id = $2",
        [tenantId, successor.session.id],
      );
      await client.query(
        'update identity.refresh_sessions set revoked_at = now() where tenant_id = $1 and id = $2',
        [tenantId, original.sessionId],
      );
    });
    expect(await check(successor.session.id)).toBe(false);
  });
  it.each(['refresh-first', 'logout-first'])(
    'does not resurrect a family during concurrent descendant refresh and ancestor logout: %s',
    async (order) => {
      const original = await family();
      const nextHash = hash();
      const successor = await identity.rotateRefreshSession({
        tenantId,
        currentTokenHash: original.tokenHash,
        nextTokenHash: nextHash,
        nextExpiresAt: expiresAt(),
        correlationId,
      });
      if (successor.outcome !== 'rotated') throw new Error('ROTATION_REQUIRED');
      const blocker = await admin.connect();
      await blocker.query('begin');
      await blocker.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await blocker.query(
        'select id from identity.users where tenant_id = $1 and id = $2 for update',
        [tenantId, userId],
      );
      let first: Promise<unknown>;
      let second: Promise<unknown>;
      const refresh = () => rotate(nextHash);
      const logout = () =>
        identity.revokeRefreshSession({ tenantId, tokenHash: original.tokenHash, correlationId });
      try {
        first = order === 'refresh-first' ? refresh() : logout();
        await waitForUserLocks(1);
        second = order === 'refresh-first' ? logout() : refresh();
        await waitForUserLocks(2);
        await blocker.query('commit');
        await Promise.all([first, second]);
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
      expect(await check(original.sessionId)).toBe(false);
      expect(await check(successor.session.id)).toBe(false);
      const active = await withTenantTransaction(admin, tenantId, (client) =>
        client.query(
          'select id from identity.refresh_sessions where tenant_id = $1 and family_id = $2 and revoked_at is null',
          [tenantId, original.sessionId],
        ),
      );
      expect(active.rows).toEqual([]);
      expect((await rotate(nextHash)).outcome).toBe('invalid');
    },
  );
  it('has no owner/bypass role and RLS denies reads without tenant context', async () => {
    const roleRow = await runtime.query(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(roleRow.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const result = await runtime.query('select id from identity.refresh_sessions');
    expect(result.rows).toEqual([]);
  });
});
