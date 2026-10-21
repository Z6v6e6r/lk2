/**
 * C3 independent acceptance tests — commercial JOIN core (scenario A) and owner-accounting (C).
 *
 * Every assertion is checked against saved PostgreSQL state and countable owner calls, not only
 * the HTTP status. The commercial executor is a local double: LOCAL evidence only, never a real
 * payment. Fixtures are synthetic and must not be read as live tariffs.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

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

const SYNTHETIC_BASE_PRICE_MINOR = 150_000; // SYNTHETIC test fixture, not a live tariff
const SYNTHETIC_SURCHARGE_PRICE_MINOR = 90_000; // SYNTHETIC test fixture, not a live tariff

c3DatabaseDescribe(`C3 commercial JOIN acceptance (${C3_FIXTURE_VERSION})`, () => {
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

  async function paidGame(tenant: SyntheticTenant, paymentMode: 'SPLIT' | 'SUBSCRIPTION') {
    return seedSyntheticGame(pool, {
      tenantId: tenant.tenantId,
      organizerUserId: tenant.organizer.userId,
      paymentMode,
      capacity: 4,
    });
  }

  async function compose(input: {
    tenant: SyntheticTenant;
    conditions: ReturnType<typeof createConditionsDouble>;
    owner: ReturnType<typeof createOwnerDouble>;
    commercialJoin?: boolean;
  }): Promise<C3App> {
    const composed = await buildC3App(pool, {
      conditions: input.conditions,
      owner: input.owner,
      ...(input.commercialJoin === false ? { commercialJoin: false } : {}),
    });
    apps.push(composed);
    return composed;
  }

  it('A6a: NO_PAYMENT join stays outside the commercial contour and saves a participation only', async () => {
    const tenant = await freshTenant('a6a');
    const game = await seedSyntheticGame(pool, {
      tenantId: tenant.tenantId,
      organizerUserId: tenant.organizer.userId,
      paymentMode: 'NO_PAYMENT',
    });
    const conditions = createConditionsDouble({
      revision: game.revision,
      legacyGameId: game.legacyGameId,
      startsAt: game.startsAt,
      subscriptionInstanceId: randomUUID(),
      quote: {
        status: 'AVAILABLE',
        basePriceMinor: SYNTHETIC_BASE_PRICE_MINOR,
        amountMinor: 0,
        freeMinutes: 90,
        paidMinutes: 0,
        reasonCode: null,
      },
    });
    const owner = createOwnerDouble();
    const { app } = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey('a6a') }),
      payload: { expectedRevision: game.revision },
    });

    expect(response.statusCode).toBe(200);
    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.participations).toBe(1);
    expect(saved.reservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    // A free join is never recorded as a commercial attempt and never calls the paid owner.
    expect(saved.commandRows).toBe(1);
    expect(owner.calls.execute).toBe(0);
    expect(owner.calls.read).toBe(0);
    expect(conditions.calls.readPreview).toBe(0);
    const participations = await readParticipations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(participations.map((row) => row.user_id)).toEqual([tenant.playerA.userId]);
  });

  it('A6b: NO_PAYMENT with a price consent is refused without a commercial side effect', async () => {
    const tenant = await freshTenant('a6b');
    const game = await seedSyntheticGame(pool, {
      tenantId: tenant.tenantId,
      organizerUserId: tenant.organizer.userId,
      paymentMode: 'NO_PAYMENT',
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
        amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR,
        freeMinutes: 60,
        paidMinutes: 30,
        reasonCode: null,
      },
    });
    const owner = createOwnerDouble();
    const { app } = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey('a6b') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR, currency: 'RUB' },
      },
    });

    expect([400, 409]).toContain(response.statusCode);
    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.reservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.commandRows).toBe(0);
    expect(saved.participations).toBe(0);
    expect(owner.calls.execute).toBe(0);
  });

  it('A2a: subscription JOIN without surcharge reserves a seat and calls the owner exactly once', async () => {
    const tenant = await freshTenant('a2a');
    const game = await paidGame(tenant, 'SPLIT');
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
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey('a2a') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: 0, currency: 'RUB' },
      },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.operation.status).toBe('PROCESSING');
    expect(body.operation.commercial.attemptState).toBe('OWNER_PENDING');
    expect(body.operation.commercial.price).toMatchObject({ amountMinor: 0, currency: 'RUB' });

    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.activeReservations).toBe(1);
    expect(saved.paymentSnapshots).toBe(1);
    expect(saved.commandRows).toBe(1);
    expect(saved.participations).toBe(0);
    expect(owner.calls.execute).toBe(1);
    expect(owner.calls.read).toBe(0);
    // One durable attempt exists before the external effect, and its payload is server-owned.
    const commands = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ state: 'IN_PROGRESS' });
    expect(body.commandId).toBe(commands[0]?.id);
    expect(owner.executed[0]?.subscriptionInstanceId).toBe(subscriptionInstanceId);
    expect(owner.executed[0]?.price).toMatchObject({
      amountMinor: 0,
      currency: 'RUB',
    });
    const reservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.state).toBe('ACTIVE');
    expect(reservations[0]?.user_id).toBe(tenant.playerA.userId);
  });

  it('A2b: repeating the same key after a pending owner call never dispatches a second owner POST', async () => {
    const tenant = await freshTenant('a2b');
    const game = await paidGame(tenant, 'SPLIT');
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
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });
    const key = c3IdempotencyKey('a2b');
    const payload = {
      expectedRevision: game.revision,
      subscriptionInstanceId,
      priceConsent: { amountMinor: 0, currency: 'RUB' },
    };

    const first = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: key }),
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(owner.calls.execute).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: key }),
      payload,
    });

    expect([200, 202]).toContain(second.statusCode);
    expect(second.json().replayed).toBe(true);
    expect(second.json().operation.status).not.toBe('SUCCEEDED');
    expect(owner.calls.execute).toBe(1);
    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.commandRows).toBe(1);
    expect(saved.activeReservations).toBe(1);
  });

  it('A2c: a trusted owner receipt completes the original operation and a repeat calls no owner', async () => {
    const tenant = await freshTenant('a2c');
    const game = await paidGame(tenant, 'SPLIT');
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
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const displayed = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });
    const key = c3IdempotencyKey('a2c');
    const payload = {
      expectedRevision: game.revision,
      subscriptionInstanceId,
      priceConsent: { amountMinor: 0, currency: 'RUB' },
    };
    const first = await displayed.app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: key }),
      payload,
    });
    expect(first.statusCode).toBe(202);
    const operationId = first.json().commandId as string;
    const reservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    const reservationId = reservations[0]?.id;
    expect(reservationId).toBeTruthy();

    // The trusted owner channel (LK1 Node-RED / legacy CONFIRM_PAYMENT) confirms the original
    // operation. A client HTTP 200 / booking id is never used as financial success.
    const confirmed = await displayed.rosterRepository.confirmPayment({
      tenantId: tenant.tenantId,
      actorUserId: tenant.playerA.userId,
      gameId: game.gameId,
      idempotencyKey: c3IdempotencyKey('a2c-confirm'),
      requestHash: 'c'.repeat(64),
      correlationId: randomUUID(),
      reservationId: reservationId!,
      evidence: {
        provider: 'VIVA',
        operationType: 'SUBSCRIPTION_BOOKING',
        operationId: `c3-synthetic-provider-op-${randomUUID()}`,
        bookingId: `c3-synthetic-booking-${randomUUID()}`,
        clientPhoneE164: '+79000000001',
        evidenceHash: 'e'.repeat(64),
        verifiedAt: new Date().toISOString(),
        verifiedBy: 'LEGACY_NODE_RED',
        amountMinor: 0,
        currency: 'RUB',
      },
    });
    expect(confirmed.outcome).toBe('applied');

    const readback = await displayed.app.inject({
      method: 'GET',
      url: `/user/api/v1/${tenant.tenantKey}/game-operations/${operationId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json().operation.status).toBe('SUCCEEDED');
    expect(readback.json().operation.commercial.attemptState).toBe('OWNER_CONFIRMED');
    expect(readback.json().operation.commercial.receipt).toMatchObject({
      provider: 'VIVA',
      status: 'CONFIRMED',
    });

    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.participations).toBe(1);
    expect(saved.paymentEvidence).toBe(1);
    const persistedReservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(persistedReservations[0]?.state).toBe('CONFIRMED');

    const repeated = await displayed.app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: key }),
      payload,
    });
    expect([200, 202]).toContain(repeated.statusCode);
    expect(repeated.json().replayed).toBe(true);
    expect(owner.calls.execute).toBe(1);
    const after = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(after.participations).toBe(1);
    expect(after.paymentEvidence).toBe(1);
  });

  it('A3a: subscription JOIN with a surcharge charges exactly the server-owned amount', async () => {
    const tenant = await freshTenant('a3a');
    const game = await paidGame(tenant, 'SPLIT');
    const subscriptionInstanceId = randomUUID();
    const conditions = createConditionsDouble({
      revision: game.revision,
      legacyGameId: game.legacyGameId,
      startsAt: game.startsAt,
      subscriptionInstanceId,
      quote: {
        status: 'AVAILABLE',
        basePriceMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR,
        amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR,
        freeMinutes: 60,
        paidMinutes: 30,
        reasonCode: null,
      },
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey('a3a') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR, currency: 'RUB' },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().operation.commercial.price).toMatchObject({
      amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR,
      currency: 'RUB',
    });
    expect(owner.executed).toHaveLength(1);
    expect(owner.executed[0]?.price.amountMinor).toBe(SYNTHETIC_SURCHARGE_PRICE_MINOR);
    expect(owner.executed[0]?.price.freeMinutes).toBe(60);
    expect(owner.executed[0]?.price.paidMinutes).toBe(30);
    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.activeReservations).toBe(1);
    expect(saved.paymentSnapshots).toBe(1);
    const participationSnapshot = await pool.query<{ snapshot: unknown }>(
      `select snapshot from eligibility.payment_snapshots
        where tenant_id = $1 and activity_id = $2`,
      [tenant.tenantId, game.gameId],
    );
    expect(participationSnapshot.rows[0]?.snapshot).toMatchObject({
      price: { amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR, currency: 'RUB' },
    });
  });

  it('A3b: a stale consent is refused with no reservation, snapshot or owner call', async () => {
    const tenant = await freshTenant('a3b');
    const game = await paidGame(tenant, 'SPLIT');
    const subscriptionInstanceId = randomUUID();
    const conditions = createConditionsDouble({
      revision: game.revision,
      legacyGameId: game.legacyGameId,
      startsAt: game.startsAt,
      subscriptionInstanceId,
      quote: {
        status: 'AVAILABLE',
        basePriceMinor: SYNTHETIC_BASE_PRICE_MINOR,
        amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR,
        freeMinutes: 60,
        paidMinutes: 30,
        reasonCode: null,
      },
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ tenant, conditions, owner });
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey('a3b') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: SYNTHETIC_SURCHARGE_PRICE_MINOR - 1, currency: 'RUB' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('GAME_PRICE_CONFIRMATION_REQUIRED');
    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.reservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.commandRows).toBe(0);
    expect(owner.calls.execute).toBe(0);
  });

  it('C-LK2a: a record confirmed through the legacy owner channel is accounted in the next JOIN', async () => {
    const tenant = await freshTenant('clk2a');
    const game = await paidGame(tenant, 'SPLIT');
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
    const { app, rosterRepository } = await compose({ tenant, conditions, owner });
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

    // Channel 1 (administrator / LK1 legacy bridge): the claim is published atomically together
    // with slot+visit counters before the second player action.
    const first = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token: tokenA, idempotencyKey: c3IdempotencyKey('clk2a-a') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: 0, currency: 'RUB' },
      },
    });
    expect(first.statusCode).toBe(202);
    const reservation = (
      await readReservations(pool, { tenantId: tenant.tenantId, gameId: game.gameId })
    )[0];
    const applied = await rosterRepository.confirmPayment({
      tenantId: tenant.tenantId,
      actorUserId: tenant.playerA.userId,
      gameId: game.gameId,
      idempotencyKey: c3IdempotencyKey('clk2a-confirm'),
      requestHash: 'c'.repeat(64),
      correlationId: randomUUID(),
      reservationId: reservation!.id,
      evidence: {
        provider: 'VIVA',
        operationType: 'SUBSCRIPTION_BOOKING',
        operationId: `c3-synthetic-provider-op-${randomUUID()}`,
        bookingId: `c3-synthetic-booking-${randomUUID()}`,
        clientPhoneE164: '+79000000002',
        evidenceHash: 'f'.repeat(64),
        verifiedAt: new Date().toISOString(),
        verifiedBy: 'LEGACY_NODE_RED',
      },
    });
    expect(applied.outcome).toBe('applied');

    // Channel 2 (second JOIN): the externally recorded participation is visible. A stale revision
    // must not open a second reservation for the same counters; a fresh revision is required.
    const stale = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token: tokenB, idempotencyKey: c3IdempotencyKey('clk2a-b') }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: 0, currency: 'RUB' },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('GAME_REVISION_CONFLICT');
    const saved = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(saved.participations).toBe(1);
    expect(saved.reservations).toBe(1);
    expect(owner.calls.execute).toBe(1);
  });
});
