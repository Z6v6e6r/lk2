import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ManagedSubscriptionRuntimeQuoteClient } from './index.js';

/**
 * Cross-repository contract test: the CUP quote receiver must produce exactly the shape the LK2
 * client accepts. These fixtures mirror the receiver's two current outcomes: a typed technical
 * uncertainty (never a permission) and a settled entitlement. They are intentionally hard-coded so
 * a field rename on either side fails here instead of at an integration meeting.
 */
const BASE_URL = 'https://cup.example.test';
const TOKEN = 'l'.repeat(40);

function client(fetchImplementation: typeof fetch) {
  return new ManagedSubscriptionRuntimeQuoteClient({
    enabled: true,
    baseUrl: BASE_URL,
    integrationToken: TOKEN,
    timeoutMs: 500,
    environment: 'production',
    fetchImplementation,
  });
}

function envelope() {
  return {
    actorDelegation: 'aaa.bbb.ccc',
    correlationId: 'lk2-quote-correlation-1',
    idempotencyKey: 'idem-key-0001',
  };
}

const request = {
  action: 'JOIN_GAME' as const,
  target: { kind: 'GAME' as const, id: randomUUID(), expectedRevision: 7 },
  paymentIntent: 'AUTO_BEST_PRICE' as const,
};

function limits() {
  return {
    activeServices: null,
    activeServicesLimit: null,
    dailyUsed: null,
    dailyLimit: null,
    weeklyUsed: null,
    weeklyLimit: null,
    monthlyUsed: null,
    monthlyLimit: null,
    remainingUnits: null,
  };
}

function cited(at: string) {
  return {
    contractVersion: 1,
    nonBinding: true,
    requiresReservationRecheck: true,
    decisionId: randomUUID(),
    evaluatedAt: at,
    expiresAt: new Date(Date.parse(at) + 30_000).toISOString(),
  };
}

function technicalUncertainty() {
  return {
    ...cited('2026-10-21T08:00:00.000Z'),
    outcome: 'RETRY_LATER',
    paymentIntent: 'AUTO_BEST_PRICE',
    serviceAllowed: false,
    subscriptionBenefitAllowed: false,
    selectedSubscription: null,
    benefit: null,
    price: null,
    limits: limits(),
    blockers: [{ code: 'POLICY_UNAVAILABLE' }],
    warnings: [],
    alternatives: [],
  };
}

function entitlementApplied() {
  return {
    ...cited('2026-10-21T08:00:00.000Z'),
    outcome: 'ENTITLEMENT_APPLIED',
    paymentIntent: 'AUTO_BEST_PRICE',
    serviceAllowed: true,
    subscriptionBenefitAllowed: true,
    selectedSubscription: {
      subscriptionInstanceId: randomUUID(),
      policyVersion: 3,
      policyDigest: `sha256:${'a'.repeat(64)}`,
    },
    benefit: { kind: 'FREE_ENTITLEMENT', ruleId: 'benefit_join', usageUnits: 1 },
    price: {
      priceRevision: 7,
      basePriceMinor: 300_000,
      discountMinor: 300_000,
      surchargeMinor: 0,
      finalPriceMinor: 0,
      currency: 'RUB',
    },
    limits: {
      ...limits(),
      activeServices: 1,
      activeServicesLimit: 8,
      dailyUsed: 0,
      dailyLimit: 1,
    },
    blockers: [],
    warnings: [],
    alternatives: [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CUP quote receiver ↔ LK2 quote client contract', () => {
  it('accepts the receiver technical-uncertainty outcome without granting permission', async () => {
    const outcome = technicalUncertainty();
    const transport = vi.fn(() => Promise.resolve(jsonResponse(outcome)));
    await expect(client(transport).quote(request, envelope())).resolves.toEqual(outcome);
  });

  it('accepts a settled entitlement outcome with the published policy reference', async () => {
    const outcome = entitlementApplied();
    const transport = vi.fn(() => Promise.resolve(jsonResponse(outcome)));
    await expect(client(transport).quote(request, envelope())).resolves.toEqual(outcome);
  });

  it('rejects a receiver response that omits a required contract field', async () => {
    const broken = Object.fromEntries(
      Object.entries(technicalUncertainty()).filter(([key]) => key !== 'limits'),
    );
    const transport = vi.fn(() => Promise.resolve(jsonResponse(broken)));
    await expect(client(transport).quote(request, envelope())).rejects.toMatchObject({
      code: 'SUBSCRIPTION_RUNTIME_RESPONSE_INVALID',
    });
  });
});
