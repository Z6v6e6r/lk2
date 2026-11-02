import type {
  SubscriptionPurchaseConsent,
  SubscriptionPurchaseQuote,
  SubscriptionPurchaseResult,
} from '@phub/api-contracts';
import {
  MonthlyPurchaseError,
  mpHash,
  mpStable,
  mpOfferId,
  mpPaymentUrl,
  parsePurchaseConsent,
  type MonthlyMode,
} from '@phub/domain/subscription-purchase';
import type {
  MonthlyActor,
  MonthlyAttempt,
  MonthlyScope,
  MonthlyPurchaseRepository,
} from '@phub/database/subscription-purchase';
import type { MonthlyPurchaseOwnerClient } from '@phub/subscription-runtime-adapter';
import type { SubscriptionRuntimeActorDelegationIssuer } from './subscription-runtime-actor-delegation-issuer.js';
export function createMonthlyPurchaseRuntime(o: {
  enabled: boolean;
  repository: MonthlyPurchaseRepository;
  issuer?: Pick<SubscriptionRuntimeActorDelegationIssuer, 'issueMonthlyPurchase'>;
  client?: Pick<MonthlyPurchaseOwnerClient, 'quote' | 'purchase' | 'read'>;
  token?: (a: MonthlyActor) => Promise<{ token: string; expiresAt: string }>;
}) {
  const repo = o.repository;
  const gate = async () => {
    if (!o.enabled || !o.issuer || !o.client || !o.token || !(await repo.ready()))
      throw new MonthlyPurchaseError();
  };
  const scope = (a: MonthlyActor, key: string): MonthlyScope => {
    if (!/^[A-Za-z0-9._:-]{16,128}$(?![\s\S])/.test(key))
      throw new MonthlyPurchaseError('INVALID_REQUEST', 400);
    return { tenantId: a.tenantId, userId: a.userId, keySha256: mpHash(key) };
  };
  const freshIdentity = async (a: MonthlyActor, attempt: MonthlyAttempt) => {
    const current = await repo.identity(a);
    if (!current || mpStable(current) !== mpStable(attempt.identity))
      throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_IDENTITY_CHANGED', 409);
    return current;
  };
  const envelope = async (
    a: MonthlyActor,
    s: MonthlyScope,
    attempt: MonthlyAttempt,
    mode: MonthlyMode,
    consent?: SubscriptionPurchaseConsent,
  ) => {
    const identity = await freshIdentity(a, attempt),
      actorToken = await o.token!(a);
    await freshIdentity(a, attempt);
    return {
      operationId: attempt.id,
      correlationId: a.correlationId,
      actorToken,
      actorDelegation: await o.issuer!.issueMonthlyPurchase({
        ...a,
        ...identity,
        keySha256: s.keySha256,
        operationId: attempt.id,
        mode,
        actorToken,
        ...(consent ? { consent } : {}),
      }),
    };
  };
  const view = async (
    a: MonthlyActor,
    s: MonthlyScope,
    attempt: MonthlyAttempt,
  ): Promise<SubscriptionPurchaseResult> => {
    await freshIdentity(a, attempt);
    const receipt = attempt.receipt;
    return {
      contractVersion: 1,
      operationId: attempt.id,
      keySha256: s.keySha256,
      offerId: mpOfferId,
      status: attempt.state === 'DISPATCH_STARTED' ? 'UNKNOWN' : attempt.state,
      amountMinor: attempt.quote?.amountMinor ?? null,
      currency: 'RUB',
      canOpenPayment:
        o.enabled &&
        attempt.state === 'PAYMENT_PENDING' &&
        !!receipt &&
        mpPaymentUrl(receipt.paymentUrl) &&
        !!receipt.paymentExpiresAt &&
        Date.parse(receipt.paymentExpiresAt) > Date.now() + 1000,
      paymentExpiresAt: receipt?.paymentExpiresAt ?? null,
    };
  };
  return {
    async capability() {
      try {
        await gate();
        return {
          contractVersion: 1 as const,
          available: true,
          offers: [{ id: mpOfferId, title: 'Абонемент «Дружба»' }],
        };
      } catch {
        return { contractVersion: 1 as const, available: false, offers: [] };
      }
    },
    async quote(a: MonthlyActor, key: string): Promise<SubscriptionPurchaseQuote> {
      await gate();
      const s = scope(a, key);
      let attempt = await repo.begin(a, s);
      if (
        attempt.state === 'QUOTED' &&
        attempt.quoteExpiresAt &&
        Date.parse(attempt.quoteExpiresAt) <= Date.now()
      )
        attempt = await repo.restartExpiredQuote(a, s);
      if (attempt.state === 'QUOTING') {
        const quote = await o.client!.quote(await envelope(a, s, attempt, 'quote'));
        attempt = await repo.saveQuote(a, s, quote);
      }
      if (attempt.state !== 'QUOTED' || !attempt.quote || !attempt.quoteExpiresAt)
        throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_ALREADY_STARTED', 409);
      if (Date.parse(attempt.quoteExpiresAt) <= Date.now())
        throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_QUOTE_EXPIRED', 409);
      await freshIdentity(a, attempt);
      return {
        contractVersion: 1,
        operationId: attempt.id,
        keySha256: s.keySha256,
        offerId: mpOfferId,
        title: 'Абонемент «Дружба»',
        revision: attempt.quote.revision,
        amountMinor: attempt.quote.amountMinor,
        currency: 'RUB',
        expiresAt: attempt.quoteExpiresAt,
      };
    },
    async read(a: MonthlyActor, key: string) {
      if (!(await repo.ready())) throw new MonthlyPurchaseError();
      const s = scope(a, key),
        attempt = await repo.read(a, s);
      return attempt ? view(a, s, attempt) : null;
    },
    async purchase(a: MonthlyActor, key: string, input: SubscriptionPurchaseConsent) {
      await gate();
      const consent = parsePurchaseConsent(input),
        s = scope(a, key),
        original = await repo.read(a, s);
      if (!original?.quote)
        throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_QUOTE_REQUIRED', 409);
      if (original.state !== 'QUOTED') {
        if (!original.consent || mpStable(original.consent) !== mpStable(consent))
          throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_KEY_CONFLICT', 409);
        return view(a, s, original);
      }
      const e = await envelope(a, s, original, 'purchase', consent),
        claimed = await repo.claimDispatch(a, s, consent);
      let attempt = claimed.attempt;
      if (claimed.claimed) {
        try {
          await freshIdentity(a, claimed.attempt);
          const receipt = await o.client!.purchase(e, consent, original.quote);
          attempt = await repo.saveReceipt(a, s, receipt);
        } catch {
          attempt = (await repo.markUnknown(a, s)) ?? attempt;
        }
      }
      return view(a, s, attempt);
    },
    async reconcile(a: MonthlyActor, key: string, operationId: string) {
      await gate();
      const s = scope(a, key),
        original = await repo.read(a, s);
      if (!original || original.id !== operationId)
        throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_NOT_FOUND', 404);
      if (!original.quote || !original.consent) return view(a, s, original);
      let attempt = original;
      try {
        const e = await envelope(a, s, original, 'reconcile'),
          receipt = await o.client!.read(e, original.quote, true);
        attempt = await repo.saveReceipt(a, s, receipt);
      } catch {
        /* Ambiguous read/reconcile never becomes another creation or releases the slot. */
      }
      return view(a, s, attempt);
    },
    async launch(a: MonthlyActor, key: string, operationId: string) {
      await gate();
      const s = scope(a, key),
        original = await repo.read(a, s);
      if (!original || original.id !== operationId)
        throw new MonthlyPurchaseError('SUBSCRIPTION_PURCHASE_NOT_FOUND', 404);
      return repo.createLaunch(a, s);
    },
    async consumeLaunch(operationId: string, code: string) {
      await gate();
      return repo.consumeLaunch(operationId, code);
    },
  };
}
export type MonthlyPurchaseRuntime = ReturnType<typeof createMonthlyPurchaseRuntime>;
