import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTournamentLocalRepository,
  type TournamentAttempt,
} from './tournament-local-repository.js';
import { withTenantTransaction } from './connection.js';
import { tournamentDigest, type TournamentOwnerReceipt } from '@phub/domain';
function ciDatabase() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw new Error('TOURNAMENT_CI_DATABASE_REQUIRED');
  const u = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['127.0.0.1', 'localhost'].includes(u.hostname) ||
    u.username !== 'phub' ||
    u.password !== 'ci-password' ||
    u.pathname !== '/phub' ||
    u.port !== '5432' ||
    u.search ||
    u.hash
  )
    throw new Error('TOURNAMENT_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ciDatabase();
(url ? describe : describe.skip)(
  'CUP tournament custody on existing migrated CI PostgreSQL',
  () => {
    const first = new Pool({ connectionString: url, max: 2 }),
      second = new Pool({ connectionString: url, max: 2 }),
      a = createTournamentLocalRepository(first),
      b = createTournamentLocalRepository(second),
      tenantId = randomUUID(),
      tenantKey = 'tournament-' + tenantId;
    beforeAll(async () => {
      await first.query(
        "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic tournament')",
        [tenantId, tenantKey],
      );
      expect(await a.ready()).toBe(true);
      expect(
        (await first.query<{ id: number }>('select pg_backend_pid() id')).rows[0]!.id,
      ).not.toBe((await second.query<{ id: number }>('select pg_backend_pid() id')).rows[0]!.id);
      await withTenantTransaction(first, tenantId, (c) =>
        c.query(
          "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','fixture-tenant')",
          [tenantId],
        ),
      );
    });
    afterAll(async () => {
      try {
        await withTenantTransaction(first, tenantId, async (c) => {
          for (const t of [
            'booking.tournament_local_attempts',
            'audit.outbox_events',
            'audit.audit_log',
            'identity.refresh_sessions',
            'integration.external_entity_map',
            'integration.identity_provider_bindings',
            'identity.users',
          ])
            await c.query(`delete from ${t} where tenant_id=$1`, [tenantId]);
        });
        await first.query('delete from identity.tenants where id=$1', [tenantId]);
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
    });
    async function fixture() {
      const userId = randomUUID(),
        sessionId = randomUUID(),
        tournamentId = randomUUID(),
        providerMappingId = randomUUID(),
        providerClientId = 'synthetic-' + userId;
      await withTenantTransaction(first, tenantId, async (c) => {
        await c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
          tenantId,
          userId,
        ]);
        await c.query(
          "insert into identity.refresh_sessions(id,tenant_id,user_id,family_id,token_hash,expires_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')",
          [sessionId, tenantId, userId, randomUUID(), await tournamentDigest('fixture', sessionId)],
        );
        await c.query(
          "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
          [tenantId, providerMappingId, userId, providerClientId],
        );
      });
      return {
        actor: { tenantId, tenantKey, userId, sessionId, correlationId: 'synthetic-tournament' },
        scope: { tenantId, userId, tournamentId },
        identity: { providerClientId, providerMappingId, providerTenantKey: 'fixture-tenant' },
        key: await tournamentDigest('fixture-key', randomUUID()),
      };
    }
    const receipt = (x: TournamentAttempt): TournamentOwnerReceipt => ({
      schemaVersion: 1,
      tournamentId: x.tournamentId,
      operation: {
        operationId: x.ownerOperationId,
        action: x.command.action,
        outcome: x.command.action === 'JOIN' ? 'REGISTERED' : 'LEFT',
        reason: x.command.action === 'JOIN' ? 'REGISTERED' : 'LEFT',
        generation:
          x.command.action === 'JOIN' ? x.ownerOperationId : x.command.originalJoinOperationId!,
        committedAt: new Date().toISOString(),
      },
      registration: {
        status: x.command.action === 'JOIN' ? 'REGISTERED' : 'NOT_REGISTERED_BY_OPERATION',
        asOf: new Date().toISOString(),
      },
    });
    it('two independent same-key requests converge, one dispatch lease and pinned date', async () => {
      const f = await fixture();
      const rows = await Promise.all([
        a.begin(f.actor, f.scope.tournamentId, f.key, { action: 'JOIN' }, f.identity, '2026-11-01'),
        b.begin(f.actor, f.scope.tournamentId, f.key, { action: 'JOIN' }, f.identity, '2026-11-02'),
      ]);
      expect(rows[0].id).toBe(rows[1].id);
      expect(rows[0].command).toEqual(rows[1].command);
      const leases = await Promise.all([
        a.claim(f.actor, f.scope, rows[0].id),
        b.claim(f.actor, f.scope, rows[0].id),
      ]);
      expect(leases.filter(Boolean)).toHaveLength(1);
      await expect(
        b.begin(
          f.actor,
          f.scope.tournamentId,
          await tournamentDigest('other', f.key),
          { action: 'JOIN' },
          f.identity,
          '2026-11-01',
        ),
      ).rejects.toMatchObject({ code: 'TOURNAMENT_LOCAL_PENDING' });
    });
    it('invalid receipt cannot complete; commit/lost-response replay emits one completed outbox', async () => {
      const f = await fixture(),
        x = await a.begin(
          f.actor,
          f.scope.tournamentId,
          f.key,
          { action: 'JOIN' },
          f.identity,
          '2026-11-01',
        ),
        lease = (await a.claim(f.actor, f.scope, x.id))!,
        r = receipt(x);
      await expect(
        a.complete(f.actor, f.scope, x.id, lease, {
          ...r,
          operation: { ...r.operation, generation: randomUUID() },
        }),
      ).rejects.toThrow();
      expect((await a.read(f.scope, { id: x.id }))?.state).toBe('DISPATCHED');
      await a.complete(f.actor, f.scope, x.id, lease, r);
      const repeated = await b.complete(f.actor, f.scope, x.id, lease, r);
      expect(repeated?.state).toBe('COMPLETED');
      expect(
        (
          await first.query<{ n: number }>(
            "select count(*)::int n from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type='tournament.local.completed'",
            [tenantId, x.tournamentId],
          )
        ).rows[0]!.n,
      ).toBe(1);
      await expect(
        b.complete(f.actor, f.scope, x.id, lease, {
          ...r,
          operation: { ...r.operation, reason: 'FULL' },
        }),
      ).rejects.toThrow();
    });
    it('LEAVE pins original generation; old terminal replay cannot target later JOIN', async () => {
      const f = await fixture(),
        join = await a.begin(
          f.actor,
          f.scope.tournamentId,
          f.key,
          { action: 'JOIN' },
          f.identity,
          '2026-11-01',
        );
      await a.complete(
        f.actor,
        f.scope,
        join.id,
        (await a.claim(f.actor, f.scope, join.id))!,
        receipt(join),
      );
      const leave = await a.begin(
        f.actor,
        f.scope.tournamentId,
        await tournamentDigest('leave', f.key),
        { action: 'LEAVE', originalJoinOperationId: join.id },
        f.identity,
        '2099-01-01',
      );
      expect(leave.command.date).toBe(join.command.date);
      expect(leave.command.originalJoinOperationId).toBe(join.ownerOperationId);
      await a.complete(
        f.actor,
        f.scope,
        leave.id,
        (await a.claim(f.actor, f.scope, leave.id))!,
        receipt(leave),
      );
      const rejoin = await a.begin(
        f.actor,
        f.scope.tournamentId,
        await tournamentDigest('rejoin', f.key),
        { action: 'JOIN' },
        f.identity,
        '2026-11-01',
      );
      expect(rejoin.ownerOperationId).not.toBe(join.ownerOperationId);
      expect((await b.read(f.scope, { id: leave.id }))?.command.originalJoinOperationId).toBe(
        join.ownerOperationId,
      );
      expect(await b.claim(f.actor, f.scope, leave.id)).toBeNull();
    });
    it('revoked session or mapping drift cannot claim, foreign original denied and RLS is forced', async () => {
      const f = await fixture(),
        x = await a.begin(
          f.actor,
          f.scope.tournamentId,
          f.key,
          { action: 'JOIN' },
          f.identity,
          '2026-11-01',
        );
      await withTenantTransaction(first, tenantId, (c) =>
        c.query('update identity.refresh_sessions set revoked_at=now() where id=$1', [
          f.actor.sessionId,
        ]),
      );
      await expect(a.claim(f.actor, f.scope, x.id)).rejects.toMatchObject({ status: 403 });
      const other = await fixture();
      await expect(
        a.begin(
          other.actor,
          other.scope.tournamentId,
          other.key,
          { action: 'LEAVE', originalJoinOperationId: x.id },
          other.identity,
          '2026-11-01',
        ),
      ).rejects.toThrow();
      const flags = (
        await first.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          "select relrowsecurity,relforcerowsecurity from pg_class where oid='booking.tournament_local_attempts'::regclass",
        )
      ).rows[0];
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(await b.read({ ...f.scope, userId: other.actor.userId }, { id: x.id })).toBeNull();
    });
    it('registered JOIN remains discoverable after newer rejected JOIN, scoped to actor and target', async () => {
      const f = await fixture();
      const original = await a.begin(
        f.actor,
        f.scope.tournamentId,
        f.key,
        { action: 'JOIN' },
        f.identity,
        '2026-11-01',
      );
      await a.complete(
        f.actor,
        f.scope,
        original.id,
        (await a.claim(f.actor, f.scope, original.id))!,
        receipt(original),
      );
      const newer = await b.begin(
        f.actor,
        f.scope.tournamentId,
        await tournamentDigest('new', f.key),
        { action: 'JOIN' },
        f.identity,
        '2026-11-01',
      );
      const rejected = {
        ...receipt(newer),
        operation: {
          ...receipt(newer).operation,
          outcome: 'REJECTED' as const,
          reason: 'MEMBERSHIP_EXISTS' as const,
          generation: null,
        },
        registration: { status: 'UNKNOWN' as const, asOf: new Date().toISOString() },
      };
      await b.complete(
        f.actor,
        f.scope,
        newer.id,
        (await b.claim(f.actor, f.scope, newer.id))!,
        rejected,
      );
      expect((await a.read(f.scope))?.id).toBe(newer.id);
      expect((await b.registeredJoinCandidate(f.scope))?.id).toBe(original.id);
      expect(await b.registeredJoinCandidate({ ...f.scope, userId: randomUUID() })).toBeNull();
      expect(
        await b.registeredJoinCandidate({ ...f.scope, tournamentId: randomUUID() }),
      ).toBeNull();
    });
    it('real isolated non-superuser RLS denies cross-tenant SELECT and INSERT', async () => {
      const f = await fixture();
      const x = await a.begin(
        f.actor,
        f.scope.tournamentId,
        f.key,
        { action: 'JOIN' },
        f.identity,
        '2026-11-01',
      );
      const role = 'tournament_rls_' + randomUUID().replaceAll('-', ''),
        client = await first.connect();
      let roleCreated = false;
      try {
        const raw = (
          await client.query<{ data: Record<string, unknown> }>(
            'select row_to_json(t) data from booking.tournament_local_attempts t where tenant_id=$1 and id=$2',
            [tenantId, x.id],
          )
        ).rows[0]!.data;
        raw.id = randomUUID();
        raw.key_sha256 = await tournamentDigest('isolated-role', raw.id);
        await client.query(`create role ${role} nosuperuser nobypassrls noinherit`);
        roleCreated = true;
        await client.query(`grant usage on schema booking to ${role}`);
        await client.query(`grant select,insert on booking.tournament_local_attempts to ${role}`);
        expect(
          (
            await client.query(
              'select rolsuper,rolbypassrls,rolinherit from pg_roles where rolname=$1',
              [role],
            )
          ).rows[0],
        ).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false });
        await client.query('begin');
        await client.query(`set local role ${role}`);
        await client.query("select set_config('app.tenant_id',$1,true)", [randomUUID()]);
        expect(
          (
            await client.query('select id from booking.tournament_local_attempts where id=$1', [
              x.id,
            ])
          ).rowCount,
        ).toBe(0);
        await expect(
          client.query(
            'insert into booking.tournament_local_attempts select * from jsonb_populate_record(null::booking.tournament_local_attempts,$1::jsonb)',
            [JSON.stringify(raw)],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        try {
          await client.query('rollback').catch(() => undefined);
          if (roleCreated) {
            await client.query(`drop owned by ${role}`);
            await client.query(`drop role ${role}`);
          }
        } finally {
          client.release();
        }
      }
    });

    it('audit constraint failure rolls back completion and allows exact retry', async () => {
      const f = await fixture(),
        x = await a.begin(
          f.actor,
          f.scope.tournamentId,
          f.key,
          { action: 'JOIN' },
          f.identity,
          '2026-11-01',
        ),
        lease = (await a.claim(f.actor, f.scope, x.id))!,
        r = receipt(x);
      await expect(
        a.complete(
          { ...f.actor, correlationId: null as unknown as string },
          f.scope,
          x.id,
          lease,
          r,
        ),
      ).rejects.toMatchObject({ code: '23502' });
      expect((await b.read(f.scope, { id: x.id }))?.state).toBe('DISPATCHED');
      const q = await first.query<{ n: number }>(
        "select count(*)::int n from audit.outbox_events where tenant_id=$1 and payload->>'operationId'=$2 and event_type='tournament.local.completed'",
        [tenantId, x.id],
      );
      expect(q.rows[0]!.n).toBe(0);
      expect((await b.complete(f.actor, f.scope, x.id, lease, r))?.state).toBe('COMPLETED');
    });
  },
);
