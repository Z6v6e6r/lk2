import { describe, expect, it } from 'vitest';

import {
  BookedOperationV3ContractError,
  parseBookedOperationV3AdmissionRequest,
  parseBookedOperationV3CancelRequest,
  parseBookedOperationV3CancelResult,
  parseBookedOperationV3PreflightRequest,
  parseBookedOperationV3PreflightResult,
  parseBookedOperationV3ReadOutcome,
} from './booked-operation-v3.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = { kind: 'GAME' as const, id: id(1), expectedRevision: 7 };
const preflight = {
  contractVersion: 3 as const,
  action: 'JOIN_GAME' as const,
  target,
  paymentIntent: 'USE_SUBSCRIPTION' as const,
};
const quote = {
  quoteId: id(2),
  operationId: id(3),
  basis: 'SUBSCRIPTION' as const,
  durationMinutes: 120 as const,
  startsAt: '2027-01-10T09:00:00.000Z',
  endsAt: '2027-01-10T11:00:00.000Z',
  amountMinor: 90000,
  currency: 'RUB' as const,
  coveredMinutes: 60,
  surchargeMinor: 90000,
  expiresAt: '2027-01-10T08:55:00.000Z',
  policyVersion: 'policy-7',
  priceDigest: 'sha256:' + 'a'.repeat(64),
};
const settlement = {
  mode: 'SURCHARGE' as const,
  currency: 'RUB' as const,
  toPayMinor: 90000,
  checkoutUrl: 'https://padlhub.su/pay/abc',
  expiresAt: '2027-01-10T08:55:00.000Z',
  state: 'OPEN' as const,
};

