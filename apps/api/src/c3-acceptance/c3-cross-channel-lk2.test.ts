/**
 * C3 independent acceptance tests — case C-LK2b (cross-channel LK2 aggregate integrity).
 *
 * A trusted legacy CONFIRM_PAYMENT (owner channel, `verifiedBy: 'LEGACY_NODE_RED'`) writes the
 * games aggregate from one channel while a second JOIN/reservation writes it from another. Neither
 * write may be silently lost: revision bumps must be consistent, both reservations and both trusted
 * receipts must survive, and no command row may disappear.
 *
 * The owner is a countable LOCAL double; a double never proves a real payment (LOCAL evidence only).
 * Fixtures are synthetic (`C3 SYNTHETIC`), amounts are synthetic. Never a live tariff.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  buildC3App,
  c3AccessToken,
  c3DatabaseDescribe,
  c3Headers,
  c3IdempotencyKey,
  createC3Pool,
  createConditionsDouble,
  createOwnerDouble,
  readCommandRows,
  readParticipations,
  readReservations,
  readSavedState,
  seedSyntheticGame,
  seedSyntheticTenant,
  C3_FIXTURE_VERSION,
  type C3App,
  type SyntheticTenant,
} from './harness.js';
import {
  readAuditSuccessCount,
  readGameAggregate,
  readPaymentEvidenceRows,
} from './c3-helpers-a.js';

/** SYNTHETIC fixture amount. Not a live tariff. */
const SYNTHETIC_BASE_PRICE_MINOR = 150_000;

