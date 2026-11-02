/** Public PadlHub identities only; provider facts stay in the private owner journal. */
export const MONTHLY_FRIENDSHIP_OFFER_ID = '862670f6-a476-4a18-aecb-9e27661fbad3';
export interface SubscriptionPurchaseConsent {
  offerId: string;
  expectedRevision: string;
  amountMinor: number;
  currency: 'RUB';
}
export interface SubscriptionPurchaseQuote {
  contractVersion: 1;
  operationId: string;
  keySha256: string;
  offerId: string;
  title: string;
  revision: string;
  amountMinor: number;
  currency: 'RUB';
  expiresAt: string;
}
export interface SubscriptionPurchaseResult {
  contractVersion: 1;
  operationId: string;
  keySha256: string;
  offerId: string;
  status: 'QUOTING' | 'QUOTED' | 'UNKNOWN' | 'PAYMENT_PENDING' | 'PAID';
  amountMinor: number | null;
  currency: 'RUB';
  canOpenPayment: boolean;
  paymentExpiresAt: string | null;
}
export interface SubscriptionPaymentLaunch {
  contractVersion: 1;
  operationId: string;
  launchCode: string;
  expiresAt: string;
}
