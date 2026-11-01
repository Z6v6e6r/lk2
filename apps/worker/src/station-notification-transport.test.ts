import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createStationWebPushAgent, mapWebPushFailure } from './web-push-adapter.js';
import { FcmDeliveryAdapter } from './fcm-adapter.js';
import { ApnsDeliveryAdapter } from './apns-adapter.js';
import { stationProviderResult } from './station-notification-delivery.js';
import type { PushDeliveryRequest } from '@phub/notifications';
const request: PushDeliveryRequest = {
  tenantId: 'tenant',
  deliveryId: 'delivery',
  providerAccountId: 'provider',
  platform: 'ANDROID',
  endpoint: 'synthetic-token',
  notification: { id: 'notice', title: 'Generic', preview: 'Generic' },
  providerIdempotencyKey: 'opaque',
};
describe('station transport submission deadline', () => {
  it('FCM checks after awaited token and never fetches when expired', async () => {
    let release!: (v: string) => void;
    let valid = true;
    const token = new Promise<string>((r) => (release = r)),
      fetch = vi.fn();
    const adapter = new FcmDeliveryAdapter({
      projectId: 'padlhub',
      timeoutMs: 1000,
      accessTokenProvider: { getAccessToken: () => token },
      fetchImplementation: fetch,
    });
    const pending = adapter.send({ ...request, stationCanSubmit: () => valid });
    valid = false;
    release('synthetic');
    expect(await pending).toEqual({
      outcome: 'retryable_failure',
      errorCode: 'STATION_NOT_SUBMITTED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('APNs waits for connection, then expiry forbids request headers', async () => {
    const session = Object.assign(new EventEmitter(), { request: vi.fn(), destroy: vi.fn() });
    let valid = true;
    const adapter = new ApnsDeliveryAdapter({
      topic: 'ru.padlhub.app',
      environment: 'SANDBOX',
      timeoutMs: 1000,
      tokenProvider: { getToken: () => 'synthetic', invalidate: vi.fn() },
      connectImplementation: vi.fn(() => session) as never,
    });
    const pending = adapter.send({
      ...request,
      platform: 'IOS',
      endpoint: 'a'.repeat(64),
      stationCanSubmit: () => valid,
    });
    expect(session.request).not.toHaveBeenCalled();
    valid = false;
    session.emit('connect');
    expect(await pending).toEqual({
      outcome: 'retryable_failure',
      errorCode: 'STATION_NOT_SUBMITTED',
    });
    expect(session.request).not.toHaveBeenCalled();
  });
  it('Web waits for secure socket, destroys expired one, callback once; forged code not proof', () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      callback = vi.fn();
    let valid = true;
    const agent = createStationWebPushAgent(() => valid, vi.fn(() => socket) as never);
    agent.createConnection({}, callback);
    expect(callback).not.toHaveBeenCalled();
    valid = false;
    socket.emit('secureConnect');
    socket.emit('secureConnect');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalled();
    expect(mapWebPushFailure(callback.mock.calls[0]![0])).toMatchObject({
      errorCode: 'STATION_NOT_SUBMITTED',
    });
    expect(
      mapWebPushFailure(Object.assign(new Error('fake'), { code: 'STATION_NOT_SUBMITTED' })),
    ).toMatchObject({ errorCode: 'WEB_PUSH_NETWORK_FAILURE' });
    agent.destroy();
  });
  it('Web hands fresh socket over once', () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() }),
      cb = vi.fn();
    const agent = createStationWebPushAgent(() => true, vi.fn(() => socket) as never);
    agent.createConnection({}, cb);
    socket.emit('secureConnect');
    expect(cb).toHaveBeenCalledWith(null, socket);
    agent.destroy();
  });
  it.each([
    'FCM_NETWORK_FAILURE',
    'FCM_PROVIDER_RETRYABLE',
    'WEB_PUSH_PROVIDER_RETRYABLE',
    'WEB_PUSH_NETWORK_FAILURE',
    'APNS_OUTCOME_UNKNOWN',
    'NEW_CODE',
  ])('does not resend ambiguous %s', (errorCode) =>
    expect(stationProviderResult({ outcome: 'retryable_failure', errorCode })).toEqual({
      outcome: 'terminal_failure',
      errorCode: 'STATION_PROVIDER_OUTCOME_UNKNOWN',
      invalidate: false,
    }),
  );
  it('Web TLS preparation timeout proves no handoff rather than hanging outside request timeout', async () => {
    vi.useFakeTimers();
    try {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() }),
        cb = vi.fn();
      const agent = createStationWebPushAgent(() => true, vi.fn(() => socket) as never);
      agent.createConnection({}, cb);
      await vi.advanceTimersByTimeAsync(5000);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(mapWebPushFailure(cb.mock.calls[0]![0])).toMatchObject({
        errorCode: 'STATION_NOT_SUBMITTED',
      });
      socket.emit('secureConnect');
      expect(cb).toHaveBeenCalledTimes(1);
      agent.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
  function fcmHarness() {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    let response!: (res: EventEmitter) => void;
    let handoff: ((error: Error | null) => void) | undefined;
    const sent = vi.fn();
    const req = Object.assign(new EventEmitter(), {
      end: vi.fn(),
    });
    const requestImpl = vi.fn(
      (
        _url: string,
        options: { agent: ReturnType<typeof createStationWebPushAgent> },
        cb: (res: EventEmitter) => void,
      ) => {
        response = cb;
        handoff = (error) => {
          if (error) req.emit('error', error);
          else sent();
        };
        options.agent.createConnection({}, handoff);
        return req;
      },
    );
    const reply = () => {
      const res = Object.assign(new EventEmitter(), {
        headers: {},
        statusCode: 200,
        destroy: vi.fn(),
      });
      response(res);
      res.emit('data', Buffer.from(JSON.stringify({ name: 'projects/p/messages/accepted' })));
      res.emit('end');
    };
    const make = () =>
      new FcmDeliveryAdapter({
        projectId: 'padlhub',
        timeoutMs: 1000,
        accessTokenProvider: { getAccessToken: () => Promise.resolve('synthetic') },
        stationRequestImplementation: requestImpl as never,
        stationConnectImplementation: vi.fn(() => socket) as never,
        fetchImplementation: vi.fn(() => {
          throw Error('ordinary fetch must not run');
        }),
      });
    return { make, socket, sent, reply, req, requestImpl };
  }
  it('FCM deferred TLS cannot submit after authority expiry', async () => {
    let valid = true;
    const h = fcmHarness();
    const pending = h.make().send({ ...request, stationCanSubmit: () => valid });
    await Promise.resolve();
    expect(h.requestImpl).toHaveBeenCalledTimes(1);
    expect(h.sent).not.toHaveBeenCalled();
    valid = false;
    h.socket.emit('secureConnect');
    expect(await pending).toMatchObject({ errorCode: 'STATION_NOT_SUBMITTED' });
    expect(h.sent).not.toHaveBeenCalled();
    expect(h.socket.destroy).toHaveBeenCalled();
  });
  it('FCM ready socket sends once and preserves existing accepted response parsing', async () => {
    const h = fcmHarness();
    const pending = h.make().send({ ...request, stationCanSubmit: () => true });
    await Promise.resolve();
    h.socket.emit('secureConnect');
    h.reply();
    expect(await pending).toEqual({
      outcome: 'accepted',
      externalMessageId: 'projects/p/messages/accepted',
    });
    expect(h.sent).toHaveBeenCalledTimes(1);
  });
  it('FCM expiry after socket handoff is UNKNOWN even with late success', async () => {
    let valid = true;
    const h = fcmHarness();
    const pending = h.make().send({ ...request, stationCanSubmit: () => valid });
    await Promise.resolve();
    h.socket.emit('secureConnect');
    valid = false;
    h.reply();
    expect(await pending).toMatchObject({ errorCode: 'STATION_PROVIDER_OUTCOME_UNKNOWN' });
    expect(h.sent).toHaveBeenCalledTimes(1);
  });
  it('FCM timeout after handoff remains ambiguous and never manufactures no-submission proof', async () => {
    vi.useFakeTimers();
    try {
      const h = fcmHarness();
      const pending = h.make().send({ ...request, stationCanSubmit: () => true });
      await Promise.resolve();
      h.socket.emit('secureConnect');
      await vi.advanceTimersByTimeAsync(1000);
      expect(stationProviderResult(await pending)).toMatchObject({
        errorCode: 'STATION_PROVIDER_OUTCOME_UNKNOWN',
      });
      expect(h.sent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
