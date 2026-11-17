/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import {
  CLIENT_SEARCH_PAGE_LIMIT,
  VivaClientPhoneLookupAdapter,
  VivaClientPhoneLookupError,
  type VivaClientPhoneLookupOptions,
} from './client-phone-lookup.js';

const PHONE = '+79990001122';
const OWNER = '11111111-1111-4111-8111-111111111111';
const NEAR_A = '22222222-2222-4222-8222-222222222222';
const NEAR_B = '33333333-3333-4333-8333-333333333333';

type Card = { id: string; phone?: string | null; deleted?: boolean };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Synthetic Viva double: a relevance search plus client cards, shaped after the pinned HAR. */
function viva(input: {
  readonly search: readonly string[] | (() => Response);
  readonly cards?: Record<string, Card | (() => Response)>;
}) {
  const calls: string[] = [];
  const fetchImplementation = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${target.pathname}${target.search}`);
    if (target.pathname === '/api/v2/search/clients') {
      if (typeof input.search === 'function') return input.search();
      return json(
        input.search.map((clientId, index) => ({
          clientId,
          clientLabel: null,
          clientDetails: 'redacted',
          familyMembers: [],
          relevanceScore: 2 - index / 10,
        })),
      );
    }
    const id = target.pathname.replace('/api/v1/clients/', '');
    const card = input.cards?.[id];
    if (!card) return json({ error: 'not found' }, 404);
    return typeof card === 'function' ? card() : json(card);
  });
  return { calls, fetchImplementation: fetchImplementation as unknown as typeof fetch };
}

function adapter(
  fetchImplementation: typeof fetch,
  overrides: Partial<VivaClientPhoneLookupOptions> = {},
): VivaClientPhoneLookupAdapter {
  return new VivaClientPhoneLookupAdapter({
    mode: 'production',
    apiBaseUrl: 'https://viva.example.test',
    apiKey: 'server-only-key',
    timeoutMs: 500,
    maxAttempts: 2,
    retryBaseDelayMs: 1,
    circuitFailureThreshold: 5,
    circuitResetMs: 30_000,
    sleep: () => Promise.resolve(),
    now: () => 0,
    fetchImplementation,
    ...overrides,
  });
}

const lookup = (subject: VivaClientPhoneLookupAdapter, phoneE164 = PHONE) =>
  subject.lookup({ phoneE164, correlationId: 'corr-1' });

describe('VivaClientPhoneLookupAdapter', () => {
  it('matches the single exact owner among relevance near-matches', async () => {
    const double = viva({
      search: [OWNER, NEAR_A, NEAR_B],
      cards: {
        [OWNER]: { id: OWNER, phone: '79990001122' },
        [NEAR_A]: { id: NEAR_A, phone: '79990001123' },
        [NEAR_B]: { id: NEAR_B, phone: '79990001102' },
      },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'MATCHED',
      providerClientId: OWNER,
    });
    expect(double.calls[0]).toBe('GET /api/v2/search/clients?q=79990001122');
    expect(double.calls).toHaveLength(4);
  });

  it('sends only GET with the server key and correlation id', async () => {
    const double = viva({
      search: [OWNER],
      cards: { [OWNER]: { id: OWNER, phone: '79990001122' } },
    });
    await lookup(adapter(double.fetchImplementation));
    const init = vi.mocked(double.fetchImplementation).mock.calls[0]?.[1];
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer server-only-key',
      'X-Correlation-ID': 'corr-1',
    });
  });

  it('accepts a card phone stored with a leading 8 or formatting', async () => {
    const double = viva({
      search: [OWNER],
      cards: { [OWNER]: { id: OWNER, phone: '8 (999) 000-11-22' } },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'MATCHED',
      providerClientId: OWNER,
    });
  });

  it('is NOT_FOUND when no candidate card carries the exact phone', async () => {
    const double = viva({
      search: [NEAR_A, NEAR_B],
      cards: {
        [NEAR_A]: { id: NEAR_A, phone: '79990001123' },
        [NEAR_B]: { id: NEAR_B, phone: null },
      },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
  });

  it('is NOT_FOUND for an empty search result without reading any card', async () => {
    const double = viva({ search: [] });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
    expect(double.calls).toHaveLength(1);
  });

  it('ignores a deleted client with the exact phone', async () => {
    const double = viva({
      search: [OWNER, NEAR_A],
      cards: {
        [OWNER]: { id: OWNER, phone: '79990001122', deleted: true },
        [NEAR_A]: { id: NEAR_A, phone: '79990001122' },
      },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'MATCHED',
      providerClientId: NEAR_A,
    });
  });

  it('is AMBIGUOUS when two active clients share the exact phone', async () => {
    const double = viva({
      search: [OWNER, NEAR_A],
      cards: {
        [OWNER]: { id: OWNER, phone: '79990001122' },
        [NEAR_A]: { id: NEAR_A, phone: '+7 999 000 11 22' },
      },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'AMBIGUOUS',
    });
  });

  it('is AMBIGUOUS when the search page may be truncated', async () => {
    const ids = Array.from(
      { length: CLIENT_SEARCH_PAGE_LIMIT },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const double = viva({ search: ids });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'AMBIGUOUS',
    });
    expect(double.calls).toHaveLength(1);
  });

  it('is AMBIGUOUS above the candidate budget without reading cards', async () => {
    const ids = Array.from(
      { length: 6 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const double = viva({ search: ids });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'AMBIGUOUS',
    });
    expect(double.calls).toHaveLength(1);
  });

  it('deduplicates repeated candidates', async () => {
    const double = viva({
      search: [OWNER, OWNER.toUpperCase()],
      cards: { [OWNER]: { id: OWNER, phone: '79990001122' } },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'MATCHED',
      providerClientId: OWNER,
    });
    expect(double.calls).toHaveLength(2);
  });

  it('fails closed when a card has no phone field at all', async () => {
    const double = viva({
      search: [OWNER, NEAR_A],
      cards: {
        [OWNER]: { id: OWNER, phone: '79990001122' },
        [NEAR_A]: { id: NEAR_A },
      },
    });
    await expect(lookup(adapter(double.fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_RESPONSE_INVALID',
    });
  });

  it('returns the client id exactly as Viva wrote it', async () => {
    const upper = OWNER.toUpperCase();
    const double = viva({
      search: [upper],
      cards: { [upper]: { id: upper, phone: '79990001122' } },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'MATCHED',
      providerClientId: upper,
    });
  });

  it('fails closed when a card names a different client', async () => {
    const double = viva({
      search: [OWNER],
      cards: { [OWNER]: { id: NEAR_A, phone: '79990001122' } },
    });
    await expect(lookup(adapter(double.fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_RESPONSE_INVALID',
    });
  });

  it('fails closed on a non-UUID candidate or a malformed search body', async () => {
    const bad = viva({ search: ['not-a-uuid'] });
    await expect(lookup(adapter(bad.fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_RESPONSE_INVALID',
    });
    const malformed = viva({ search: () => json({ content: [] }) });
    await expect(lookup(adapter(malformed.fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_RESPONSE_INVALID',
    });
  });

  it('fails closed, not NOT_FOUND, when a candidate card is unavailable', async () => {
    const double = viva({
      search: [OWNER, NEAR_A],
      cards: { [OWNER]: { id: OWNER, phone: '79990001122' } },
    });
    await expect(lookup(adapter(double.fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_UNAVAILABLE',
      status: 404,
      retryable: false,
    });
  });

  it('retries 429 once and then succeeds', async () => {
    let first = true;
    const double = viva({
      search: () => {
        if (first) {
          first = false;
          return json({}, 429);
        }
        return json([]);
      },
    });
    await expect(lookup(adapter(double.fetchImplementation))).resolves.toEqual({
      kind: 'NOT_FOUND',
    });
    expect(double.calls).toHaveLength(2);
  });

  it('does not retry 401/403', async () => {
    const double = viva({ search: () => json({}, 403) });
    await expect(lookup(adapter(double.fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_UNAVAILABLE',
      status: 403,
    });
    expect(double.calls).toHaveLength(1);
  });

  it('maps an aborted request to TIMEOUT', async () => {
    const fetchImplementation = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;
    await expect(lookup(adapter(fetchImplementation))).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_TIMEOUT',
    });
  });

  it('opens the circuit after repeated failures', async () => {
    const double = viva({ search: () => json({}, 503) });
    const subject = adapter(double.fetchImplementation, {
      maxAttempts: 1,
      circuitFailureThreshold: 2,
    });
    await expect(lookup(subject)).rejects.toBeInstanceOf(VivaClientPhoneLookupError);
    await expect(lookup(subject)).rejects.toBeInstanceOf(VivaClientPhoneLookupError);
    await expect(lookup(subject)).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_CIRCUIT_OPEN',
    });
    expect(double.calls).toHaveLength(2);
  });

  it('rejects a non-Russian or malformed phone before any request', async () => {
    const double = viva({ search: [] });
    await expect(lookup(adapter(double.fetchImplementation), '79990001122')).rejects.toMatchObject({
      code: 'CLIENT_PHONE_LOOKUP_PHONE_INVALID',
    });
    await expect(
      lookup(adapter(double.fetchImplementation), '+4915112345678'),
    ).rejects.toMatchObject({ code: 'CLIENT_PHONE_LOOKUP_PHONE_INVALID' });
    expect(double.calls).toHaveLength(0);
  });

  it('is disabled outside sandbox/production', async () => {
    const double = viva({ search: [] });
    await expect(
      lookup(adapter(double.fetchImplementation, { mode: 'mock', apiBaseUrl: '', apiKey: '' })),
    ).rejects.toMatchObject({ code: 'CLIENT_PHONE_LOOKUP_DISABLED' });
    expect(double.calls).toHaveLength(0);
  });

  it('requires credentials and a bare https origin', () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;
    expect(() => adapter(fetchImplementation, { apiKey: '' })).toThrow(
      'VIVA_CLIENT_PHONE_LOOKUP_CREDENTIALS_REQUIRED',
    );
    expect(() => adapter(fetchImplementation, { apiBaseUrl: 'http://viva.example.test' })).toThrow(
      'VIVA_CLIENT_PHONE_LOOKUP_BASE_URL_INVALID',
    );
    expect(() =>
      adapter(fetchImplementation, { apiBaseUrl: 'https://viva.example.test/api' }),
    ).toThrow('VIVA_CLIENT_PHONE_LOOKUP_BASE_URL_INVALID');
  });
});
