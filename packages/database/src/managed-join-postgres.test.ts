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
  if (!process.env.DATABASE_URL) throw new Error('MANAGED_JOIN_DISPOSABLE_CI_DATABASE_REQUIRED');
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
    throw new Error('MANAGED_JOIN_DISPOSABLE_CI_DATABASE_REQUIRED');
  return url.toString();
}
const url = ciDatabase();
const suite = url ? describe : describe.skip;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

suite('managed JOIN on existing disposable CI PostgreSQL (no provider calls)', () => {
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
      [tenantId, `managed-join-${tenantId}`],
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
  async function counts(gameId: string) {
    return withTenantTransaction(
      first,
      tenantId,
      async (client) =>
        (
          await client.query<{
            attempts: number;
            seats: number;
            snapshots: number;
            players: number;
            applied: number;
            confirmedEvents: number;
          }>(
            `select
      (select count(*)::int from games.command_idempotency where tenant_id=$1 and aggregate_id=$2 and command_type='game.join.paid.v1') attempts,
      (select count(*)::int from games.seat_reservations where tenant_id=$1 and game_id=$2) seats,
      (select count(*)::int from eligibility.payment_snapshots where tenant_id=$1 and activity_id=$2) snapshots,
      (select count(*)::int from games.participations where tenant_id=$1 and game_id=$2 and role='PLAYER') players,
      (select count(*)::int from games.payment_confirmation_evidence where tenant_id=$1 and game_id=$2 and resolution='APPLIED') applied,
      (select count(*)::int from audit.outbox_events where tenant_id=$1 and aggregate_id=$2 and event_type='game.participation.confirmed.v1') "confirmedEvents"`,
            [tenantId, gameId],
          )
        ).rows[0],
    );
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
  it('serializes same key on independent clients to one seat, attempt and immutable snapshot', async () => {
    const game = await fixtureGame();
    const input = command(game);
    const results = await Promise.all([repo1.beginPaidJoin(input), repo2.beginPaidJoin(input)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['replayed', 'reserved']);
    expect(await counts(game.gameId)).toEqual({
      attempts: 1,
      seats: 1,
      snapshots: 1,
      players: 0,
      applied: 0,
      confirmedEvents: 0,
    });
    const stored = await repo2.getPaidJoinAttempt({
      tenantId,
      actorUserId: player1,
      operationId: input.operationId,
    });
    expect(stored?.managedJoin).toEqual(input.managedJoin);
    expect(stored?.requestHash).toBe(input.requestHash);
  });
  it('allows only one competing key into the last seat', async () => {
    const game = await fixtureGame();
    const a = command(game);
    const b = command(game, player2);
    const results = await Promise.all([repo1.beginPaidJoin(a), repo2.beginPaidJoin(b)]);
    expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'rejected')).toHaveLength(1);
    const loser = results[0]?.outcome === 'rejected' ? a : b;
    const revision = await withTenantTransaction(
      first,
      tenantId,
      async (client) =>
        (
          await client.query<{ revision: string }>(
            'select revision from games.games where tenant_id=$1 and id=$2',
            [tenantId, game.gameId],
          )
        ).rows[0]!.revision,
    );
    expect(
      await repo2.beginPaidJoin({ ...loser, expectedRevision: Number(revision) }),
    ).toMatchObject({ outcome: 'rejected', code: 'GAME_FULL' });

    expect(await counts(game.gameId)).toMatchObject({
      attempts: 1,
      seats: 1,
      snapshots: 1,
      players: 0,
    });
  });
  it('rejects wrong receipt, then commits once and recovers a lost acknowledgement on another client', async () => {
    const game = await fixtureGame();
    const input = command(game);
    const reserved = await repo1.beginPaidJoin(input);
    expect(reserved.outcome).toBe('reserved');
    if (reserved.outcome !== 'reserved') throw new Error('FIXTURE_RESERVATION_REQUIRED');
    const valid = confirmation(input, reserved.reservationId);
    const changed = {
      ...valid,
      managedJoinReceipt: {
        ...valid.managedJoinReceipt!,
        entitlement: {
          ...valid.managedJoinReceipt!.entitlement,
          subscriptionInstanceId: 'subscription:foreign',
        },
      },
    };
    expect(await repo2.confirmPayment(changed)).toMatchObject({
      outcome: 'rejected',
      code: 'GAME_PAYMENT_EVIDENCE_CONFLICT',
    });
    expect(await counts(game.gameId)).toMatchObject({ players: 0, applied: 0, confirmedEvents: 0 });
    // Deliberately discard the committed return: recovery must consult persisted exact evidence.
    await repo1.confirmPayment(valid);
    expect(await repo2.confirmPayment(valid)).toMatchObject({ outcome: 'applied', replayed: true });
    expect(await counts(game.gameId)).toEqual({
      attempts: 1,
      seats: 1,
      snapshots: 1,
      players: 1,
      applied: 1,
      confirmedEvents: 1,
    });
    expect(await repo2.confirmPayment(changed)).toMatchObject({
      outcome: 'rejected',
      code: 'GAME_PAYMENT_EVIDENCE_CONFLICT',
      replayed: true,
    });
    const stored = await repo2.getPaidJoinAttempt({
      tenantId,
      actorUserId: player1,
      operationId: input.operationId,
    });
    expect(stored?.managedReceipt).toEqual(valid.managedJoinReceipt);
    expect(stored?.state).toBe('COMPLETED');
    expect(await counts(game.gameId)).toEqual({
      attempts: 1,
      seats: 1,
      snapshots: 1,
      players: 1,
      applied: 1,
      confirmedEvents: 1,
    });
  });
});
