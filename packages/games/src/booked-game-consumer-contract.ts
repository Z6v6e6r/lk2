import { z } from 'zod';

// P2 consumer proposal for the existing open doubles/subscription scenario.
// No HTTP endpoint, provider writer, price rule or activation is implemented here.
// All SUCCEEDED inputs stay disabled until the real resolver and finance authority exist.
export const bookedGameQuoteSchema = z
  .object({
    quoteId: z.uuid(),
    slotId: z.uuid(),
    stationId: z.uuid(),
    courtId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    revision: z.number().int().nonnegative(),
    kind: z.literal('FRIENDLY'),
    visibility: z.literal('PUBLIC'),
    capacity: z.literal(4),
    paymentMode: z.literal('SUBSCRIPTION'),
    subscriptionId: z.uuid(),
    visits: z.number().int().positive(),
    baseAmountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
  .refine((quote) => Date.parse(quote.endsAt) > Date.parse(quote.startsAt));

// Caller selects a server-issued quote; it cannot supply identity, price or provider IDs.
export const bookedGameIntentSchema = z
  .object({
    quoteId: z.uuid(),
    expectedQuoteRevision: z.number().int().nonnegative(),
  })
  .strict();

const uuid = z.uuid();
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Date.parse compares milliseconds; reject finer readback precision instead of truncating it.
const dateTime = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{4,}(?:Z|[+-]\d{2}:\d{2})$/.test(value));
const revision = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

// Integration verifies full private mapping rows. Games reads only these safe references.
const mappingSchema = z.object({ tenantId: uuid, id: uuid, revision, internalId: uuid }).strict();
const bindingSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    operationId: uuid,
    gameId: uuid,
    quoteId: uuid,
    quoteRevision: z.number().int().nonnegative(),
    slotId: uuid,
    slotVersion: revision,
    subscriptionInstanceId: uuid,
    visits: z.number().int().positive(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal('RUB'),
    keySha256: hash,
    intentSha256: hash,
    requestSha256: hash,
    bindingSha256: hash,
    mappingBindingSha256: hash,
    mappings: z
      .object({ actor: mappingSchema, subscription: mappingSchema, slot: mappingSchema })
      .strict(),
  })
  .strict();
const receiptSchema = z.object({ receiptRef: uuid, bindingSha256: hash, asOf: dateTime }).strict();
const attemptSchema = z
  .object({
    id: uuid.nullable(),
    state: z.enum(['NOT_ATTEMPTED', 'CLAIMED', 'DISPATCH_STARTED', 'RESOLVED', 'UNKNOWN']),
  })
  .strict()
  .refine((attempt) => (attempt.state === 'NOT_ATTEMPTED') === (attempt.id === null));

const bookingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['NONE', 'UNKNOWN', 'PENDING_CONFIRMATION', 'FAILED']) }).strict(),
  z
    .object({
      status: z.literal('CONFIRMED'),
      bookingId: uuid,
      gameId: uuid,
      slotId: uuid,
      quoteId: uuid,
      confirmedAt: dateTime,
      receipt: receiptSchema,
    })
    .strict(),
]);
const benefitSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['UNKNOWN', 'RESERVED', 'REJECTED']) }).strict(),
  z
    .object({
      status: z.literal('APPLIED'),
      count: z.number().int().positive(),
      subscriptionOperationId: uuid,
      receipt: receiptSchema,
    })
    .strict(),
]);
const settlementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['UNKNOWN', 'REJECTED']) }).strict(),
  z
    .object({
      status: z.enum(['CONFIRMED', 'PAYMENT_REQUIRED']),
      amountMinor: z.number().int().nonnegative(),
      debtMinor: z.number().int().nonnegative(),
      currency: z.literal('RUB'),
      receipt: receiptSchema,
    })
    .strict(),
]);