describe('booked operation v3 contract', () => {
  it('accepts a 120-minute preflight and a surcharge settlement', () => {
    expect(parseBookedOperationV3PreflightRequest(preflight)).toEqual(preflight);
    expect(
      parseBookedOperationV3PreflightResult({
        contractVersion: 3,
        nonBinding: true,
        operationId: id(3),
        action: 'JOIN_GAME',
        target,
        quote,
        settlement,
        requestSha256: 'sha256:' + 'b'.repeat(64),
      }),
    ).toMatchObject({ operationId: id(3), quote: { durationMinutes: 120 }, settlement });
  });

  it('rejects unknown fields and an invalid revision', () => {
    expect(() => parseBookedOperationV3PreflightRequest({ ...preflight, extra: true })).toThrow(
      BookedOperationV3ContractError,
    );
    expect(() =>
      parseBookedOperationV3PreflightRequest({
        ...preflight,
        target: { ...target, expectedRevision: 0 },
      }),
    ).toThrow(BookedOperationV3ContractError);
  });

  it('requires the exact consent echo on admission', () => {
    expect(
      parseBookedOperationV3AdmissionRequest({
        ...preflight,
        quoteId: id(2),
        settlementConsent: {
          quoteId: id(2),
          amountMinor: 90000,
          currency: 'RUB',
          expiresAt: '2027-01-10T08:55:00.000Z',
        },
      }),
    ).toMatchObject({ settlementConsent: { amountMinor: 90000 } });
    expect(() =>
      parseBookedOperationV3AdmissionRequest({
        ...preflight,
        quoteId: id(2),
        settlementConsent: {
          quoteId: 'not-a-uuid',
          amountMinor: 90000,
          currency: 'RUB',
          expiresAt: '2027-01-10T08:55:00.000Z',
        },
      }),
    ).toThrow(BookedOperationV3ContractError);
  });

  it('keeps payment, booking and visit states separate on read', () => {
    expect(
      parseBookedOperationV3ReadOutcome({
        contractVersion: 3,
        operationId: id(3),
        quoteId: id(2),
        requestSha256: 'sha256:' + 'c'.repeat(64),
        status: 'PENDING',
        asOf: '2027-01-10T08:30:00.000Z',
        payment: {
          state: 'PAID',
          toPayMinor: 90000,
          paidMinor: 90000,
          checkoutUrl: 'https://padlhub.su/pay/abc',
        },
        booking: { state: 'PENDING' },
        visit: { state: 'CONSUMED', usageRef: 'usage-7' },
        reason: 'OWNER_PENDING',
        receipt: null,
      }),
    ).toMatchObject({
      payment: { state: 'PAID' },
      booking: { state: 'PENDING' },
      visit: { state: 'CONSUMED' },
    });
  });

  it('never accepts an http checkout or an open settlement without a deadline', () => {
    expect(() =>
      parseBookedOperationV3PreflightResult({
        contractVersion: 3,
        nonBinding: true,
        operationId: id(3),
        action: 'JOIN_GAME',
        target,
        quote,
        requestSha256: 'sha256:' + 'd'.repeat(64),
        settlement: { ...settlement, checkoutUrl: 'http://padlhub.su/pay/abc' },
      }),
    ).toThrow(BookedOperationV3ContractError);
    expect(() =>
      parseBookedOperationV3PreflightResult({
        contractVersion: 3,
        nonBinding: true,
        operationId: id(3),
        action: 'JOIN_GAME',
        target,
        quote,
        requestSha256: 'sha256:' + 'd'.repeat(64),
        settlement: { ...settlement, expiresAt: null },
      }),
    ).toThrow(BookedOperationV3ContractError);
  });

  it('requires a bound receipt for CONFIRMED and rejects a missing one', () => {
    const outcome = {
      contractVersion: 3,
      operationId: id(3),
      quoteId: id(2),
      requestSha256: 'sha256:' + 'e'.repeat(64),
      status: 'CONFIRMED' as const,
      asOf: '2027-01-10T08:40:00.000Z',
      payment: { state: 'PAID' as const, toPayMinor: 90000, paidMinor: 90000, checkoutUrl: null },
      booking: { state: 'CONFIRMED' as const, bookingRef: 'booking-7' },
      visit: { state: 'CONSUMED' as const, usageRef: 'usage-7' },
      reason: 'OWNER_BOOKING_CONFIRMED',
      receipt: {
        receiptId: 'receipt-7',
        confirmedAt: '2027-01-10T08:40:00.000Z',
        bookingRef: 'booking-7',
        usageRef: 'usage-7',
        appliedRule: 'rule-7',
        priceCharged: { amountMinor: 90000, currency: 'RUB' as const },
        provider: 'VIVA' as const,
      },
    };
    expect(parseBookedOperationV3ReadOutcome(outcome)).toMatchObject({
      status: 'CONFIRMED',
      receipt: { receiptId: 'receipt-7', priceCharged: { amountMinor: 90000 } },
    });
    expect(() => parseBookedOperationV3ReadOutcome({ ...outcome, receipt: null })).toThrow(
      BookedOperationV3ContractError,
    );
  });

  it('rejects a cancel result that claims release facts before CLOSED', () => {
    expect(() =>
      parseBookedOperationV3CancelResult({
        contractVersion: 3,
        operationId: id(3),
        status: 'CLOSING',
        cancelled: false,
        limitReleased: true,
        visitReturned: false,
      }),
    ).toThrow(BookedOperationV3ContractError);
    expect(() =>
      parseBookedOperationV3CancelResult({
        contractVersion: 3,
        operationId: id(3),
        status: 'CLOSED',
        cancelled: false,
        limitReleased: true,
        visitReturned: false,
      }),
    ).toThrow(BookedOperationV3ContractError);
  });

  it('expresses idempotent cancel with independent release facts', () => {
    expect(
      parseBookedOperationV3CancelRequest({
        contractVersion: 3,
        operationId: id(3),
        reason: 'USER_CANCEL',
      }),
    ).toEqual({ contractVersion: 3, operationId: id(3), reason: 'USER_CANCEL' });
    expect(
      parseBookedOperationV3CancelResult({
        contractVersion: 3,
        operationId: id(3),
        status: 'CLOSED',
        cancelled: true,
        limitReleased: true,
        visitReturned: false,
      }),
    ).toMatchObject({ status: 'CLOSED', cancelled: true, limitReleased: true });
  });
});
