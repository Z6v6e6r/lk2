import {
  createManagedSelfLeaveRepository,
  type ManagedSelfLeaveAttempt,
} from './managed-self-leave-repository.js';
import type { ManagedSelfLeaveReceipt } from '@phub/domain';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManagedJoinReceipt, type ManagedJoinBinding } from '@phub/domain';
import { withTenantTransaction } from './connection.js';
import {
  createGameRosterRepository,
  type BeginPaidJoinInput,
  type ConfirmGamePaymentInput,
} from './game-roster-repository.js';

// Existing migrated quality-full service only. Never adopt an ambient/local or remote database.
function ciDatabase(): string | undefined {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.APP_ENV !== 'ci') return undefined;
  if (!process.env.DATABASE_URL)
    throw new Error('MANAGED_SELF_LEAVE_DISPOSABLE_CI_DATABASE_REQUIRED');
  const url = new URL(process.env.DATABASE_URL);
  if (
    process.env.VIVA_MODE !== 'mock' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.password !== 'ci-password' ||
    url.pathname !== '/phub' ||
    url.port !== '5432' ||
    url.search ||
    url.hash
  )
    throw new Error('MANAGED_SELF_LEAVE_DISPOSABLE_CI_DATABASE_REQUIRED');
  return url.toString();
}
const url = ciDatabase();
const suite = url ? describe : describe.skip;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

