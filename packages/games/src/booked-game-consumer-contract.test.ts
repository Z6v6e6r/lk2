import { describe, expect, it } from 'vitest';

import {
  bookedGameIntentSchema,
  bookedGameOperationSchema,
  bookedGameQuoteSchema,
  hasConfirmedBookedGame,
} from './booked-game-consumer-contract.js';

const ids = {
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  quoteId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  slotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  gameId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  bookingId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  subscriptionOperationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

// Synthetic consumer fixture only; no real slot, tariff, entitlement or booking.
const confirmed = {
  operationId: ids.operationId,
  revision: 2,
  status: 'SUCCEEDED',
  gameId: ids.gameId,
  booking: {
    status: 'CONFIRMED',
    bookingId: ids.bookingId,
    gameId: ids.gameId,
    slotId: ids.slotId,
    quoteId: ids.quoteId,
    subscriptionOperationId: ids.subscriptionOperationId,
    settlementStatus: 'CONFIRMED',
    confirmedAt: '2027-01-01T12:00:00Z',
  },
  errorCode: null,
};

describe('P2 booked-game consumer proposal (BLOCKED on owner adapter)', () => {
  it('allows only a server quote, never caller identity, price or provider selection', () => {
    const intent = { quoteId: ids.quoteId, expectedQuoteRevision: 1 };
    expect(bookedGameIntentSchema.parse(intent)).toEqual(intent);
    for (const field of [
      'actorUserId',
      'clientPhone',
      'price',
      'subscriptionId',
      'provider',
      'roomId',
    ]) {
      expect(bookedGameIntentSchema.safeParse({ ...intent, [field]: 'untrusted' }).success).toBe(
        false,
      );
    }
    const quote = {
      quoteId: ids.quoteId,
      slotId: ids.slotId,
      stationId: ids.gameId,
      courtId: ids.bookingId,
      startsAt: '2027-01-02T12:00:00Z',
      endsAt: '2027-01-02T13:00:00Z',
      expiresAt: '2027-01-01T12:05:00Z',
      revision: 1,
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      capacity: 4,
      paymentMode: 'SUBSCRIPTION',
      subscriptionId: ids.subscriptionOperationId,
      visits: 1,
      baseAmountMinor: 12345,
      currency: 'RUB',
    };
    expect(bookedGameQuoteSchema.safeParse(quote).success).toBe(true);
    expect(bookedGameQuoteSchema.safeParse({ ...quote, endsAt: quote.startsAt }).success).toBe(
      false,
    );
  });

  it('requires confirmed booking and settlement bound to the exact operation, slot, quote and game', () => {
    expect(hasConfirmedBookedGame(confirmed, ids)).toBe(true);
    for (const field of ['operationId', 'quoteId', 'slotId'] as const) {
      expect(hasConfirmedBookedGame(confirmed, { ...ids, [field]: ids.gameId })).toBe(false);
    }
    for (const booking of [
      { status: 'PENDING_CONFIRMATION' },
      { status: 'NONE' },
      { ...confirmed.booking, settlementStatus: 'PENDING_CONFIRMATION' },
      { ...confirmed.booking, gameId: ids.slotId },
      { ...confirmed.booking, bookingId: 'viva-booking-private' },
      { ...confirmed.booking, providerId: 'private' },
    ]) {
      expect(hasConfirmedBookedGame({ ...confirmed, booking }, ids)).toBe(false);
    }
  });

  it('retains PENDING_CONFIRMATION after lost provider response and never equates gameId with booking', () => {
    const pending = {
      ...confirmed,
      status: 'PROCESSING',
      booking: { status: 'PENDING_CONFIRMATION' },
    };
    expect(bookedGameOperationSchema.safeParse(pending).success).toBe(true);
    expect(hasConfirmedBookedGame(pending, ids)).toBe(false);
    expect(hasConfirmedBookedGame(null, ids)).toBe(false);
    expect(hasConfirmedBookedGame({ ...confirmed, booking: null }, ids)).toBe(false);
    // Re-reading the same operation after authoritative reconciliation can prove success.
    expect(hasConfirmedBookedGame(confirmed, ids)).toBe(true);
  });

  it('accepts a definitive slot conflict only without a pending or confirmed booking', () => {
    const conflict = {
      ...confirmed,
      status: 'FAILED',
      booking: { status: 'NONE' },
      errorCode: 'SLOT_CONFLICT',
    };
    expect(bookedGameOperationSchema.safeParse(conflict).success).toBe(true);
    expect(hasConfirmedBookedGame(conflict, ids)).toBe(false);
    for (const booking of [confirmed.booking, { status: 'PENDING_CONFIRMATION' }]) {
      expect(bookedGameOperationSchema.safeParse({ ...conflict, booking }).success).toBe(false);
    }
  });

  it.fails(
    'BLOCKED: current beta GameCommandResult cannot satisfy confirmed-booking consumer acceptance',
    () => {
      const currentBetaResponse = {
        commandId: ids.operationId,
        operation: {
          id: ids.operationId,
          type: 'CREATE_GAME',
          status: 'SUCCEEDED',
          gameId: ids.gameId,
          aggregateRevision: 1,
          createdAt: '2027-01-01T12:00:00Z',
          updatedAt: '2027-01-01T12:00:00Z',
          nextAction: { type: 'NONE' },
          error: null,
        },
        game: null,
        replayed: false,
      };
      expect(hasConfirmedBookedGame(currentBetaResponse, ids)).toBe(true);
    },
  );
});
