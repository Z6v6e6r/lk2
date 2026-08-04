import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCommunityRealtimeTransport,
  type CommunityRealtimeLifecycle,
  type CommunityRealtimeSocket,
} from './community-realtime-transport.js';

const firstCommunityId = '11111111-1111-4111-8111-111111111111';
const secondCommunityId = '22222222-2222-4222-8222-222222222222';
const url = 'wss://staging.padlhub.test/realtime/v1/local-padel';

class FakeSocket implements CommunityRealtimeSocket {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  public onclose: ((event: { readonly code: number }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly sent: string[] = [];
  public readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason ? { reason } : {}) });
  }

  public open(): void {
    this.onopen?.();
  }

  public message(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  public closed(code: number): void {
    this.onclose?.({ code });
  }
}

function lifecycle() {
  let online = true;
  let visible = true;
  const onlineListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();
  const value: CommunityRealtimeLifecycle = {
    isOnline: () => online,
    isVisible: () => visible,
    now: () => Date.now(),
    random: () => 0.5,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
    onOnline(callback) {
      onlineListeners.add(callback);
      return () => onlineListeners.delete(callback);
    },
    onVisibilityChange(callback) {
      visibilityListeners.add(callback);
      return () => visibilityListeners.delete(callback);
    },
  };
  return {
    value,
    setOnline(next: boolean) {
      online = next;
      for (const listener of onlineListeners) listener();
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of visibilityListeners) listener();
    },
  };
}

function ticket(value: string) {
  return { ticket: value.repeat(64), expiresAt: new Date(Date.now() + 30_000).toISOString() };
}

function ready() {
  return { type: 'connection.ready', communitySubscriptions: true };
}

function subscribed(communityId: string, latestSequence = 0) {
  return {
    type: 'community.subscribed',
    communityId,
    communityRevision: 7,
    membershipRevision: 4,
    latestSequence,
    delivery: 'DURABLE_SEQUENCE_HTTP_RECOVERY',
  };
}

