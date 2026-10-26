import { describe, expect, it } from 'vitest';

import {
  bookedGameIntentSchema,
  bookedGameOperationSchema,
  bookedGameQuoteSchema,
  hasConfirmedBookedGame,
  parseBookedGameNonFinalOperation,
} from './booked-game-consumer-contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (n: string) => `sha256:${n.repeat(64)}`;
const time = '2027-01-01T12:00:00Z';
const binding = {
  tenantId: id(1),
  actorUserId: id(2),
  operationId: id(3),
  gameId: id(4),
  quoteId: id(5),
  quoteRevision: 1,
  slotId: id(6),
  slotVersion: 'slot-v1',
  subscriptionInstanceId: id(7),
  visits: 1,
  amountMinor: 12345,
  currency: 'RUB' as const,
  keySha256: hash('a'),
  intentSha256: hash('b'),
  requestSha256: hash('c'),
  bindingSha256: hash('d'),
  mappingBindingSha256: hash('e'),
  mappings: {
    actor: { tenantId: id(1), id: id(8), revision: 'actor-v1', internalId: id(2) },
    subscription: { tenantId: id(1), id: id(9), revision: 'subscription-v1', internalId: id(7) },
    slot: { tenantId: id(1), id: id(10), revision: 'slot-map-v1', internalId: id(6) },
  },
};
const receipt = { receiptRef: id(11), bindingSha256: hash('d'), asOf: time };
const confirmedBooking = {
  status: 'CONFIRMED' as const,
  bookingId: id(12),
  gameId: id(4),
  quoteId: id(5),
  slotId: id(6),
  confirmedAt: time,
  receipt,
};
const appliedBenefit = {
  status: 'APPLIED' as const,
  count: 1,
  subscriptionOperationId: id(13),
  receipt,
};
const confirmedSettlement = {
  status: 'CONFIRMED' as const,
  amountMinor: 12345,
  debtMinor: 0,
  currency: 'RUB' as const,
  receipt,
};
const expected = { operationId: id(3), quoteId: id(5), slotId: id(6) };
// Inert parser claims only. No fake owner/provider or successful receipt resolver exists.
const pending = () => ({
  operationId: id(3),
  revision: 2,
  status: 'PROCESSING',
  gameId: id(4),
  booking: { status: 'UNKNOWN' },
  benefit: { status: 'UNKNOWN' },
  settlement: { status: 'UNKNOWN' },
  binding: structuredClone(binding),
  attempt: { id: id(14), state: 'UNKNOWN' },
  asOf: time,
  errorCode: null,
});
const parse = (value: unknown) =>
  parseBookedGameNonFinalOperation(value, { operationId: id(3), binding });

