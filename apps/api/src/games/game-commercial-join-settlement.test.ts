import { describe, expect, it, vi } from 'vitest';

import { createBookedOperationV3SettlementOwner } from './game-commercial-join-settlement.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = {
  tenantId: id(1),
  tenantKey: 'synthetic',
  userId: id(2),
  sessionId: id(3),
  gameId: id(4),
  expectedRevision: 8,
};
const settlement = {
  quoteId: id(10),
  amountMinor: 90000,
  toPayMinor: 90000,
  checkoutUrl: 'https://padlhub.su/pay/synthetic',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  requestSha256: 'sha256:' + 'a'.repeat(64),
};
const price = {
  amountMinor: 90000,
  currency: 'RUB' as const,
  basePriceMinor: 90000,
  freeMinutes: 60,
  paidMinutes: 60,
  evaluatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const quote = {
  quoteId: settlement.quoteId,
  operationId: id(20),
  basis: 'SUBSCRIPTION' as const,
  durationMinutes: 120 as const,
  startsAt: '2027-01-10T09:00:00.000Z',
  endsAt: '2027-01-10T11:00:00.000Z',
  amountMinor: 90000,
  currency: 'RUB' as const,
  coveredMinutes: 60,
  surchargeMinor: 90000,
  expiresAt: settlement.expiresAt,
  policyVersion: 'policy-7',
  priceDigest: 'sha256:' + 'b'.repeat(64),
};
const settlementResult = {
  mode: 'SURCHARGE' as const,
  currency: 'RUB' as const,
  toPayMinor: 90000,
  checkoutUrl: settlement.checkoutUrl,
  expiresAt: settlement.expiresAt,
  state: 'OPEN' as const,
};

function owner(overrides: { preflight?: unknown; admit?: unknown } = {}) {
  const issueBookedOperationV3 = vi.fn(() => Promise.resolve('delegation'));
  const preflight = vi.fn(
    () =>
      (overrides.preflight as never) ?? {
        contractVersion: 3 as const,
        nonBinding: true as const,
        operationId: id(20),
        action: 'JOIN_GAME' as const,
        target: { kind: 'GAME' as const, id: actor.gameId, expectedRevision: 8 },
        quote,
        settlement: settlementResult,
        requestSha256: settlement.requestSha256,
      },
  );
  const admit = vi.fn(
    () =>
      (overrides.admit as never) ?? {
        contractVersion: 3 as const,
        operationId: id(20),
        quoteId: quote.quoteId,
        requestSha256: 'sha256:' + 'c'.repeat(64),
        status: 'PENDING' as const,
        asOf: new Date().toISOString(),
        payment: {
          state: 'OPEN' as const,
          toPayMinor: 90000,
          paidMinor: 0,
          checkoutUrl: settlement.checkoutUrl,
        },
        booking: { state: 'PENDING' as const },
        visit: { state: 'CONSUMED' as const, usageRef: 'usage-7' },
        reason: 'OWNER_PENDING',
        receipt: null,
      },
  );
  return {
    issueBookedOperationV3,
    preflight,
    admit,
    owner: createBookedOperationV3SettlementOwner({
      client: { preflight, admit, read: vi.fn(), cancel: vi.fn() },
      issuer: { issueBookedOperationV3 },
      issueActorToken: () =>
        Promise.resolve({
          token: 'synthetic-token-1234567890',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      resolveActorContext: () =>
        Promise.resolve({
          providerClientId: 'viva-client-1',
          providerMappingId: id(30),
        }),
      resolveProviderClientSubscriptionId: () => Promise.resolve(id(31)),
    }),
  };
}

describe('v3 settlement owner adapter', () => {
  it('signs a preflight and returns the exact server settlement', async () => {
    const fixture = owner();
    await expect(
      fixture.owner.prepare({
        actor,
        subscriptionInstanceId: id(5),
        operationId: id(20),
        correlationId: 'corr-v3-settlement-0001',
        idempotencyKey: 'synthetic-key-0001',
        price,
      }),
    ).resolves.toEqual(settlement);
    expect(fixture.issueBookedOperationV3).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'preflight', operationId: id(20) }),
    );
  });

  it('refuses a quote that differs from the server price', async () => {
    const fixture = owner({
      preflight: {
        contractVersion: 3,
        nonBinding: true,
        operationId: id(20),
        action: 'JOIN_GAME',
        target: { kind: 'GAME', id: actor.gameId, expectedRevision: 8 },
        quote: { ...quote, amountMinor: 1 },
        settlement: settlementResult,
        requestSha256: settlement.requestSha256,
      },
    });
    await expect(
      fixture.owner.prepare({
        actor,
        subscriptionInstanceId: id(5),
        operationId: id(20),
        correlationId: 'corr-v3-settlement-0002',
        idempotencyKey: 'synthetic-key-0002',
        price,
      }),
    ).rejects.toThrow('COMMERCIAL_JOIN_V3_QUOTE_INVALID');
  });

  it('returns the owner checkout after admission without inventing a price', async () => {
    const fixture = owner();
    const prepared = await fixture.owner.prepare({
      actor,
      subscriptionInstanceId: id(5),
      operationId: id(20),
      correlationId: 'corr-v3-settlement-0003',
      idempotencyKey: 'synthetic-key-0003',
      price,
    });
    await expect(
      fixture.owner.execute({
        actor,
        operationId: id(20),
        correlationId: 'corr-v3-settlement-0003',
        idempotencyKey: 'synthetic-key-0003',
        subscriptionInstanceId: id(5),
        reservationId: id(40),
        settlement: prepared,
      }),
    ).resolves.toEqual({ status: 'PAYMENT_REQUIRED', settlement: prepared });
    expect(fixture.issueBookedOperationV3).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: 'admit',
        quoteId: prepared.quoteId,
        reservationId: id(40),
      }),
    );
  });
});
