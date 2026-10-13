import { z } from 'zod';

import {
  bookedGameOperationSchema,
  parseBookedGameNonFinalOperation,
} from './booked-game-consumer-contract.js';

// Internal C2 read boundary. None of these types changes the HTTP/SDK contract.
export const createOriginalBindingSchema = bookedGameOperationSchema.shape.binding.unwrap();
export type CreateOriginalBinding = z.output<typeof createOriginalBindingSchema>;
export interface CreateProofLookup {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly operationId: string;
}
export interface CreateOriginalAssociation {
  readonly binding: CreateOriginalBinding;
  readonly recordedAt: string;
}
export interface CreateOriginalAssociationReader {
  // Loaded before owner evidence; never constructed from an owner response.
  load(input: CreateProofLookup): Promise<CreateOriginalAssociation | null>;
}
export interface CreateProofOwnerReader {
  // Trusted server composition must provide one authenticated, current owner snapshot.
  // Data cannot self-declare authority. No client payload or B1 booking DTO is a reader.
  // No production implementation exists yet. One read, no retry or effect capability.
  read(original: CreateOriginalAssociation): Promise<unknown>;
}
export class CreateOriginalAssociationReadError extends Error {
  constructor(
    public readonly reason:
      'ORIGINAL_INVALID' | 'MAPPING_UNAVAILABLE' | 'MAPPING_CONFLICT' | 'ORIGINAL_UNSUPPORTED',
  ) {
    super(reason);
  }
}

const uuid = z.uuid();
const instant = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{4,}(?:Z|[+-]\d{2}:\d{2})$/.test(value));
const receiptBase = {
  receiptRef: uuid,
  bindingSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  binding: createOriginalBindingSchema,
  attemptId: uuid,
  revision: z.number().int().positive(),
  asOf: instant,
};
const ownerSnapshotSchema = z
  .object({
    binding: createOriginalBindingSchema,
    revision: z.number().int().positive(),
    asOf: instant,
    attempt: bookedGameOperationSchema.shape.attempt.unwrap(),
    receipts: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({
              ...receiptBase,
              kind: z.literal('BOOKING'),
              status: z.literal('CONFIRMED'),
              bookingId: uuid,
              confirmedAt: instant,
            })
            .strict(),
          z
            .object({
              ...receiptBase,
              kind: z.literal('BENEFIT'),
              status: z.literal('APPLIED'),
              count: z.number().int().positive(),
              subscriptionOperationId: uuid,
            })
            .strict(),
          z
            .object({
              ...receiptBase,
              kind: z.literal('SETTLEMENT'),
              status: z.enum(['CONFIRMED', 'PAYMENT_REQUIRED']),
              amountMinor: z.number().int().nonnegative(),
              debtMinor: z.number().int().nonnegative(),
              currency: z.literal('RUB'),
            })
            .strict(),
        ]),
      )
      .max(3),
  })
  .strict();

export type CreateFinancialProofReason =
  | 'ORIGINAL_UNAVAILABLE'
  | 'ORIGINAL_INVALID'
  | 'ORIGINAL_UNSUPPORTED'
  | 'MAPPING_UNAVAILABLE'
  | 'MAPPING_CONFLICT'
  | 'OWNER_UNAVAILABLE'
  | 'OWNER_INVALID'
  | 'BINDING_CONFLICT'
  | 'EVIDENCE_CONFLICT'
  | 'EVIDENCE_MISSING'
  | 'OUTSTANDING_OBLIGATION'
  | 'FINANCE_ACCEPTANCE_REQUIRED';
export interface CreateFinancialProofResult {
  readonly operationId: string;
  readonly state: 'UNKNOWN' | 'PARTIAL' | 'PAYMENT_REQUIRED' | 'EVIDENCE_CONSISTENT';
  readonly reason: CreateFinancialProofReason;
  // A consistency check is deliberately not a business approval or Games finalization.
  readonly canFinalize: false;
  readonly projection: z.output<typeof bookedGameOperationSchema> | null;
}

