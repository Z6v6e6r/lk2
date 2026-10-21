import { describe, expect, it, vi } from 'vitest';
import {
  SubscriptionPolicyRegistryClient,
  SubscriptionPolicyRegistryError,
  parseSubscriptionPolicyRegistryResult,
} from './policy-registry.js';

const TOKEN = 'policy-registry-integration-token-0123456789';
const CORRELATION_ID = 'cup-rules-p1-20261021';

function item() {
  return {
    subscriptionTypeId: 'subscription_type:alpha',
    code: 'alpha',
    title: 'Alpha',
    description: null,
    state: 'ACTIVE',
    currentPolicyVersion: 3,
    publication: {
      publicationId: 'publication:alpha:v3',
      policyVersion: 3,
      policyDigest: `sha256:${'a'.repeat(64)}`,
      state: 'PUBLISHED',
      effectiveAt: '2026-09-01T00:00:00.000Z',
      applyTo: 'ACTIVE_AND_NEW',
      publishedAt: '2026-08-31T00:00:00.000Z',
      supersededAt: null,
      runtimeCompatibility: {
        adapterId: 'LK_REGIONAL_BOOKING_GATEWAY',
        contractVersion: 1,
        capabilityDigest: `sha256:${'b'.repeat(64)}`,
      },
    },
    rules: { runtimeSchemaVersion: 1, policyVersion: 3 },
    surfaces: ['CREATE_GAME', 'JOIN_GAME'],
    versions: [
      {
        policyVersion: 3,
        status: 'PUBLISHED',
        modelVersion: 3,
        effectiveAt: '2026-09-01T00:00:00.000Z',
        applyTo: 'ACTIVE_AND_NEW',
        publicationState: 'PUBLISHED',
      },
    ],
    instances: {
      total: 2,
      byPolicyVersion: [{ policyVersion: 3, count: 2 }],
    },
    lastDecision: {
      at: '2026-10-01T10:00:00.000Z',
      source: 'LEDGER',
      eventType: 'ENTITLEMENT_RESERVED',
      operationState: null,
      action: null,
      policyVersion: 3,
      policyDigest: `sha256:${'a'.repeat(64)}`,
      usageDelta: 1,
      moneyDeltaMinor: 0,
    },
  };
}

function result() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-10-21T08:00:00.000Z',
    items: [item()],
    totals: {
      subscriptionTypes: 1,
      publishedPolicies: 1,
      draftPolicies: 0,
      instances: 2,
    },
  };
}

function client(fetchImplementation: typeof fetch, timeoutMs = 500) {
  return new SubscriptionPolicyRegistryClient({
    enabled: true,
    baseUrl: 'https://cup.example.test',
    integrationToken: TOKEN,
    timeoutMs,
    environment: 'production',
    fetchImplementation,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CUP published-policy registry client', () => {
  it('reads and validates the persisted registry', async () => {
    const transport = vi.fn(() => Promise.resolve(jsonResponse(result())));
    await expect(client(transport).read(CORRELATION_ID)).resolves.toEqual(result());
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      'https://cup.example.test/api/internal/subscriptions/policy-registry',
    );
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Subscriptions-Integration-Token']).toBe(TOKEN);
    expect(headers['X-Correlation-ID']).toBe(CORRELATION_ID);
  });

  it('rejects malformed, missing and repudiated responses', async () => {
    const cases: unknown[] = [
      { ...result(), schemaVersion: 2 },
      { ...result(), generatedAt: 'not-an-instant' },
      { ...result(), totals: { ...result().totals, instances: -1 } },
      { ...result(), items: [{ ...item(), publication: { ...item().publication, state: 'X' } }] },
      { ...result(), items: [{ ...item(), versions: [{ policyVersion: 0 }] }] },
    ];
    for (const body of cases)
      expect(() => parseSubscriptionPolicyRegistryResult(body)).toThrow(
        SubscriptionPolicyRegistryError,
      );
    const transport = vi.fn(() => Promise.resolve(jsonResponse({ ...result(), items: 'nope' })));
    await expect(client(transport).read(CORRELATION_ID)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_POLICY_REGISTRY_RESPONSE_INVALID',
    });
  });

  it('fails closed on non-2xx, oversized and non-JSON bodies', async () => {
    const factories: Array<() => Response> = [
      () => jsonResponse({ code: 'X' }, 403),
      () => jsonResponse({ code: 'X' }, 503),
      () => new Response('x'.repeat(1_048_577), { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const make of factories) {
      const transport = vi.fn(() => Promise.resolve(make()));
      await expect(client(transport).read(CORRELATION_ID)).rejects.toBeInstanceOf(
        SubscriptionPolicyRegistryError,
      );
    }
  });

  it('rejects insecure or credential-bearing CUP URLs and short tokens', () => {
    for (const baseUrl of [
      'http://cup.example.test',
      'https://user:secret@cup.example.test',
      'https://cup.example.test/path',
      'https://cup.example.test/?key=secret',
    ])
      expect(
        () =>
          new SubscriptionPolicyRegistryClient({
            enabled: true,
            baseUrl,
            integrationToken: TOKEN,
            timeoutMs: 500,
            environment: 'production',
          }),
      ).toThrow();
    expect(
      () =>
        new SubscriptionPolicyRegistryClient({
          enabled: true,
          baseUrl: 'https://cup.example.test',
          integrationToken: 'short',
          timeoutMs: 500,
          environment: 'production',
        }),
    ).toThrow();
  });

  it('rejects an invalid correlation id before any network call', async () => {
    const transport = vi.fn(() => Promise.resolve(jsonResponse(result())));
    await expect(client(transport).read('short')).rejects.toMatchObject({
      code: 'SUBSCRIPTION_POLICY_REGISTRY_REQUEST_INVALID',
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
