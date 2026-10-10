import { z } from 'zod';

// P2 consumer proposal for the existing open doubles/subscription scenario.
// No HTTP endpoint, provider writer, price rule or activation is implemented here.
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

const bookingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['NONE', 'PENDING_CONFIRMATION', 'FAILED']) }).strict(),
  z
    .object({
      status: z.literal('CONFIRMED'),
      bookingId: z.uuid(),
      gameId: z.uuid(),
      slotId: z.uuid(),
      quoteId: z.uuid(),
      subscriptionOperationId: z.uuid(),
      settlementStatus: z.literal('CONFIRMED'),
      confirmedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);

export const bookedGameOperationSchema = z
  .object({
    operationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    status: z.enum(['ACCEPTED', 'PROCESSING', 'SUCCEEDED', 'FAILED']),
    gameId: z.uuid().nullable(),
    booking: bookingSchema,
    errorCode: z.enum(['SLOT_CONFLICT', 'QUOTE_EXPIRED', 'SUBSCRIPTION_REJECTED']).nullable(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (
      operation.status === 'SUCCEEDED' &&
      (operation.booking.status !== 'CONFIRMED' ||
        operation.errorCode !== null ||
        operation.gameId !== operation.booking.gameId)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Confirmed booking and settlement are required' });
    }
    if (
      operation.status === 'FAILED' &&
      (!operation.errorCode || !['NONE', 'FAILED'].includes(operation.booking.status))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Failure must prove no booking or definitive rejection',
      });
    }
    if (operation.status !== 'FAILED' && operation.errorCode !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'A pending or successful operation cannot prove rejection',
      });
    }
  });

export function hasConfirmedBookedGame(
  value: unknown,
  expected: { readonly operationId: string; readonly quoteId: string; readonly slotId: string },
): boolean {
  const parsed = bookedGameOperationSchema.safeParse(value);
  if (!parsed.success) return false;
  const operation = parsed.data;
  return (
    operation.operationId === expected.operationId &&
    operation.status === 'SUCCEEDED' &&
    operation.booking.status === 'CONFIRMED' &&
    operation.booking.quoteId === expected.quoteId &&
    operation.booking.slotId === expected.slotId
  );
}