c3DatabaseDescribe(`C3 cross-channel LK2 aggregate acceptance (${C3_FIXTURE_VERSION})`, () => {
  let pool: Pool;
  const apps: C3App[] = [];

  beforeAll(async () => {
    pool = await createC3Pool();
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((entry) => entry.close()));
    await pool.end();
  });

  async function freshTenant(label: string): Promise<SyntheticTenant> {
    return seedSyntheticTenant(pool, label);
  }

  async function compose(input: {
    conditions: ReturnType<typeof createConditionsDouble>;
    owner: ReturnType<typeof createOwnerDouble>;
  }): Promise<C3App> {
    const composed = await buildC3App(pool, { conditions: input.conditions, owner: input.owner });
    apps.push(composed);
    return composed;
  }

  it('C-LK2b: a trusted legacy CONFIRM_PAYMENT is not lost when a second JOIN updates the same aggregate', async () => {
    const tenant = await freshTenant('clk2b');
    const game = await seedSyntheticGame(pool, {
      tenantId: tenant.tenantId,
      organizerUserId: tenant.organizer.userId,
      paymentMode: 'SPLIT',
      capacity: 4,
    });
    const subscriptionInstanceId = randomUUID();
    const conditions = createConditionsDouble({
      revision: game.revision,
      legacyGameId: game.legacyGameId,
      startsAt: game.startsAt,
      subscriptionInstanceId,
      quote: {
        status: 'AVAILABLE',
        basePriceMinor: SYNTHETIC_BASE_PRICE_MINOR,
        amountMinor: 0,
        freeMinutes: 90,
        paidMinutes: 0,
        reasonCode: null,
      },
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }, { status: 'PENDING' }]);
    const displayed = await compose({ conditions, owner });
    const tokenA = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });
    const tokenB = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerB.userId,
      sessionId: tenant.playerB.sessionId,
    });

    // ---- Channel 1a: player A opens the commercial JOIN and reserves one seat. -----------------
    const first = await displayed.app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token: tokenA, idempotencyKey: c3IdempotencyKey('clk2b-a') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: 0, currency: 'RUB' },
      },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().operation.status).toBe('PROCESSING');
    expect(first.json().operation.commercial.attemptState).toBe('OWNER_PENDING');
    const operationIdA = first.json().commandId as string;
    expect(operationIdA).toBeTruthy();
    expect(owner.calls.execute).toBe(1);
    expect(owner.calls.read).toBe(0);

    const aggregateAfterReserve = await readGameAggregate(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(aggregateAfterReserve?.revision).toBe(game.revision + 1); // 2
    const revisionAfterReserve = aggregateAfterReserve?.revision ?? 0;
    const reservationsAfterReserve = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservationsAfterReserve).toHaveLength(1);
    const reservationA = reservationsAfterReserve[0]!;
    expect(reservationA.user_id).toBe(tenant.playerA.userId);
    expect(reservationA.state).toBe('ACTIVE');
    expect(reservationA.payment_state).toBe('PROCESSING');

    // ---- Interleave: trusted legacy owner channel confirms A while player B JOINs -------------
    // Both writes touch the same games.games revision. One may lose the race and must be told so
    // explicitly (GAME_REVISION_CONFLICT), never silently overwrite the other.
    conditions.setRevision(revisionAfterReserve);
    const [confirmedA, concurrentB] = await Promise.all([
      displayed.rosterRepository.confirmPayment({
        tenantId: tenant.tenantId,
        actorUserId: tenant.playerA.userId,
        gameId: game.gameId,
        idempotencyKey: c3IdempotencyKey('clk2b-confirm-a'),
        requestHash: 'c'.repeat(64),
        correlationId: randomUUID(),
        reservationId: reservationA.id,
        evidence: {
          provider: 'VIVA',
          operationType: 'SUBSCRIPTION_BOOKING',
          operationId: `c3-synthetic-provider-op-${randomUUID()}`,
          bookingId: `c3-synthetic-booking-${randomUUID()}`,
          clientPhoneE164: '+79000000003',
          evidenceHash: 'e'.repeat(64),
          verifiedAt: new Date().toISOString(),
          verifiedBy: 'LEGACY_NODE_RED',
          amountMinor: 0,
          currency: 'RUB',
        },
      }),
      displayed.app.inject({
        method: 'POST',
        url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
        headers: c3Headers({ token: tokenB, idempotencyKey: c3IdempotencyKey('clk2b-b') }),
        payload: {
          expectedRevision: revisionAfterReserve,
          subscriptionInstanceId,
          priceConsent: { amountMinor: 0, currency: 'RUB' },
        },
      }),
    ]);

    // The trusted confirmation always wins its own record: the legacy receipt must land.
    expect(confirmedA.outcome).toBe('applied');
    if (confirmedA.outcome !== 'applied') return; // TypeScript narrowing; unreachable after expect.
    expect(confirmedA.participationId).toBeTruthy();

    // The concurrent second JOIN either applies on the current revision or reports an explicit
    // revision conflict. It must never return a technical error (5xx) or a fake success.
    let acceptedB: { readonly commandId: string } | undefined;
    if (concurrentB.statusCode === 409) {
      expect(concurrentB.json().code).toBe('GAME_REVISION_CONFLICT');
      const aggregateAfterConflict = await readGameAggregate(pool, {
        tenantId: tenant.tenantId,
        gameId: game.gameId,
      });
      const freshRevision = aggregateAfterConflict?.revision ?? 0;
      expect(freshRevision).toBeGreaterThan(revisionAfterReserve);
      // A fresh revision is required; the same stale revision can never open a second reservation.
      conditions.setRevision(freshRevision);
      const retriedB = await displayed.app.inject({
        method: 'POST',
        url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
        headers: c3Headers({ token: tokenB, idempotencyKey: c3IdempotencyKey('clk2b-b-retry') }),
        payload: {
          expectedRevision: freshRevision,
          subscriptionInstanceId,
          priceConsent: { amountMinor: 0, currency: 'RUB' },
        },
      });
      expect(retriedB.statusCode).toBe(202);
      acceptedB = { commandId: retriedB.json().commandId as string };
    } else {
      expect(concurrentB.statusCode).toBe(202);
      expect(concurrentB.json().operation.status).toBe('PROCESSING');
      acceptedB = { commandId: concurrentB.json().commandId as string };
    }
    expect(acceptedB?.commandId).toBeTruthy(); // TypeScript narrowing; unreadable otherwise.

    // ---- Saved state after both channel writes: no record was silently lost -------------------
    const revisionAfterBothJoins = (
      await readGameAggregate(pool, { tenantId: tenant.tenantId, gameId: game.gameId })
    )?.revision;
    // 1 (seed) + A reservation (2) + confirm A (3) + B JOIN (4): each write bumped the revision
    // exactly once, so a lost update would be visible here.
    expect(revisionAfterBothJoins).toBe(4);

    const reservationsAfterBoth = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservationsAfterBoth).toHaveLength(2);
    const persistedA = reservationsAfterBoth.find((row) => row.user_id === tenant.playerA.userId);
    const reservationB = reservationsAfterBoth.find((row) => row.user_id === tenant.playerB.userId);
    expect(persistedA).toMatchObject({ state: 'CONFIRMED', payment_state: 'PAID' });
    expect(reservationB).toMatchObject({ state: 'ACTIVE', payment_state: 'PROCESSING' });
    // A's reservation id and trusted record survived B's aggregate update.
    expect(persistedA?.id).toBe(reservationA.id);

    expect(
      await readParticipations(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual([
      expect.objectContaining({
        user_id: tenant.playerA.userId,
        state: 'ACTIVE',
        payment_state: 'PAID',
      }),
    ]);
    const evidenceAfterOneConfirm = await readPaymentEvidenceRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(evidenceAfterOneConfirm).toHaveLength(1);
    expect(evidenceAfterOneConfirm[0]).toMatchObject({
      reservation_id: reservationA.id,
      user_id: tenant.playerA.userId,
      verified_by: 'LEGACY_NODE_RED',
      resolution: 'APPLIED',
      participation_id: confirmedA.participationId,
    });

    const savedAfterBoth = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(savedAfterBoth.participations).toBe(1);
    expect(savedAfterBoth.reservations).toBe(2);
    expect(savedAfterBoth.activeReservations).toBe(1);
    expect(savedAfterBoth.paymentSnapshots).toBe(2);
    expect(savedAfterBoth.paymentEvidence).toBe(1);
    expect(savedAfterBoth.commandRows).toBe(3);
    expect(await readAuditSuccessCount(pool, tenant.tenantId)).toBe(1);

    const commandsAfterBoth = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(commandsAfterBoth).toHaveLength(3);
    const paidJoinCommands = commandsAfterBoth.filter(
      (row) => row.command_type === 'game.join.paid.v1',
    );
    const confirmCommands = commandsAfterBoth.filter(
      (row) => row.command_type === 'game.payment.confirm.v1',
    );
    expect(paidJoinCommands).toHaveLength(2);
    expect(confirmCommands).toHaveLength(1);
    expect(paidJoinCommands.find((row) => row.id === operationIdA)).toMatchObject({
      state: 'COMPLETED',
    });
    expect(paidJoinCommands.find((row) => row.id === acceptedB?.commandId)).toMatchObject({
      state: 'IN_PROGRESS',
    });
    expect(confirmCommands[0]?.state).toBe('COMPLETED');
    // One owner execute per accepted JOIN; the trusted channel itself never calls the owner.
    expect(owner.calls.execute).toBe(2);
    expect(owner.calls.read).toBe(0);
    // The conditions owner was re-read server-side for each accepted JOIN (never client-trusted).
    expect(conditions.calls.readPreview).toBeGreaterThanOrEqual(2);

    // ---- Channel 2: player B confirms through the same trusted legacy channel ------------------
    const confirmedB = await displayed.rosterRepository.confirmPayment({
      tenantId: tenant.tenantId,
      actorUserId: tenant.playerB.userId,
      gameId: game.gameId,
      idempotencyKey: c3IdempotencyKey('clk2b-confirm-b'),
      requestHash: 'd'.repeat(64),
      correlationId: randomUUID(),
      reservationId: reservationB!.id,
      evidence: {
        provider: 'VIVA',
        operationType: 'SUBSCRIPTION_BOOKING',
        operationId: `c3-synthetic-provider-op-${randomUUID()}`,
        bookingId: `c3-synthetic-booking-${randomUUID()}`,
        clientPhoneE164: '+79000000004',
        evidenceHash: 'f'.repeat(64),
        verifiedAt: new Date().toISOString(),
        verifiedBy: 'LEGACY_NODE_RED',
        amountMinor: 0,
        currency: 'RUB',
      },
    });
    expect(confirmedB.outcome).toBe('applied');
    if (confirmedB.outcome !== 'applied') return; // TypeScript narrowing; unreachable after expect.
    expect(confirmedB.participationId).toBeTruthy();

    // ---- Final saved state: two participations, two confirmed reservations, no lost row --------
    const finalRevision = (
      await readGameAggregate(pool, { tenantId: tenant.tenantId, gameId: game.gameId })
    )?.revision;
    expect(finalRevision).toBe(5); // every accepted write bumped the revision once
    expect(finalRevision).toBeGreaterThan(revisionAfterBothJoins ?? 0);

    const finalReservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(finalReservations).toHaveLength(2);
    expect(finalReservations.every((row) => row.state === 'CONFIRMED')).toBe(true);
    expect(finalReservations.every((row) => row.payment_state === 'PAID')).toBe(true);
    // Both reservations kept the eligibility link required for a trusted confirmation.
    expect(finalReservations.every((row) => row.eligibility_decision_id !== null)).toBe(true);

    const finalParticipations = await readParticipations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(finalParticipations).toHaveLength(2);
    expect(finalParticipations.map((row) => row.user_id).sort()).toEqual(
      [tenant.playerA.userId, tenant.playerB.userId].sort(),
    );
    expect(finalParticipations.every((row) => row.state === 'ACTIVE')).toBe(true);
    expect(finalParticipations.every((row) => row.payment_state === 'PAID')).toBe(true);
    // The first channel's participation is still the same record (not replaced by the second JOIN).
    expect(finalParticipations.find((row) => row.user_id === tenant.playerA.userId)?.id).toBe(
      confirmedA.participationId,
    );
    expect(finalParticipations.find((row) => row.user_id === tenant.playerB.userId)?.id).toBe(
      confirmedB.participationId,
    );

    const finalEvidence = await readPaymentEvidenceRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(finalEvidence).toHaveLength(2);
    expect(finalEvidence.every((row) => row.resolution === 'APPLIED')).toBe(true);
    expect(finalEvidence.every((row) => row.verified_by === 'LEGACY_NODE_RED')).toBe(true);
    expect(finalEvidence.map((row) => row.user_id).sort()).toEqual(
      [tenant.playerA.userId, tenant.playerB.userId].sort(),
    );

    const finalSaved = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(finalSaved.participations).toBe(2);
    expect(finalSaved.reservations).toBe(2);
    expect(finalSaved.activeReservations).toBe(0);
    expect(finalSaved.paymentSnapshots).toBe(2);
    expect(finalSaved.paymentEvidence).toBe(2);
    expect(finalSaved.commandRows).toBe(4);
    expect(finalSaved.outboxEvents).toBe(4); // 2 reserved + 2 confirmed domain events
    expect(await readAuditSuccessCount(pool, tenant.tenantId)).toBe(2);

    const finalCommands = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(finalCommands).toHaveLength(4);
    const finalPaidJoins = finalCommands.filter((row) => row.command_type === 'game.join.paid.v1');
    const finalConfirms = finalCommands.filter(
      (row) => row.command_type === 'game.payment.confirm.v1',
    );
    expect(finalPaidJoins).toHaveLength(2);
    expect(finalConfirms).toHaveLength(2);
    expect(finalPaidJoins.every((row) => row.state === 'COMPLETED')).toBe(true);
    expect(finalConfirms.every((row) => row.state === 'COMPLETED')).toBe(true);
    expect(finalPaidJoins.map((row) => row.id).sort()).toEqual(
      [operationIdA, acceptedB!.commandId].sort(),
    );
    // A second trusted channel write never caused a new owner dispatch.
    expect(owner.calls.execute).toBe(2);
    expect(owner.calls.read).toBe(0);
    expect(conditions.calls.readPreview).toBeGreaterThanOrEqual(2);
  });
});
