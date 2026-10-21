import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookedOperationAdmissionClient } from './booked-operation-admission.js';
const operationId = randomUUID(),
  body = {
    action: 'JOIN_GAME' as const,
    target: { id: randomUUID(), expectedRevision: 1 },
    paymentIntent: 'USE_SUBSCRIPTION' as const,
  };
const envelope = {
  operationId,
  actorDelegation: 'synthetic-delegation',
  correlationId: 'b1-synthetic-correlation',
};
const outcome = {
  contractVersion: 1,
  operationId,
  status: 'PENDING',
  asOf: '2026-10-06T08:00:00.000Z',
  reason: 'OWNER_PENDING',
};
function fixture(fetchImplementation: typeof fetch, timeoutMs = 100) {
  return new BookedOperationAdmissionClient({
    baseUrl: 'https://owner.example.test',
    environment: 'production',
    timeoutMs,
    fetchImplementation,
  });
}
afterEach(() => vi.useRealTimers());
describe('admission bounded transport', () => {
  it('never retries a failed writer and rejects wrong operation or completion claims', async () => {
    for (const response of [
      Response.json(outcome, { status: 503 }),
      Response.json({ ...outcome, operationId: randomUUID() }, { status: 202 }),
      Response.json(
        { ...outcome, status: 'CONFIRMED', reason: 'OWNER_BOOKING_CONFIRMED' },
        { status: 202 },
      ),
      Response.json(outcome, { status: 200 }),
    ]) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(fixture(transport).admit(body, envelope)).rejects.toMatchObject({ status: 503 });
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const conflict = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 409 }));
    await expect(fixture(conflict).admit(body, envelope)).rejects.toMatchObject({ status: 409 });
    expect(conflict).toHaveBeenCalledTimes(1);
  });
  it('bounds response bytes and cancels the body', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(2049)));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      fixture(() => Promise.resolve(new Response(stream, { status: 202 }))).admit(body, envelope),
    ).rejects.toMatchObject({ status: 503 });
    expect(cancelled).toBe(true);
  });
  it('hard deadline bounds transports and body reads that ignore abort', async () => {
    const signals: AbortSignal[] = [];
    for (const transport of [
      (async (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise(() => {});
      }) as typeof fetch,
      (() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
            }),
            { status: 202 },
          ),
        )) as typeof fetch,
    ]) {
      const start = Date.now();
      signals.length = 0;
      await expect(fixture(transport).admit(body, envelope)).rejects.toMatchObject({ status: 503 });
      expect(Date.now() - start).toBeLessThan(1000);
      for (const signal of signals) expect(signal.aborted).toBe(true);
    }
  });
  it('opens after three failures, permits only one half-open probe and closes on success', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>().mockRejectedValue(Error('Synthetic unavailable'));
    const client = fixture(transport);
    for (let i = 0; i < 3; i++)
      await expect(client.admit(body, envelope)).rejects.toMatchObject({ status: 503 });
    await expect(client.admit(body, envelope)).rejects.toMatchObject({ status: 503 });
    expect(transport).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10001);
    let resolve: (r: Response) => void = () => {};
    transport.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const probe = client.admit(body, envelope);
    await expect(client.admit(body, envelope)).rejects.toMatchObject({ status: 503 });
    expect(transport).toHaveBeenCalledTimes(4);
    resolve(Response.json(outcome, { status: 202 }));
    await expect(probe).resolves.toEqual(outcome);
    transport.mockResolvedValueOnce(Response.json(outcome, { status: 202 }));
    await expect(client.admit(body, envelope)).resolves.toEqual(outcome);
  });
  it('rejects insecure or credential-bearing owner URLs', () => {
    for (const baseUrl of [
      'http://owner.example.test',
      'https://secret@owner.example.test',
      'https://owner.example.test/path',
      'https://owner.example.test/?key=secret',
    ])
      expect(
        () =>
          new BookedOperationAdmissionClient({
            baseUrl,
            environment: 'production',
            timeoutMs: 100,
          }),
      ).toThrow();
  });
});
