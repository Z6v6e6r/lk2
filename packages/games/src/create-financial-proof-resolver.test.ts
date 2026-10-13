import { describe, expect, it, vi } from 'vitest';

import { hasConfirmedBookedGame } from './booked-game-consumer-contract.js';
import { createFinancialProofResolver } from './create-financial-proof-resolver.js';
import {
  originalBinding,
  ownerSnapshot,
  proofAt,
  recordedAt,
  syntheticId,
} from './create-financial-proof.test-fixture.js';

const lookup = {
  tenantId: syntheticId(1),
  actorUserId: syntheticId(2),
  operationId: syntheticId(3),
};
function setup(snapshot: unknown = ownerSnapshot()) {
  const original = { binding: originalBinding(), recordedAt };
  const load = vi.fn(() => Promise.resolve(structuredClone(original)));
  const read = vi.fn(() => Promise.resolve(structuredClone(snapshot)));
  return {
    resolver: createFinancialProofResolver({ originals: { load }, owner: { read } }),
    load,
    read,
    original,
  };
}
describe('internal CREATE evidence resolver, financial authority still unavailable', () => {
  it('loads expected terms independently, checks raw receipts, and never enables success', async () => {
    const { resolver, load, read } = setup();
    const result = await resolver.resolve(lookup);
    expect(load).toHaveBeenCalledWith(lookup);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: 'EVIDENCE_CONSISTENT',
      canFinalize: false,
      reason: 'FINANCE_ACCEPTANCE_REQUIRED',
    });
    expect(result.projection?.status).toBe('PROCESSING');
    expect(
      hasConfirmedBookedGame(result.projection, {
        operationId: lookup.operationId,
        quoteId: syntheticId(5),
        slotId: syntheticId(6),
      }),
    ).toBe(false);
  });
  it.each(['BOOKING', 'BENEFIT', 'SETTLEMENT'])(
    'preserves partial proof with %s missing',
    async (kind) => {
      const snapshot = ownerSnapshot();
      snapshot.receipts = snapshot.receipts.filter((receipt) => receipt.kind !== kind);
      const result = await setup(snapshot).resolver.resolve(lookup);
      expect(result.state).toBe('PARTIAL');
      expect(
        result.projection?.[kind.toLowerCase() as 'booking' | 'benefit' | 'settlement']?.status,
      ).toBe('UNKNOWN');
    },
  );
  it('preserves an explicit outstanding obligation without calculating price', async () => {
    const snapshot = ownerSnapshot();
    Object.assign(snapshot.receipts[2]!, { status: 'PAYMENT_REQUIRED', debtMinor: 2345 });
    expect(await setup(snapshot).resolver.resolve(lookup)).toMatchObject({
      state: 'PAYMENT_REQUIRED',
      canFinalize: false,
      projection: {
        settlement: { status: 'PAYMENT_REQUIRED', amountMinor: 12345, debtMinor: 2345 },
      },
    });
  });
  it.each([
    'tenantId',
    'actorUserId',
    'operationId',
    'gameId',
    'quoteId',
    'slotId',
    'subscriptionInstanceId',
  ])('rejects a foreign receipt %s despite matching hashes', async (field) => {
    const snapshot = ownerSnapshot();
    Object.assign(snapshot.receipts[0]!.binding, { [field]: syntheticId(99) });
    expect(await setup(snapshot).resolver.resolve(lookup)).toMatchObject({
      state: 'UNKNOWN',
      reason: 'EVIDENCE_CONFLICT',
    });
  });
  it.each([
    { quoteRevision: 2 },
    { slotVersion: 'slot-source-v2' },
    { amountMinor: 12000 },
    { currency: 'USD' },
    { visits: 2 },
    { requestSha256: `sha256:${'a'.repeat(64)}` },
    { keySha256: `sha256:${'b'.repeat(64)}` },
    { intentSha256: `sha256:${'c'.repeat(64)}` },
  ])('rejects changed owner terms %j without adopting them', async (change) => {
    const snapshot = ownerSnapshot();
    Object.assign(snapshot.binding, change);
    const result = await setup(snapshot).resolver.resolve(lookup);
    expect(result.state).toBe('UNKNOWN');
    expect(result.projection).toBeNull();
  });
  it.each(['actor', 'subscription', 'slot'] as const)(
    'rejects changed %s mapping revision',
    async (kind) => {
      const snapshot = ownerSnapshot();
      snapshot.receipts[1]!.binding.mappings[kind].revision = 'foreign-v2';
      expect((await setup(snapshot).resolver.resolve(lookup)).reason).toBe('EVIDENCE_CONFLICT');
    },
  );
  it.each([
    [
      'duplicate kind',
      (s: ReturnType<typeof ownerSnapshot>) => {
        s.receipts[1] = structuredClone(s.receipts[0]!);
      },
    ],
    [
      'duplicate ref',
      (s: ReturnType<typeof ownerSnapshot>) => {
        s.receipts[1]!.receiptRef = s.receipts[0]!.receiptRef;
      },
    ],
    [
      'different attempt',
      (s: ReturnType<typeof ownerSnapshot>) => {
        s.receipts[1]!.attemptId = syntheticId(99);
      },
    ],
    [
      'different revision',
      (s: ReturnType<typeof ownerSnapshot>) => {
        s.receipts[1]!.revision = 1;
      },
    ],
    [
      'stale receipt',
      (s: ReturnType<typeof ownerSnapshot>) => {
        s.receipts[1]!.asOf = '2026-10-12T00:00:00.000Z';
      },
    ],
    [
      'future receipt',
      (s: ReturnType<typeof ownerSnapshot>) => {
        s.receipts[1]!.asOf = '2026-10-13T00:00:02.000Z';
      },
    ],
    [
      'wrong visit count',
      (s: ReturnType<typeof ownerSnapshot>) => {
        Object.assign(s.receipts[1]!, { count: 2 });
      },
    ],
    [
      'wrong amount',
      (s: ReturnType<typeof ownerSnapshot>) => {
        Object.assign(s.receipts[2]!, { amountMinor: 0 });
      },
    ],
    [
      'contradictory debt',
      (s: ReturnType<typeof ownerSnapshot>) => {
        Object.assign(s.receipts[2]!, { debtMinor: 1 });
      },
    ],
  ] as const)('rejects %s', async (_label, mutate) => {
    const snapshot = ownerSnapshot();
    mutate(snapshot);
    expect(await setup(snapshot).resolver.resolve(lookup)).toMatchObject({
      state: 'UNKNOWN',
      reason: 'EVIDENCE_CONFLICT',
    });
  });
  it('a digest and valid payload cannot substitute for a trusted reader', async () => {
    const { original } = setup();
    const resolver = createFinancialProofResolver({
      originals: { load: () => Promise.resolve(original) },
    });
    expect(await resolver.resolve(lookup)).toMatchObject({
      state: 'UNKNOWN',
      reason: 'OWNER_UNAVAILABLE',
    });
  });
  it('does not fetch evidence when original custody is missing or foreign', async () => {
    const read = vi.fn(() => Promise.resolve(ownerSnapshot()));
    for (const original of [
      null,
      { binding: { ...originalBinding(), actorUserId: syntheticId(99) }, recordedAt },
    ]) {
      const resolver = createFinancialProofResolver({
        originals: { load: () => Promise.resolve(original) },
        owner: { read },
      });
      expect((await resolver.resolve(lookup)).state).toBe('UNKNOWN');
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('checks the receipt own binding hash rather than manufacturing it from expectation', async () => {
    const snapshot = ownerSnapshot();
    snapshot.receipts[0]!.bindingSha256 = `sha256:${'e'.repeat(64)}`;
    expect((await setup(snapshot).resolver.resolve(lookup)).reason).toBe('EVIDENCE_CONFLICT');
  });
  it('rejects changed trusted storage after the owner read', async () => {
    const original = { binding: originalBinding(), recordedAt };
    const load = vi
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, binding: { ...original.binding, quoteRevision: 2 } });
    const resolver = createFinancialProofResolver({
      originals: { load },
      owner: { read: () => Promise.resolve(ownerSnapshot()) },
    });
    expect((await resolver.resolve(lookup)).reason).toBe('BINDING_CONFLICT');
  });
  it('response loss allows only the next explicit read of the same original', async () => {
    const { original } = setup();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue(ownerSnapshot());
    const resolver = createFinancialProofResolver({
      originals: { load: () => Promise.resolve(original) },
      owner: { read },
    });
    expect((await resolver.resolve(lookup)).reason).toBe('OWNER_UNAVAILABLE');
    expect(read).toHaveBeenCalledTimes(1);
    expect((await resolver.resolve(lookup)).state).toBe('EVIDENCE_CONSISTENT');
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]).toEqual(read.mock.calls[1]);
  });
  it('does not infer benefit or settlement from a zero quote', async () => {
    const binding = { ...originalBinding(), amountMinor: 0 };
    const snapshot = ownerSnapshot(binding);
    snapshot.receipts = [snapshot.receipts[0]!];
    const resolver = createFinancialProofResolver({
      originals: { load: () => Promise.resolve({ binding, recordedAt }) },
      owner: { read: () => Promise.resolve(snapshot) },
    });
    expect(await resolver.resolve(lookup)).toMatchObject({
      state: 'PARTIAL',
      projection: { benefit: { status: 'UNKNOWN' }, settlement: { status: 'UNKNOWN' } },
    });
  });
  it('cannot promote receipt consistency while an attempt remains unresolved', async () => {
    const snapshot = ownerSnapshot();
    snapshot.attempt.state = 'UNKNOWN';
    expect((await setup(snapshot).resolver.resolve(lookup)).state).toBe('PARTIAL');
  });
  it('bounds original/owner failure and rejects old booking-only DTOs', async () => {
    const { original } = setup();
    const resolver = createFinancialProofResolver({
      originals: {
        load: () => Promise.reject(new Error('DB unavailable')),
      },
    });
    expect((await resolver.resolve(lookup)).reason).toBe('ORIGINAL_UNAVAILABLE');
    const b1 = {
      contractVersion: 1,
      operationId: lookup.operationId,
      status: 'CONFIRMED',
      asOf: proofAt,
      reason: 'OWNER_BOOKING_CONFIRMED',
    };
    expect(
      (
        await createFinancialProofResolver({
          originals: { load: () => Promise.resolve(original) },
          owner: { read: () => Promise.resolve(b1) },
        }).resolve(lookup)
      ).reason,
    ).toBe('OWNER_INVALID');
  });
});
