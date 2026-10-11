import { describe, expect, it, vi } from 'vitest';

import { FcmDeliveryAdapter } from './fcm-adapter.js';
import { buildFcmData } from './fcm-delivery.js';

const request = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  deliveryId: '22222222-2222-4222-8222-222222222222',
  providerAccountId: '33333333-3333-4333-8333-333333333333',
  platform: 'ANDROID' as const,
  endpoint: 'opaque-fcm-token',
  notification: {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'ПадлХАБ',
    preview: 'Новое уведомление',
  },
  data: {
    endpointId: '55555555-5555-4555-8555-555555555555',
    deliveryId: '22222222-2222-4222-8222-222222222222',
    notificationId: '44444444-4444-4444-8444-444444444444',
  },
  providerIdempotencyKey: 'fcm:test',
};
function adapter(fetchImplementation: typeof fetch) {
  return new FcmDeliveryAdapter({
    projectId: 'padlhub',
    timeoutMs: 1_000,
    accessTokenProvider: { getAccessToken: vi.fn().mockResolvedValue('access-token') },
    fetchImplementation,
  });
}
describe('FCM adapter', () => {
  it('keeps account identity out of the provider-visible data envelope', () => {
    expect(
      buildFcmData({
        endpointId: 'endpoint',
        deliveryId: 'delivery',
        notificationId: 'notification',
        deepLink: '/notifications',
      }),
    ).toEqual({
      endpointId: 'endpoint',
      deliveryId: 'delivery',
      notificationId: 'notification',
      deepLink: '/notifications',
    });
  });
  it('sends data-only opaque identifiers and no visible notification payload', async () => {
    let sentBody: string | undefined;
    const fetchImplementation: typeof fetch = (_input, init) => {
      sentBody = typeof init?.body === 'string' ? init.body : undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ name: 'projects/p/messages/1' }), { status: 200 }),
      );
    };
    await expect(adapter(fetchImplementation).send(request)).resolves.toEqual({
      outcome: 'accepted',
      externalMessageId: 'projects/p/messages/1',
    });
    const body = JSON.parse(sentBody ?? '{}') as {
      message?: { token?: string; data?: unknown; notification?: unknown };
    };
    expect(body.message).toEqual(
      expect.objectContaining({ token: request.endpoint, data: request.data }),
    );
    expect(body.message?.notification).toBeUndefined();
  });
  it('invalidates only explicit UNREGISTERED responses', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      }),
      { status: 404 },
    );
    await expect(adapter(vi.fn().mockResolvedValue(response)).send(request)).resolves.toMatchObject(
      { invalidate: true, errorCode: 'FCM_TOKEN_UNREGISTERED' },
    );
    await expect(
      adapter(vi.fn().mockResolvedValue(new Response('{}', { status: 404 }))).send(request),
    ).resolves.toMatchObject({ invalidate: false, errorCode: 'FCM_PROVIDER_REJECTED' });
  });
  it.each([
    [401, 'FCM_AUTH_REJECTED'],
    [403, 'FCM_AUTH_REJECTED'],
    [429, 'FCM_PROVIDER_RETRYABLE'],
    [503, 'FCM_PROVIDER_RETRYABLE'],
  ])('classifies HTTP %i without leaking provider payloads', async (status, errorCode) => {
    await expect(
      adapter(
        vi.fn().mockResolvedValue(new Response('{"secret":"never logged"}', { status })),
      ).send(request),
    ).resolves.toMatchObject({ outcome: 'retryable_failure', errorCode });
  });
  it('classifies an aborted provider call as retryable', async () => {
    const fetchImplementation = vi
      .fn()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(adapter(fetchImplementation).send(request)).resolves.toEqual({
      outcome: 'retryable_failure',
      errorCode: 'FCM_NETWORK_FAILURE',
    });
  });
  it('invalidates the cached OAuth token only after HTTP 401', async () => {
    const invalidateAccessToken = vi.fn();
    const subject = new FcmDeliveryAdapter({
      projectId: 'padlhub',
      timeoutMs: 1_000,
      accessTokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue('cached-token'),
        invalidateAccessToken,
      },
      fetchImplementation: vi.fn().mockResolvedValue(new Response('{}', { status: 401 })),
    });
    await subject.send(request);
    expect(invalidateAccessToken).toHaveBeenCalledWith('cached-token');
    const forbidden = new FcmDeliveryAdapter({
      projectId: 'padlhub',
      timeoutMs: 1_000,
      accessTokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue('cached-token'),
        invalidateAccessToken,
      },
      fetchImplementation: vi.fn().mockResolvedValue(new Response('{}', { status: 403 })),
    });
    await forbidden.send(request);
    expect(invalidateAccessToken).toHaveBeenCalledTimes(1);
  });
  it.each([
    { label: 'malformed', response: new Response('{', { status: 401 }) },
    {
      label: 'oversized',
      response: {
        status: 401,
        headers: new Headers({ 'content-length': '999999' }),
        body: { cancel: vi.fn().mockResolvedValue(undefined), getReader: vi.fn() },
      } as unknown as Response,
    },
    {
      label: 'hung',
      response: {
        status: 401,
        headers: new Headers(),
        body: {
          cancel: vi.fn().mockResolvedValue(undefined),
          getReader: vi.fn(() => ({
            read: () => new Promise(() => undefined),
            cancel: vi.fn().mockResolvedValue(undefined),
          })),
        },
      } as unknown as Response,
    },
  ])('classifies $label 401 before reading a hostile response body', async ({ response }) => {
    const invalidateAccessToken = vi.fn();
    const subject = new FcmDeliveryAdapter({
      projectId: 'padlhub',
      timeoutMs: 10,
      accessTokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue('cached-token'),
        invalidateAccessToken,
      },
      fetchImplementation: vi.fn().mockResolvedValue(response),
    });
    await expect(subject.send(request)).resolves.toMatchObject({
      outcome: 'retryable_failure',
      errorCode: 'FCM_AUTH_REJECTED',
    });
    expect(invalidateAccessToken).toHaveBeenCalledWith('cached-token');
  });
  it('opens after three transient failures without calling OAuth or FCM, then recovers', async () => {
    let now = 1_000;
    const token = { getAccessToken: vi.fn().mockResolvedValue('access-token') };
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'projects/p/messages/recovered' }), { status: 200 }),
      );
    const subject = new FcmDeliveryAdapter({
      projectId: 'padlhub',
      timeoutMs: 1_000,
      accessTokenProvider: token,
      fetchImplementation,
      now: () => now,
      circuitFailureThreshold: 3,
      circuitResetMs: 30_000,
    });
    await subject.send(request);
    await subject.send(request);
    await subject.send(request);
    await expect(subject.send(request)).resolves.toMatchObject({
      errorCode: 'FCM_CIRCUIT_OPEN',
      retryAfterMs: 30_000,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(token.getAccessToken).toHaveBeenCalledTimes(3);
    now += 30_001;
    await expect(subject.send(request)).resolves.toMatchObject({ outcome: 'accepted' });
  });
});
