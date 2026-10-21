/**
 * C3 independent acceptance tests — scenario A, CREATE side: A1a, A1b, A4, A5.
 *
 * The paid/whole-court CREATE paths are NOT implemented in this slice (HANDOFF-C1 §4): CREATE stays
 * fail-closed `GAME_PAYMENT_REQUIRED` and is not replaced by a fake success. A1a proves the
 * fail-closed boundary (PASS-able). A1b/A4/A5 additionally try to exercise the commercial outcome
 * that does not exist yet and therefore end in an explicit executable `BLOCKED:` failure instead of
 * a fake PASS or a silent skip.
 *
 * Every case asserts HTTP/result AND saved PostgreSQL state AND counted owner/provider calls.
 * Fixtures/amounts are synthetic (`C3 SYNTHETIC`), never a live tariff. Evidence level: LOCAL.
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
  readSavedState,
  seedSyntheticTenant,
  C3_FIXTURE_VERSION,
  type C3App,
  type ConditionsDouble,
  type OwnerDouble,
  type SyntheticTenant,
} from './harness.js';
import { countTenantGames, readAuditSuccessCount, seedSyntheticStation } from './c3-helpers-a.js';

/** SYNTHETIC fixture amount. Not a live tariff. */
const SYNTHETIC_FULL_PRICE_MINOR = 150_000;

type CreatePaymentMode = 'NO_PAYMENT' | 'SPLIT' | 'SUBSCRIPTION' | 'ORGANIZER_PAYS';

interface CreatePayloadInput {
  readonly label: string;
  readonly stationId: string;
  readonly paymentMode: CreatePaymentMode;
  readonly kind?: 'FRIENDLY' | 'PRIVATE';
  readonly visibility?: 'PUBLIC' | 'PRIVATE';
  readonly courtId?: string;
  readonly extraFields?: Readonly<Record<string, unknown>>;
}

/** The accepted free-game payload shape, modified only through the payment/create fields. */
function createPayload(input: CreatePayloadInput): Record<string, unknown> {
  const startsAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const endsAt = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
  return {
    title: `C3 SYNTHETIC create ${input.label} ${randomUUID()}`,
    kind: input.kind ?? 'FRIENDLY',
    visibility: input.visibility ?? 'PUBLIC',
    stationId: input.stationId,
    ...(input.courtId === undefined ? {} : { courtId: input.courtId }),
    startsAt,
    endsAt,
    timezone: 'Europe/Moscow',
    capacity: 4,
    levelRange: null,
    paymentMode: input.paymentMode,
    waitlistEnabled: true,
    ...input.extraFields,
  };
}

function blocked(reason: string): never {
  throw new Error(`BLOCKED: ${reason}`);
}

