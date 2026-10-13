import { createHash } from 'node:crypto';

import type { CreateOriginalBinding } from './create-financial-proof-resolver.js';

export const syntheticId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const syntheticHash = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const recordedAt = '2026-10-13T00:00:00.000Z';
export const proofAt = '2026-10-13T00:00:01.000Z';
export const syntheticKey = 'fin01-synthetic-original-key';
export function originalBinding(): CreateOriginalBinding {
  const mapping = (id: number, internalId: number, revision: string) => ({
    tenantId: syntheticId(1),
    id: syntheticId(id),
    revision,
    internalId: syntheticId(internalId),
  });
  const mappings = {
    actor: mapping(8, 2, 'actor-v1'),
    subscription: mapping(9, 7, 'subscription-v1'),
    slot: mapping(10, 6, 'slot-map-v1'),
  };
  return {
    tenantId: syntheticId(1),
    actorUserId: syntheticId(2),
    operationId: syntheticId(3),
    gameId: syntheticId(4),
    quoteId: syntheticId(5),
    quoteRevision: 1,
    slotId: syntheticId(6),
    slotVersion: 'slot-source-v1',
    subscriptionInstanceId: syntheticId(7),
    visits: 1,
    amountMinor: 12345,
    currency: 'RUB',
    keySha256: syntheticHash(syntheticKey),
    intentSha256: syntheticHash('original-intent'),
    requestSha256: syntheticHash('owner-request'),
    bindingSha256: syntheticHash('private-owner-binding'),
    mappingBindingSha256: syntheticHash(
      JSON.stringify({
        actor: { ...mappings.actor, externalId: syntheticId(20) },
        subscription: { ...mappings.subscription, externalId: syntheticId(21) },
        slot: { ...mappings.slot, slotVersion: 'slot-source-v1' },
      }),
    ),
    mappings,
  };
}
// Raw test-owner rows, never a mocked successful resolver result.
export function ownerSnapshot(binding = originalBinding()) {
  const receipt = (n: number) => ({
    receiptRef: syntheticId(n),
    bindingSha256: binding.bindingSha256,
    binding: structuredClone(binding),
    attemptId: syntheticId(14),
    revision: 2,
    asOf: proofAt,
  });
  return {
    binding: structuredClone(binding),
    revision: 2,
    asOf: proofAt,
    attempt: { id: syntheticId(14), state: 'RESOLVED' },
    receipts: [
      {
        ...receipt(11),
        kind: 'BOOKING',
        status: 'CONFIRMED',
        bookingId: syntheticId(12),
        confirmedAt: proofAt,
      },
      {
        ...receipt(15),
        kind: 'BENEFIT',
        status: 'APPLIED',
        count: 1,
        subscriptionOperationId: syntheticId(13),
      },
      {
        ...receipt(16),
        kind: 'SETTLEMENT',
        status: 'CONFIRMED',
        amountMinor: 12345,
        debtMinor: 0,
        currency: 'RUB',
      },
    ],
  };
}
