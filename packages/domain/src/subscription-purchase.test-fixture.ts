import {
  mpVersion,
  mpOfferId,
  mpHash,
  mpOperationId,
  type MonthlyOwnerQuote,
  type MonthlyOwnerReceipt,
} from './subscription-purchase.js';
export const monthlyUid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const monthlyKey = 'fixture-original-key';
export const monthlyActor = {
  tenantId: monthlyUid(1),
  tenantKey: 'iSkq6G',
  userId: monthlyUid(2),
  sessionId: monthlyUid(3),
  correlationId: 'fixture-correlation',
};
export const monthlyIdentity = {
  providerClientId: 'fixture-client',
  providerMappingId: monthlyUid(5),
};
export const monthlyQuote = (): MonthlyOwnerQuote => ({
  contract: mpVersion,
  offerId: mpOfferId,
  revision: mpHash('fixture-quote'),
  amountMinor: 980000,
  currency: 'RUB',
  inventoryId: 'fixture-inventory',
  productId: 'fixture-product',
  operationId: mpOperationId(monthlyActor.tenantId, monthlyActor.userId, mpHash(monthlyKey)),
});
export const monthlyReceipt = (): MonthlyOwnerReceipt => ({
  contract: mpVersion,
  operationId: monthlyQuote().operationId,
  offerId: mpOfferId,
  state: 'PAYMENT_PENDING',
  amountMinor: 980000,
  currency: 'RUB',
  paymentUrl: 'https://bank.example.com/pay',
  paymentExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  providerTransactionId: 'fixture-transaction',
  providerSubscriptionId: null,
});
export const monthlyConsent = () => ({
  offerId: mpOfferId,
  expectedRevision: monthlyQuote().revision,
  amountMinor: 980000,
  currency: 'RUB' as const,
});
