/**
 * C3 independent acceptance tests — case B4 (service prohibition vs benefit refusal).
 *
 * HANDOFF-C1 §2.4/§3 requires `GAME_SERVICE_BLOCKED` as a distinct stable code ("the service itself
 * is forbidden; paying does not remove the prohibition") separate from the payment/subscription
 * guard. This file proves the LK2 commercial JOIN distinguishes:
 *   - B4-LK2a: the service itself is forbidden (conditions quote UNAVAILABLE, reasonCode
 *     SERVICE_BLOCKED) → expected 409 `GAME_SERVICE_BLOCKED`;
 *   - B4-LK2b: only the subscription benefit is refused (reasonCode DAILY_USAGE_LIMIT_REACHED) →
 *     a stable payment/subscription refusal, but NOT `GAME_SERVICE_BLOCKED`.
 *
 * Both cases assert HTTP AND saved PostgreSQL state AND owner/conditions call counts. The owner is a
 * countable LOCAL double; fixtures/amounts are synthetic (`C3 SYNTHETIC`), never a live tariff.
 * Evidence level: LOCAL.
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
  seedSyntheticGame,
  seedSyntheticTenant,
  C3_FIXTURE_VERSION,
  type C3App,
  type SyntheticTenant,
} from './harness.js';
import { readAuditSuccessCount } from './c3-helpers-a.js';

/** SYNTHETIC fixture amount. Not a live tariff. */
const SYNTHETIC_BASE_PRICE_MINOR = 150_000;

/** LK2 stable refusals that are acceptable for a benefit-only refusal (B4-LK2b). */
const BENEFIT_REFUSAL_CODES = [
  'GAME_PAYMENT_REQUIRED',
  'GAME_PRICE_CONFIRMATION_REQUIRED',
  'GAME_SUBSCRIPTION_SELECTION_REQUIRED',
] as const;

/**
 * Non-AVAILABLE preview quote: structurally valid per readGameJoinConditions (amountMinor null,
 * freeMinutes/paidMinutes 0, reasonCode set). The reason code below is the only difference between
 * the two cases.
 */
function unavailableQuote(reasonCode: string) {
  return {
    status: 'UNAVAILABLE' as const,
    basePriceMinor: SYNTHETIC_BASE_PRICE_MINOR,
    amountMinor: null,
    freeMinutes: 0,
    paidMinutes: 0,
    reasonCode,
  };
}

c3DatabaseDescribe(`C3 commercial JOIN — service-block distinction (${C3_FIXTURE_VERSION})`, () => {
  let pool: Pool;
  const apps: C3App[] = [];

  beforeAll(async () => {
    pool = await createC3Pool();
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((entry) => entry.close()));
    await pool.end();
  });

  async function scenario(input: { readonly label: string; readonly reasonCode: string }): Promise<{
    tenant: SyntheticTenant;
    gameId: string;
    conditions: ReturnType<typeof createConditionsDouble>;
    owner: ReturnType<typeof createOwnerDouble>;
    response: Awaited<ReturnType<C3App['app']['inject']>>;
  }> {
    const tenant = await seedSyntheticTenant(pool, input.label);
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
      quote: unavailableQuote(input.reasonCode),
    });
    const owner = createOwnerDouble([{ status: 'PENDING' }]);
    const composed = await buildC3App(pool, { conditions, owner });
    apps.push(composed);
    const token = await c3AccessToken({
      tenantId: tenant.tenantId,
      userId: tenant.playerA.userId,
      sessionId: tenant.playerA.sessionId,
    });

    const response = await composed.app.inject({
      method: 'POST',
      url: `/user/api/v1/${tenant.tenantKey}/games/${game.gameId}/join`,
      headers: c3Headers({ token, idempotencyKey: c3IdempotencyKey(input.label) }),
      payload: {
        expectedRevision: game.revision,
        subscriptionInstanceId,
        priceConsent: { amountMinor: SYNTHETIC_BASE_PRICE_MINOR, currency: 'RUB' },
      },
    });
    return { tenant, gameId: game.gameId, conditions, owner, response };
  }

  /** Shared fail-closed evidence: a refused conditions decision must not reserve/charge anything. */
  async function expectNoCommercialEffect(input: {
    readonly tenant: SyntheticTenant;
    readonly gameId: string;
    readonly conditions: ReturnType<typeof createConditionsDouble>;
    readonly owner: ReturnType<typeof createOwnerDouble>;
  }): Promise<void> {
    const saved = await readSavedState(pool, {
      tenantId: input.tenant.tenantId,
      gameId: input.gameId,
    });
    expect(saved.participations).toBe(0);
    expect(saved.reservations).toBe(0);
    expect(saved.activeReservations).toBe(0);
    expect(saved.paymentSnapshots).toBe(0);
    expect(saved.paymentEvidence).toBe(0);
    expect(saved.commandRows).toBe(0);
    expect(saved.outboxEvents).toBe(0);
    expect(await readAuditSuccessCount(pool, input.tenant.tenantId)).toBe(0);
    // The server consulted the owner conditions before deciding; the refusal is a rule decision.
    expect(input.conditions.calls.readPreview).toBe(1);
    expect(input.conditions.calls.resolveSelection).toBe(2);
    // No external commercial executor was asked to book or charge anything.
    expect(input.owner.calls.execute).toBe(0);
    expect(input.owner.calls.read).toBe(0);
  }

  it('B4-LK2a: service-forbidden conditions must surface GAME_SERVICE_BLOCKED, not the payment guard', async () => {
    const { tenant, gameId, conditions, owner, response } = await scenario({
      label: 'b4-lk2a',
      reasonCode: 'SERVICE_BLOCKED',
    });

    // The refusal itself is fail-closed and produces no commercial effect.
    expect(response.statusCode).toBe(409);
    await expectNoCommercialEffect({ tenant, gameId, conditions, owner });

    // HANDOFF-C1 §2.4/§3: "the service itself is forbidden" has its own stable code so the client is
    // not told to pay/see the payment guard. Expected: GAME_SERVICE_BLOCKED (409).
    //
    // KNOWN DEFECT (P1, minimal failing assertion): at the pinned candidate
    // apps/api/src/games/game-commercial-join.ts:396-400 maps every non-AVAILABLE conditions
    // decision (including a service prohibition) to GAME_PAYMENT_REQUIRED. Observed below.
    const observedCode = response.json().code as string;
    expect(observedCode).toBe('GAME_SERVICE_BLOCKED');
  });

  it('B4-LK2b: benefit-only refusal (DAILY_USAGE_LIMIT_REACHED) is not conflated with GAME_SERVICE_BLOCKED — NEEDS_PRODUCT_RULE: no approved reasonCode→LK2 code mapping', async () => {
    // NEEDS_PRODUCT_RULE: the LK1 preview reasonCode vocabulary is not mapped to LK2 error codes in
    // an approved source, so this case does not invent a specific code for DAILY_USAGE_LIMIT_REACHED.
    // It only requires that a benefit-only refusal stays fail-closed and is NOT reported as the
    // service prohibition.
    const { tenant, gameId, conditions, owner, response } = await scenario({
      label: 'b4-lk2b',
      reasonCode: 'DAILY_USAGE_LIMIT_REACHED',
    });

    expect(response.statusCode).toBe(409);
    await expectNoCommercialEffect({ tenant, gameId, conditions, owner });

    const observedCode = response.json().code as string;
    expect(observedCode).not.toBe('GAME_SERVICE_BLOCKED');
    expect(BENEFIT_REFUSAL_CODES).toContain(observedCode);
  });
});