suite('managed SELF LEAVE on existing disposable CI PostgreSQL (no provider calls)', () => {
  // Different pools force independent sessions, unlike a single mocked Pool or transaction.
  const first = new Pool({ connectionString: url, max: 1 });
  const second = new Pool({ connectionString: url, max: 1 });
  const repo1 = createGameRosterRepository(first);
  const repo2 = createGameRosterRepository(second);
  const tenantId = randomUUID();
  const organizer = randomUUID();
  const player1 = randomUUID();
  const player2 = randomUUID();
  const stationId = randomUUID();
  beforeAll(async () => {
    await first.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic managed JOIN')",
      [tenantId, `managed-self-leave-${tenantId}`],
    );
    await withTenantTransaction(first, tenantId, async (client) => {
      await client.query(
        "insert into identity.users(tenant_id,id,status) select $1,id,'ACTIVE' from unnest($2::uuid[]) id",
        [tenantId, [organizer, player1, player2]],
      );
      await client.query(
        "insert into profile.user_summaries(tenant_id,user_id,display_name,phone_e164) values($1,$2,'Synthetic One','+79990000101'),($1,$3,'Synthetic Two','+79990000102')",
        [tenantId, player1, player2],
      );
    });
    const [a, b] = await Promise.all([
      first.query<{ pid: number }>('select pg_backend_pid() pid'),
      second.query<{ pid: number }>('select pg_backend_pid() pid'),
    ]);
    expect(a.rows[0]?.pid).not.toBe(b.rows[0]?.pid);
  });
  afterAll(async () => {
    try {
      await withTenantTransaction(first, tenantId, async (client) => {
        // Closed allowlist and exact unique fixture tenant; no TRUNCATE, global DDL or cascade.
        for (const table of [
          'games.managed_self_leave_command_links',
          'games.managed_self_leave_attempts',
          'audit.outbox_events',
          'audit.audit_log',
          'games.payment_confirmation_evidence',
          'games.scheduled_commands',
          'games.participations',
          'games.seat_reservations',
          'games.command_idempotency',
          'eligibility.payment_snapshots',
          'eligibility.decisions',
          'integration.external_entity_map',
          'games.games',
          'profile.user_summaries',
          'identity.users',
        ])
          await client.query(`delete from ${table} where tenant_id=$1`, [tenantId]);
      });
      await first.query('delete from identity.tenants where id=$1', [tenantId]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });
  async function fixtureGame() {
    const gameId = randomUUID();
    const mappingId = randomUUID();
    const startsAt = new Date(Date.now() + 7_200_000).toISOString();
    await withTenantTransaction(first, tenantId, async (client) => {
      await client.query(
        `insert into games.games(tenant_id,id,organizer_user_id,title,kind,visibility,lifecycle_state,station_id,
        starts_at,ends_at,timezone,capacity,waitlist_enabled,payment_mode)
        values($1,$2,$3,'Synthetic managed JOIN','FRIENDLY','PUBLIC','SCHEDULED',$4,$5,$5::timestamptz+interval '90 minutes','Europe/Moscow',2,false,'SUBSCRIPTION')`,
        [tenantId, gameId, organizer, stationId, startsAt],
      );
      await client.query(
        "insert into games.participations(tenant_id,game_id,user_id,role) values($1,$2,$3,'ORGANIZER')",
        [tenantId, gameId, organizer],
      );
      await client.query(
        `insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,external_version,sync_status,last_synced_at)
        values($1,$2,'VIVA','exercise',$3,$4,'fixture-v1','synced',now())`,
        [tenantId, mappingId, gameId, `fixture-exercise:${gameId}`],
      );
    });
    return { gameId, mappingId, startsAt };
  }
  function command(
    game: Awaited<ReturnType<typeof fixtureGame>>,
    actorUserId = player1,
  ): BeginPaidJoinInput {
    const operationId = randomUUID();
    const idempotencyKey = `managed-join:${operationId}`;
    const managedJoin: ManagedJoinBinding = {
      contractVersion: 2,
      requestFingerprint: hash(idempotencyKey),
      entitlement: {
        subscriptionInstanceId: `subscription:${actorUserId}`,
        expectations: {
          schemaVersion: 1,
          policyVersion: 3,
          policyDigest: `sha256:${hash('synthetic-policy')}`,
          targetSnapshot: {
            snapshotId: `snapshot:${game.gameId}`,
            revision: 1,
            evidenceRef: `evidence:${game.gameId}`,
          },
        },
      },
    };
    return {
      tenantId,
      actorUserId,
      gameId: game.gameId,
      operationId,
      idempotencyKey,
      correlationId: `managed-join:${operationId}`,
      expectedRevision: 1,
      subscriptionInstanceId: randomUUID(),
      reservationTtlSeconds: 600,
      managedJoin,
      bindingRefs: {
        policyRef: {
          policyVersion: 3,
          policyDigest: managedJoin.entitlement.expectations.policyDigest,
        },
      },
      requestHash: hash('game.join.managed.v2\0' + JSON.stringify(managedJoin)),
      price: {
        amountMinor: 0,
        currency: 'RUB',
        basePriceMinor: 0,
        freeMinutes: 90,
        paidMinutes: 0,
        evaluatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
      providerBinding: {
        providerClientId: `client:${actorUserId}`,
        providerClientSubscriptionId: `client-subscription:${actorUserId}`,
        providerMappingId: randomUUID(),
        providerExerciseId: `fixture-exercise:${game.gameId}`,
        targetMappingId: game.mappingId,
        targetVersion: 'fixture-v1',
        startsAt: game.startsAt,
        durationMinutes: 90,
        capacity: 2,
        admissible: true,
        requestSha256: `sha256:${hash('synthetic-owner-admission:' + operationId)}`,
        idempotencyKeySha256: `sha256:${hash(idempotencyKey)}`,
      },
    };
  }
  function confirmation(input: BeginPaidJoinInput, reservationId: string): ConfirmGamePaymentInput {
    const b = input.providerBinding!;
    const e = input.managedJoin!.entitlement;
    const receipt = parseManagedJoinReceipt({
      contractVersion: 2,
      source: 'LK1_SUBSCRIPTION_BOOKING_OWNER',
      operationId: input.operationId,
      tenantId,
      userId: input.actorUserId,
      gameId: input.gameId,
      reservationId,
      providerClientId: b.providerClientId,
      providerClientSubscriptionId: b.providerClientSubscriptionId,
      providerMappingId: b.providerMappingId,
      providerExerciseId: b.providerExerciseId,
      targetMappingId: b.targetMappingId,
      targetVersion: b.targetVersion,
      requestSha256: b.requestSha256,
      idempotencyKeySha256: b.idempotencyKeySha256,
      bookingId: `fixture-booking:${input.operationId}`,
      verifiedAt: new Date().toISOString(),
      entitlement: {
        subscriptionInstanceId: e.subscriptionInstanceId,
        policyRef: {
          policyVersion: e.expectations.policyVersion,
          policyDigest: e.expectations.policyDigest,
        },
        usageRef: {
          usageRef: `booking:${hash(input.operationId).slice(0, 48)}`,
          reservationUnits: 1,
        },
      },
    });
    const evidenceHash = hash(
      JSON.stringify(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b))),
    );
    return {
      tenantId,
      actorUserId: input.actorUserId,
      gameId: input.gameId,
      reservationId,
      idempotencyKey: `confirm:${input.operationId}`,
      requestHash: evidenceHash,
      correlationId: input.correlationId,
      paidJoinBinding: b,
      managedJoinReceipt: receipt,
      evidence: {
        provider: 'VIVA',
        operationType: 'SUBSCRIPTION_BOOKING',
        operationId: input.operationId,
        bookingId: receipt.bookingId,
        exerciseId: receipt.providerExerciseId,
        evidenceHash,
        verifiedAt: receipt.verifiedAt,
        verifiedBy: 'LEGACY_NODE_RED',
      },
    };
  }

  const leave1 = createManagedSelfLeaveRepository(first),
    leave2 = createManagedSelfLeaveRepository(second);
  async function joined() {
    const game = await fixtureGame();
    const join = command(game);
    const started = await repo1.beginPaidJoin(join);
    if (started.outcome !== 'reserved') throw new Error('FIXTURE_JOIN_NOT_RESERVED');
    const proof = confirmation(join, started.reservationId);
    const result = await repo1.confirmPayment(proof);
    if (result.outcome !== 'applied') throw new Error('FIXTURE_JOIN_NOT_CONFIRMED');
    await withTenantTransaction(first, tenantId, async (client) => {
      await client.query(
        `insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,external_version,sync_status,last_synced_at) values($1,$2,'LK_LEGACY_SNAPSHOT','game',$3,$4,'fixture-legacy-v1','synced',now())`,
        [tenantId, randomUUID(), game.gameId, 'legacy:' + game.gameId],
      );
    });
    const input = {
      tenantId,
      actorUserId: player1,
      gameId: game.gameId,
      idempotencyKey: 'self-leave:' + randomUUID(),
      requestHash: hash('leave:' + game.gameId),
      correlationId: 'self-leave:' + randomUUID(),
      providerClientId: join.providerBinding!.providerClientId,
      providerMappingId: join.providerBinding!.providerMappingId,
    };
    return { game, join, result, input };
  }
  function receipt(a: ManagedSelfLeaveAttempt): ManagedSelfLeaveReceipt {
    const x = a.authority,
      j = x.originalJoinReceipt,
      q = x.request;
    const generation = 'synthetic-generation:' + q.participationId;
    return {
      contractVersion: 1,
      source: 'LK1_MANAGED_SELF_LEAVE_OWNER',
      operationId: x.operationId,
      tenantId,
      userId: player1,
      gameId: q.target.id,
      participationId: q.participationId,
      reservationId: q.reservationId,
      joinOperationId: q.joinOperationId,
      joinReceiptSha256: q.joinReceiptSha256,
      requestSha256: x.requestSha256,
      idempotencyKeySha256: x.idempotencyKeySha256,
      legacyGameId: x.legacyGameId,
      legacyGameMappingId: x.legacyGameMappingId,
      legacyGameMappingVersion: x.legacyGameMappingVersion,
      providerMappingId: j.providerMappingId,
      providerClientId: j.providerClientId,
      providerClientSubscriptionId: j.providerClientSubscriptionId,
      providerExerciseId: j.providerExerciseId,
      providerBookingId: j.bookingId,
      membershipVersion: generation,
      ownerLeaveOperationId: `self-leave:${x.legacyGameId}:${j.providerClientId}:${generation}`,
      completedAt: new Date().toISOString(),
      compensation: {
        schemaVersion: 1,
        operationId: j.entitlement.usageRef.usageRef,
        subscriptionInstanceId: j.entitlement.subscriptionInstanceId,
        operationState: 'COMPENSATED',
        compensationState: 'APPLIED',
        releaseReason: 'BOOKING_CANCELLED',
        providerBookingId: j.bookingId,
      },
    };
  }
  async function facts(gameId: string) {
    return withTenantTransaction(
      first,
      tenantId,
      async (client) =>
        (
          await client.query<{
            attempts: number;
            left_players: number;
            events: number;
            confirmed: number;
            evidence: number;
          }>(
            `select
    (select count(*)::int from games.managed_self_leave_attempts where tenant_id=$1 and game_id=$2) attempts,
    (select count(*)::int from games.participations where tenant_id=$1 and game_id=$2 and role='PLAYER' and state='LEFT') left_players,
    (select count(*)::int from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type='game.participation.left.v1') events,
    (select count(*)::int from games.seat_reservations where tenant_id=$1 and game_id=$2 and state='CONFIRMED') confirmed,
    (select count(*)::int from games.payment_confirmation_evidence where tenant_id=$1 and game_id=$2 and resolution='APPLIED') evidence`,
            [tenantId, gameId],
          )
        ).rows[0]!,
    );
  }
  it('converges independent same/different keys, persists JSONB authority and fences one fresh dispatch', async () => {
    const f = await joined();
    const [a, b] = await Promise.all([leave1.begin(f.input), leave2.begin(f.input)]);
    expect(a?.authority).toEqual(b?.authority);
    const alias = { ...f.input, idempotencyKey: 'self-alias:' + randomUUID() };
    const c = await leave2.begin(alias);
    expect(c?.authority.operationId).toBe(a?.authority.operationId);
    const identity = { tenantId, actorUserId: player1, operationId: a!.authority.operationId };
    const claims = await Promise.all([leave1.claim(identity), leave2.claim(identity)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.recoveryOnly).toBe(false);
    await withTenantTransaction(first, tenantId, async (client) => {
      await client.query(
        "update games.managed_self_leave_attempts set lease_until=created_at+interval '1 millisecond' where tenant_id=$1 and id=$2",
        [tenantId, identity.operationId],
      );
    });
    expect((await leave2.claim(identity))?.recoveryOnly).toBe(true);
    expect((await leave1.readByKey(alias))?.authority.operationId).toBe(identity.operationId);
    await expect(leave1.begin({ ...f.input, gameId: randomUUID() })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect((await facts(f.game.gameId)).attempts).toBe(1);
  });
  it('denies forged receipt; exact commit lost ACK replays aliases after rejoin and never changes the new generation', async () => {
    const f = await joined();
    const a = (await leave1.begin(f.input))!;
    const alias = { ...f.input, idempotencyKey: 'self-alias:' + randomUUID() };
    await leave2.begin(alias);
    const identity = {
      tenantId,
      actorUserId: player1,
      operationId: a.authority.operationId,
      correlationId: f.input.correlationId,
    };
    await leave1.claim(identity);
    const proof = receipt(a);
    await expect(
      leave2.finalize({ ...identity, receipt: { ...proof, reservationId: randomUUID() } }),
    ).rejects.toThrow();
    expect(await facts(f.game.gameId)).toMatchObject({ left_players: 0, events: 0 });
    await leave1.finalize({ ...identity, receipt: proof });
    expect(await facts(f.game.gameId)).toMatchObject({
      left_players: 1,
      events: 1,
      confirmed: 1,
      evidence: 1,
    });
    const current = await withTenantTransaction(
      first,
      tenantId,
      async (client) =>
        (
          await client.query<{ revision: number }>(
            'select revision from games.games where tenant_id=$1 and id=$2',
            [tenantId, f.game.gameId],
          )
        ).rows[0],
    );
    if (!current) throw new Error('FIXTURE_GAME_MISSING');
    const next = { ...command(f.game), expectedRevision: Number(current.revision) };
    const reserved = await repo2.beginPaidJoin(next);
    if (reserved.outcome !== 'reserved') throw new Error('REJOIN_NOT_RESERVED');
    const rejoined = await repo2.confirmPayment(confirmation(next, reserved.reservationId));
    expect(rejoined.outcome).toBe('applied');
    expect((await leave2.begin(f.input))?.state).toBe('COMPLETED');
    expect((await leave2.readByKey(alias))?.state).toBe('COMPLETED');
    await leave2.finalize({ ...identity, receipt: proof });
    await expect(
      leave1.finalize({
        ...identity,
        receipt: {
          ...proof,
          completedAt: new Date(Date.parse(proof.completedAt) - 1).toISOString(),
        },
      }),
    ).rejects.toThrow();
    expect(await facts(f.game.gameId)).toMatchObject({
      left_players: 1,
      events: 1,
      confirmed: 2,
      evidence: 2,
    });
  });
  it('rolls local participation and journal back if the existing outbox insert fails', async () => {
    const f = await joined();
    const a = (await leave1.begin(f.input))!;
    const identity = {
      tenantId,
      actorUserId: player1,
      operationId: a.authority.operationId,
      correlationId: f.input.correlationId,
    };
    await leave1.claim(identity);
    const failingPool = {
      connect: async () => {
        const client = await first.connect();
        return {
          query: (text: string, values?: unknown[]) => {
            if (text.includes('insert into audit.outbox_events'))
              throw new Error('SYNTHETIC_OUTBOX_FAILURE');
            return client.query(text, values);
          },
          release: () => client.release(),
        };
      },
    } as unknown as Pool;
    await expect(
      createManagedSelfLeaveRepository(failingPool).finalize({ ...identity, receipt: receipt(a) }),
    ).rejects.toThrow('SYNTHETIC_OUTBOX_FAILURE');
    expect(await facts(f.game.gameId)).toMatchObject({ left_players: 0, events: 0 });
    expect((await leave1.read(identity))?.state).toBe('DISPATCH_STARTED');
  });
  it('rejects foreign alias FK and actor scope; new tables retain FORCE RLS without creating roles', async () => {
    const f = await joined();
    const a = (await leave1.begin(f.input))!;
    expect(
      await leave2.read({ tenantId, actorUserId: player2, operationId: a.authority.operationId }),
    ).toBeNull();
    await expect(
      withTenantTransaction(first, tenantId, (client) =>
        client.query(
          `insert into games.managed_self_leave_command_links(tenant_id,command_id,attempt_id) values($1,$2,$3)`,
          [tenantId, randomUUID(), a.authority.operationId],
        ),
      ),
    ).rejects.toThrow();
    const tables = await first.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity,relforcerowsecurity from pg_class where oid in ('games.managed_self_leave_attempts'::regclass,'games.managed_self_leave_command_links'::regclass)",
    );
    expect(tables.rows).toHaveLength(2);
    expect(tables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  });
});