// Optional evidence preserves the existing C1 non-final projection. Absence is unknown,
// never an implicit confirmation. Receipt labels/hashes are claims, not verified authority.
export const bookedGameOperationSchema = z
  .object({
    operationId: uuid,
    revision: z.number().int().nonnegative(),
    status: z.enum(['ACCEPTED', 'PROCESSING', 'SUCCEEDED', 'FAILED']),
    gameId: uuid.nullable(),
    booking: bookingSchema,
    benefit: benefitSchema.optional(),
    settlement: settlementSchema.optional(),
    binding: bindingSchema.optional(),
    attempt: attemptSchema.optional(),
    asOf: dateTime.optional(),
    errorCode: z.enum(['SLOT_CONFLICT', 'QUOTE_EXPIRED', 'SUBSCRIPTION_REJECTED']).nullable(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (operation.status === 'SUCCEEDED') {
      reject(
        'CREATE success requires the unavailable authoritative resolver and finance acceptance',
      );
    }
    if (
      operation.status === 'FAILED' &&
      (!operation.errorCode ||
        operation.booking.status !== 'NONE' ||
        (!operation.binding && operation.gameId !== null) ||
        (operation.attempt && operation.attempt.state !== 'NOT_ATTEMPTED') ||
        (operation.benefit && !['UNKNOWN', 'REJECTED'].includes(operation.benefit.status)) ||
        (operation.settlement && !['UNKNOWN', 'REJECTED'].includes(operation.settlement.status)))
    ) {
      reject('Failure must prove no attempted booking, benefit or obligation');
    }
    if (operation.status !== 'FAILED' && operation.errorCode !== null) {
      reject('A pending operation cannot prove rejection');
    }
    const bound = operation.binding;
    if (bound) {
      if (
        bound.operationId !== operation.operationId ||
        bound.gameId !== operation.gameId ||
        Object.values(bound.mappings).some((mapping) => mapping.tenantId !== bound.tenantId) ||
        bound.mappings.actor.internalId !== bound.actorUserId ||
        bound.mappings.subscription.internalId !== bound.subscriptionInstanceId ||
        bound.mappings.slot.internalId !== bound.slotId
      ) {
        reject('Canonical operation/game/tenant/mapping binding mismatch');
      }
      if (!operation.attempt || !operation.asOf) {
        reject('Bound readback requires the original attempt and owner asOf');
      }
    }
    const receipts = [
      operation.booking.status === 'CONFIRMED' ? operation.booking.receipt : undefined,
      operation.benefit?.status === 'APPLIED' ? operation.benefit.receipt : undefined,
      operation.settlement && 'receipt' in operation.settlement
        ? operation.settlement.receipt
        : undefined,
    ].filter((receipt) => receipt !== undefined);
    if (receipts.length) {
      if (
        !bound ||
        !operation.asOf ||
        !operation.attempt ||
        operation.attempt.state === 'NOT_ATTEMPTED'
      ) {
        reject('Partial proof requires a bound attempted operation');
      } else {
        for (const receipt of receipts) {
          if (
            receipt.bindingSha256 !== bound.bindingSha256 ||
            Date.parse(receipt.asOf) > Date.parse(operation.asOf)
          ) {
            reject('Receipt binding or owner timestamp mismatch');
          }
        }
      }
      if (operation.status !== 'PROCESSING') reject('Partial proof remains PROCESSING');
    }
    if (operation.booking.status === 'CONFIRMED') {
      const booking = operation.booking;
      if (
        !bound ||
        booking.gameId !== bound.gameId ||
        booking.quoteId !== bound.quoteId ||
        booking.slotId !== bound.slotId ||
        (operation.asOf && Date.parse(booking.confirmedAt) > Date.parse(operation.asOf))
      ) {
        reject('Booking must match the canonical game, quote, slot and owner timestamp');
      }
    }
    if (operation.benefit?.status === 'APPLIED' && operation.benefit.count !== bound?.visits) {
      reject('Benefit count must match the accepted binding');
    }
    if (operation.settlement && 'receipt' in operation.settlement) {
      const settlement = operation.settlement;
      if (
        settlement.amountMinor !== bound?.amountMinor ||
        settlement.debtMinor > settlement.amountMinor ||
        (settlement.status === 'CONFIRMED' ? settlement.debtMinor !== 0 : settlement.debtMinor <= 0)
      ) {
        reject('Settlement claim must preserve accepted amount and outstanding debt');
      }
    }
  });

// Compare only with the original trusted association supplied by the owning resolver.
// This pure parser neither loads rows nor grants authority, rebinds, writes or dispatches.
export function parseBookedGameNonFinalOperation(
  value: unknown,
  expected: { readonly operationId: string; readonly binding?: z.input<typeof bindingSchema> },
): z.output<typeof bookedGameOperationSchema> {
  const operation = bookedGameOperationSchema.parse(value);
  if (operation.operationId !== uuid.parse(expected.operationId)) {
    throw new Error('CREATE_OPERATION_BINDING_CONFLICT');
  }
  if (operation.binding || expected.binding) {
    const original = bindingSchema.parse(expected.binding);
    if (JSON.stringify(operation.binding) !== JSON.stringify(original)) {
      throw new Error('CREATE_ORIGINAL_BINDING_CONFLICT');
    }
  }
  return operation;
}

export function hasConfirmedBookedGame(
  value: unknown,
  expected: { readonly operationId: string; readonly quoteId: string; readonly slotId: string },
): boolean {
  // Kept for existing consumers; this increment deliberately enables no success path.
  void value;
  void expected;
  return false;
}
