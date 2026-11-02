import { z } from 'zod';

// Exact canonical UNKNOWN codes in LK #279 (952031f7); never forward arbitrary owner strings.
export const stationMessageUnknownCodes = [
  'MESSAGE_CONTRACT_REQUIRED',
  'COMMUNITY_AUTH_REQUIRED',
  'MESSAGE_REQUEST_INVALID',
  'MESSAGE_STATUS_WRITE_FORBIDDEN',
  'MESSAGE_STORE_UNAVAILABLE',
  'COMMUNITY_MESSAGE_ACCESS_UNAVAILABLE',
  'MESSAGE_RECEIPT_UNPROVEN',
  'MESSAGE_STATUS_STATE_INVALID',
  'MESSAGE_CUSTODY_UNPROVEN',
  'MESSAGE_REQUEST_CONFLICT',
  'MESSAGE_COMMIT_INVALID',
  'MESSAGE_REQUEST_TERMINAL',
  'MESSAGE_COMMIT_UNPROVEN',
  'MESSAGE_ACCEPTANCE_UNPROVEN',
  'MESSAGE_COMMUNITY_CHANGED',
  'COMMUNITY_MESSAGE_ACCESS_DENIED',
  'COMMUNITY_MESSAGE_ACCESS_CHANGED',
  'MESSAGE_OUTBOX_FULL',
  'MESSAGE_ACCEPTANCE_CONFLICT',
  'MESSAGE_EVENT_UNPROVEN',
  'MESSAGE_STATE_INVALID',
  'MESSAGE_STEP_LIMIT',
] as const;

// A receipt proves durable acceptance, never delivery or a read acknowledgement.
export const stationMessageRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    text: z
      .string()
      .max(8_000)
      .refine((text) => text.trim().length > 0),
  })
  .strict();
const receipt = {
  contractVersion: z.literal(1),
  contract: z.literal('station-message'),
  requestId: z.string().uuid(),
};
export const stationMessageReceiptSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...receipt,
      outcome: z.literal('CONFIRMED'),
      message: z
        .object({
          id: z.string().uuid(),
          body: z.string().min(1).max(8_000),
          sentAt: z.string().datetime({ offset: true }),
          author: z.object({ displayName: z.string().min(1).max(120) }).strict(),
          isViewer: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...receipt,
      outcome: z.literal('UNKNOWN'),
      code: z.enum(stationMessageUnknownCodes),
    })
    .strict(),
]);
export type StationMessageRequest = z.infer<typeof stationMessageRequestSchema>;
export type StationMessageReceipt = z.infer<typeof stationMessageReceiptSchema>;
