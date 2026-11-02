import type { MonthlyActor, MonthlyScope } from '@phub/database/subscription-purchase';
import type { MonthlyOwnerReceipt } from '@phub/domain/subscription-purchase';
import { it, expect, vi } from 'vitest';
import { createMonthlyPurchaseRuntime } from './monthly-purchase-runtime.js';
import type { MonthlyAttempt } from '@phub/database/subscription-purchase';
import {
  monthlyActor,
  monthlyIdentity,
  monthlyKey,
  monthlyQuote,
  monthlyReceipt,
  monthlyConsent,
} from '../../../../packages/domain/src/subscription-purchase.test-fixture.js';
function fixture() {
  let active = true,
    attempt: MonthlyAttempt = {
      id: monthlyQuote().operationId,
      state: 'QUOTED',
      identity: monthlyIdentity,
      quote: monthlyQuote(),
      quoteExpiresAt: new Date(Date.now() + 120000).toISOString(),
      consent: null,
      receipt: null,
    };
  const repo = {
    ready: vi.fn(async () => await Promise.resolve(true)),
    identity: vi.fn(async () => await Promise.resolve(active ? monthlyIdentity : null)),
    read: vi.fn(async () => await Promise.resolve(structuredClone(attempt))),
    begin: vi.fn(async () => await Promise.resolve(structuredClone(attempt))),
    restartExpiredQuote: vi.fn(async () => {
      if (attempt.state === 'QUOTED' && Date.parse(attempt.quoteExpiresAt!) <= Date.now())
        attempt = { ...attempt, state: 'QUOTING', quote: null, quoteExpiresAt: null };
      return await Promise.resolve(structuredClone(attempt));
    }),
    saveQuote: vi.fn(async () => {
      if (attempt.state === 'QUOTING')
        attempt = {
          ...attempt,
          state: 'QUOTED',
          quote: monthlyQuote(),
          quoteExpiresAt: new Date(Date.now() + 120000).toISOString(),
        };
      return await Promise.resolve(structuredClone(attempt));
    }),
    claimDispatch: vi.fn(async () => {
      const claimed = attempt.state === 'QUOTED';
      if (claimed) attempt = { ...attempt, state: 'DISPATCH_STARTED', consent: monthlyConsent() };
      return await Promise.resolve({ attempt: structuredClone(attempt), claimed });
    }),
    saveReceipt: vi.fn(async (_a: MonthlyActor, _s: MonthlyScope, receipt: MonthlyOwnerReceipt) => {
      attempt = {
        ...attempt,
        receipt,
        state: receipt.state === 'PROVIDER_UNKNOWN' ? 'UNKNOWN' : receipt.state,
      };
      return await Promise.resolve(structuredClone(attempt));
    }),
    markUnknown: vi.fn(async () => {
      if (attempt.state === 'DISPATCH_STARTED') attempt = { ...attempt, state: 'UNKNOWN' };
      return await Promise.resolve(structuredClone(attempt));
    }),
    createLaunch: vi.fn(),
    consumeLaunch: vi.fn(),
  };
  const client = {
      quote: vi.fn(async () => await Promise.resolve(monthlyQuote())),
      purchase: vi.fn(async () => await Promise.resolve(monthlyReceipt())),
      read: vi.fn(async () => await Promise.resolve(monthlyReceipt())),
    },
    issuer = {
      issueMonthlyPurchase: vi.fn(async () => await Promise.resolve('fixture.header.signature')),
    },
    token = vi.fn(
      async () =>
        await Promise.resolve({
          token: 'fixture-actor-token-never-live',
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        }),
    );
  const runtime = createMonthlyPurchaseRuntime({
    enabled: true,
    repository: repo,
    client,
    issuer,
    token,
  });
  return {
    runtime,
    repo,
    client,
    token,
    revoke: () => {
      active = false;
    },
    stored: () => attempt,
    expireQuote: () => {
      attempt = { ...attempt, quoteExpiresAt: new Date(Date.now() - 1000).toISOString() };
    },
  };
}
it('concurrent calls preserve one local claim and one owner purchase', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent()),
    f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent()),
  ]);
  expect(f.client.purchase).toHaveBeenCalledTimes(1);
  expect(results.some((r) => r.status === 'PAYMENT_PENDING')).toBe(true);
  expect(JSON.stringify(results)).not.toMatch(
    /fixture-client|fixture-product|fixture-transaction|bank\.example/,
  );
});
it('ambiguous purchase is retained and retry/reconcile cannot invoke another creation', async () => {
  const f = fixture();
  f.client.purchase.mockRejectedValueOnce(Error('timeout'));
  expect((await f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent())).status).toBe(
    'UNKNOWN',
  );
  await f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent());
  expect(f.client.purchase).toHaveBeenCalledTimes(1);
  expect(
    (await f.runtime.reconcile(monthlyActor, monthlyKey, monthlyQuote().operationId)).status,
  ).toBe('PAYMENT_PENDING');
  expect(f.client.purchase).toHaveBeenCalledTimes(1);
});
it('logout during provider response retains receipt but denies exposure and launch', async () => {
  const f = fixture();
  f.client.purchase.mockImplementationOnce(async () => {
    f.revoke();
    return await Promise.resolve(monthlyReceipt());
  });
  await expect(
    f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent()),
  ).rejects.toMatchObject({ code: 'SUBSCRIPTION_PURCHASE_IDENTITY_CHANGED' });
  expect(f.repo.saveReceipt).toHaveBeenCalledTimes(1);
  expect(f.stored().state).toBe('PAYMENT_PENDING');
  expect(f.repo.createLaunch).not.toHaveBeenCalled();
});
it('token refresh identity drift prevents the local dispatch marker', async () => {
  const f = fixture();
  f.token.mockImplementationOnce(async () => {
    f.revoke();
    return await Promise.resolve({
      token: 'fixture-actor-token-never-live',
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
  });
  await expect(f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent())).rejects.toThrow();
  expect(f.repo.claimDispatch).not.toHaveBeenCalled();
  expect(f.client.purchase).not.toHaveBeenCalled();
});
it('status read never calls owner/provider and original-key conflict does not dispatch', async () => {
  const f = fixture();
  await f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent());
  await f.runtime.read(monthlyActor, monthlyKey);
  expect(f.client.read).not.toHaveBeenCalled();
  await expect(
    f.runtime.purchase(monthlyActor, monthlyKey, { ...monthlyConsent(), amountMinor: 1 }),
  ).rejects.toMatchObject({ code: 'SUBSCRIPTION_PURCHASE_KEY_CONFLICT' });
  expect(f.client.purchase).toHaveBeenCalledTimes(1);
});