describe('P2 non-final booked-game readback (success authority unavailable)', () => {
  it('preserves actual server quote/intent and rejects caller identity, price and provider selection', () => {
    const intent = { quoteId: id(5), expectedQuoteRevision: 1 };
    expect(bookedGameIntentSchema.parse(intent)).toEqual(intent);
    for (const field of [
      'actorUserId',
      'clientPhone',
      'price',
      'subscriptionId',
      'provider',
      'mappingBinding',
    ]) {
      expect(bookedGameIntentSchema.safeParse({ ...intent, [field]: 'untrusted' }).success).toBe(
        false,
      );
    }
    const quote = {
      quoteId: id(5),
      slotId: id(6),
      stationId: id(15),
      courtId: id(16),
      startsAt: '2027-01-02T12:00:00Z',
      endsAt: '2027-01-02T13:00:00Z',
      expiresAt: '2027-01-01T12:00:30Z',
      revision: 1,
      kind: 'FRIENDLY',
      visibility: 'PUBLIC',
      capacity: 4,
      paymentMode: 'SUBSCRIPTION',
      subscriptionId: id(7),
      visits: 1,
      baseAmountMinor: 12345,
      currency: 'RUB',
    };
    expect(bookedGameQuoteSchema.safeParse(quote).success).toBe(true);
    expect(bookedGameQuoteSchema.safeParse({ ...quote, endsAt: quote.startsAt }).success).toBe(
      false,
    );
  });

  it('preserves the existing C1 non-final projection without inventing independent proof', () => {
    const legacy = {
      operationId: id(3),
      revision: 1,
      status: 'PROCESSING',
      gameId: null,
      booking: { status: 'PENDING_CONFIRMATION' },
      errorCode: null,
    };
    const result = parseBookedGameNonFinalOperation(legacy, { operationId: id(3) });
    expect(result).toEqual(legacy);
    expect(result.benefit).toBeUndefined();
    expect(result.settlement).toBeUndefined();
    expect(hasConfirmedBookedGame(result, expected)).toBe(false);
    const rejected = {
      ...legacy,
      status: 'FAILED',
      booking: { status: 'NONE' },
      errorCode: 'SLOT_CONFLICT',
    };
    expect(bookedGameOperationSchema.safeParse(rejected).success).toBe(true);
  });

  it.each([
    [
      'booking confirmed, benefit unknown',
      { booking: confirmedBooking, settlement: confirmedSettlement },
    ],
    [
      'booking confirmed, settlement unknown',
      { booking: confirmedBooking, benefit: appliedBenefit },
    ],
    [
      'booking confirmed, obligation outstanding',
      {
        booking: confirmedBooking,
        benefit: appliedBenefit,
        settlement: { ...confirmedSettlement, status: 'PAYMENT_REQUIRED', debtMinor: 12345 },
      },
    ],
    [
      'benefit/settlement claimed, booking unknown',
      { benefit: appliedBenefit, settlement: confirmedSettlement },
    ],
    [
      'all three claims remain non-final',
      { booking: confirmedBooking, benefit: appliedBenefit, settlement: confirmedSettlement },
    ],
  ])('retains separate %s facts without success', (_name, facts) => {
    const input = { ...pending(), ...facts };
    const result = parse(input);
    expect(result).toEqual(input);
    expect(result.status).toBe('PROCESSING');
    expect(hasConfirmedBookedGame(result, expected)).toBe(false);
  });

  it('keeps repeated readback on the original operation without mutating the input', () => {
    const input = { ...pending(), booking: confirmedBooking };
    const before = JSON.stringify(input);
    expect(parse(input)).toEqual(parse(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(parse(input).operationId).toBe(id(3));
  });

  it('refuses terminal booking failure or a canonical game without pre-attempt association', () => {
    const legacy = {
      operationId: id(3),
      revision: 1,
      status: 'FAILED',
      gameId: null,
      booking: { status: 'NONE' },
      errorCode: 'SLOT_CONFLICT',
    };
    expect(parseBookedGameNonFinalOperation(legacy, { operationId: id(3) })).toEqual(legacy);
    for (const input of [
      { ...legacy, booking: { status: 'FAILED' } },
      { ...legacy, booking: { status: 'FAILED' }, gameId: id(4) },
      { ...legacy, gameId: id(4) },
    ]) {
      expect(bookedGameOperationSchema.safeParse(input).success).toBe(false);
      expect(() => parseBookedGameNonFinalOperation(input, { operationId: id(3) })).toThrow();
    }
    expect(
      bookedGameOperationSchema.safeParse({ ...pending(), booking: { status: 'FAILED' } }).success,
    ).toBe(true);
  });

  it('rejects every SUCCEEDED shape including the old fixture and all terminal labels', () => {
    const old = {
      operationId: id(3),
      revision: 2,
      status: 'SUCCEEDED',
      gameId: id(4),
      booking: {
        status: 'CONFIRMED',
        bookingId: id(12),
        gameId: id(4),
        slotId: id(6),
        quoteId: id(5),
        subscriptionOperationId: id(13),
        settlementStatus: 'CONFIRMED',
        confirmedAt: time,
      },
      errorCode: null,
    };
    for (const input of [
      old,
      { ...pending(), status: 'SUCCEEDED' },
      {
        ...pending(),
        status: 'SUCCEEDED',
        booking: confirmedBooking,
        benefit: appliedBenefit,
        settlement: confirmedSettlement,
      },
    ]) {
      expect(bookedGameOperationSchema.safeParse(input).success).toBe(false);
      expect(hasConfirmedBookedGame(input, expected)).toBe(false);
    }
  });

  it.each([
    'tenantId',
    'actorUserId',
    'operationId',
    'gameId',
    'quoteId',
    'slotId',
    'subscriptionInstanceId',
  ] as const)('rejects original canonical %s drift', (field) => {
    const input = pending();
    input.binding[field] = id(99);
    expect(() => parse(input)).toThrow();
  });

  it.each([
    'keySha256',
    'intentSha256',
    'requestSha256',
    'bindingSha256',
    'mappingBindingSha256',
  ] as const)('rejects original %s drift', (field) => {
    const input = pending();
    input.binding[field] = hash('f');
    expect(() => parse(input)).toThrow('CREATE_ORIGINAL_BINDING_CONFLICT');
    input.binding[field] = 'not-a-digest';
    expect(bookedGameOperationSchema.safeParse(input).success).toBe(false);
  });

  it.each(['actor', 'subscription', 'slot'] as const)(
    'rejects %s mapping tenant/id/revision/internal drift',
    (kind) => {
      for (const field of ['tenantId', 'id', 'revision', 'internalId'] as const) {
        const input = pending();
        input.binding.mappings[kind][field] = field === 'revision' ? 'changed-v2' : id(99);
        expect(() => parse(input)).toThrow();
      }
    },
  );

  it('requires original binding on both sides and matching quote/slot revision', () => {
    const input = pending();
    expect(() => parseBookedGameNonFinalOperation(input, { operationId: id(3) })).toThrow();
    const legacy = {
      operationId: id(3),
      revision: 1,
      status: 'PROCESSING',
      gameId: null,
      booking: { status: 'PENDING_CONFIRMATION' },
      errorCode: null,
    };
    expect(() => parse(legacy)).toThrow();
    expect(() => parseBookedGameNonFinalOperation(legacy, { operationId: id(99) })).toThrow(
      'CREATE_OPERATION_BINDING_CONFLICT',
    );
    for (const patch of [
      { quoteRevision: 2 },
      { slotVersion: 'slot-v2' },
      { visits: 2 },
      { amountMinor: 1 },
    ]) {
      expect(() => parse({ ...input, binding: { ...input.binding, ...patch } })).toThrow();
    }
  });

  it.each(['gameId', 'quoteId', 'slotId'] as const)(
    'rejects confirmed booking %s mismatch even while pending',
    (field) => {
      expect(
        bookedGameOperationSchema.safeParse({
          ...pending(),
          booking: { ...confirmedBooking, [field]: id(99) },
        }).success,
      ).toBe(false);
    },
  );

  it.each(['booking', 'benefit', 'settlement'] as const)(
    'rejects unbound, mismatched or future %s receipt',
    (leg) => {
      const facts = {
        booking: confirmedBooking,
        benefit: appliedBenefit,
        settlement: confirmedSettlement,
      };
      for (const proof of [
        { ...receipt, bindingSha256: hash('f') },
        { ...receipt, asOf: '2027-01-01T12:01:00Z' },
        { ...receipt, receiptRef: 'provider-private' },
      ]) {
        expect(
          bookedGameOperationSchema.safeParse({
            ...pending(),
            [leg]: { ...facts[leg], receipt: proof },
          }).success,
        ).toBe(false);
      }
      expect(
        bookedGameOperationSchema.safeParse({ ...pending(), binding: undefined, [leg]: facts[leg] })
          .success,
      ).toBe(false);
    },
  );

  it('rejects visit/amount/debt mismatch and zero-quote implicit confirmation', () => {
    expect(
      bookedGameOperationSchema.safeParse({
        ...pending(),
        benefit: { ...appliedBenefit, count: 2 },
      }).success,
    ).toBe(false);
    for (const patch of [
      { amountMinor: 1 },
      { debtMinor: 1 },
      { debtMinor: 12346 },
      { currency: 'USD' },
    ]) {
      expect(
        bookedGameOperationSchema.safeParse({
          ...pending(),
          settlement: { ...confirmedSettlement, ...patch },
        }).success,
      ).toBe(false);
    }
    expect(
      bookedGameOperationSchema.safeParse({
        ...pending(),
        settlement: { ...confirmedSettlement, status: 'PAYMENT_REQUIRED', debtMinor: 0 },
      }).success,
    ).toBe(false);
    const zero = { ...pending(), binding: { ...binding, amountMinor: 0 } };
    expect(bookedGameOperationSchema.parse(zero).settlement).toEqual({ status: 'UNKNOWN' });
    expect(hasConfirmedBookedGame(zero, expected)).toBe(false);
  });

  it('rejects ambiguous FAILED and partial evidence labeled ACCEPTED', () => {
    for (const state of ['CLAIMED', 'DISPATCH_STARTED', 'RESOLVED', 'UNKNOWN']) {
      expect(
        bookedGameOperationSchema.safeParse({
          ...pending(),
          status: 'FAILED',
          booking: { status: 'NONE' },
          errorCode: 'SLOT_CONFLICT',
          attempt: { id: id(14), state },
        }).success,
      ).toBe(false);
    }
    expect(
      bookedGameOperationSchema.safeParse({
        ...pending(),
        status: 'ACCEPTED',
        booking: confirmedBooking,
      }).success,
    ).toBe(false);
    expect(
      bookedGameOperationSchema.safeParse({
        ...pending(),
        status: 'PROCESSING',
        errorCode: 'QUOTE_EXPIRED',
      }).success,
    ).toBe(false);
    for (const facts of [
      { booking: confirmedBooking },
      { benefit: appliedBenefit },
      { settlement: confirmedSettlement },
      { benefit: { status: 'RESERVED' } },
    ]) {
      expect(
        bookedGameOperationSchema.safeParse({
          ...pending(),
          status: 'FAILED',
          booking: { status: 'NONE' },
          attempt: { id: null, state: 'NOT_ATTEMPTED' },
          errorCode: 'SLOT_CONFLICT',
          ...facts,
        }).success,
      ).toBe(false);
    }
  });

  it('requires coherent attempt and owner timestamps for bound readback', () => {
    for (const patch of [
      { attempt: undefined },
      { asOf: undefined },
      { attempt: { id: id(14), state: 'NOT_ATTEMPTED' } },
      { attempt: { id: null, state: 'UNKNOWN' } },
    ]) {
      expect(bookedGameOperationSchema.safeParse({ ...pending(), ...patch }).success).toBe(false);
    }
    expect(
      bookedGameOperationSchema.safeParse({
        ...pending(),
        booking: confirmedBooking,
        attempt: { id: null, state: 'NOT_ATTEMPTED' },
      }).success,
    ).toBe(false);
    expect(
      bookedGameOperationSchema.safeParse({
        ...pending(),
        booking: { ...confirmedBooking, confirmedAt: '2027-01-01T12:01:00Z' },
      }).success,
    ).toBe(false);
  });

  it('rejects raw provider/contact fields at each structured boundary', () => {
    for (const field of [
      'phone',
      'email',
      'providerId',
      'externalId',
      'paymentUrl',
      'token',
      'authorization',
    ]) {
      for (const input of [
        { ...pending(), [field]: 'private' },
        { ...pending(), binding: { ...binding, [field]: 'private' } },
        {
          ...pending(),
          binding: {
            ...binding,
            mappings: {
              ...binding.mappings,
              actor: { ...binding.mappings.actor, [field]: 'private' },
            },
          },
        },
        { ...pending(), booking: { ...confirmedBooking, [field]: 'private' } },
        {
          ...pending(),
          benefit: { ...appliedBenefit, receipt: { ...receipt, [field]: 'private' } },
        },
      ]) {
        expect(bookedGameOperationSchema.safeParse(input).success).toBe(false);
      }
    }
  });

  it('rejects sub-millisecond readback precision and compares accepted offset/millisecond boundaries', () => {
    for (const patch of [
      { asOf: '2027-01-01T12:00:00.0001Z' },
      {
        booking: {
          ...confirmedBooking,
          receipt: { ...receipt, asOf: '2027-01-01T12:00:00.0002Z' },
        },
      },
      { booking: { ...confirmedBooking, confirmedAt: '2027-01-01T15:00:00.0002+03:00' } },
    ]) {
      expect(
        bookedGameOperationSchema.safeParse({ ...pending(), booking: confirmedBooking, ...patch })
          .success,
      ).toBe(false);
    }
    const equivalent = {
      ...pending(),
      asOf: '2027-01-01T12:00:00.000Z',
      booking: {
        ...confirmedBooking,
        confirmedAt: '2027-01-01T15:00:00.000+03:00',
        receipt: { ...receipt, asOf: '2027-01-01T15:00:00.000+03:00' },
      },
    };
    expect(parse(equivalent)).toEqual(equivalent);
    expect(
      bookedGameOperationSchema.safeParse({
        ...equivalent,
        booking: {
          ...equivalent.booking,
          receipt: { ...receipt, asOf: '2027-01-01T12:00:00.001Z' },
        },
      }).success,
    ).toBe(false);
    expect(
      bookedGameOperationSchema.safeParse({
        ...equivalent,
        booking: { ...equivalent.booking, confirmedAt: '2027-01-01T12:00:00.001Z' },
      }).success,
    ).toBe(false);
  });

  it('refuses ordinary GameCommandResult as booked-game proof', () => {
    const current = {
      commandId: id(3),
      operation: {
        id: id(3),
        type: 'CREATE_GAME',
        status: 'SUCCEEDED',
        gameId: id(4),
        aggregateRevision: 1,
        nextAction: { type: 'NONE' },
        error: null,
      },
      game: null,
      replayed: false,
    };
    expect(bookedGameOperationSchema.safeParse(current).success).toBe(false);
    for (const value of [current, null, undefined, { gameId: id(4) }]) {
      expect(hasConfirmedBookedGame(value, expected)).toBe(false);
    }
  });
});
