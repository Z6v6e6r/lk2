/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';

import {
  ClientResidencyOwnerClient,
  ResidencyOwnerError,
} from './client-residency-owner-client.js';

const TOKEN = 'viva-actor-' + 'a'.repeat(40);
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const credential = { token: TOKEN, expiresAt: new Date(Date.now() + 300_000).toISOString() };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function build(fetchImplementation: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new ClientResidencyOwnerClient({
    baseUrl: 'https://padlhub.su/',
    environment: 'production',
    timeoutMs: 1_000,
    fetchImplementation,
    ...overrides,
  });
}

describe('client residency owner client', () => {
  it('sends only the actor delegation and the operation headers', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ schemaVersion: 1 }));
    const client = build(fetchImplementation);
    await client.createOrder(
      { credential, correlationId: 'corr-12345678', idempotencyKey: 'residency-key-0001' },
      { mode: 'NEW', expectedTotalMinor: 79000 },
    );
    const [url, init] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://padlhub.su/lk/residency/orders');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(headers['X-Correlation-ID']).toBe('corr-12345678');
    expect(headers['Idempotency-Key']).toBe('residency-key-0001');
    expect(headers['X-Residency-Return-Target']).toBe('lk2');
    expect(init.body).toBe(JSON.stringify({ mode: 'NEW', expectedTotalMinor: 79000 }));
    const serialized = JSON.stringify(init);
    expect(serialized.includes('PadlHub')).toBe(false);
    expect(Object.keys(headers)).not.toContain('X-Tenant-ID');
  });

  it('does not send the return target on reads or reconciles', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ schemaVersion: 1 }));
    const client = build(fetchImplementation);
    await client.readOrder({ credential, correlationId: 'corr-12345678' }, ORDER_ID);
    await client.reconcileOrder(
      { credential, correlationId: 'corr-12345678', idempotencyKey: 'residency-key-0002' },
      ORDER_ID,
      {},
    );
    const [, first] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit];
    const [, second] = fetchImplementation.mock.calls[1] as unknown as [string, RequestInit];
    expect((first.headers as Record<string, string>)['X-Residency-Return-Target']).toBeUndefined();
    expect((second.headers as Record<string, string>)['X-Residency-Return-Target']).toBeUndefined();
  });

  it('passes a stable owner refusal through with its details', async () => {
    const fetchImplementation = async () =>
      jsonResponse(
        {
          code: 'RESIDENCY_RENEWAL_TOO_EARLY',
          message: 'too early',
          details: { eligibleAt: '2026-11-23T09:05:00.000Z' },
        },
        409,
      );
    const client = build(fetchImplementation);
    await expect(
      client.createOrder(
        { credential, correlationId: 'corr-12345678', idempotencyKey: 'residency-key-0001' },
        {},
      ),
    ).rejects.toMatchObject({
      name: 'ResidencyOwnerError',
      status: 409,
      code: 'RESIDENCY_RENEWAL_TOO_EARLY',
      details: { eligibleAt: '2026-11-23T09:05:00.000Z' },
    });
  });

  it('maps an untyped upstream failure to a retryable owner-unavailable error', async () => {
    for (const response of [
      async () => jsonResponse({ code: 'SOMETHING_ELSE' }, 500),
      async () => new Response('gateway timeout', { status: 504 }),
      async () => jsonResponse({ code: 'RESIDENCY_UPSTREAM_INVALID' }, 500),
    ]) {
      const client = build(response);
      const error = await client
        .catalog({ credential, correlationId: 'corr-12345678' })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ResidencyOwnerError);
      expect((error as ResidencyOwnerError).status).toBe(503);
      expect((error as ResidencyOwnerError).code).toBe('RESIDENCY_OWNER_UNAVAILABLE');
    }
  });

  it('aborts on timeout and opens the circuit after three failures', async () => {
    let calls = 0;
    const fetchImplementation = async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    };
    const client = new ClientResidencyOwnerClient({
      baseUrl: 'https://padlhub.su/',
      environment: 'production',
      timeoutMs: 100,
      fetchImplementation,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        client.catalog({ credential, correlationId: 'corr-12345678' }),
      ).rejects.toMatchObject({ status: 503, code: 'RESIDENCY_OWNER_UNAVAILABLE' });
    }
    const afterCircuit = await client
      .catalog({ credential, correlationId: 'corr-12345678' })
      .catch((value: unknown) => value);
    expect((afterCircuit as ResidencyOwnerError).code).toBe('RESIDENCY_OWNER_UNAVAILABLE');
    expect(calls).toBe(3);
  });

  it('refuses an expired credential without calling the owner', async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({}));
    const client = build(fetchImplementation);
    await expect(
      client.catalog({
        credential: { token: TOKEN, expiresAt: new Date(Date.now() - 1_000).toISOString() },
        correlationId: 'corr-12345678',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'RESIDENCY_REAUTH_REQUIRED' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects an owner URL that could leak credentials or a path', () => {
    for (const baseUrl of [
      'https://padlhub.su/path',
      'https://user:pass@padlhub.su/',
      'https://padlhub.su/?x=1',
      'http://padlhub.su/',
      'https://example.com/',
    ]) {
      expect(
        () =>
          new ClientResidencyOwnerClient({
            baseUrl,
            environment: 'production',
            timeoutMs: 1_000,
          }),
      ).toThrow(ResidencyOwnerError);
    }
    expect(
      () =>
        new ClientResidencyOwnerClient({
          baseUrl: 'http://localhost:3000/',
          environment: 'development',
          timeoutMs: 1_000,
        }),
    ).not.toThrow();
  });
});
