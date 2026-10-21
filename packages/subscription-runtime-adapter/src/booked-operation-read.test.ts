import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  BookedOperationReadClient,
  BookedOperationReadError,
  parseBookedOperationReadOutcome,
} from './booked-operation-read.js';

const operationId = randomUUID();
const envelope = {
  actorDelegation: 'synthetic-delegation',
  correlationId: 'b1-synthetic-correlation',
};
const outcome = {
  contractVersion: 1,
  operationId,
  status: 'UNKNOWN',
  asOf: null,
  reason: 'RECONCILIATION_REQUIRED',
};
function client(
  fetchImplementation: typeof fetch,
  onMetric?: (outcome: 'success' | 'not_found' | 'failure' | 'circuit_open') => void,
) {
  return new BookedOperationReadClient({
    baseUrl: 'https://owner.example.test',
    timeoutMs: 100,
    environment: 'production',
    fetchImplementation,
    ...(onMetric ? { onMetric } : {}),
  });
}

describe('bounded commercial receipt GET client', () => {
  it.each([
    'http://owner.example.test',
    'https://owner.example.test/path',
    'https://owner.example.test/?token=x',
  ])('rejects unsafe owner configuration %s', (baseUrl) => {
    expect(
      () => new BookedOperationReadClient({ baseUrl, timeoutMs: 100, environment: 'production' }),
    ).toThrow(BookedOperationReadError);
  });
  it('rejects synthetic URL userinfo before any request', () => {
    const url = new URL('https://owner.example.test');
    url.username = randomUUID();
    url.password = randomUUID();
    expect(
      () =>
        new BookedOperationReadClient({
          baseUrl: url.toString(),
          timeoutMs: 100,
          environment: 'production',
        }),
    ).toThrow(BookedOperationReadError);
  });
  it('opens circuit after three failures without any retry or creation fallback', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('synthetic transport error'));
    const metrics =
      vi.fn<(outcome: 'success' | 'not_found' | 'failure' | 'circuit_open') => void>();
    const read = client(fetchImplementation, metrics);
    for (let i = 0; i < 4; i++)
      await expect(read.read(operationId, envelope)).rejects.toMatchObject({ status: 503 });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(metrics.mock.calls.map(([outcome]) => outcome)).toEqual([
      'failure',
      'failure',
      'failure',
      'circuit_open',
    ]);
    for (const [, request] of fetchImplementation.mock.calls) {
      expect(request?.method).toBe('GET');
      expect(request?.body).toBeUndefined();
      expect(request?.redirect).toBe('error');
    }
  });
  it('bounds the entire body read and aborts timed-out transport', async () => {
    const stalled = vi.fn<typeof fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('synthetic abort')), {
            once: true,
          });
        }),
    );
    await expect(client(stalled).read(operationId, envelope)).rejects.toMatchObject({
      status: 503,
    });
    expect(stalled).toHaveBeenCalledTimes(1);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2049)));
    await expect(client(large).read(operationId, envelope)).rejects.toMatchObject({ status: 503 });
  });
  it('keeps not-found separate and ignores telemetry failures', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json(outcome));
    const read = client(fetchImplementation, () => {
      throw new Error('synthetic telemetry error');
    });
    await expect(read.read(operationId, envelope)).rejects.toMatchObject({ status: 404 });
    expect(await read.read(operationId, envelope)).toEqual(outcome);
  });
  it.each([404, 401, 500])('cancels the body of HTTP %s before returning', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status }));
    await expect(client(fetchImplementation).read(operationId, envelope)).rejects.toMatchObject({
      status: status === 404 ? 404 : 503,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...outcome, bookingId: 'private' },
    { ...outcome, reason: 'raw error' },
    { ...outcome, status: 'FAILED' },
    { ...outcome, operationId: randomUUID() },
    { ...outcome, status: 'CONFIRMED', reason: 'OWNER_BOOKING_CONFIRMED', asOf: null },
  ])('rejects invalid or private owner DTO', (invalid) => {
    expect(() => parseBookedOperationReadOutcome(invalid, operationId)).toThrow(
      BookedOperationReadError,
    );
  });
});
