import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ManagedJoinOwnerClient,
  managedJoinPreflightSha256,
  managedJoinAdmissionSha256,
  parseManagedJoinPreflightRequest,
  parseManagedJoinPreflightResult,
  parseManagedJoinAdmissionRequest,
  parseManagedJoinReadOutcome,
  parseManagedJoinReceipt,
} from './managed-join.js';

const bytes = readFileSync(new URL('./fixtures/managed-join-v2.json', import.meta.url));
const fixture = JSON.parse(bytes.toString()) as {
  preflight: { request: unknown; response: unknown; requestSha256: string };
  admission: { request: unknown; requestSha256: string };
  confirmed: unknown;
  identity: { operationId: string };
};
const request = parseManagedJoinPreflightRequest(fixture.preflight.request);
const admit = parseManagedJoinAdmissionRequest(fixture.admission.request);
const confirmed = parseManagedJoinReadOutcome(fixture.confirmed, fixture.identity.operationId);
const envelope = () => ({
  operationId: fixture.identity.operationId,
  correlationId: 'fixture-correlation',
  actorDelegation: ['synthetic', 'delegation'].join('-'),
  actorToken: {
    token: ['synthetic', 'actor', 'credential'].join('-'),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  },
});

describe('managed JOIN v2 owner contract', () => {
  it('preserves frozen cross-repository fixture bytes and versioned body hashes', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '82f7b918275c86fd357283abd67bc7c727427a3680dfe9906b2d560eea3c0171',
    );
    expect(managedJoinPreflightSha256(request)).toBe(fixture.preflight.requestSha256);
    expect(managedJoinAdmissionSha256(admit)).toBe(fixture.admission.requestSha256);
    expect(
      parseManagedJoinPreflightResult(fixture.preflight.response, envelope().operationId, request),
    ).toHaveProperty('entitlement', admit.entitlement);
    expect(confirmed.receipt?.entitlement.usageRef.reservationUnits).toBe(1);
  });
  it('only accepts an explicit exact LEGACY union', () => {
    const managed = fixture.preflight.response as Record<string, unknown>;
    const { entitlement: ignored, ...base } = managed;
    void ignored;
    expect(
      parseManagedJoinPreflightResult(
        { ...base, management: 'LEGACY' },
        envelope().operationId,
        request,
      ),
    ).toHaveProperty('management', 'LEGACY');
    for (const value of [
      base,
      { ...base, management: 'UNKNOWN' },
      { ...managed, management: 'LEGACY' },
      { ...base, management: 'LEGACY', extra: true },
      null,
    ])
      expect(() =>
        parseManagedJoinPreflightResult(value, envelope().operationId, request),
      ).toThrow();
  });
  it.each(['operationId', 'action', 'target', 'nonBinding', 'contractVersion'])(
    'rejects mismatched preflight %s',
    (key) => {
      expect(() =>
        parseManagedJoinPreflightResult(
          { ...(fixture.preflight.response as object), [key]: null },
          envelope().operationId,
          request,
        ),
      ).toThrow();
    },
  );
  it('rejects malformed, invented and incomplete policy/usage evidence', () => {
    const r = confirmed.receipt!;
    for (const value of [
      { ...r, extra: true },
      { ...r, contractVersion: 1 },
      {
        ...r,
        entitlement: {
          ...r.entitlement,
          usageRef: { usageRef: 'invented-ref', reservationUnits: 1 },
        },
      },
      {
        ...r,
        entitlement: {
          ...r.entitlement,
          usageRef: { ...r.entitlement.usageRef, reservationUnits: 0 },
        },
      },
      {
        ...r,
        entitlement: {
          ...r.entitlement,
          policyRef: { ...r.entitlement.policyRef, policyDigest: 'sha256:bad' },
        },
      },
      { ...r, entitlement: { ...r.entitlement, subscriptionInstanceId: null } },
      { ...r, entitlement: undefined },
      { ...r, verifiedAt: '2026-10-31' },
    ])
      expect(() => parseManagedJoinReceipt(value)).toThrow();
    expect(() => parseManagedJoinAdmissionRequest({ ...admit, usageRef: 'fake' })).toThrow();
    expect(() =>
      parseManagedJoinReadOutcome({ ...confirmed, receipt: undefined }, envelope().operationId),
    ).toThrow();
  });
  it('uses fixed v2 paths, bound token headers, no redirects/cache and no write retry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fixture.preflight.response))
      .mockResolvedValueOnce(
        Response.json({
          ...confirmed,
          status: 'PENDING',
          reason: 'OWNER_PENDING',
          receipt: undefined,
        }),
      )
      .mockResolvedValueOnce(Response.json(fixture.confirmed));
    const client = new ManagedJoinOwnerClient({
      baseUrl: 'https://owner.example.test',
      environment: 'production',
      timeoutMs: 100,
      fetchImplementation: fetcher,
    });
    await client.preflight(request, envelope());
    await client.admit(admit, envelope());
    await client.read(envelope());
    expect(
      fetcher.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url).pathname),
    ).toEqual([
      '/lk/integrations/v2/booked-operation-preflights',
      '/lk/integrations/v2/booked-operation-admissions',
      `/lk/integrations/v2/booked-operations/${envelope().operationId}`,
    ]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'X-Subscription-Actor-Token': envelope().actorToken.token },
    });
  });
  it.each([403, 404, 409, 429, 500, 503])(
    'keeps HTTP %s unavailable without fallback or retry',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
      const client = new ManagedJoinOwnerClient({
        baseUrl: 'https://owner.example.test',
        environment: 'production',
        timeoutMs: 100,
        fetchImplementation: fetcher,
      });
      await expect(client.preflight(request, envelope())).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects changed origin, oversized responses and expires the transport', async () => {
    const changed = Response.json(fixture.preflight.response);
    Object.defineProperty(changed, 'url', { value: 'https://foreign.example.test' });
    for (const response of [changed, new Response('x'.repeat(32769))]) {
      const client = new ManagedJoinOwnerClient({
        baseUrl: 'https://owner.example.test',
        environment: 'production',
        timeoutMs: 100,
        fetchImplementation: vi.fn().mockResolvedValue(response),
      });
      await expect(client.preflight(request, envelope())).rejects.toThrow();
    }
    const client = new ManagedJoinOwnerClient({
      baseUrl: 'https://owner.example.test',
      environment: 'production',
      timeoutMs: 100,
      fetchImplementation: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('fixture timeout'))),
        ),
    });
    await expect(client.preflight(request, envelope())).rejects.toThrow();
  });
});
