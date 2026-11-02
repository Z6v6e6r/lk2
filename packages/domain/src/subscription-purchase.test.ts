import { describe, it, expect } from 'vitest';
import {
  mpBody,
  mpRequestHash,
  mpHash,
  mpOperationId,
  parsePurchaseConsent,
  parseMonthlyOwnerQuote,
  parseMonthlyOwnerReceipt,
  mpPaymentUrl,
} from './subscription-purchase.js';
import {
  monthlyUid,
  monthlyQuote,
  monthlyReceipt,
  monthlyConsent,
} from './subscription-purchase.test-fixture.js';
describe('monthly purchase closed wire', () => {
  it('matches the LK65c8069e owner operation namespace and canonical request digest', () => {
    expect(mpHash('fixture-original-key')).toBe(
      'sha256:53566446f0e019193859a43c05a8187853af29c62eea472d84ca4621c6b548fb',
    );
    expect(mpOperationId(monthlyUid(1), monthlyUid(2), mpHash('fixture-original-key'))).toBe(
      '10e9f462-8e7e-88d0-aff8-d4348c4ea5d2',
    );
    expect(mpRequestHash('quote', mpBody('quote'))).toBe(
      'sha256:ba3c7d51ad28f24542f4efaafcdcececd6e61015ae0984d48dc2b9c2a868ecc0',
    );
  });
  it('rejects alternate products, ambiguous price units and extra identity/redirect fields', () => {
    for (const p of [
      { amountMinor: 9800.1 },
      { currency: 'EUR' },
      { offerId: monthlyUid(9) },
      { expectedRevision: 'foreign' },
      { clientId: 'fixture-client' },
      { successUrl: 'https://example.com' },
    ])
      expect(() => parsePurchaseConsent({ ...monthlyConsent(), ...p })).toThrow();
    expect(parseMonthlyOwnerQuote(monthlyQuote(), monthlyQuote().operationId)).toEqual(
      monthlyQuote(),
    );
  });
  it('cannot turn unknown/foreign/price-mismatched issuance into a paid receipt', () => {
    const q = monthlyQuote(),
      r = monthlyReceipt();
    expect(parseMonthlyOwnerReceipt(r, q)).toEqual(r);
    for (const p of [
      { operationId: monthlyUid(9) },
      { amountMinor: 1 },
      { state: 'PAID' },
      { state: 'PROVIDER_UNKNOWN' },
      { providerSubscriptionId: 'fixture-issued' },
      { extra: true },
    ])
      expect(() => parseMonthlyOwnerReceipt({ ...r, ...p }, q)).toThrow();
    expect(
      parseMonthlyOwnerReceipt(
        { ...r, state: 'PAID', paymentUrl: null, providerSubscriptionId: 'fixture-issued' },
        q,
      ).state,
    ).toBe('PAID');
  });
  it('bank navigation rejects protocols, local/IP names, credentials, ports and controls', () => {
    const userInfo = new URL('https://bank.example.com');
    userInfo.username = 'synthetic';
    userInfo.password = 'fixture';
    for (const u of [
      'http://bank.example.com',
      'javascript:alert(1)',
      'https://127.0.0.1/pay',
      'https://[::1]/pay',
      'https://localhost/pay',
      'https://bank.local/pay',
      userInfo.href,
      'https://bank.example.com:8443',
      'https://bank.example.com/#fragment',
      'https://bank.example.com/\n',
      'https://bank.example.com/\\evil',
    ])
      expect(mpPaymentUrl(u)).toBe(false);
    expect(mpPaymentUrl('https://bank.example.com/pay?order=fixture')).toBe(true);
  });
});

it('rejects absolute DNS names that hide local payment destinations', () => {
  expect(mpPaymentUrl('https://localhost./pay')).toBe(false);
  expect(mpPaymentUrl('https://bank.local./pay')).toBe(false);
});
