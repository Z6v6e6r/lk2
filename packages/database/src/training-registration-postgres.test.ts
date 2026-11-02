import {
  trainingStationRequest,
  trainingStationActor,
  stationAdmissionId,
  type TrainingStationMarker,
} from '@phub/subscription-runtime-adapter';
import { trainingHash } from '@phub/domain/training-registration';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  createTrainingStationFactRepository,
  createTrainingRegistrationRepository,
} from './training-registration-repository.js';
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

    async function stationAttempt(f: Awaited<ReturnType<typeof fixture>>, adopted = true) {
      const request = {
        trainingId: f.scope.trainingId,
        subscriptionId: f.authority.request.subscriptionId,
        dateHint: f.authority.request.target.dateHint,
      };
      await a.begin(f.scope, request, 'fixture-station-birth', adopted);
      return (await a.claimPreparation(f.scope))!;
    }
    async function marker(f: Awaited<ReturnType<typeof fixture>>): Promise<TrainingStationMarker> {
      const request = trainingStationRequest(f.authority),
        actor = trainingStationActor(f.authority);
      return {
        version: 1,
        outcome: 'OWNER_ADMISSION',
        actor,
        request,
        authoritySha256: await trainingHash(JSON.stringify(f.authority)),
        response: {
          contractVersion: 1,
          operationId: request.operationId,
          replayed: false,
          admission: {
            outcome: 'ADMITTED',
            admissionId: stationAdmissionId(tenantId, request.operationId),
            communityId: 'synthetic-station',
            membershipEpoch: 0,
            reason: 'ELIGIBLE',
            bindingSha256: 'sha256:' + 'a'.repeat(64),
          },
        },
      };
    }
    it('station intent has one lease winner; pin commit ACK loss preserves original capsule across recovery', async () => {
      const f = await fixture(),
        claim = await stationAttempt(f);
      const competing = await b.claimPreparation(f.scope);
      expect(competing?.token).toBeNull();
      expect(await b.pinStationPreparation(f.scope, randomUUID(), f.authority)).toBeNull();
      expect(
        (await a.pinStationPreparation(f.scope, claim.token!, f.authority))?.stationMembership,
      ).toEqual({ version: 1, outcome: 'INTENT', authority: f.authority });
      await withTenantTransaction(first, tenantId, (c) =>
        c.query(
          "update booking.training_registration_attempts set created_at=now()-interval '121 seconds',lease_until=now()-interval '1 second' where tenant_id=$1 and id=$2",
          [tenantId, claim.attempt.id],
        ),
      );
      const recovered = (await b.claimPreparation(f.scope))!;
      expect(recovered.attempt.stationMembership).toEqual({
        version: 1,
        outcome: 'INTENT',
        authority: f.authority,
      });
      const intent = recovered.attempt.stationMembership;
      if (intent?.outcome !== 'INTENT') throw new Error('fixture');
      expect(JSON.stringify(intent.authority)).toBe(JSON.stringify(f.authority));
      const recoveredMarker = await marker(f);
      if (recoveredMarker.outcome !== 'OWNER_ADMISSION') throw new Error('fixture');
      recoveredMarker.authoritySha256 = await trainingHash(JSON.stringify(intent.authority));
      expect(recoveredMarker.authoritySha256).toBe(await trainingHash(JSON.stringify(f.authority)));
      expect(
        await a.settlePreparation(
          f.scope,
          claim.token!,
          f.authority,
          'fixture-stale',
          await marker(f),
        ),
      ).toBeNull();
      const changed = await trainingAuthorityFixture({
        tenantId,
        userId: f.scope.userId,
        key: f.key,
        observedAt: new Date(Date.now() + 1).toISOString(),
      });
      await expect(
        b.settlePreparation(
          f.scope,
          recovered.token!,
          changed,
          'fixture-replacement',
          await marker(f),
        ),
      ).rejects.toThrow();
      const negative = {
        version: 1 as const,
        outcome: 'NO_ENROLLMENT' as const,
        reason: 'OWNER_UNAVAILABLE' as const,
      };
      expect(
        (
          await b.settlePreparation(
            f.scope,
            recovered.token!,
            f.authority,
            'fixture-timeout',
            negative,
          )
        )?.stationMembership,
      ).toEqual(negative);
      expect(
        await a.settlePreparation(
          f.scope,
          recovered.token!,
          f.authority,
          'fixture-late-ack',
          await marker(f),
        ),
      ).toBeNull();
      expect((await a.read(f.scope))?.stationMembership).toEqual(negative);
    });
    it('station pre-adoption NULL is never upgraded; forged marker or studio cannot settle', async () => {
      const legacy = await fixture(),
        claim = await stationAttempt(legacy, false);
      await a.begin(legacy.scope, claim.attempt.request, 'fixture-retry', true);
      expect((await b.read(legacy.scope))?.stationMembership).toBeNull();
      expect(
        await a.pinStationPreparation(legacy.scope, claim.token!, legacy.authority),
      ).toBeNull();
      await expect(
        a.settlePreparation(
          legacy.scope,
          claim.token!,
          legacy.authority,
          'fixture-forged',
          await marker(legacy),
        ),
      ).rejects.toThrow();
      const f = await fixture(),
        owned = await stationAttempt(f);
      await a.pinStationPreparation(f.scope, owned.token!, f.authority);
      const forged = await marker(f);
      if (forged.outcome !== 'OWNER_ADMISSION') throw new Error('fixture');
      forged.request.stationId = 'another-studio';
      await expect(
        a.settlePreparation(f.scope, owned.token!, f.authority, 'fixture-forged', forged),
      ).rejects.toThrow();
      expect((await a.read(f.scope))?.state).toBe('PREPARING');
    });
    it('station confirmed loader binds persisted event, original actor and validated receipt generation', async () => {
      const f = await fixture(),
        prepare = await stationAttempt(f);
      await a.pinStationPreparation(f.scope, prepare.token!, f.authority);
      const recovered = (await b.read(f.scope))!.stationMembership;
      if (recovered?.outcome !== 'INTENT') throw new Error('fixture');
      const recoveredMarker = await marker(f);
      if (recoveredMarker.outcome !== 'OWNER_ADMISSION') throw new Error('fixture');
      recoveredMarker.authoritySha256 = await trainingHash(JSON.stringify(recovered.authority));
      await a.settlePreparation(
        f.scope,
        prepare.token!,
        recovered.authority,
        'fixture-prepared',
        recoveredMarker,
      );
      const dispatch = (await a.claim(f.scope, 'fixture-dispatch'))!,
        receipt = await trainingReceiptFixture(f.authority, new Date().toISOString());
      await a.complete(
        f.scope,
        dispatch.token!,
        dispatch.attempt.authoritySha256!,
        receipt,
        'fixture-completion',
      );
      // Duplicate completion is a readback, not a second event/generation.
      await b.complete(
        f.scope,
        dispatch.token!,
        dispatch.attempt.authoritySha256!,
        receipt,
        'fixture-retry',
      );
      const events = await withTenantTransaction(first, tenantId, (c) =>
        c.query<{ id: string }>(
          "select id from audit.outbox_events where tenant_id=$1 and event_type='training.registration.confirmed.v1' and payload->>'operationId'=$2",
          [tenantId, dispatch.attempt.id],
        ),
      );
      expect(events.rows).toHaveLength(1);
      const input = {
          tenantId,
          eventId: events.rows[0]!.id,
          trainingId: f.scope.trainingId,
          userId: f.scope.userId,
          operationId: dispatch.attempt.id,
        },
        repo = createTrainingStationFactRepository(second);
      const fact = await repo.loadTrainingConfirmedFact(input);
      expect(fact?.request.confirmation).toEqual({
        kind: 'TRAINING_REGISTRATION',
        generationId: receipt.receiptId,
        activityId: f.scope.trainingId,
      });
      expect(fact?.correlationId).toBe('fixture-completion');
      expect(await repo.loadTrainingConfirmedFact({ ...input, eventId: randomUUID() })).toBeNull();
      expect(await repo.loadTrainingConfirmedFact({ ...input, userId: randomUUID() })).toBeNull();
      await withTenantTransaction(first, tenantId, (c) =>
        c.query(
          "update booking.training_registration_attempts set receipt=jsonb_set(receipt,'{receiptId}',to_jsonb($3::text)) where tenant_id=$1 and id=$2",
          [tenantId, dispatch.attempt.id, randomUUID()],
        ),
      );
      await expect(repo.loadTrainingConfirmedFact(input)).rejects.toThrow();
    });
    it('station terminal marker and preparation outbox commit atomically', async () => {
      const f = await fixture(),
        claim = await stationAttempt(f);
      await a.pinStationPreparation(f.scope, claim.token!, f.authority);
      const broken = {
        connect: async () => {
          const client = await first.connect();
          return {
            query: (sql: string, values?: unknown[]) => {
              if (sql.includes('insert into audit.outbox_events'))
                throw new Error('SYNTHETIC_STATION_OUTBOX');
              return client.query(sql, values);
            },
            release: () => client.release(),
          } as PoolClient;
        },
      } as Pool;
      await expect(
        createTrainingRegistrationRepository(broken).settlePreparation(
          f.scope,
          claim.token!,
          f.authority,
          'fixture-outbox',
          await marker(f),
        ),
      ).rejects.toThrow('SYNTHETIC_STATION_OUTBOX');
      expect((await b.read(f.scope))?.stationMembership?.outcome).toBe('INTENT');
      expect((await b.read(f.scope))?.authority).toBeNull();
    });
    it('flag-off registration SQL never names 0108 column and accepts a 0107-shaped row', async () => {
      const f = await fixture();
      const oldShape = {
        connect: async () => {
          const client = await first.connect();
          return {
            query: async (sql: string, values?: unknown[]) => {
              expect(sql).not.toContain('station_membership');
              const result = await client.query(sql, values);
              result.rows.forEach((row: Record<string, unknown>) => delete row.station_membership);
              return result;
            },
            release: () => client.release(),
          } as PoolClient;
        },
      } as Pool;
      const legacy = createTrainingRegistrationRepository(oldShape),
        request = {
          trainingId: f.scope.trainingId,
          subscriptionId: f.authority.request.subscriptionId,
          dateHint: f.authority.request.target.dateHint,
        };
      await legacy.begin(f.scope, request, 'fixture-old-begin');
      const preparation = (await legacy.claimPreparation(f.scope))!;
      await legacy.settlePreparation(
        f.scope,
        preparation.token!,
        f.authority,
        'fixture-old-prepare',
      );
      const dispatch = (await legacy.claim(f.scope, 'fixture-old-dispatch'))!;
      expect(
        (
          await legacy.complete(
            f.scope,
            dispatch.token!,
            dispatch.attempt.authoritySha256!,
            await trainingReceiptFixture(f.authority, new Date().toISOString()),
            'fixture-old-complete',
          )
        )?.state,
      ).toBe('CONFIRMED');
    });
  },
);
