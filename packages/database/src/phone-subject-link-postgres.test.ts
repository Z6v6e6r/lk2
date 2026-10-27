import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { externalSubjectAdvisoryKey } from './auth-repository.js';
import { withTenantTransaction } from './connection.js';
import { createPhoneSubjectLinkRepository } from './phone-subject-link-repository.js';

// Only the migrated disposable GitHub Actions PostgreSQL service. Never adopt ambient/local DBs.
function ciDatabase(): string | undefined {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.APP_ENV !== 'ci' ||
    !process.env.DATABASE_URL
  ) {
    return undefined;
  }
  const url = new URL(process.env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.password !== 'ci-password' ||
    url.pathname !== '/phub' ||
    url.port !== '5432' ||
    url.search ||
    url.hash
  ) {
    throw new Error('SUBJECT_LINK_TEST_DISPOSABLE_DATABASE_REQUIRED');
  }
  return url.toString();
}

const url = ciDatabase();
const suite = url ? describe : describe.skip;
const digest = (value: string = randomUUID()): string =>
  createHash('sha256').update(value).digest('hex');

suite('phone subject link on disposable PostgreSQL with an RLS runtime role', () => {
  const admin = new Pool({ connectionString: url, max: 6 });
  const tenantId = randomUUID();
  const actorUserId = randomUUID();
  const otherUserId = randomUUID();
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const phoneE164 = '+79990000001';
  const role = `subject_link_${randomUUID().replaceAll('-', '')}`;
  const rolePassword = randomUUID();
  const issuer = 'https://synthetic.example.test/realms/clients';
  let runtime: Pool;
  let repository: ReturnType<typeof createPhoneSubjectLinkRepository>;

  beforeAll(async () => {
    await admin.query(
      `create role ${role} login password '${rolePassword}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole noreplication`,
    );
    await admin.query(`grant usage on schema identity, profile, integration, audit to ${role}`);
    await admin.query(`grant select, update(updated_at) on identity.users to ${role}`);
    await admin.query(`grant select, update(updated_at) on profile.user_summaries to ${role}`);
    await admin.query(`grant select, update(last_used_at) on identity.refresh_sessions to ${role}`);
    await admin.query(
      `grant select, insert, update(last_seen_at) on integration.external_identity_map to ${role}`,
    );
    await admin.query(
      `grant select, insert, update(outcome, completed_at) on identity.external_subject_link_commands to ${role}`,
    );
    await admin.query(`grant insert on audit.audit_log to ${role}`);
    const runtimeUrl = new URL(url!);
    runtimeUrl.username = role;
    runtimeUrl.password = rolePassword;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 5 });
    repository = createPhoneSubjectLinkRepository(runtime);

    await admin.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, 'Synthetic subject link')`,
      [tenantId, `subject-link-${tenantId}`],
    );
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query(`insert into identity.users (tenant_id, id) values ($1, $2), ($1, $3)`, [
        tenantId,
        actorUserId,
        otherUserId,
      ]);
      await client.query(
        `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
         values ($1, $2, 'Actor', $4), ($1, $3, 'Other', '+79990000002')`,
        [tenantId, actorUserId, otherUserId, phoneE164],
      );
      await client.query(
        `insert into identity.refresh_sessions (
           id, tenant_id, user_id, family_id, token_hash, expires_at
         ) values ($1, $2, $3, $4, $5, now() + interval '1 day')`,
        [sessionId, tenantId, actorUserId, familyId, digest('session')],
      );
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.end();
    await withTenantTransaction(admin, tenantId, async (client) => {
      await client.query('delete from audit.audit_log where tenant_id = $1', [tenantId]);
      await client.query(
        'delete from identity.external_subject_link_commands where tenant_id = $1',
        [tenantId],
      );
      await client.query('delete from integration.external_identity_map where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from identity.refresh_sessions where tenant_id = $1', [tenantId]);
      await client.query('delete from profile.user_summaries where tenant_id = $1', [tenantId]);
      await client.query('delete from identity.users where tenant_id = $1', [tenantId]);
    });
    await admin.query('delete from identity.tenants where id = $1', [tenantId]);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role ${role}`);
    await admin.end();
  });

  function command(challengeId = randomUUID(), commandKeyHash = digest()) {
    return {
      tenantId,
      actorUserId,
      sessionFamilyId: familyId,
      audience: 'client' as const,
      challengeId,
      commandKeyHash,
      requestHash: digest(`request:${challengeId}`),
    };
  }

  function complete(input = command(), subject = `subject-${randomUUID()}`) {
    return repository.completeCommand({
      ...input,
      presentedSessionId: sessionId,
      phoneE164,
      issuer,
      subject,
      correlationId: 'synthetic-subject-link',
    });
  }

  it('has the exact tenant catalog and enforces the restricted runtime boundary', async () => {
    const catalog = await admin.query<{
      rls: boolean;
      forced: boolean;
      constraint_types: string[];
      indexes: number;
      policies: number;
      public_grants: number;
    }>(`select c.relrowsecurity rls, c.relforcerowsecurity forced,
        (select array_agg(contype::text order by contype::text)
           from pg_constraint where conrelid=c.oid) constraint_types,
        (select count(*)::int from pg_index where indrelid=c.oid) indexes,
        (select count(*)::int from pg_policy where polrelid=c.oid
           and polname='external_subject_link_commands_tenant_isolation'
           and polcmd='*' and polpermissive and polroles='{0}'::oid[]
           and pg_get_expr(polqual,polrelid) = pg_get_expr(polwithcheck,polrelid)
           and pg_get_expr(polqual,polrelid) like '%app.tenant_id%') policies,
        (select count(*)::int from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))
           where grantee=0) public_grants
      from pg_class c where c.oid='identity.external_subject_link_commands'::regclass`);
    expect(catalog.rows).toEqual([
      {
        rls: true,
        forced: true,
        constraint_types: ['c', 'c', 'c', 'c', 'c', 'c', 'f', 'p', 'u', 'u', 'u'],
        indexes: 5,
        policies: 1,
        public_grants: 0,
      },
    ]);
    const privileges = await runtime.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_update_outcome: boolean;
      can_update_completed: boolean;
    }>(`select
      has_table_privilege(current_user,'identity.external_subject_link_commands','SELECT') can_select,
      has_table_privilege(current_user,'identity.external_subject_link_commands','INSERT') can_insert,
      has_table_privilege(current_user,'identity.external_subject_link_commands','UPDATE') can_update,
      has_table_privilege(current_user,'identity.external_subject_link_commands','DELETE') can_delete,
      has_column_privilege(current_user,'identity.external_subject_link_commands','outcome','UPDATE') can_update_outcome,
      has_column_privilege(current_user,'identity.external_subject_link_commands','completed_at','UPDATE') can_update_completed`);
    expect(privileges.rows).toEqual([
      {
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_update_outcome: true,
        can_update_completed: true,
      },
    ]);
    expect(
      (await runtime.query('select id from identity.external_subject_link_commands')).rows,
    ).toEqual([]);
    await expect(
      withTenantTransaction(runtime, randomUUID(), (client) =>
        client.query(
          `insert into identity.external_subject_link_commands
       (tenant_id,actor_user_id,session_family_id,challenge_id,audience,command_key_hash,request_hash)
       values ($1,$2,$3,$4,'client',$5,$6)`,
          [tenantId, actorUserId, familyId, randomUUID(), digest(), digest()],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('inserts only one missing mapping, receipt and redacted audit, then replays', async () => {
    const input = command();
    const subject = `subject-${randomUUID()}`;
    expect(await complete(input, subject)).toEqual({ outcome: 'completed', result: 'LINKED' });
    expect(await complete(input, subject)).toEqual({ outcome: 'replayed', result: 'LINKED' });
    const evidence = await withTenantTransaction(admin, tenantId, async (client) =>
      client.query<{
        mappings: number;
        commands: number;
        audits: number;
        sessions: number;
        users: number;
        profiles: number;
        delegations: number;
        legal: number;
      }>(
        `select
          (select count(*)::int from integration.external_identity_map
            where tenant_id=$1 and issuer=$2 and subject=$3 and user_id=$4) mappings,
          (select count(*)::int from identity.external_subject_link_commands
            where tenant_id=$1 and challenge_id=$5 and outcome='LINKED') commands,
          (select count(*)::int from audit.audit_log
            where tenant_id=$1 and action='AUTH_EXTERNAL_SUBJECT_LINK_COMPLETED'
              and resource_id = (select id from identity.external_subject_link_commands
                                  where tenant_id=$1 and challenge_id=$5)) audits,
          (select count(*)::int from identity.refresh_sessions where tenant_id=$1) sessions,
          (select count(*)::int from identity.users where tenant_id=$1) users,
          (select count(*)::int from profile.user_summaries where tenant_id=$1) profiles,
          (select count(*)::int from integration.user_delegations where tenant_id=$1) delegations,
          (select count(*)::int from legal.document_acceptances where tenant_id=$1) legal`,
        [tenantId, issuer, subject, actorUserId, input.challengeId],
      ),
    );
    expect(evidence.rows[0]).toEqual({
      mappings: 1,
      commands: 1,
      audits: 1,
      sessions: 1,
      users: 2,
      profiles: 2,
      delegations: 0,
      legal: 0,
    });
    const audit = await withTenantTransaction(admin, tenantId, (client) =>
      client.query<{ old_value: unknown; new_value: unknown; reason: string | null }>(
        `select old_value, new_value, reason from audit.audit_log
          where tenant_id=$1 and action='AUTH_EXTERNAL_SUBJECT_LINK_COMPLETED'`,
        [tenantId],
      ),
    );
    expect(audit.rows[0]).toEqual({ old_value: null, new_value: null, reason: null });
  });

  it('records UNCHANGED without duplicating the existing same-account mapping', async () => {
    const subject = `subject-${randomUUID()}`;
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        `insert into integration.external_identity_map (tenant_id,user_id,provider,issuer,subject)
         values ($1,$2,'VIVA',$3,$4)`,
        [tenantId, actorUserId, issuer, subject],
      ),
    );
    expect(await complete(command(), subject)).toEqual({
      outcome: 'completed',
      result: 'UNCHANGED',
    });
    const count = await withTenantTransaction(admin, tenantId, (client) =>
      client.query<{ count: number }>(
        `select count(*)::int as count from integration.external_identity_map
          where tenant_id=$1 and issuer=$2 and subject=$3`,
        [tenantId, issuer, subject],
      ),
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('rejects a foreign subject and a drifted or revoked account without a receipt', async () => {
    const subject = `subject-${randomUUID()}`;
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        `insert into integration.external_identity_map (tenant_id,user_id,provider,issuer,subject)
         values ($1,$2,'VIVA',$3,$4)`,
        [tenantId, otherUserId, issuer, subject],
      ),
    );
    expect(await complete(command(), subject)).toEqual({ outcome: 'foreign_subject' });

    const driftCommand = command();
    expect(
      await repository.completeCommand({
        ...driftCommand,
        presentedSessionId: sessionId,
        phoneE164: '+79990000009',
        issuer,
        subject: `subject-${randomUUID()}`,
        correlationId: 'synthetic-subject-link',
      }),
    ).toEqual({ outcome: 'phone_drift' });

    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        `update identity.refresh_sessions set revoked_at=now(), revoke_reason='LOGOUT'
          where tenant_id=$1 and id=$2`,
        [tenantId, sessionId],
      ),
    );
    expect(await complete(command())).toEqual({ outcome: 'invalid_session' });
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        `update identity.refresh_sessions set revoked_at=null, revoke_reason=null
          where tenant_id=$1 and id=$2`,
        [tenantId, sessionId],
      ),
    );
  });

  it('rejects an existing subject with another provider without rewriting it', async () => {
    const subject = `subject-${randomUUID()}`;
    const input = command();
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        `insert into integration.external_identity_map (tenant_id,user_id,provider,issuer,subject)
         values ($1,$2,'LOCAL',$3,$4)`,
        [tenantId, actorUserId, issuer, subject],
      ),
    );
    expect(await complete(input, subject)).toEqual({ outcome: 'foreign_subject' });
    const unchanged = await withTenantTransaction(admin, tenantId, (client) =>
      client.query<{ provider: string; receipts: number }>(
        `select provider, (select count(*)::int from identity.external_subject_link_commands
                           where tenant_id=$1 and challenge_id=$4) receipts
           from integration.external_identity_map where tenant_id=$1 and issuer=$2 and subject=$3`,
        [tenantId, issuer, subject, input.challengeId],
      ),
    );
    expect(unchanged.rows).toEqual([{ provider: 'LOCAL', receipts: 0 }]);
  });

  it('waits on the same subject advisory lock used by ordinary login before linking', async () => {
    const subject = `subject-${randomUUID()}`;
    const key = externalSubjectAdvisoryKey({ tenantId, issuer, subject });
    const blocker = await admin.connect();
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    let settled = false;
    const pending = complete(command(), subject).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    await blocker.query('commit');
    blocker.release();
    await expect(pending).resolves.toEqual({ outcome: 'completed', result: 'LINKED' });
  });
});
