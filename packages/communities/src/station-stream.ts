import { z } from 'zod';

export const stationStreamUuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const stationStreamSequence = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const stationStreamPositionShape = {
  streamId: stationStreamUuid,
  membershipEpoch: stationStreamSequence,
};
export const stationStreamStateShape = {
  ...stationStreamPositionShape,
  baselineSequence: stationStreamSequence,
  readThroughSequence: stationStreamSequence,
  publishedThroughSequence: stationStreamSequence,
  unreadCount: stationStreamSequence,
};
export function stationStreamStateValid(value: {
  baselineSequence: number;
  readThroughSequence: number;
  publishedThroughSequence: number;
  unreadCount: number;
}): boolean {
  return (
    value.baselineSequence <= value.readThroughSequence &&
    value.readThroughSequence <= value.publishedThroughSequence &&
    value.unreadCount <= value.publishedThroughSequence - value.readThroughSequence
  );
}
const cursor = z
  .string()
  .min(16)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();
const row = {
  id: stationStreamUuid,
  body: z.string().min(1).max(8000),
  sentAt: z.string().datetime(),
  author: z.object({ displayName: z.string().min(1).max(120) }).strict(),
  isViewer: z.boolean(),
};
const shared = {
  historyVersion: z.literal(3),
  ...stationStreamStateShape,
  nextCursor: cursor,
  catchUpCursor: cursor,
  olderCursor: cursor,
  archiveCursor: cursor,
  canRequestStationMessage: z.boolean(),
};
export const stationStreamPageSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        ...shared,
        mode: z.literal('STREAM'),
        afterSequence: stationStreamSequence,
        throughSequence: stationStreamSequence,
        items: z
          .array(z.object({ ...row, sequence: stationStreamSequence.min(1) }).strict())
          .max(50),
      })
      .strict(),
    z
      .object({
        ...shared,
        mode: z.literal('ARCHIVE'),
        items: z.array(z.object({ ...row, sequence: z.null() }).strict()).max(50),
      })
      .strict(),
  ])
  .refine(stationStreamStateValid);
export const stationReadRequestSchema = z
  .object({
    requestId: stationStreamUuid,
    ...stationStreamPositionShape,
    throughSequence: stationStreamSequence,
  })
  .strict();
export const stationReadUnknownCodes = [
  'READ_REQUEST_INVALID',
  'READ_REQUEST_CONFLICT',
  'READ_ACCESS_DENIED',
  'READ_STREAM_UNAVAILABLE',
  'READ_RECEIPT_UNPROVEN',
] as const;
const receipt = {
  contractVersion: z.literal(1),
  contract: z.literal('station-read'),
  requestId: stationStreamUuid,
};
export const stationReadReceiptSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...receipt,
      outcome: z.literal('CONFIRMED'),
      ...stationStreamPositionShape,
      throughSequence: stationStreamSequence,
      readThroughSequence: stationStreamSequence,
    })
    .strict()
    .refine((value) => value.readThroughSequence >= value.throughSequence),
  z
    .object({ ...receipt, outcome: z.literal('UNKNOWN'), code: z.enum(stationReadUnknownCodes) })
    .strict(),
]);
export type StationStreamPage = z.infer<typeof stationStreamPageSchema>;
export type StationReadRequest = z.infer<typeof stationReadRequestSchema>;
export type StationReadReceipt = z.infer<typeof stationReadReceiptSchema>;
const summaryItem = z.discriminatedUnion('availability', [
  z
    .object({
      communityId: stationStreamUuid,
      availability: z.literal('AVAILABLE'),
      ...stationStreamStateShape,
    })
    .strict()
    .refine(stationStreamStateValid),
  z.object({ communityId: stationStreamUuid, availability: z.literal('UNADOPTED') }).strict(),
  z.object({ communityId: stationStreamUuid, availability: z.literal('NOT_STATION') }).strict(),
]);
export const stationStreamSummariesSchema = z
  .object({
    contractVersion: z.literal(1),
    contract: z.literal('station-stream-summaries'),
    items: z.array(summaryItem).min(1).max(50),
  })
  .strict()
  .refine(
    (value) => new Set(value.items.map((item) => item.communityId)).size === value.items.length,
  );
export type StationStreamSummary = z.infer<typeof summaryItem>;
export type StationStreamSummaries = z.infer<typeof stationStreamSummariesSchema>;