it('revocation while the durable claim waits prevents the owner POST', async () => {
  const f = fixture(),
    claim = f.repo.claimDispatch.getMockImplementation()!;
  f.repo.claimDispatch.mockImplementation(async () => {
    const v = await claim();
    f.revoke();
    return v;
  });
  await expect(f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent())).rejects.toThrow();
  expect(f.client.purchase).not.toHaveBeenCalled();
  expect(f.stored().state).toBe('UNKNOWN');
});

it('expired undispatched intent refreshes the original quote without a purchase; unknown intent cannot reset', async () => {
  const f = fixture();
  f.expireQuote();
  const q = await f.runtime.quote(monthlyActor, monthlyKey);
  expect(q.operationId).toBe(monthlyQuote().operationId);
  expect(f.repo.restartExpiredQuote).toHaveBeenCalledTimes(1);
  expect(f.client.purchase).not.toHaveBeenCalled();
  f.client.purchase.mockRejectedValueOnce(new Error('Lost ACK'));
  await f.runtime.purchase(monthlyActor, monthlyKey, monthlyConsent());
  await expect(f.runtime.quote(monthlyActor, monthlyKey)).rejects.toThrow(
    'SUBSCRIPTION_PURCHASE_ALREADY_STARTED',
  );
  expect(f.stored().state).toBe('UNKNOWN');
  expect(f.repo.restartExpiredQuote).toHaveBeenCalledTimes(1);
});
