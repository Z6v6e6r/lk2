import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BookedOperationAdmissionClient,
  BookedOperationAdmissionError,
  bookedOperationAdmissionRequestSha256,
  parseBookedOperationAdmissionRequest,
} from './booked-operation-admission.js';
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
const ACTOR_TOKEN = ['synthetic', 'actor', 'token', 'value'].join('-');
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
  it('forwards the user-scoped actor token only when the envelope carries it', async () => {
    const captured: Array<HeadersInit | undefined> = [];
    const transport = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      captured.push(init?.headers);
      return Promise.resolve(Response.json(outcome, { status: 202 }));
    });

    await fixture(transport).admit(body, envelope);
    expect(new Headers(captured[0]).get('x-subscription-actor-token')).toBeNull();

    captured.length = 0;
    await fixture(transport).admit(body, {
      ...envelope,
      actorToken: { token: ACTOR_TOKEN, expiresAt: '2026-08-01T10:00:30.000Z' },
    });
    expect(new Headers(captured[0]).get('x-subscription-actor-token')).toBe(ACTOR_TOKEN);
  });

  it('refuses a malformed actor token envelope before any request', async () => {
    for (const actorToken of [
      { token: 'has space', expiresAt: '2026-08-01T10:00:30.000Z' },
      { token: ACTOR_TOKEN, expiresAt: 'not-an-instant' },
      { token: ACTOR_TOKEN, expiresAt: '2026-08-01T10:00:30Z' },
    ]) {
      const transport = vi.fn<typeof fetch>();
      await expect(
        fixture(transport).admit(body, { ...envelope, actorToken }),
      ).rejects.toMatchObject({ status: 400 });
      expect(transport).not.toHaveBeenCalled();
    }
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

describe('booked admission wire request', () => {
  const joinRequest = {
    action: 'JOIN_GAME' as const,
    target: { id: '0f0e0d0c-0b0a-4b0a-8b0a-0f0e0d0c0b0a', expectedRevision: 3 },
    paymentIntent: 'USE_SUBSCRIPTION' as const,
  };
  const createRequest = { ...joinRequest, action: 'CREATE_GAME' as const };
  it('accepts the frozen CREATE_GAME shape with the same allowlist as JOIN_GAME', () => {
    expect(parseBookedOperationAdmissionRequest(joinRequest)).toEqual(joinRequest);
    expect(parseBookedOperationAdmissionRequest(createRequest)).toEqual(createRequest);
    for (const expectedRevision of [1, 2, 7, Number.MAX_SAFE_INTEGER])
      expect(
        parseBookedOperationAdmissionRequest({
          ...createRequest,
          target: { ...createRequest.target, expectedRevision },
        }),
      ).toMatchObject({ action: 'CREATE_GAME', target: { expectedRevision } });
  });
  it('rejects anything outside the strict action/target/key allowlist with the same 400', () => {
    const values: unknown[] = [
      null,
      [],
      'CREATE_GAME',
      {},
      { ...createRequest, action: 'BOOK_GROUP_TRAINING' },
      { ...createRequest, action: 'create_game' },
      { ...createRequest, action: undefined },
      {
        ...createRequest,
        target: { ...createRequest.target, id: createRequest.target.id.toUpperCase() },
      },
      { ...createRequest, target: { ...createRequest.target, id: 'not-a-uuid' } },
      {
        ...createRequest,
        target: { ...createRequest.target, id: '0f0e0d0c-0b0a-0b0a-8b0a-0f0e0d0c0b0a' },
      },
      { ...createRequest, target: { ...createRequest.target, expectedRevision: 0 } },
      { ...createRequest, target: { ...createRequest.target, expectedRevision: -1 } },
      { ...createRequest, target: { ...createRequest.target, expectedRevision: 1.5 } },
      { ...createRequest, target: { ...createRequest.target, expectedRevision: '1' } },
      {
        ...createRequest,
        target: { ...createRequest.target, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      },
      { ...createRequest, target: { ...createRequest.target, providerId: 'guessed' } },
      { ...createRequest, target: { ...createRequest.target, kind: 'GAME' } },
      { ...createRequest, operationId: randomUUID() },
      { ...createRequest, paymentIntent: 'PAY' },
      { action: 'CREATE_GAME', target: createRequest.target },
      { action: 'CREATE_GAME', paymentIntent: 'USE_SUBSCRIPTION', target: null },
    ];
    for (const value of values)
      expect(() => parseBookedOperationAdmissionRequest(value)).toThrow(
        BookedOperationAdmissionError,
      );
    for (const value of values)
      try {
        parseBookedOperationAdmissionRequest(value);
        expect.unreachable('Malformed request must be rejected');
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
      }
  });
  it('keeps the JOIN_GAME digest byte-identical and separates CREATE_GAME', () => {
    const canonical = JSON.stringify({
      action: 'JOIN_GAME',
      target: { id: joinRequest.target.id, expectedRevision: 3 },
      paymentIntent: 'USE_SUBSCRIPTION',
    });
    const expectedJoinSha256 = `sha256:${createHash('sha256')
      .update(`booked-operation-admission:v1\0${canonical}`, 'utf8')
      .digest('hex')}`;
    expect(bookedOperationAdmissionRequestSha256(joinRequest)).toBe(
      'sha256:20f14d7af2260a27606ee1418c5051814c32a3100d76e2d75da234d14711bb0a',
    );
    expect(bookedOperationAdmissionRequestSha256(joinRequest)).toBe(expectedJoinSha256);
    expect(bookedOperationAdmissionRequestSha256(createRequest)).not.toBe(expectedJoinSha256);
    expect(bookedOperationAdmissionRequestSha256(createRequest)).toBe(
      'sha256:64ea19192651e6e78977baf9202dd967dce3585d23bd979d1e872af914a41ffa',
    );
  });
});
