import webPush from 'web-push';
import { describe, expect, it, vi } from 'vitest';

import { mapWebPushFailure, WebPushDeliveryAdapter } from './web-push-adapter.js';

const { WebPushError } = webPush;

const request = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  deliveryId: '22222222-2222-4222-8222-222222222222',
  providerAccountId: '33333333-3333-4333-8333-333333333333',
  platform: 'WEB' as const,
  endpoint: JSON.stringify({
    endpoint: 'https://push.example.test/subscriptions/abc',
    expirationTime: null,
    keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) },
  }),
  notification: {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'ПаделХАБ',
    preview: 'Новое оповещение',
    deepLink: '/notifications',
  },
  providerIdempotencyKey: 'web-push-delivery-test-0001',
};

describe('Web Push delivery adapter', () => {
  it('sends only the bounded notification payload with VAPID options', async () => {
    const sendImplementation = vi.fn().mockResolvedValue({
      statusCode: 201,
      headers: {},
      body: '',
    });
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 5,
      circuitResetMs: 30_000,
      sendImplementation,
    });

    await expect(adapter.send(request)).resolves.toEqual({ outcome: 'accepted' });
    expect(JSON.parse(String(sendImplementation.mock.calls[0]?.[1]))).toEqual({
      notificationId: request.notification.id,
      title: 'ПаделХАБ',
      preview: 'Новое оповещение',
      deepLink: '/notifications',
    });
    expect(sendImplementation.mock.calls[0]?.[2]).toMatchObject({
      TTL: 300,
      timeout: 5_000,
      contentEncoding: 'aes128gcm',
      urgency: 'normal',
    });
  });

  it('invalidates gone subscriptions without logging provider response bodies', () => {
    expect(
      mapWebPushFailure(
        new WebPushError(
          'gone',
          410,
          {},
          'provider body that must not be persisted',
          request.endpoint,
        ),
      ),
    ).toEqual({
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_SUBSCRIPTION_GONE',
      invalidate: true,
    });
  });

  it('opens a provider-account circuit after bounded retryable failures and probes after reset', async () => {
    let now = 1_000;
    const sendImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ statusCode: 201, headers: {}, body: '' });
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 2,
      circuitResetMs: 30_000,
      sendImplementation,
      now: () => now,
    });

    await expect(adapter.send(request)).resolves.toMatchObject({
      outcome: 'retryable_failure',
    });
    await expect(adapter.send(request)).resolves.toMatchObject({
      outcome: 'retryable_failure',
    });
    await expect(adapter.send(request)).resolves.toEqual({
      outcome: 'retryable_failure',
      errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
    });
    expect(sendImplementation).toHaveBeenCalledTimes(2);

    now += 30_001;
    await expect(adapter.send(request)).resolves.toEqual({ outcome: 'accepted' });
    expect(sendImplementation).toHaveBeenCalledTimes(3);
  });
});
