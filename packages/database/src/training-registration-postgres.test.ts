import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createTrainingRegistrationRepository } from './training-registration-repository.js';
import { withTenantTransaction } from './connection.js';
import {
  trainingAuthorityFixture,
  trainingReceiptFixture,
} from '../../subscription-runtime-adapter/src/training-registration.test-fixture.js';
function ciDatabase() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL) throw new Error('TRAINING_DISPOSABLE_CI_DATABASE_REQUIRED');
  const u = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    !['localhost', '127.0.0.1'].includes(u.hostname) ||
    u.username !== 'phub' ||
    u.password !== 'ci-password' ||
    u.pathname !== '/phub' ||
    u.port !== '5432' ||
    u.search ||
    u.hash
  )
    throw new Error('TRAINING_DISPOSABLE_CI_DATABASE_REQUIRED');
  return u.href;
}
const url = ciDatabase();
(url ? describe : describe.skip)(
  'training journal on existing migrated disposable CI PostgreSQL',
  () => {
    const first = new Pool({ connectionString: url, max: 2 }),
      second = new Pool({ connectionString: url, max: 2 }),
      a = createTrainingRegistrationRepository(first),
      b = createTrainingRegistrationRepository(second),
      tenantId = randomUUID();
    beforeAll(async () => {
      await first.query(
        "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic training')",
        [tenantId, 'training-' + tenantId],
      );
      expect(
        (await first.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid,
      ).not.toBe((await second.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid);
      expect(await a.ready()).toBe(true);
    });
    afterAll(async () => {
      try {
        await withTenantTransaction(first, tenantId, async (c) => {
          for (const table of [
            'booking.training_registration_attempts',
            'audit.outbox_events',
            'audit.audit_log',
            'identity.users',
          ])
            await c.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
        });
        await first.query('delete from identity.tenants where id=$1', [tenantId]);
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
    });
    async function fixture(expired = false) {
      const userId = randomUUID(),
        key = 'fixture-training-' + randomUUID();
      await withTenantTransaction(first, tenantId, (c) =>
        c.query("insert into identity.users(tenant_id,id,status) values($1,$2,'ACTIVE')", [
          tenantId,
          userId,
        ]),
      );
      const authority = await trainingAuthorityFixture({
          tenantId,
          userId,
          key,
          observedAt: new Date(Date.now() - (expired ? 61000 : 1000)).toISOString(),
        }),
        scope = {
          tenantId,
          userId,
          trainingId: authority.request.target.id,
          keySha256: authority.keySha256,
        };
      return { authority, scope, key };
    }
    async function prepared(f: Awaited<ReturnType<typeof fixture>>) {
      await a.begin(
        f.scope,
        {
          trainingId: f.scope.trainingId,
          subscriptionId: f.authority.request.subscriptionId,
          dateHint: f.authority.request.target.dateHint,
        },
        'fixture-start',
      );
      const claim = (await a.claimPreparation(f.scope))!;
      return (await a.settlePreparation(f.scope, claim.token!, f.authority, 'fixture-prepared'))!;
    }
    it('independent connections serialize initial dispatch and immutable same-key/different-key conflicts', async () => {
      const f = await fixture();
      await prepared(f);
      const claims = await Promise.all([
        a.claim(f.scope, 'fixture-one'),
        b.claim(f.scope, 'fixture-two'),
      ]);
      expect(claims.filter((c) => c?.token)).toHaveLength(1);
      const other = await trainingAuthorityFixture({
        tenantId,
        userId: f.scope.userId,
        key: f.key + '-other',
        observedAt: new Date().toISOString(),
      });
      await expect(
        b.begin(
          { ...f.scope, keySha256: other.keySha256 },
          {
            trainingId: f.scope.trainingId,
            subscriptionId: other.request.subscriptionId,
            dateHint: other.request.target.dateHint,
          },
          'fixture-other',
        ),
      ).rejects.toMatchObject({ code: 'TRAINING_REGISTRATION_ATTEMPT_EXISTS' });
      expect((await a.read(f.scope))?.authority).toEqual(f.authority);
    });
    it('explicit expired PREPARED CAS releases only that no-dispatch fence; GET changes nothing', async () => {
      const f = await fixture(true),
        original = await prepared(f);
      expect((await b.read(f.scope))?.state).toBe('PREPARED');
      const [one, two] = await Promise.all([
        a.claim(f.scope, 'fixture-one'),
        b.claim(f.scope, 'fixture-two'),
      ]);
      expect(one?.attempt.state).toBe('EXPIRED_NOT_DISPATCHED');
      expect(two?.token).toBeNull();
      expect((await a.read(f.scope))?.authority).toEqual(original.authority);
      const next = await trainingAuthorityFixture({
        tenantId,
        userId: f.scope.userId,
        key: f.key + '-next',
        observedAt: new Date().toISOString(),
      });
      expect(
        (
          await b.begin(
            { ...f.scope, keySha256: next.keySha256 },
            {
              trainingId: f.scope.trainingId,
              subscriptionId: next.request.subscriptionId,
              dateHint: next.request.target.dateHint,
            },
            'fixture-next',
          )
        ).state,
      ).toBe('PREPARING');
      expect((await a.read(f.scope))?.state).toBe('EXPIRED_NOT_DISPATCHED');
    });
    it('claim winner retains target fence through expiry; stale lease ACK fails; postcommit lost response replays receipt', async () => {
      const f = await fixture();
      await prepared(f);
      const firstClaim = (await a.claim(f.scope, 'fixture-first'))!;
      await withTenantTransaction(first, tenantId, (c) =>
        c.query(
          "update booking.training_registration_attempts set created_at=now()-interval '121 seconds',lease_until=now()-interval '1 second' where tenant_id=$1 and id=$2",
          [tenantId, firstClaim.attempt.id],
        ),
      );
      const secondClaim = (await b.claim(f.scope, 'fixture-second'))!;
      expect(secondClaim.recovery).toBe(true);
      const receipt = await trainingReceiptFixture(f.authority, new Date().toISOString());
      expect(
        await a.complete(
          f.scope,
          firstClaim.token!,
          firstClaim.attempt.authoritySha256!,
          receipt,
          'fixture-stale',
        ),
      ).toBeNull();
      const done = await b.complete(
        f.scope,
        secondClaim.token!,
        secondClaim.attempt.authoritySha256!,
        receipt,
        'fixture-complete',
      );
      expect(done?.state).toBe('CONFIRMED');
      expect((await a.read(f.scope))?.receipt).toEqual(receipt);
      const before = await first.query(
        'select count(*)::int n from audit.outbox_events where tenant_id=$1',
        [tenantId],
      );
      expect(
        (
          await a.complete(
            f.scope,
            secondClaim.token!,
            secondClaim.attempt.authoritySha256!,
            receipt,
            'fixture-lost-response-retry',
          )
        )?.receipt,
      ).toEqual(receipt);
      expect(
        (
          await first.query('select count(*)::int n from audit.outbox_events where tenant_id=$1', [
            tenantId,
          ])
        ).rows,
      ).toEqual(before.rows);
    });
    it('transaction outbox failure rolls back confirmation and expired transition', async () => {
      const f = await fixture();
      await prepared(f);
      const claim = (await a.claim(f.scope, 'fixture-first'))!;
      const receipt = await trainingReceiptFixture(f.authority, new Date().toISOString());
      const broken = {
        connect: async () => {
          const client = await first.connect();
          return {
            query: (text: string, values?: unknown[]) => {
              if (text.includes('insert into audit.outbox_events'))
                throw new Error('SYNTHETIC_OUTBOX_FAILURE');
              return client.query(text, values);
            },
            release: () => client.release(),
          } as PoolClient;
        },
      } as Pool;
      await expect(
        createTrainingRegistrationRepository(broken).complete(
          f.scope,
          claim.token!,
          claim.attempt.authoritySha256!,
          receipt,
          'fixture-failure',
        ),
      ).rejects.toThrow('SYNTHETIC_OUTBOX_FAILURE');
      expect((await a.read(f.scope))?.state).toBe('DISPATCH_STARTED');
      const expired = await fixture(true);
      await prepared(expired);
      await expect(
        createTrainingRegistrationRepository(broken).claim(expired.scope, 'fixture-expiry-failure'),
      ).rejects.toThrow();
      expect((await a.read(expired.scope))?.state).toBe('PREPARED');
    });
    it('foreign actor scope, FK and malformed states fail closed; table has FORCE RLS', async () => {
      const f = await fixture();
      await prepared(f);
      expect(await b.read({ ...f.scope, userId: randomUUID() })).toBeNull();
      const row = await first.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relrowsecurity,relforcerowsecurity from pg_class where oid='booking.training_registration_attempts'::regclass",
      );
      expect(row.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
      await expect(
        withTenantTransaction(first, tenantId, (c) =>
          c.query(
            "update booking.training_registration_attempts set state='CONFIRMED' where tenant_id=$1 and id=$2",
            [tenantId, f.authority.request.preparation.operationId],
          ),
        ),
      ).rejects.toThrow();
      const invalid = await trainingAuthorityFixture({
        tenantId,
        userId: randomUUID(),
        key: 'fixture-invalid-' + randomUUID(),
        observedAt: new Date().toISOString(),
      });
      await expect(
        a.begin(
          {
            ...f.scope,
            userId: invalid.request.preparation.actor.userId,
            keySha256: invalid.keySha256,
          },
          {
            trainingId: f.scope.trainingId,
            subscriptionId: invalid.request.subscriptionId,
            dateHint: invalid.request.target.dateHint,
          },
          'fixture-fk',
        ),
      ).rejects.toThrow();
    });
    it('preparation competing leases fence late successful ACK and refusal; terminal retains original key', async () => {
      const f = await fixture(),
        request = {
          trainingId: f.scope.trainingId,
          subscriptionId: f.authority.request.subscriptionId,
          dateHint: f.authority.request.target.dateHint,
        };
      await a.begin(f.scope, request, 'fixture-start');
      const claims = await Promise.all([a.claimPreparation(f.scope), b.claimPreparation(f.scope)]);
      expect(claims.filter((x) => x?.token)).toHaveLength(1);
      const original = claims.find((x) => x?.token)!;
      await withTenantTransaction(first, tenantId, (c) =>
        c.query(
          "update booking.training_registration_attempts set created_at=now()-interval '121 seconds',lease_until=now()-interval '1 second' where tenant_id=$1 and id=$2",
          [tenantId, original.attempt.id],
        ),
      );
      const fresh = (await b.claimPreparation(f.scope))!;
      expect(fresh.token).not.toBe(original.token);
      expect(
        await a.settlePreparation(f.scope, original.token!, f.authority, 'fixture-old'),
      ).toBeNull();
      expect(
        await a.settlePreparation(f.scope, original.token!, null, 'fixture-old-refusal'),
      ).toBeNull();
      expect(
        (await b.settlePreparation(f.scope, fresh.token!, null, 'fixture-refusal'))?.state,
      ).toBe('REJECTED_NOT_DISPATCHED');
      expect(
        await a.settlePreparation(f.scope, fresh.token!, f.authority, 'fixture-late'),
      ).toBeNull();
      await expect(
        a.begin(f.scope, { ...request, subscriptionId: randomUUID() }, 'fixture-conflict'),
      ).rejects.toMatchObject({ code: 'TRAINING_REGISTRATION_KEY_CONFLICT' });
      const next = await trainingAuthorityFixture({
        tenantId,
        userId: f.scope.userId,
        key: f.key + '-next',
        observedAt: new Date().toISOString(),
      });
      expect(
        (await a.begin({ ...f.scope, keySha256: next.keySha256 }, request, 'fixture-replacement'))
          .state,
      ).toBe('PREPARING');
      expect((await b.read(f.scope))?.state).toBe('REJECTED_NOT_DISPATCHED');
    });
  },
);