c3DatabaseDescribe(`C3 commercial CREATE acceptance (${C3_FIXTURE_VERSION})`, () => {
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

  /**
   * Composes the real LK2 app with countable owner doubles. The conditions/owner doubles are never
   * expected to be called by CREATE in this slice; their call counters are part of the assertion.
   */
  async function composeCreateApp(): Promise<{
    composed: C3App;
    conditions: ConditionsDouble;
    owner: OwnerDouble;
  }> {
    const conditions = createConditionsDouble({
      revision: 1,
      legacyGameId: `c3-legacy-create-${randomUUID()}`,
      startsAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      subscriptionInstanceId: randomUUID(),
      quote: {
        status: 'AVAILABLE',
        basePriceMinor: SYNTHETIC_FULL_PRICE_MINOR,
        amountMinor: SYNTHETIC_FULL_PRICE_MINOR,
        freeMinutes: 60,
        paidMinutes: 30,
        reasonCode: null,
      },
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const composed = await buildC3App(pool, { conditions, owner });
    apps.push(composed);
    return { composed, conditions, owner };
  }

  async function organizerToken(tenant: SyntheticTenant): Promise<string> {
    return c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.organizer.userId,
      sessionId: tenant.organizer.sessionId,
    });
  }

  async function createGame(
    tenant: SyntheticTenant,
    app: C3App['app'],
    token: string,
    label: string,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey(label) }),
      payload,
    });
  }

  /** Asserts the fail-closed boundary: no forbidden business effect of any kind was saved. */
  async function expectNoForbiddenCreateEffect(input: {
    readonly tenant: SyntheticTenant;
    readonly conditions: ConditionsDouble;
    readonly owner: OwnerDouble;
    readonly visibility?: string;
  }): Promise<void> {
    const saved = await readSavedState(pool, { tenantId: input.tenant.tenantId });
    expect(saved.participations).toBe(0);
    expect(saved.reservations).toBe(0);
    expect(saved.activeReservations).toBe(0);
    expect(saved.commandRows).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.paymentEvidence).toBe(0);
    expect(saved.outboxEvents).toBe(0);
    expect(
      await countTenantGames(pool, {
        tenantId: input.tenant.tenantId,
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      }),
    ).toBe(0);
    // A refusal may be audited, but nothing may claim a successful creation/payment.
    expect(await readAuditSuccessCount(pool, input.tenant.tenantId)).toBe(0);
    expect(input.owner.calls.execute).toBe(0);
    expect(input.owner.calls.read).toBe(0);
    expect(input.conditions.calls.resolveSelection).toBe(0);
    expect(input.conditions.calls.readPreview).toBe(0);
  }

  it('A1a: paid CREATE by subscription/organizer-pays is fail-closed with no game row and no commercial call', async () => {
    const tenant = await freshTenant('a1a');
    const stationId = await seedSyntheticStation(pool, {
      tenantId: tenant.tenantId,
      createdByUserId: tenant.organizer.userId,
      label: 'a1a',
    });
    const { composed, conditions, owner } = await composeCreateApp();
    const token = await organizerToken(tenant);

    for (const paymentMode of ['SUBSCRIPTION', 'ORGANIZER_PAYS'] as const) {
      const refused = await createGame(
        tenant,
        composed.app,
        token,
        `a1a-${paymentMode.toLowerCase()}`,
        createPayload({ label: paymentMode, stationId, paymentMode }),
      );
      // HANDOFF-C1 §2.4: GAME_PAYMENT_REQUIRED is preserved as the fail-closed answer while the
      // commercial path is not configured. INVALID_REQUEST would also be fail-closed but the
      // documented contract code is asserted here.
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('GAME_PAYMENT_REQUIRED');
    }

    await expectNoForbiddenCreateEffect({ tenant, conditions, owner });

    // Control: the exact same request shape with NO_PAYMENT is accepted, so the refusal above is
    // the payment-mode guard and not a technical/authorization error.
    const control = await createGame(
      tenant,
      composed.app,
      token,
      'a1a-control',
      createPayload({ label: 'control', stationId, paymentMode: 'NO_PAYMENT' }),
    );
    expect(control.statusCode).toBe(202);
    expect(await countTenantGames(pool, { tenantId: tenant.tenantId })).toBe(1);
    // Even the accepted free control must not reach the commercial owner.
    expect(owner.calls.execute).toBe(0);
    expect(owner.calls.read).toBe(0);
    expect(conditions.calls.readPreview).toBe(0);
  });

  it('A1b: commercial CREATE end-to-end is not implemented in this slice (executable BLOCKED check)', async () => {
    const tenant = await freshTenant('a1b');
    const stationId = await seedSyntheticStation(pool, {
      tenantId: tenant.tenantId,
      createdByUserId: tenant.organizer.userId,
      label: 'a1b',
    });
    const { composed, conditions, owner } = await composeCreateApp();
    const token = await organizerToken(tenant);

    // Product A (organizer subscription) CREATE: the only behaviour that exists is the guard.
    const refused = await createGame(
      tenant,
      composed.app,
      token,
      'a1b-subscription',
      createPayload({ label: 'subscription', stationId, paymentMode: 'SUBSCRIPTION' }),
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('GAME_PAYMENT_REQUIRED');

    // No durable operation, no server-owned product/price, no owner call, no participation.
    await expectNoForbiddenCreateEffect({ tenant, conditions, owner });

    blocked(
      'commercial CREATE end-to-end (durable operation, server-owned product/price, exactly one ' +
        'owner call, participation only after a trusted receipt) is not implemented: paid CREATE ' +
        'is refused GAME_PAYMENT_REQUIRED with no durable attempt, no product selection and no ' +
        'owner call (HANDOFF-C1 §4). Unblock requires: D0 BookedOperationAdmissionRequest.action ' +
        'CREATE_GAME + server-side subscriptionInstanceId; a ЦУП LK2-facing quote receiver; a LK1 ' +
        'receiver for booked-operation admissions or a LK2-game booking endpoint; and CREATE ' +
        'financial acceptance (PR #392 canFinalize:false).',
    );
  });

  it('A4: full-price (no subscription) CREATE is fail-closed; the paid purchase path stays BLOCKED', async () => {
    const tenant = await freshTenant('a4');
    const stationId = await seedSyntheticStation(pool, {
      tenantId: tenant.tenantId,
      createdByUserId: tenant.organizer.userId,
      label: 'a4',
    });
    const { composed, conditions, owner } = await composeCreateApp();
    const token = await organizerToken(tenant);

    // 1. A client cannot even express a full-price purchase intent: the strict CREATE contract has
    //    no price/intent field, so a client-supplied amount is rejected, not trusted.
    const intentProbe = await createGame(
      tenant,
      composed.app,
      token,
      'a4-intent',
      createPayload({
        label: 'full-price-intent',
        stationId,
        paymentMode: 'ORGANIZER_PAYS',
        extraFields: {
          paymentIntent: 'PAY_FULL_PRICE',
          amountMinor: SYNTHETIC_FULL_PRICE_MINOR,
          currency: 'RUB',
        },
      }),
    );
    expect(intentProbe.statusCode).toBe(400);
    expect(intentProbe.json().code).toBe('INVALID_REQUEST');

    // 2. The valid-shape organizer-pays CREATE is refused by the existing beta guard.
    const paid = await createGame(
      tenant,
      composed.app,
      token,
      'a4-organizer-pays',
      createPayload({ label: 'organizer-pays', stationId, paymentMode: 'ORGANIZER_PAYS' }),
    );
    expect(paid.statusCode).toBe(409);
    expect(paid.json().code).toBe('GAME_PAYMENT_REQUIRED');

    // 3. Fail-closed: no game row, no seat reservation, no payment snapshot/evidence, no charge,
    //    no owner call. A full-price attempt must never reach the commercial owner.
    await expectNoForbiddenCreateEffect({ tenant, conditions, owner });

    // 4. Control: the same shape with NO_PAYMENT is accepted, so the request itself is valid.
    const control = await createGame(
      tenant,
      composed.app,
      token,
      'a4-control',
      createPayload({ label: 'control', stationId, paymentMode: 'NO_PAYMENT' }),
    );
    expect(control.statusCode).toBe(202);
    expect(await countTenantGames(pool, { tenantId: tenant.tenantId })).toBe(1);
    expect(owner.calls.execute).toBe(0);
    expect(owner.calls.read).toBe(0);

    blocked(
      'one-time full-price payment (no subscription, PAY_FULL_PRICE intent) is not implemented ' +
        '(HANDOFF-C1 §4): the CREATE contract accepts no price/intent field, the join/price ' +
        'conditions owner cannot quote a purchase without an entitlement, and the commercial ' +
        'executor only exposes subscription admission. The observed state is the fail-closed ' +
        'guard: 400 INVALID_REQUEST for a client amount, 409 GAME_PAYMENT_REQUIRED for a ' +
        'paid CREATE, with zero seat reservations, zero payment snapshots/evidence and zero ' +
        'owner calls (no charge). A full-price path requires a server-owned price intent and the ' +
        'D0/LK1 admission contract before it can be accepted.',
    );
  });

  it('A5: private whole-court paid booking by the organizer stays fail-closed with no forbidden effect', async () => {
    const tenant = await freshTenant('a5');
    const stationId = await seedSyntheticStation(pool, {
      tenantId: tenant.tenantId,
      createdByUserId: tenant.organizer.userId,
      label: 'a5',
    });
    const { composed, conditions, owner } = await composeCreateApp();
    const token = await organizerToken(tenant);

    // Whole-court private paid booking: private kind/visibility plus an organizer-pays mode. The
    // court id is a synthetic UUID; the paid guard must fire before any venue/court lookup.
    const paidPrivate = await createGame(
      tenant,
      composed.app,
      token,
      'a5-private-paid',
      createPayload({
        label: 'private-paid',
        stationId,
        paymentMode: 'ORGANIZER_PAYS',
        kind: 'PRIVATE',
        visibility: 'PRIVATE',
        courtId: randomUUID(),
      }),
    );
    expect(paidPrivate.statusCode).toBe(409);
    expect(paidPrivate.json().code).toBe('GAME_PAYMENT_REQUIRED');

    // No private game row, no seat reservation/participation, no payment, no owner call.
    await expectNoForbiddenCreateEffect({
      tenant,
      conditions,
      owner,
      visibility: 'PRIVATE',
    });

    // Control: the same private shape is accepted only as a free game, which proves the refusal is
    // the payment boundary rather than an invalid private-request shape.
    const control = await createGame(
      tenant,
      composed.app,
      token,
      'a5-control',
      createPayload({
        label: 'private-control',
        stationId,
        paymentMode: 'NO_PAYMENT',
        kind: 'PRIVATE',
        visibility: 'PRIVATE',
      }),
    );
    expect(control.statusCode).toBe(202);
    expect(await countTenantGames(pool, { tenantId: tenant.tenantId, visibility: 'PRIVATE' })).toBe(
      1,
    );
    expect(owner.calls.execute).toBe(0);
    expect(owner.calls.read).toBe(0);

    blocked(
      'private whole-court paid booking by the organizer is not implemented (HANDOFF-C1 §1/§4): ' +
        'the only booking owner path is the legacy LK1 split/create route which requires an ' +
        'end-user bearer and creates a new legacy game, and LK2 has no server-to-server booking ' +
        'delegation or private-court payment composition. Observed state is the fail-closed ' +
        'boundary: 409 GAME_PAYMENT_REQUIRED with no private game row, no seat reservation, no ' +
        'payment snapshot/evidence and no owner call.',
    );
  });
});
