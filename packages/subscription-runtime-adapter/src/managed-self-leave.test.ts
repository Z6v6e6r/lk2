import { managedSelfLeaveFixture as fixture } from './managed-self-leave.test-fixture.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  assertManagedSelfLeaveAuthority,
  managedSelfLeaveReceiptMatches,
  managedSelfLeaveJoinReceiptSha256,
  type ManagedSelfLeaveAuthority,
} from '@phub/domain';
import {
  ManagedSelfLeaveOwnerClient,
  managedSelfLeaveRequestSha256,
  managedSelfLeaveOperationId,
  parseManagedSelfLeaveRequest,
  parseManagedSelfLeaveReceipt,
  parseManagedSelfLeaveReadOutcome,
} from './managed-self-leave.js';
const bytes = readFileSync(
  new URL('./fixtures/managed-self-leave-v1-contract.json', import.meta.url),
);
const authority: ManagedSelfLeaveAuthority = {
  ...fixture.identity,
  request: fixture.request,
  requestSha256: fixture.requestSha256,
  originalJoinReceipt: fixture.originalJoinReceipt,
  legacyGameId: fixture.confirmed.receipt.legacyGameId,
  legacyGameMappingId: fixture.confirmed.receipt.legacyGameMappingId,
  legacyGameMappingVersion: fixture.confirmed.receipt.legacyGameMappingVersion,
};
describe('managed SELF owner exact wire contract', () => {
  it('preserves owner fixture, operation and canonical hashes across JSONB key ordering', async () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'fce0141db188fd432657b87e4148249c34faabd36162d0bc23f93dfe4f91088b',
    );
    expect(await managedSelfLeaveRequestSha256(fixture.request)).toBe(fixture.requestSha256);
    expect(await managedSelfLeaveOperationId(fixture.identity)).toBe(fixture.identity.operationId);
    expect(await managedSelfLeaveJoinReceiptSha256(fixture.originalJoinReceipt)).toBe(
      fixture.request.joinReceiptSha256,
    );
    await expect(assertManagedSelfLeaveAuthority(authority)).resolves.toBeUndefined();
    expect(
      managedSelfLeaveReceiptMatches(
        parseManagedSelfLeaveReceipt(fixture.confirmed.receipt),
        authority,
      ),
    ).toBe(true);
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    expect(await managedSelfLeaveRequestSha256(reverse(fixture.request) as never)).toBe(
      fixture.requestSha256,
    );
    expect(
      await managedSelfLeaveJoinReceiptSha256(reverse(fixture.originalJoinReceipt) as never),
    ).toBe(fixture.request.joinReceiptSha256);
  });
  it.each([
    'tenantId',
    'userId',
    'operationId',
    'gameId',
    'participationId',
    'reservationId',
    'joinOperationId',
    'providerMappingId',
    'legacyGameMappingId',
  ])('rejects valid foreign %s before local application', (key) => {
    const changed = { ...fixture.confirmed.receipt, [key]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    expect(managedSelfLeaveReceiptMatches(parseManagedSelfLeaveReceipt(changed), authority)).toBe(
      false,
    );
  });
  it.each(['requestSha256', 'idempotencyKeySha256', 'joinReceiptSha256'])(
    'rejects forged %s',
    (key) =>
      expect(
        managedSelfLeaveReceiptMatches(
          { ...fixture.confirmed.receipt, [key]: 'sha256:' + 'a'.repeat(64) },
          authority,
        ),
      ).toBe(false),
  );
  it('refuses money/NONE, invented entitlement and unsupported state/fields', () => {
    for (const receipt of [
      { ...fixture.confirmed.receipt, extra: 1 },
      {
        ...fixture.confirmed.receipt,
        compensation: { ...fixture.confirmed.receipt.compensation, operationState: 'CONFIRMED' },
      },
      {
        ...fixture.confirmed.receipt,
        compensation: {
          ...fixture.confirmed.receipt.compensation,
          releaseReason: 'PROVIDER_REJECTED',
        },
      },
      { ...fixture.confirmed.receipt, providerBookingId: 'other-booking' },
      { ...fixture.confirmed.receipt, membershipVersion: 'other-generation' },
    ])
      expect(() => parseManagedSelfLeaveReceipt(receipt)).toThrow();
    for (const request of [
      { ...fixture.request, returnMode: 'NONE' },
      { ...fixture.request, refund: 10 },
      { ...fixture.request, action: 'CANCEL_GAME' },
    ])
      expect(() => parseManagedSelfLeaveRequest(request)).toThrow();
    for (const outcome of [
      { ...fixture.unknown, receipt: fixture.confirmed.receipt },
      { ...fixture.confirmed, asOf: null },
      { ...fixture.pending, extra: 1 },
      {},
    ])
      expect(() =>
        parseManagedSelfLeaveReadOutcome(outcome, fixture.identity.operationId),
      ).toThrow();
  });
  it('uses two fixed authenticated routes, never retries or follows redirects', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(fixture.unknown), { status: 200 })),
      );
    const client = new ManagedSelfLeaveOwnerClient({
      baseUrl: 'https://owner.example.test',
      environment: 'production',
      timeoutMs: 100,
      fetchImplementation: transport,
    });
    const envelope = {
      operationId: fixture.identity.operationId,
      actorDelegation: 'synthetic-jwt',
      correlationId: 'synthetic-correlation',
      actorToken: {
        token: 'synthetic-user-credential',
        expiresAt: new Date(Date.now() + 30000).toISOString(),
      },
    };
    await client.admit(fixture.request, envelope);
    await client.read(envelope);
    expect(transport.mock.calls.map((c) => c[0])).toEqual([
      'https://owner.example.test' + fixture.paths.admission,
      'https://owner.example.test' + fixture.paths.read,
    ]);
    const options = transport.mock.calls[0]?.[1] as RequestInit;
    expect(options.redirect).toBe('error');
    expect(options.body).toBe(JSON.stringify(fixture.request));
    transport.mockRejectedValueOnce(new TypeError('transport failure'));
    await expect(client.admit(fixture.request, envelope)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
