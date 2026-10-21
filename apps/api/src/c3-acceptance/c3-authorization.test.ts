/**
 * C3 independent acceptance tests — scenario E: authorization, tenant isolation, operation
 * ownership, spoofing/forgery resistance and the personal-invitation entitlement boundary
 * (E1, E2, E3, E4, E5, E6, E7).
 *
 * Every case asserts the HTTP/result, the saved PostgreSQL state and the counted external-owner
 * calls. The commercial executor and the LK1 conditions owner are countable local doubles:
 * LOCAL evidence only. All fixtures, amounts and provider identifiers are synthetic
 * (`C3 SYNTHETIC`) and are never a live tariff, account or provider operation.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  C3_FIXTURE_VERSION,
  buildC3App,
  c3AccessToken,
  c3DatabaseDescribe,
  c3Headers,
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
  conditionsForGame,
  conditionsWithoutOwnedSelection,
  getGameOperation,
  getJoinConditions,
  getJoinOperation,
  insertPersonalInvitation,
  paidJoinBody,
  postJoin,
  readEligibilityDecisions,
  readGameRevision,
  readPersonalInvitations,
  seedLevelBlockedPaidGame,
  syntheticTrustedEvidence,
  zeroSurchargeQuote,
  type ConditionsDouble,
} from './c3-helpers-concurrency.js';

// The DB-backed acceptance cases share one isolated PostgreSQL instance. Under parallel C3
// workers the default 5s per-test budget is too tight even though no assertion changes; keep a
// generous budget so a timing stall can never be misread as a product failure (a real hang still
// fails). Assertions themselves are unchanged.
vi.setConfig({ testTimeout: 30_000 });

c3DatabaseDescribe(`C3 paid JOIN authorization acceptance (${C3_FIXTURE_VERSION})`, () => {
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

  it('E1: a foreign or non-owned subscription selection is refused before any commercial write', async () => {
    const tenant = await freshTenant('e1');
    const game = await paidGame(tenant);
    const ownedSubscriptionInstanceId = randomUUID();
    const foreignSubscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, {
      subscriptionInstanceId: ownedSubscriptionInstanceId,
      quote: zeroSurchargeQuote(),
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const emptyState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(emptyState).toMatchObject({
      participations: 0,
      reservations: 0,
      activeReservations: 0,
      commandRows: 0,
      paymentSnapshots: 0,
      paymentEvidence: 0,
    });

    // (a) The client names a subscription product the conditions owner does not resolve for it.
    const foreignSelection = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e1-foreign'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId: foreignSubscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(foreignSelection.statusCode).toBe(409);
    // C1 41157c5e (P2.1): an unmapped/foreign selection is a selection problem, not a payment
    // problem. It never reserves for a selection the owner did not confirm for this actor.
    expect(foreignSelection.json().code).toBe('GAME_SUBSCRIPTION_SELECTION_REQUIRED');
    expect(conditions.calls.readPreview).toBe(0);
    expect(owner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );

    // (b) A price consent without any server-owned subscription selection is refused explicitly.
    const missingSelection = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e1-missing'),
      body: {
        expectedRevision: game.revision,
        priceConsent: { amountMinor: 0, currency: 'RUB' },
      },
    });
    expect(missingSelection.statusCode).toBe(409);
    expect(missingSelection.json().code).toBe('GAME_SUBSCRIPTION_SELECTION_REQUIRED');
    expect(owner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );

    // (c) The owner resolves no selection at all for this actor (not owned / foreign product).
    const noSelectionConditions = conditionsWithoutOwnedSelection(
      conditionsForGame(game, {
        subscriptionInstanceId: ownedSubscriptionInstanceId,
        quote: zeroSurchargeQuote(),
      }),
    );
    const noSelectionOwner = createOwnerDouble([{ status: 'PENDING' }]);
    const noSelection = await compose({
      conditions: noSelectionConditions,
      owner: noSelectionOwner,
    });
    const noOwnedSelection = await postJoin({
      app: noSelection.app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e1-null'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId: ownedSubscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(noOwnedSelection.statusCode).toBe(409);
    // C1 41157c5e (P2.1): the same stable selection code when the owner resolves no selection.
    expect(noOwnedSelection.json().code).toBe('GAME_SUBSCRIPTION_SELECTION_REQUIRED');
    expect(noSelectionOwner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );
  });

  it('E2: a token without the path tenant is refused with TENANT_ACCESS_DENIED and writes nothing', async () => {
    const tenantA = await freshTenant('e2-a');
    const tenantB = await freshTenant('e2-b');
    const game = await paidGame(tenantA);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    // The token is valid (JWT + active session) but its `tenants` claim only contains tenant B.
    const foreignTenantToken = await token(tenantB, 'playerA');

    const beforeA = await readSavedState(pool, {
      tenantId: tenantA.tenantId,
      gameId: game.gameId,
    });
    const beforeB = await readSavedState(pool, { tenantId: tenantB.tenantId });

    const response = await postJoin({
      app,
      tenantKey: tenantA.tenantKey,
      gameId: game.gameId,
      token: foreignTenantToken,
      idempotencyKey: c3IdempotencyKey('e2-join'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('TENANT_ACCESS_DENIED');
    expect(owner.calls.execute).toBe(0);
    expect(conditions.calls.resolveSelection).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenantA.tenantId, gameId: game.gameId })).toEqual(
      beforeA,
    );
    expect(await readSavedState(pool, { tenantId: tenantB.tenantId })).toEqual(beforeB);

    // The advisory preview path is tenant-scoped the same way.
    const preview = await getJoinConditions({
      app,
      tenantKey: tenantA.tenantKey,
      gameId: game.gameId,
      token: foreignTenantToken,
      expectedRevision: game.revision,
      subscriptionInstanceId,
    });
    expect(preview.statusCode).toBe(403);
    expect(preview.json().code).toBe('TENANT_ACCESS_DENIED');
    expect(conditions.calls.resolveSelection).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenantA.tenantId, gameId: game.gameId })).toEqual(
      beforeA,
    );
  });

  it('E3: another actor cannot read a foreign operation and the readback mutates nothing', async () => {
    const tenant = await freshTenant('e3');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const tokenB = await token(tenant, 'playerB');
    const keyA = c3IdempotencyKey('e3-a');

    const created = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: keyA,
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(created.statusCode).toBe(202);
    const operationId = created.json().commandId as string;
    owner.setReadOutcome({ status: 'PENDING' });
    const before = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(owner.calls.execute).toBe(1);

    // User B reads user A's operation by id: the durable attempt is actor-scoped.
    const foreignById = await getGameOperation({
      app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenB,
    });
    expect(foreignById.statusCode).toBe(404);
    expect(foreignById.json().code).toBe('GAME_OPERATION_NOT_FOUND');

    // User B replays user A's Idempotency-Key on the recovery route: it derives B's own operation
    // id, which does not exist, so no foreign attempt is disclosed.
    const foreignByKey = await getJoinOperation({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenB,
      idempotencyKey: keyA,
    });
    expect(foreignByKey.statusCode).toBe(404);
    expect(foreignByKey.json().code).toBe('GAME_OPERATION_NOT_FOUND');
    // A foreign readback mutates nothing and dispatches no owner call.
    expect(owner.calls.execute).toBe(1);
    expect(owner.calls.read).toBe(0);
    const afterForeign = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(afterForeign).toEqual(before);

    // The rightful owner can read the very same durable attempt.
    const own = await getGameOperation({
      app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().operation.id).toBe(operationId);
    expect(own.json().operation.status).toBe('PROCESSING');
    expect(owner.calls.read).toBe(1);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      before,
    );
  });

  it('E4: actor/price/version spoofing is rejected or ignored and never decides the command', async () => {
    const tenant = await freshTenant('e4');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const tokenB = await token(tenant, 'playerB');
    const emptyState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });

    // (a) The body price differs from the server-owned price: a new consent is required.
    const priceSpoof = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e4-price'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 1,
      }),
    });
    expect(priceSpoof.statusCode).toBe(409);
    expect(priceSpoof.json().code).toBe('GAME_PRICE_CONFIRMATION_REQUIRED');
    expect(owner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );

    // (b) The body tries to name another actor/tenant: strict parsing rejects the command.
    const actorSpoof = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e4-actor'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
        extra: { userId: tenant.playerB.userId },
      }),
    });
    expect(actorSpoof.statusCode).toBe(400);
    expect(actorSpoof.json().code).toBe('INVALID_REQUEST');
    const tenantSpoof = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e4-tenant'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
        extra: { tenantId: randomUUID(), actorUserId: tenant.playerB.userId },
      }),
    });
    expect(tenantSpoof.statusCode).toBe(400);
    expect(tenantSpoof.json().code).toBe('INVALID_REQUEST');
    expect(owner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );

    // (c) Spoofed identity/tenant headers are ignored: the server uses the JWT subject.
    const spoofedHeaders = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e4-headers'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
      headers: {
        'x-user-id': tenant.playerB.userId,
        'x-tenant-id': randomUUID(),
        'x-actor-user-id': tenant.playerB.userId,
      },
    });
    expect(spoofedHeaders.statusCode).toBe(202);
    expect(owner.calls.execute).toBe(1);
    const reservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.user_id).toBe(tenant.playerA.userId);
    const participations = await readParticipations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(participations.filter((row) => row.user_id === tenant.playerB.userId)).toHaveLength(0);
    const afterJoin = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(afterJoin).toMatchObject({
      activeReservations: 1,
      commandRows: 1,
      paymentSnapshots: 1,
      participations: 0,
    });

    // (d) A stale expectedRevision cannot be replayed from the body: the durable command recheck
    //     refuses it after the seat was reserved (revision advanced), with no additional write.
    const staleRevision = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e4-revision'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(staleRevision.statusCode).toBe(409);
    expect(staleRevision.json().code).toBe('GAME_REVISION_CONFLICT');
    expect(owner.calls.execute).toBe(1);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      afterJoin,
    );
    expect(
      await readReservations(pool, { tenantId: tenant.tenantId, gameId: game.gameId }),
    ).toHaveLength(1);

    // The foreign player's token is a real tenant member but still owns no operation here.
    const foreignJoinOperation = await getJoinOperation({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenB,
      idempotencyKey: c3IdempotencyKey('e4-foreign-key'),
    });
    expect(foreignJoinOperation.statusCode).toBe(404);
  });

  it('E5: client provider/return fields cannot confirm a payment; only a trusted receipt can', async () => {
    const tenant = await freshTenant('e5');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app, rosterRepository } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const emptyState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });

    // (a) Strict body validation rejects any client-chosen provider booking identifier.
    for (const field of [
      'providerBookingId',
      'bookingId',
      'returnUrl',
      'providerOperationId',
      'paymentStatus',
    ]) {
      const rejected = await postJoin({
        app,
        tenantKey: tenant.tenantKey,
        gameId: game.gameId,
        token: tokenA,
        idempotencyKey: c3IdempotencyKey(`e5-${field}`),
        body: paidJoinBody({
          expectedRevision: game.revision,
          subscriptionInstanceId,
          amountMinor: 0,
          extra: { [field]: 'c3-synthetic-forged-value' },
        }),
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe('INVALID_REQUEST');
    }
    // The price consent object itself is strict as well.
    const nestedForgery = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e5-nested'),
      body: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: {
          amountMinor: 0,
          currency: 'RUB',
          bookingId: 'c3-synthetic-booking',
        },
      },
    });
    expect(nestedForgery.statusCode).toBe(400);
    expect(nestedForgery.json().code).toBe('INVALID_REQUEST');
    expect(owner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );

    // (b) An arbitrary client "return callback" path is not a payment confirmation.
    const returnCallback = await app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join-return?providerBookingId=c3-synthetic-booking`,
      headers: c3Headers({ token: tokenA, idempotencyKey: c3IdempotencyKey('e5-return') }),
      payload: { providerBookingId: 'c3-synthetic-booking', status: 'CONFIRMED' },
    });
    expect(returnCallback.statusCode).toBe(404);
    expect(owner.calls.execute).toBe(0);
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      emptyState,
    );

    // (c) After a real reservation, forged client fields still cannot confirm it.
    const reserved = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e5-real'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(reserved.statusCode).toBe(202);
    expect(reserved.json().operation.status).toBe('PROCESSING');
    const operationId = reserved.json().commandId as string;
    expect(owner.calls.execute).toBe(1);
    const afterReserve = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(afterReserve).toMatchObject({
      activeReservations: 1,
      commandRows: 1,
      paymentSnapshots: 1,
      paymentEvidence: 0,
      participations: 0,
    });
    const forgedConfirm = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e5-forged-confirm'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
        extra: {
          providerBookingId: 'c3-synthetic-booking',
          bookingId: 'c3-synthetic-booking',
          returnUrl: 'https://c3.invalid/synthetic-return',
        },
      }),
    });
    expect(forgedConfirm.statusCode).toBe(400);
    expect(forgedConfirm.json().code).toBe('INVALID_REQUEST');
    expect(await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      afterReserve,
    );
    const unresolvedReadback = await getGameOperation({
      app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(unresolvedReadback.statusCode).toBe(200);
    expect(unresolvedReadback.json().operation.status).not.toBe('SUCCEEDED');
    expect(unresolvedReadback.json().operation.commercial.attemptState).not.toBe('OWNER_CONFIRMED');

    // (d) Only the trusted owner receipt (legacy CONFIRM_PAYMENT) applies the participation.
    const reservationId = (
      await readReservations(pool, { tenantId: tenant.tenantId, gameId: game.gameId })
    )[0]!.id;
    const applied = await rosterRepository.confirmPayment({
      tenantId: tenant.tenantId,
      actorUserId: tenant.playerA.userId,
      gameId: game.gameId,
      idempotencyKey: c3IdempotencyKey('e5-trusted-confirm'),
      requestHash: 'd'.repeat(64),
      correlationId: randomUUID(),
      reservationId,
      evidence: syntheticTrustedEvidence(0),
    });
    expect(applied.outcome).toBe('applied');
    const confirmedState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(confirmedState).toMatchObject({ participations: 1, paymentEvidence: 1 });
    const confirmed = await getGameOperation({
      app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().operation.status).toBe('SUCCEEDED');
    expect(confirmed.json().operation.commercial.attemptState).toBe('OWNER_CONFIRMED');
  });

  it('E6: direct client confirm/release paths are refused and change no business state', async () => {
    const tenant = await freshTenant('e6');
    const game = await paidGame(tenant);
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');

    const reserved = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e6-join'),
      body: paidJoinBody({
        expectedRevision: game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
      }),
    });
    expect(reserved.statusCode).toBe(202);
    const operationId = reserved.json().commandId as string;
    const reservationId = (
      await readReservations(pool, { tenantId: tenant.tenantId, gameId: game.gameId })
    )[0]!.id;
    const before = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    const commandsBefore = await readCommandRows(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });

    // Plausible client confirm/release endpoints do not exist: the commercial success belongs to
    // the existing owner + trusted receipt channel, never to a client POST.
    for (const url of [
      `/user/api/v1/${tenant.tenantKey}/game-operations/${operationId}/confirm`,
      `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/confirm`,
      `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join/confirm`,
      `/user/api/v1/${tenant.tenantKey}/subscriptions/${subscriptionInstanceId}/confirm`,
      `/user/api/v1/${tenant.tenantKey}/subscriptions/${subscriptionInstanceId}/release`,
      `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/seat-reservations/${reservationId}/release`,
    ]) {
      const refused = await app.inject({
        method: 'POST',
        url,
        headers: c3Headers({ token: tokenA, idempotencyKey: c3IdempotencyKey('e6-direct') }),
        payload: { reservationId, status: 'CONFIRMED' },
      });
      expect([401, 403, 404]).toContain(refused.statusCode);
    }

    // The internal trusted bridge is closed to clients. In the C3 composition the bridge is not
    // configured at all, so it fails closed with 503 instead of accepting an untrusted
    // CONFIRM_PAYMENT; either way it must not write a payment confirmation.
    const bridgePayload = {
      command: 'CONFIRM_PAYMENT',
      reservationId,
      evidence: {
        provider: 'VIVA',
        operationType: 'SUBSCRIPTION_BOOKING',
        operationId: 'c3-synthetic-forged-provider-op',
        bookingId: 'c3-synthetic-forged-booking',
        clientPhoneE164: '+79000000009',
        status: 'CONFIRMED',
        verifiedAt: new Date().toISOString(),
      },
    };
    for (const headers of [
      c3Headers({ token: tokenA, idempotencyKey: c3IdempotencyKey('e6-bridge-notoken') }),
      {
        ...c3Headers({ token: tokenA, idempotencyKey: c3IdempotencyKey('e6-bridge-token') }),
        'x-phub-legacy-roster-token': 'c3-synthetic-forged-integration-token',
      },
    ]) {
      const bridge = await app.inject({
        method: 'POST',
        url: `/internal/api/v1/${tenant.tenantKey}/legacy-games/${game.legacyGameId}/roster-commands`,
        headers,
        payload: bridgePayload,
      });
      expect([401, 403, 404, 503]).toContain(bridge.statusCode);
      expect([
        'LEGACY_GAME_BRIDGE_DISABLED',
        'LEGACY_GAME_BRIDGE_FORBIDDEN',
        'LEGACY_AUTH_REQUIRED',
      ]).toContain(bridge.json().code);
    }

    // Nothing changed: no confirmation, no participation, no evidence, same operations/reservations.
    const after = await readSavedState(pool, { tenantId: tenant.tenantId, gameId: game.gameId });
    expect(after).toEqual(before);
    expect(await readCommandRows(pool, { tenantId: tenant.tenantId, gameId: game.gameId })).toEqual(
      commandsBefore,
    );
    const reservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: game.gameId,
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      id: reservationId,
      state: 'ACTIVE',
      payment_state: 'PROCESSING',
    });
    expect(owner.calls.execute).toBe(1);
    const readback = await getGameOperation({
      app,
      tenantKey: tenant.tenantKey,
      operationId,
      token: tokenA,
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json().operation.status).not.toBe('SUCCEEDED');
    expect(readback.json().operation.commercial.attemptState).not.toBe('OWNER_CONFIRMED');
  });

  it('E7a: the personal-invitation level bypass is consumed exactly once by the paid finalization', async () => {
    // Minimal P1 case: an under-level player joins a paid game through a single-use personal
    // invitation; the trusted finalization must consume that invitation exactly once.
    const tenant = await freshTenant('e7a');
    const levelBlocked = await seedLevelBlockedPaidGame(pool, {
      tenant,
      paymentMode: 'SPLIT',
    });
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(levelBlocked.game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const { app, rosterRepository } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const invitationId = await insertPersonalInvitation(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
      recipientUserId: tenant.playerA.userId,
      createdByUserId: tenant.organizer.userId,
    });

    // The paid JOIN reserves through the level bypass (the invitation is bound to the decision).
    const reserved = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: levelBlocked.game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e7a-bypass'),
      body: paidJoinBody({
        expectedRevision: levelBlocked.game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
        invitationId,
      }),
    });
    expect(reserved.statusCode).toBe(202);
    const decisionsBeforeConfirm = await readEligibilityDecisions(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    expect(
      decisionsBeforeConfirm.find((decision) => decision.reasonCode === 'PERSONAL_INVITE_BYPASS'),
    ).toMatchObject({ status: 'ALLOWED', outcome: 'BYPASS', invitationId });

    // The trusted legacy receipt finalizes the participation on the original reservation.
    const reservationId = (
      await readReservations(pool, {
        tenantId: tenant.tenantId,
        gameId: levelBlocked.game.gameId,
      })
    )[0]!.id;
    const applied = await rosterRepository.confirmPayment({
      tenantId: tenant.tenantId,
      actorUserId: tenant.playerA.userId,
      gameId: levelBlocked.game.gameId,
      idempotencyKey: c3IdempotencyKey('e7a-confirm'),
      requestHash: 'f'.repeat(64),
      correlationId: randomUUID(),
      reservationId,
      evidence: syntheticTrustedEvidence(0),
    });
    expect(applied.outcome).toBe('applied');
    const confirmedState = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    expect(confirmedState).toMatchObject({ participations: 1, paymentEvidence: 1 });
    const invitationAfterFinalization = (
      await readPersonalInvitations(pool, {
        tenantId: tenant.tenantId,
        invitationId,
      })
    )[0];
    expect(invitationAfterFinalization).toBeDefined();

    // A second paid JOIN must not reuse the same single-use invitation.
    const currentRevision = await readGameRevision(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    conditions.setRevision(currentRevision);
    const reuse = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: levelBlocked.game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e7a-reuse'),
      body: paidJoinBody({
        expectedRevision: currentRevision,
        subscriptionInstanceId,
        amountMinor: 0,
        invitationId,
      }),
    });
    const afterReuse = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    const reservationsAfterReuse = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    const decisionsAfterReuse = await readEligibilityDecisions(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });

    expect({
      invitationAfterPaidFinalization: {
        status: invitationAfterFinalization?.status,
        useCount: invitationAfterFinalization?.useCount,
        maxUses: invitationAfterFinalization?.maxUses,
      },
      secondJoinReuse: {
        status: reuse.statusCode,
        reservations: reservationsAfterReuse.length,
        activeReservations: afterReuse.activeReservations,
        participations: afterReuse.participations,
        bypassDecisions: decisionsAfterReuse.filter(
          (decision) => decision.reasonCode === 'PERSONAL_INVITE_BYPASS',
        ).length,
      },
    }).toEqual({
      invitationAfterPaidFinalization: { status: 'USED', useCount: 1, maxUses: 1 },
      secondJoinReuse: {
        status: 409,
        reservations: 1,
        activeReservations: 0,
        participations: 1,
        bypassDecisions: 1,
      },
    });
  });

  it('E7: a failed paid attempt leaves the single-use personal invitation reusable', async () => {
    // Follow-up finding: the bypass is validated by beginPaidJoin but never consumed, so a paid
    // attempt that used it and then failed definitively can hand the same invitation to a second
    // paid enrollment.
    const tenant = await freshTenant('e7');
    const levelBlocked = await seedLevelBlockedPaidGame(pool, {
      tenant,
      paymentMode: 'SPLIT',
    });
    const subscriptionInstanceId = randomUUID();
    const conditions = conditionsForGame(levelBlocked.game, { subscriptionInstanceId });
    const owner = createOwnerDouble([{ status: 'REJECTED', code: 'GAME_SERVICE_BLOCKED' }]);
    const { app } = await compose({ conditions, owner });
    const tokenA = await token(tenant, 'playerA');
    const invitationId = await insertPersonalInvitation(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
      recipientUserId: tenant.playerA.userId,
      createdByUserId: tenant.organizer.userId,
    });

    const failedAttempt = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: levelBlocked.game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e7-failed'),
      body: paidJoinBody({
        expectedRevision: levelBlocked.game.revision,
        subscriptionInstanceId,
        amountMinor: 0,
        invitationId,
      }),
    });
    expect(failedAttempt.statusCode).toBe(409);
    expect(failedAttempt.json().code).toBe('GAME_SERVICE_BLOCKED');
    expect(owner.calls.execute).toBe(1);
    const failedDecisions = await readEligibilityDecisions(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    // The failed attempt did use the personal-invitation bypass.
    expect(
      failedDecisions.filter((decision) => decision.reasonCode === 'PERSONAL_INVITE_BYPASS'),
    ).toHaveLength(1);
    const failedReservations = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    expect(failedReservations).toHaveLength(1);
    expect(failedReservations[0]?.state).toBe('CANCELLED');

    // Retry the same single-use invitation with a new key after the failed attempt.
    const refreshedRevision = await readGameRevision(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    conditions.setRevision(refreshedRevision);
    const retry = await postJoin({
      app,
      tenantKey: tenant.tenantKey,
      gameId: levelBlocked.game.gameId,
      token: tokenA,
      idempotencyKey: c3IdempotencyKey('e7-retry'),
      body: paidJoinBody({
        expectedRevision: refreshedRevision,
        subscriptionInstanceId,
        amountMinor: 0,
        invitationId,
      }),
    });
    const afterRetry = await readSavedState(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    const reservationsAfterRetry = await readReservations(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    const decisionsAfterRetry = await readEligibilityDecisions(pool, {
      tenantId: tenant.tenantId,
      gameId: levelBlocked.game.gameId,
    });
    const invitationAfterFailure = (
      await readPersonalInvitations(pool, {
        tenantId: tenant.tenantId,
        invitationId,
      })
    )[0];

    expect({
      invitationAfterFailedAttempt: invitationAfterFailure
        ? {
            status: invitationAfterFailure.status,
            useCount: invitationAfterFailure.useCount,
            maxUses: invitationAfterFailure.maxUses,
          }
        : null,
      retryAfterFailedAttempt: {
        status: retry.statusCode,
        reservations: reservationsAfterRetry.length,
        activeReservations: afterRetry.activeReservations,
        bypassDecisions: decisionsAfterRetry.filter(
          (decision) => decision.reasonCode === 'PERSONAL_INVITE_BYPASS',
        ).length,
        ownerExecuteCalls: owner.calls.execute,
        participations: afterRetry.participations,
      },
    }).toEqual({
      invitationAfterFailedAttempt: { status: 'USED', useCount: 1, maxUses: 1 },
      retryAfterFailedAttempt: {
        status: 409,
        reservations: 1,
        activeReservations: 0,
        bypassDecisions: 1,
        ownerExecuteCalls: 1,
        participations: 0,
      },
    });
  });
});