function event(communityId: string, sequence: number) {
  return {
    type: 'community.event',
    communityId,
    sequence,
    eventType: 'community.post.edited.v1',
    targetType: 'POST',
    targetId: '33333333-3333-4333-8333-333333333333',
    targetRevision: 3,
    targetStatus: 'PUBLISHED',
    occurredAt: '2026-08-04T12:00:00.000Z',
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Community realtime session transport', () => {
  it('is lazy and multiplexes dynamic community subscriptions over one credential-free socket', async () => {
    const sockets: FakeSocket[] = [];
    const issueTicket = vi.fn().mockResolvedValue(ticket('a'));
    const firstSubscribed = vi.fn();
    const secondSubscribed = vi.fn();
    const firstHint = vi.fn();
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: (requestedUrl) => {
        expect(requestedUrl).toBe(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
    });

    transport.start();
    expect(issueTicket).not.toHaveBeenCalled();
    const unwatchFirst = transport.subscribe(firstCommunityId, {
      onSubscribed: firstSubscribed,
      onHint: firstHint,
    });
    const unwatchSecond = transport.subscribe(secondCommunityId, {
      onSubscribed: secondSubscribed,
      onHint: vi.fn(),
    });
    await flush();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0] as FakeSocket;
    socket.open();
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      type: 'authenticate',
      ticket: 'a'.repeat(64),
    });
    socket.message(ready());
    await flush();
    expect(socket.sent.slice(1).map(parseJson)).toEqual([
      { type: 'community.subscribe', communityId: firstCommunityId },
      { type: 'community.subscribe', communityId: secondCommunityId },
    ]);
    socket.message(subscribed(firstCommunityId, 12));
    socket.message(subscribed(secondCommunityId, 4));
    socket.message(event(firstCommunityId, 13));
    await flush();
    expect(firstSubscribed).toHaveBeenCalledWith({
      communityId: firstCommunityId,
      communityRevision: 7,
      membershipRevision: 4,
      latestSequence: 12,
    });
    expect(secondSubscribed).toHaveBeenCalledOnce();
    expect(firstHint).toHaveBeenCalledWith({ communityId: firstCommunityId, sequence: 13 });

    unwatchFirst();
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'community.unsubscribe',
      communityId: firstCommunityId,
    });
    expect(socket.closes).toEqual([]);
    unwatchSecond();
    expect(socket.closes).toContainEqual({ code: 1000, reason: 'No active subscriptions' });
  });

  it('serializes canonical bootstrap before a following sequence hint', async () => {
    const sockets: FakeSocket[] = [];
    let finishBootstrap: (() => void) | undefined;
    const onSubscribed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishBootstrap = resolve;
        }),
    );
    const onHint = vi.fn();
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket: vi.fn().mockImplementation(() => Promise.resolve(ticket('a'))),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
    });
    transport.subscribe(firstCommunityId, { onSubscribed, onHint });
    transport.start();
    await flush();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    socket.message(ready());
    await flush();
    socket.message(subscribed(firstCommunityId, 12));
    socket.message(event(firstCommunityId, 13));
    await flush();
    expect(onSubscribed).toHaveBeenCalledOnce();
    expect(onHint).not.toHaveBeenCalled();
    finishBootstrap?.();
    await flush();
    expect(onHint).toHaveBeenCalledWith({ communityId: firstCommunityId, sequence: 13 });
  });

  it('uses a new one-time ticket after bounded exponential reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const issueTicket = vi
      .fn()
      .mockResolvedValueOnce(ticket('a'))
      .mockResolvedValueOnce(ticket('b'));
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
      baseReconnectDelayMs: 500,
      maximumReconnectDelayMs: 2_000,
      authReconnectDelayMs: 2_000,
      jitterRatio: 0,
    });
    transport.subscribe(firstCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    await flush();
    sockets[0]?.closed(1006);
    await vi.advanceTimersByTimeAsync(499);
    expect(issueTicket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(issueTicket).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it('backs off at least 60 seconds after a rate-limit frame', async () => {
    const sockets: FakeSocket[] = [];
    const issueTicket = vi.fn().mockResolvedValue(ticket('a'));
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
      jitterRatio: 0,
    });
    transport.subscribe(firstCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    await flush();
    sockets[0]?.open();
    sockets[0]?.message(ready());
    await flush();
    sockets[0]?.message({ type: 'error', code: 'REALTIME_RATE_LIMITED' });
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(issueTicket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(issueTicket).toHaveBeenCalledTimes(2);
  });

  it('uses a capacity backoff and does not reset failures merely on subscription ack', async () => {
    const sockets: FakeSocket[] = [];
    const issueTicket = vi.fn().mockResolvedValue(ticket('a'));
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
      jitterRatio: 0,
    });
    transport.subscribe(firstCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    await flush();
    sockets[0]?.closed(1013);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(issueTicket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(issueTicket).toHaveBeenCalledTimes(2);
  });

  it('moves deterministic disabled state to terminal HTTP-only mode', async () => {
    const sockets: FakeSocket[] = [];
    const issueTicket = vi.fn().mockResolvedValue(ticket('a'));
    const onUnavailable = vi.fn();
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
    });
    transport.subscribe(firstCommunityId, {
      onSubscribed: vi.fn(),
      onHint: vi.fn(),
      onUnavailable,
    });
    transport.start();
    await flush();
    sockets[0]?.open();
    sockets[0]?.message(ready());
    await flush();
    sockets[0]?.message({ type: 'error', code: 'COMMUNITIES_REALTIME_DISABLED' });
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(transport.isStarted()).toBe(false);
    expect(issueTicket).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith({
      communityId: firstCommunityId,
      code: 'COMMUNITIES_REALTIME_DISABLED',
    });
  });

  it('moves a disabled ticket response to terminal HTTP-only mode without retries', async () => {
    const issueTicket = vi.fn().mockRejectedValue({
      status: 404,
      code: 'COMMUNITIES_REALTIME_DISABLED',
    });
    const onUnavailable = vi.fn();
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => new FakeSocket(),
      lifecycle: lifecycle().value,
    });
    transport.subscribe(firstCommunityId, {
      onSubscribed: vi.fn(),
      onHint: vi.fn(),
      onUnavailable,
    });

    transport.start();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(transport.isStarted()).toBe(false);
    expect(issueTicket).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith({
      communityId: firstCommunityId,
      code: 'COMMUNITIES_REALTIME_DISABLED',
    });
  });

  it('removes only a denied community watcher without reconnecting the session socket', async () => {
    const sockets: FakeSocket[] = [];
    const denied = vi.fn();
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket: vi.fn().mockResolvedValue(ticket('a')),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
    });
    transport.subscribe(firstCommunityId, {
      onSubscribed: vi.fn(),
      onHint: vi.fn(),
      onUnavailable: denied,
    });
    transport.subscribe(secondCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    await flush();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    socket.message(ready());
    await flush();
    socket.message({
      type: 'error',
      code: 'COMMUNITY_NOT_FOUND',
      communityId: firstCommunityId,
    });
    await flush();
    expect(denied).toHaveBeenCalledOnce();
    expect(socket.closes).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it('times out a socket that never opens', async () => {
    const sockets: FakeSocket[] = [];
    const issueTicket = vi.fn().mockResolvedValue(ticket('a'));
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: lifecycle().value,
      handshakeTimeoutMs: 1_000,
      jitterRatio: 0,
    });
    transport.subscribe(firstCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets[0]?.closes).toContainEqual({ code: 1002, reason: 'Handshake timeout' });
  });

  it('does not churn a healthy socket when a mobile tab becomes hidden', async () => {
    const sockets: FakeSocket[] = [];
    const life = lifecycle();
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket: vi.fn().mockImplementation(() => Promise.resolve(ticket('a'))),
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      lifecycle: life.value,
    });
    transport.subscribe(firstCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    await flush();
    life.setVisible(false);
    expect(sockets[0]?.closes).toEqual([]);
    sockets[0]?.closed(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    life.setVisible(true);
    await flush();
    expect(sockets).toHaveLength(2);
  });

  it('stops stale ticket callbacks and requires explicit restart after repeated 4401', async () => {
    let releaseTicket: ((value: ReturnType<typeof ticket>) => void) | undefined;
    const sockets: FakeSocket[] = [];
    const fatalAuth = vi.fn();
    const issueTicket = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof ticket>>((resolve) => {
            releaseTicket = resolve;
          }),
      )
      .mockResolvedValue(ticket('b'));
    const transport = createCommunityRealtimeTransport({
      url,
      issueTicket,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onFatalAuth: fatalAuth,
      lifecycle: lifecycle().value,
      baseReconnectDelayMs: 500,
      maximumReconnectDelayMs: 1_000,
      authReconnectDelayMs: 1_000,
      jitterRatio: 0,
    });
    transport.subscribe(firstCommunityId, { onSubscribed: vi.fn(), onHint: vi.fn() });
    transport.start();
    transport.stop();
    releaseTicket?.(ticket('a'));
    await flush();
    expect(sockets).toHaveLength(0);

    transport.start();
    await flush();
    sockets[0]?.closed(4401);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    sockets[1]?.closed(4401);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fatalAuth).toHaveBeenNthCalledWith(1, { closeCode: 4401, retrying: true });
    expect(fatalAuth).toHaveBeenNthCalledWith(2, { closeCode: 4401, retrying: false });
    expect(transport.isStarted()).toBe(false);
    expect(sockets).toHaveLength(2);
  });

  it('rejects credential-bearing URLs before issuing a ticket', () => {
    const issueTicket = vi.fn();
    expect(() =>
      createCommunityRealtimeTransport({
        url: `${url}?ticket=secret`,
        issueTicket,
        createSocket: () => new FakeSocket(),
      }),
    ).toThrow('COMMUNITY_REALTIME_URL_INVALID');
    expect(issueTicket).not.toHaveBeenCalled();
  });
});
