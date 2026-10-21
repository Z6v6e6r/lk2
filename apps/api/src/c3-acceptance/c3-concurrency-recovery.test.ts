/**
 * C3 independent acceptance tests — scenario D: paid JOIN concurrency, idempotency and
 * lost/unknown-outcome recovery (D1, D3a, D3b, D4, D5, D6, D7a, D7b).
 *
 * Every case asserts the HTTP/result, the saved PostgreSQL state (participations, seat
 * reservations, payment snapshots, command idempotency, payment confirmation evidence, audit,
 * outbox) and the counted external-owner calls. The commercial executor and the LK1 conditions
 * owner are countable local doubles: LOCAL evidence only, never a real payment.
 *
 * All fixtures, amounts and provider identifiers are synthetic (`C3 SYNTHETIC`) and must never be
 * read as a live tariff, account or provider operation.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  C3_FIXTURE_VERSION,
  buildC3App,
  c3AccessToken,
  c3DatabaseDescribe,
  c3IdempotencyKey,
  createC3Pool,
  createOwnerDouble,
  readCommandRows,
  readParticipations,
  readReservations,
  readSavedState,
  seedSyntheticGame,
  seedSyntheticTenant,
  type C3App,
  type SyntheticTenant,
} from './harness.js';
import {
  C3_SYNTHETIC_SURCHARGE_PRICE_MINOR,
  bumpSyntheticGameRevision,
  conditionsForGame,
  conditionsWithAdvancedRevision,
  getGameOperation,
  getJoinConditions,
  getJoinOperation,
  insertSyntheticParticipant,
  paidJoinBody,
  postJoin,
  readGameRevision,
  readSeatOccupancy,
  surchargeQuote,
  syntheticTrustedEvidence,
  zeroSurchargeQuote,
  type ConditionsDouble,
} from './c3-helpers-concurrency.js';

// The DB-backed acceptance cases share one isolated PostgreSQL instance. Under parallel C3
// workers the default 5s per-test budget is too tight even though no assertion changes; keep a
// generous budget so a timing stall can never be misread as a product failure (a real hang still
// fails). Assertions themselves are unchanged.
vi.setConfig({ testTimeout: 30_000 });

c3DatabaseDescribe(`C3 paid JOIN concurrency and recovery acceptance (${C3_FIXTURE_VERSION})`, () => {
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

  async function paidGame(
    tenant: SyntheticTenant,
    paymentMode: 'SPLIT' | 'SUBSCRIPTION' = 'SPLIT',
    capacity = 4,
  ) {
    return seedSyntheticGame(pool, {
      tenantId: tenant.tenantId,
      organizerUserId: tenant.organizer.userId,
      paymentMode,
      capacity,
    });
  }

  async function compose(input: {
    readonly conditions: ConditionsDouble;
    readonly owner: ReturnType<typeof createOwnerDouble>;
  }): Promise<C3App> {
    const composed = await buildC3App(pool, {
      conditions: input.conditions,
      owner: input.owner,
    });
    apps.push(composed);
    return composed;
  }

  async function token(
    tenant: SyntheticTenant,
    actor: 'organizer' | 'playerA' | 'playerB' | 'outsider',
  ): Promise<string> {
    const selected = tenant[actor];
    return c3AccessToken({
      tenantId: tenant.tenantId,
      userId: selected.userId,
      sessionId: selected.sessionId,
    });
  }

  it('D1: two concurrent JOINs for the last seat grant exactly one reservation and one owner execute', async () => {
    const tenant = await freshTenant('d1');
    const game = await paidGame(tenant, 'SPLIT', 2);
    // One of the two seats is already taken, so exactly one seat is left for the two contenders.
    await insertSyntheticParticipant(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
      userId: tenant.outsider.userId,
    });
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, {
      subscriptionInstanceId,
      quote: zeroSurchargeQuote(),
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const tokenB = await token(tenant, 'playerB');

    const before = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(before).toMatchObject({
      participations: 1,
      activeReservations: 0,
      reservations: 0,
      commandRows: 0,
      paymentSnapshots: 0,
      paymentEvidence: 0,
    });

    const [responseA, responseB] = await Promise.all([
      postJoin({
        app,
        tenantKey: tenant.tenantKey,
        gameId: game.gameId,
        token: tokenA,
        idempotencyKey: c3IdempotencyKey('d1-a'),
        body: paidJoinBody({
          expectedRevision: game.revision,
          subscriptionInstanceId,
          amountMinor: 0,
        }),
      }),
      postJoin({
        app,
        tenantKey: tenant.tenantKey,
        gameId: game.gameId,
        token: tokenB,
        idempotencyKey: c3IdempotencyKey('d1-b'),
        body: paidJoinBody({
          expectedRevision: game.revision,
          subscriptionInstanceId,
          amountMinor: 0,
        }),
      }),
    ]);

    const contenders = [
      { userId: tenant.playerA.userId, response: responseA, token: tokenA },
      { userId: tenant.playerB.userId, response: responseB, token: tokenB },
    ];
    const accepted = contenders.filter((entry) => entry.response.statusCode === 202);
    const refused = contenders.filter((entry) => entry.response.statusCode !== 202);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.response.statusCode).toBe(409);
    const refusalCode = refused[0]!.response.json().code as string;
    // The loser is refused by the serialized seat/revision rule; it is never granted a second seat.
    expect([
      'GAME_REVISION_CONFLICT',
      'GAME_FULL',
      'GAME_ALREADY_RESERVED',
      'GAME_ALREADY_JOINED',
      'GAME_RECONCILIATION_REQUIRED',
      'GAME_COMMERCIAL_ATTEMPT_CONFLICT',
    ]).toContain(refusalCode);

    const winner = accepted[0]!;
    const winnerBody = winner.response.json();
    expect(winnerBody.replayed).toBe(false);
    expect(winnerBody.operation.status).toBe('PROCESSING');
    expect(winnerBody.operation.commercial.attemptState).toBe('OWNER_PENDING');
    expect(winnerBody.operation.commercial.reservation).toMatchObject({ state: 'ACTIVE' });

    const saved = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    // A pending purchase creates no participation; only the one seat reservation is new.
    expect(saved.participations).toBe(1);
    expect(saved.activeReservations).toBe(1);
    expect(saved.reservations).toBe(1);
    expect(saved.commandRows).toBe(1);
    expect(saved.paymentSnapshots).toBe(1);
    expect(saved.paymentEvidence).toBe(0);
    expect(saved.outboxEvents).toBe(1);
    expect(owner.calls.execute).toBe(1);
    expect(owner.calls.read).toBe(0);

    const reservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ state: 'ACTIVE', user_id: winner.userId });
    expect(reservations[0]?.id).toBe(winnerBody.operation.commercial.reservation.id);
    const commands = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ id: winnerBody.commandId, state: 'IN_PROGRESS' });
    expect(owner.executed[0]?.operationId).toBe(winnerBody.commandId);
    // The seat count is never allowed to exceed capacity.
    const occupancy = await readSeatOccupancy(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(occupancy).toMatchObject({
      capacity: 2,
      activeParticipations: 1,
      activeReservations: 1,
    });
    expect(occupancy.activeParticipations + occupancy.activeReservations).toBeLessThanOrEqual(
      occupancy.capacity,
    );

    // Once the last seat is gone, a refreshed retry by the loser is refused by capacity only.
    const loser = refused[0]!;
    const refreshedRevision = await readGameRevision(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(refreshedRevision).toBe(game.revision + 1);
    conditions.setRevision(refreshedRevision);
    const capacityRefusal = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: loser.token,
      idempotencyKey: c3IdempotencyKey('d1-retry'),
      body: paidJoinBody({
        expectedRevision: refreshedRevision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(capacityRefusal.statusCode).toBe(409);
    expect(capacityRefusal.json().code).toBe('GAME_FULL');
    expect(owner.calls.execute).toBe(1);
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual(saved);
    expect(
      await readReservations(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toHaveLength(1);
  });

  it('D3a: the same key and payload after PENDING is a replay with one owner execute and one attempt', async () => {
    const tenant = await freshTenant('d3a');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const key = c3IdempotencyKey('d3a');
    const body = paidJoinBody({
      expectedRevision: game.revision,
      subscriptionInstanceId,
      amountMinor: 0,
    });

    const first = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body,
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json();
    expect(firstBody.operation.status).toBe('PROCESSING');
    expect(firstBody.operation.commercial.attemptState).toBe('OWNER_PENDING');
    const operationId = firstBody.commandId as string;
    expect(owner.calls.execute).toBe(1);

    const savedAfterFirst = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    const durableAttempt = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(durableAttempt).toHaveLength(1);
    expect(durableAttempt[0]).toMatchObject({ id: operationId, state: 'IN_PROGRESS' });

    const second = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body,
    });
    expect([200, 202]).toContain(second.statusCode);
    const secondBody = second.json();
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.operation.id).toBe(operationId);
    expect(secondBody.commandId).toBe(operationId);
    expect(secondBody.operation.status).not.toBe('SUCCEEDED');
    expect(['PROCESSING', 'UNKNOWN']).toContain(secondBody.operation.status);
    // A repeat is a read/recovery: it never dispatches another owner POST (or even an owner read).
    expect(owner.calls.execute).toBe(1);
    expect(owner.calls.read).toBe(0);
    expect(owner.executed).toHaveLength(1);
    expect(owner.executed[0]?.operationId).toBe(operationId);

    const savedAfterSecond = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(savedAfterSecond).toEqual(savedAfterFirst);
    expect(
      await readReservations(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toHaveLength(1);
    expect(
      await readCommandRows(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toHaveLength(1);
  });

  it('D3b: the same key with a changed payload is a stable attempt conflict with no new write', async () => {
    const tenant = await freshTenant('d3b');
    const firstGame = await paidGame(tenant);
    const secondGame = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(firstGame, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const key = c3IdempotencyKey('d3b');

    const reserved = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: firstGame.gameId,
      token: tokenA,
      idempotencyKey: key,
      body: paidJoinBody({
        expectedRevision: firstGame.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(reserved.statusCode).toBe(202);
    expect(owner.calls.execute).toBe(1);
    const firstGameState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: firstGame.gameId,
    });
    expect(firstGameState).toMatchObject({
      activeReservations: 1,
      commandRows: 1,
      paymentSnapshots: 1,
    });

    // Same Idempotency-Key, different content (another game): must never mint a second attempt.
    const conflict = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: secondGame.gameId,
      token: tokenA,
      idempotencyKey: key,
      body: paidJoinBody({
        expectedRevision: secondGame.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('GAME_COMMERCIAL_ATTEMPT_CONFLICT');
    expect(owner.calls.execute).toBe(1);
    expect(owner.executed).toHaveLength(1);
    const secondGameState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: secondGame.gameId,
    });
    expect(secondGameState).toMatchObject({
      participations: 0,
      activeReservations: 0,
      reservations: 0,
      commandRows: 0,
      paymentSnapshots: 0,
      paymentEvidence: 0,
    });
    // Outbox/audit are tenant-wide counters: the conflicting attempt must add nothing.
    expect(secondGameState.auditEvents).toBe(firstGameState.auditEvents);
    expect(secondGameState.outboxEvents).toBe(firstGameState.outboxEvents);
    // The original operation is untouched by the conflicting attempt.
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: firstGame.gameId }),
    ).toEqual(firstGameState);
  });

  it('D4: a lost response is recoverable by key and by operation id, also after a client restart', async () => {
    const tenant = await freshTenant('d4');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const key = c3IdempotencyKey('d4');

    const lost = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    // The response is "lost" from the client's point of view; the server outcome is durable.
    expect(lost.statusCode).toBe(202);
    const operationId = lost.json().commandId as string;
    expect(owner.calls.execute).toBe(1);
    const durable = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(durable).toMatchObject({
      activeReservations: 1,
      commandRows: 1,
      paymentSnapshots: 1,
      participations: 0,
    });
    // The owner still reports the same attempt as pending.
    owner.setReadOutcome({ status: 'PENDING' });

    const byKey = await getJoinOperation({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
    });
    expect(byKey.statusCode).toBe(200);
    const byKeyBody = byKey.json();
    expect(byKeyBody.operation.id).toBe(operationId);
    expect(byKeyBody.operation.status).not.toBe('FAILED');
    expect(byKeyBody.operation.status).toBe('PROCESSING');
    expect(byKeyBody.operation.commercial.attemptState).toBe('OWNER_PENDING');
    expect(byKeyBody.operation.commercial.reservation).toMatchObject({ state: 'ACTIVE' });

    const byId = await getGameOperation({
      app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().operation.id).toBe(operationId);
    expect(byId.json().operation.status).toBe('PROCESSING');
    expect(byId.json().operation.commercial.attemptState).toBe('OWNER_PENDING');
    // Readback is a read: it never dispatches the owner.
    expect(owner.calls.execute).toBe(1);
    expect(owner.calls.read).toBe(2);
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual(durable);

    // Client restart: a second app instance over the same database with a fresh owner double.
    const restartedOwner = createOwnerDouble([{ status: 'PENDING' }]);
    restartedOwner.setReadOutcome({ status: 'PENDING' });
    const restarted = await compose({
      conditions: conditionsForGame(game, { subscriptionInstanceId }),
      owner: restartedOwner,
    });
    const recoveredByKey = await getJoinOperation({
      app: restarted.app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
    });
    expect(recoveredByKey.statusCode).toBe(200);
    expect(recoveredByKey.json().operation.id).toBe(operationId);
    expect(recoveredByKey.json().operation.status).toBe('PROCESSING');
    expect(recoveredByKey.json().operation.commercial.attemptState).toBe('OWNER_PENDING');
    const recoveredById = await getGameOperation({
      app: restarted.app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(recoveredById.statusCode).toBe(200);
    expect(recoveredById.json().operation.id).toBe(operationId);
    expect(recoveredById.json().operation.status).toBe('PROCESSING');
    // The restarted client recovers the original attempt and never issues a replacement owner POST.
    expect(restartedOwner.calls.execute).toBe(0);
    expect(restartedOwner.calls.read).toBeGreaterThanOrEqual(1);
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual(durable);
  });

  it('D5: an unknown owner outcome stays UNKNOWN with an ACTIVE reservation and no replacement POST', async () => {
    const tenant = await freshTenant('d5');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    owner.setThrowOnExecute(new Error('synthetic owner timeout'));
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const key = c3IdempotencyKey('d5');
    const body = paidJoinBody({
      expectedRevision: game.revision,
      subscriptionInstanceId,
      amountMinor: 0,
    });

    const response = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body,
    });
    expect(response.statusCode).toBe(202);
    const bodyJson = response.json();
    const operationId = bodyJson.commandId as string;
    expect(bodyJson.operation.status).toBe('UNKNOWN');
    expect(bodyJson.operation.commercial.attemptState).toBe('UNKNOWN');
    expect(bodyJson.operation.nextAction).toMatchObject({ type: 'WAIT_FOR_RECONCILIATION' });
    expect(bodyJson.operation.error).toBeNull();
    expect(bodyJson.operation.commercial.reservation).toMatchObject({ state: 'ACTIVE' });
    expect(owner.calls.execute).toBe(1);

    const saved = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(saved).toMatchObject({
      participations: 0,
      activeReservations: 1,
      reservations: 1,
      commandRows: 1,
      paymentSnapshots: 1,
      paymentEvidence: 0,
      outboxEvents: 1,
    });
    const reservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservations).toHaveLength(1);
    // A timeout never releases (or cancels) a potentially used benefit.
    expect(reservations[0]).toMatchObject({ state: 'ACTIVE', payment_state: 'PROCESSING' });
    const commands = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ id: operationId, state: 'IN_PROGRESS' });

    // Repeating the SAME key recovers the attempt and never creates a replacement owner POST.
    const replay = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body,
    });
    expect([200, 202]).toContain(replay.statusCode);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().operation.id).toBe(operationId);
    expect(['UNKNOWN', 'PROCESSING']).toContain(replay.json().operation.status);
    expect(owner.calls.execute).toBe(1);
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual(saved);

    // A new key from the same actor cannot start a replacement purchase for the reserved seat.
    const refreshedRevision = await readGameRevision(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    conditions.setRevision(refreshedRevision);
    const replacement = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('d5-other'),
      body: paidJoinBody({
        expectedRevision: refreshedRevision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(replacement.statusCode).toBe(409);
    expect(replacement.json().code).toBe('GAME_ALREADY_RESERVED');
    expect(owner.calls.execute).toBe(1);
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual(saved);
    const reservationsAfter = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservationsAfter).toHaveLength(1);
    expect(reservationsAfter[0]).toMatchObject({ state: 'ACTIVE', payment_state: 'PROCESSING' });
  });

  it('D6: a restart between reserve and confirm finalizes the same attempt exactly once', async () => {
    const tenant = await freshTenant('d6');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const key = c3IdempotencyKey('d6');
    const body = paidJoinBody({
      expectedRevision: game.revision,
      subscriptionInstanceId,
      amountMinor: 0,
    });

    const reserved = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body,
    });
    expect(reserved.statusCode).toBe(202);
    expect(reserved.json().operation.status).toBe('PROCESSING');
    expect(reserved.json().operation.commercial.attemptState).toBe('OWNER_PENDING');
    const operationId = reserved.json().commandId as string;
    expect(owner.calls.execute).toBe(1);
    const reservedRows = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservedRows).toHaveLength(1);
    const reservationId = reservedRows[0]!.id;

    // Client restart: a NEW app instance over the same database with a fresh owner double.
    const restartedOwner = createOwnerDouble([{ status: 'PENDING' }]);
    const restarted = await compose({
      conditions: conditionsForGame(game, { subscriptionInstanceId }),
      owner: restartedOwner,
    });

    // The trusted legacy owner channel (LK1 CONFIRM_PAYMENT) confirms the original reservation.
    const applied = await restarted.rosterRepository.confirmPayment({
      tenantId: tenant.tenantId,
      actorUserId: tenant.playerA.userId,
      gameId: game.gameId,
      idempotencyKey: c3IdempotencyKey('d6-confirm'),
      requestHash: 'c'.repeat(64),
      correlationId: randomUUID(),
      reservationId,
      evidence: syntheticTrustedEvidence(0),
    });
    expect(applied.outcome).toBe('applied');

    const readback = await getGameOperation({
      app: restarted.app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(readback.statusCode).toBe(200);
    const readbackBody = readback.json();
    expect(readbackBody.operation.id).toBe(operationId);
    expect(readbackBody.operation.status).toBe('SUCCEEDED');
    expect(readbackBody.operation.commercial.attemptState).toBe('OWNER_CONFIRMED');
    expect(readbackBody.operation.commercial.receipt).toMatchObject({
      provider: 'VIVA',
      status: 'CONFIRMED',
    });
    // Readback after a trusted confirmation never re-dispatches the owner.
    expect(restartedOwner.calls.execute).toBe(0);

    const saved = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(saved.participations).toBe(1);
    expect(saved.paymentEvidence).toBe(1);
    expect(saved.reservations).toBe(1);
    expect(saved.activeReservations).toBe(0);
    const confirmedReservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(confirmedReservations).toHaveLength(1);
    expect(confirmedReservations[0]).toMatchObject({
      id: reservationId,
      state: 'CONFIRMED',
      payment_state: 'PAID',
    });
    const participations = await readParticipations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(participations).toHaveLength(1);
    expect(participations[0]?.user_id).toBe(tenant.playerA.userId);
    const commands = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    const paidJoinAttempts = commands.filter(
      (command) => command.command_type === 'game.join.paid.v1',
    );
    // One original durable attempt, completed by the trusted receipt — never a second reservation.
    expect(paidJoinAttempts).toHaveLength(1);
    expect(paidJoinAttempts[0]).toMatchObject({ id: operationId, state: 'COMPLETED' });

    // Repeating the original POST with the same key replays the completed operation.
    const repeated = await postJoin({
      app: restarted.app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: key,
      body,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().replayed).toBe(true);
    expect(repeated.json().operation.id).toBe(operationId);
    expect(repeated.json().operation.status).toBe('SUCCEEDED');
    expect(restartedOwner.calls.execute).toBe(0);
    expect(owner.calls.execute).toBe(1);
    expect(
      await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toEqual(saved);
  });

  it('D7a: a price change after the preview requires a new consent before any reservation', async () => {
    const tenant = await freshTenant('d7a');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, {
      subscriptionInstanceId,
      quote: zeroSurchargeQuote(),
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');

    const previewResponse = await getJoinConditions({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      expectedRevision: game.revision,
      subscriptionInstanceId,
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json();
    expect(preview.eligibility).toBe('AVAILABLE');
    expect(preview.price).toMatchObject({ amountMinor: 0, currency: 'RUB' });
    expect(preview.requiresPriceConsent).toBe(true);
    expect(preview.nonBinding).toBe(true);

    // The server price changed between the preview and the command.
    conditions.setQuote(surchargeQuote());
    const staleConsent = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('d7a-stale'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(staleConsent.statusCode).toBe(409);
    expect(staleConsent.json().code).toBe('GAME_PRICE_CONFIRMATION_REQUIRED');
    const afterStale = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(afterStale).toMatchObject({
      participations: 0,
      activeReservations: 0,
      reservations: 0,
      commandRows: 0,
      paymentSnapshots: 0,
      paymentEvidence: 0,
      outboxEvents: 0,
    });
    expect(owner.calls.execute).toBe(0);

    // An explicit consent to the NEW server price succeeds and dispatches the owner once.
    const accepted = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('d7a-new'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: C3_SYNTHETIC_SURCHARGE_PRICE_MINOR,
      }),
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().operation.commercial.price).toMatchObject({
      amountMinor: C3_SYNTHETIC_SURCHARGE_PRICE_MINOR,
      currency: 'RUB',
    });
    expect(owner.calls.execute).toBe(1);
    expect(owner.executed[0]?.price.amountMinor).toBe(C3_SYNTHETIC_SURCHARGE_PRICE_MINOR);
    const saved = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(saved).toMatchObject({
      activeReservations: 1,
      reservations: 1,
      commandRows: 1,
      paymentSnapshots: 1,
      participations: 0,
    });
  });

  it('D7b: a rules/usage-induced revision advance refuses the stale expectedRevision without side effects', async () => {
    // (1) Owner-side revision advance: the owner reports a newer current revision than the client
    //     expects. The advisory conditions recheck must refuse before any reservation.
    const ownerAdvancedTenant = await freshTenant('d7b-owner');
    const ownerAdvancedGame = await paidGame(ownerAdvancedTenant);
    const ownerAdvancedSubscription = randomUUID();
    const ownerAdvancedBase = conditionsForGame(ownerAdvancedGame, {
      subscriptionInstanceId: ownerAdvancedSubscription,
    });
    const ownerAdvancedConditions = conditionsWithAdvancedRevision(
      ownerAdvancedBase,
      ownerAdvancedGame.revision + 1,
    );
    const ownerAdvancedOwner = createOwnerDouble([{ status: 'PENDING' }]);
    const ownerAdvanced = await compose({
      conditions: ownerAdvancedConditions,
      owner: ownerAdvancedOwner,
    });
    const ownerAdvancedToken = await token(ownerAdvancedTenant, 'playerA');

    const refused = await postJoin({
      app: ownerAdvanced.app,
      tenantKey: ownerAdvancedTenant.tenantKey,
      gameId: ownerAdvancedGame.gameId,
      token: ownerAdvancedToken,
      idempotencyKey: c3IdempotencyKey('d7b-owner'),
      body: paidJoinBody({
        expectedRevision: ownerAdvancedGame.revision,
        subscriptionInstanceId: ownerAdvancedSubscription,
        amountMinor: 0,
      }),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('GAME_REVISION_CONFLICT');
    expect(ownerAdvancedOwner.calls.execute).toBe(0);
    // The revision is refused before the preview transport is even read.
    expect(ownerAdvancedBase.calls.readPreview).toBe(0);
    const ownerAdvancedState = await readSavedState(pool, {
      tenantId: ownerAdvancedTenant.tenantId,
      gameId: ownerAdvancedGame.gameId,
    });
    expect(ownerAdvancedState).toMatchObject({
      participations: 0,
      activeReservations: 0,
      reservations: 0,
      commandRows: 0,
      paymentSnapshots: 0,
      paymentEvidence: 0,
    });

    // (2) Database-side revision advance (rules/usage changed the game): the stale client revision
    //     passes the advisory preview but is refused by the durable command recheck.
    const dbAdvancedTenant = await freshTenant('d7b-db');
    const dbAdvancedGame = await paidGame(dbAdvancedTenant);
    const dbAdvancedSubscription = randomUUID();
    const dbAdvancedConditions = conditionsForGame(dbAdvancedGame, {
      subscriptionInstanceId: dbAdvancedSubscription,
    });
    const dbAdvancedOwner = createOwnerDouble([{ status: 'PENDING' }]);
    const dbAdvanced = await compose({
      conditions: dbAdvancedConditions,
      owner: dbAdvancedOwner,
    });
    const dbAdvancedToken = await token(dbAdvancedTenant, 'playerA');
    const bumped = await bumpSyntheticGameRevision(pool, {
      tenantId: dbAdvancedTenant.tenantId,
      gameId: dbAdvancedGame.gameId,
    });
    expect(bumped).toBe(dbAdvancedGame.revision + 1);

    const stale = await postJoin({
      app: dbAdvanced.app,
      tenantKey: dbAdvancedTenant.tenantKey,
      gameId: dbAdvancedGame.gameId,
      token: dbAdvancedToken,
      idempotencyKey: c3IdempotencyKey('d7b-db'),
      body: paidJoinBody({
        expectedRevision: dbAdvancedGame.revision,
        subscriptionInstanceId: dbAdvancedSubscription,
        amountMinor: 0,
      }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('GAME_REVISION_CONFLICT');
    expect(dbAdvancedOwner.calls.execute).toBe(0);
    expect(dbAdvancedConditions.calls.readPreview).toBe(1);
    const dbAdvancedState = await readSavedState(pool, {
      tenantId: dbAdvancedTenant.tenantId,
      gameId: dbAdvancedGame.gameId,
    });
    expect(dbAdvancedState).toMatchObject({
      participations: 0,
      activeReservations: 0,
      reservations: 0,
      commandRows: 0,
      paymentSnapshots: 0,
      paymentEvidence: 0,
    });
  });
});