const sameBinding = (a: CreateOriginalBinding, b: CreateOriginalBinding) =>
  JSON.stringify(a) === JSON.stringify(b); // Both parsed by the same ordered schema.

export function createFinancialProofResolver(options: {
  readonly originals: CreateOriginalAssociationReader;
  readonly owner?: CreateProofOwnerReader;
}) {
  return {
    async resolve(input: CreateProofLookup): Promise<CreateFinancialProofResult> {
      const lookup = z
        .object({ tenantId: uuid, actorUserId: uuid, operationId: uuid })
        .strict()
        .parse(input);
      const unknown = (reason: CreateFinancialProofReason): CreateFinancialProofResult => ({
        operationId: lookup.operationId,
        state: 'UNKNOWN',
        reason,
        canFinalize: false,
        projection: null,
      });
      let original: CreateOriginalAssociation | null;
      try {
        original = await options.originals.load(lookup);
      } catch (error) {
        return unknown(
          error instanceof CreateOriginalAssociationReadError
            ? error.reason
            : 'ORIGINAL_UNAVAILABLE',
        );
      }
      if (!original) return unknown('ORIGINAL_UNAVAILABLE');
      const parsed = createOriginalBindingSchema.safeParse(original.binding);
      if (
        !parsed.success ||
        !instant.safeParse(original.recordedAt).success ||
        parsed.data.tenantId !== lookup.tenantId ||
        parsed.data.actorUserId !== lookup.actorUserId ||
        parsed.data.operationId !== lookup.operationId
      ) {
        return unknown('ORIGINAL_INVALID');
      }
      const binding = parsed.data;
      const originalRecordedAt = original.recordedAt;
      // Reuse the fixed contract to check internal mapping/identity invariants as well.
      try {
        parseBookedGameNonFinalOperation(
          {
            operationId: binding.operationId,
            revision: 0,
            status: 'PROCESSING',
            gameId: binding.gameId,
            booking: { status: 'UNKNOWN' },
            binding,
            attempt: { id: null, state: 'NOT_ATTEMPTED' },
            asOf: originalRecordedAt,
            errorCode: null,
          },
          { operationId: lookup.operationId, binding },
        );
      } catch {
        return unknown('ORIGINAL_INVALID');
      }
      if (!options.owner) return unknown('OWNER_UNAVAILABLE');
      let raw: unknown;
      try {
        // Copies prevent an adapter from changing the independently loaded expectation.
        raw = await options.owner.read(
          structuredClone({ binding, recordedAt: originalRecordedAt }),
        );
      } catch {
        return unknown('OWNER_UNAVAILABLE');
      }
      const result = ownerSnapshotSchema.safeParse(raw);
      if (!result.success) return unknown('OWNER_INVALID');
      const snapshot = result.data;
      if (!sameBinding(snapshot.binding, binding)) return unknown('BINDING_CONFLICT');
      const afterAdmission = (time: string) =>
        Date.parse(time) >= Date.parse(originalRecordedAt) &&
        Date.parse(time) <= Date.parse(snapshot.asOf);
      if (
        !afterAdmission(snapshot.asOf) ||
        Date.parse(snapshot.asOf) > Date.now() ||
        new Set(snapshot.receipts.map((receipt) => receipt.kind)).size !==
          snapshot.receipts.length ||
        new Set(snapshot.receipts.map((receipt) => receipt.receiptRef)).size !==
          snapshot.receipts.length ||
        snapshot.receipts.some(
          (receipt) =>
            !sameBinding(receipt.binding, binding) ||
            receipt.bindingSha256 !== binding.bindingSha256 ||
            receipt.attemptId !== snapshot.attempt.id ||
            receipt.revision !== snapshot.revision ||
            !afterAdmission(receipt.asOf) ||
            (receipt.kind === 'BOOKING' &&
              (!afterAdmission(receipt.confirmedAt) ||
                Date.parse(receipt.confirmedAt) > Date.parse(receipt.asOf))) ||
            (receipt.kind === 'BENEFIT' && receipt.count !== binding.visits) ||
            (receipt.kind === 'SETTLEMENT' &&
              (receipt.amountMinor !== binding.amountMinor ||
                receipt.debtMinor > receipt.amountMinor ||
                (receipt.status === 'CONFIRMED'
                  ? receipt.debtMinor !== 0
                  : receipt.debtMinor <= 0))),
        ) ||
        (snapshot.receipts.length > 0 && snapshot.attempt.state === 'NOT_ATTEMPTED')
      ) {
        // Never select one receipt from a contradictory aggregate or mix snapshots.
        return unknown('EVIDENCE_CONFLICT');
      }
      // Separate stores cannot share a transaction. Revalidate the trusted preimage and
      // current Integration mappings after the owner read; a moving source stays unknown.
      try {
        const current = await options.originals.load(lookup);
        const currentBinding = createOriginalBindingSchema.safeParse(current?.binding);
        if (
          !current ||
          !currentBinding.success ||
          !sameBinding(currentBinding.data, binding) ||
          current.recordedAt !== originalRecordedAt
        ) {
          return unknown('BINDING_CONFLICT');
        }
      } catch (error) {
        return unknown(
          error instanceof CreateOriginalAssociationReadError
            ? error.reason
            : 'ORIGINAL_UNAVAILABLE',
        );
      }
      const booking = snapshot.receipts.find((receipt) => receipt.kind === 'BOOKING');
      const benefit = snapshot.receipts.find((receipt) => receipt.kind === 'BENEFIT');
      const settlement = snapshot.receipts.find((receipt) => receipt.kind === 'SETTLEMENT');
      const publicReceipt = (receipt: (typeof snapshot.receipts)[number]) => ({
        receiptRef: receipt.receiptRef,
        bindingSha256: receipt.bindingSha256,
        asOf: receipt.asOf,
      });
      const projection = parseBookedGameNonFinalOperation(
        {
          operationId: binding.operationId,
          revision: snapshot.revision,
          status: 'PROCESSING',
          gameId: binding.gameId,
          binding,
          attempt: snapshot.attempt,
          asOf: snapshot.asOf,
          errorCode: null,
          booking: booking
            ? {
                status: 'CONFIRMED',
                bookingId: booking.bookingId,
                gameId: binding.gameId,
                slotId: binding.slotId,
                quoteId: binding.quoteId,
                confirmedAt: booking.confirmedAt,
                receipt: publicReceipt(booking),
              }
            : { status: 'UNKNOWN' },
          benefit: benefit
            ? {
                status: 'APPLIED',
                count: benefit.count,
                subscriptionOperationId: benefit.subscriptionOperationId,
                receipt: publicReceipt(benefit),
              }
            : { status: 'UNKNOWN' },
          settlement: settlement
            ? {
                status: settlement.status,
                amountMinor: settlement.amountMinor,
                debtMinor: settlement.debtMinor,
                currency: settlement.currency,
                receipt: publicReceipt(settlement),
              }
            : { status: 'UNKNOWN' },
        },
        { operationId: lookup.operationId, binding },
      );
      const all = booking && benefit && settlement && snapshot.attempt.state === 'RESOLVED';
      return {
        operationId: lookup.operationId,
        state:
          settlement?.status === 'PAYMENT_REQUIRED'
            ? 'PAYMENT_REQUIRED'
            : all
              ? 'EVIDENCE_CONSISTENT'
              : snapshot.receipts.length
                ? 'PARTIAL'
                : 'UNKNOWN',
        reason:
          settlement?.status === 'PAYMENT_REQUIRED'
            ? 'OUTSTANDING_OBLIGATION'
            : all
              ? 'FINANCE_ACCEPTANCE_REQUIRED'
              : 'EVIDENCE_MISSING',
        canFinalize: false,
        projection,
      };
    },
  };
}
