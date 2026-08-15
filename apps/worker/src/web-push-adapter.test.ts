import { Agent } from 'node:https';

import webPush from 'web-push';
import { describe, expect, it, vi } from 'vitest';

import {
  areAllWebPushAddressesPublic,
  isPublicWebPushAddress,
  mapWebPushFailure,
  WebPushDeliveryAdapter,
} from './web-push-adapter.js';

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
      allowedEndpointOrigins: ['https://push.example.test'],
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
      agent: expect.any(Agent) as unknown,
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
      allowedEndpointOrigins: ['https://push.example.test'],
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

  it('starts the reset window when a delayed provider failure is observed', async () => {
    let now = 1_000;
    const sendImplementation = vi.fn().mockImplementation(() => {
      now += 30_000;
      return Promise.reject(new Error('provider timeout'));
    });
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 30_000,
      circuitFailureThreshold: 1,
      circuitResetMs: 30_000,
      allowedEndpointOrigins: ['https://push.example.test'],
      sendImplementation,
      now: () => now,
    });

    await expect(adapter.send(request)).resolves.toEqual({
      outcome: 'retryable_failure',
      errorCode: 'WEB_PUSH_NETWORK_FAILURE',
    });
    await expect(adapter.send(request)).resolves.toEqual({
      outcome: 'retryable_failure',
      errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
    });
    expect(sendImplementation).toHaveBeenCalledOnce();
  });

  it('allows only one provider probe after the reset window', async () => {
    let now = 1_000;
    let releaseProbe: (() => void) | undefined;
    const sendImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseProbe = () => resolve({ statusCode: 201, headers: {}, body: '' });
          }),
      );
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 1,
      circuitResetMs: 30_000,
      allowedEndpointOrigins: ['https://push.example.test'],
      sendImplementation,
      now: () => now,
    });

    await adapter.send(request);
    now += 30_001;
    const probe = adapter.send(request);
    await expect(adapter.send(request)).resolves.toEqual({
      outcome: 'retryable_failure',
      errorCode: 'WEB_PUSH_CIRCUIT_OPEN',
    });
    expect(sendImplementation).toHaveBeenCalledTimes(2);
    releaseProbe?.();
    await expect(probe).resolves.toEqual({ outcome: 'accepted' });
  });

  it('closes the account circuit after a terminal half-open provider response', async () => {
    let now = 1_000;
    const sendImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new WebPushError('gone', 410, {}, '', request.endpoint))
      .mockResolvedValue({ statusCode: 201, headers: {}, body: '' });
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 1,
      circuitResetMs: 30_000,
      allowedEndpointOrigins: ['https://push.example.test'],
      sendImplementation,
      now: () => now,
    });

    await adapter.send(request);
    now += 30_001;
    await expect(adapter.send(request)).resolves.toMatchObject({
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_SUBSCRIPTION_GONE',
    });
    await expect(Promise.all([adapter.send(request), adapter.send(request)])).resolves.toEqual([
      { outcome: 'accepted' },
      { outcome: 'accepted' },
    ]);
    expect(sendImplementation).toHaveBeenCalledTimes(4);
  });

  it('resets sub-threshold retryable failures after a terminal provider response', async () => {
    const sendImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('network-1'))
      .mockRejectedValueOnce(new WebPushError('gone', 410, {}, '', request.endpoint))
      .mockRejectedValueOnce(new Error('network-2'))
      .mockResolvedValue({ statusCode: 201, headers: {}, body: '' });
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 2,
      circuitResetMs: 30_000,
      allowedEndpointOrigins: ['https://push.example.test'],
      sendImplementation,
    });

    await adapter.send(request);
    await adapter.send(request);
    await adapter.send(request);
    await expect(adapter.send(request)).resolves.toEqual({ outcome: 'accepted' });
    expect(sendImplementation).toHaveBeenCalledTimes(4);
  });

  it('reports bounded provider outcomes without exposing provider account or endpoint data', async () => {
    const onProviderOutcome = vi.fn();
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 1,
      circuitResetMs: 30_000,
      allowedEndpointOrigins: ['https://push.example.test'],
      sendImplementation: vi.fn().mockRejectedValue(new Error('network')),
      onProviderOutcome,
    });

    await adapter.send(request);
    await adapter.send(request);

    expect(onProviderOutcome.mock.calls).toEqual([
      ['WEB_PUSH_NETWORK_FAILURE'],
      ['WEB_PUSH_CIRCUIT_OPEN'],
    ]);
  });

  it('rejects an untrusted endpoint before the provider call', async () => {
    const sendImplementation = vi.fn();
    const adapter = new WebPushDeliveryAdapter({
      subject: 'mailto:ops@padlhub.test',
      publicKey: 'public-key',
      privateKey: 'private-key',
      ttlSeconds: 300,
      timeoutMs: 5_000,
      circuitFailureThreshold: 5,
      circuitResetMs: 30_000,
      allowedEndpointOrigins: ['https://fcm.googleapis.com'],
      sendImplementation,
    });

    await expect(adapter.send(request)).resolves.toEqual({
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_ENDPOINT_ORIGIN_NOT_ALLOWED',
      invalidate: false,
      suspendPolicy: true,
    });
    expect(sendImplementation).not.toHaveBeenCalled();
  });

  it('classifies public and non-routable DNS answers at the connection boundary', () => {
    expect(isPublicWebPushAddress('8.8.8.8')).toBe(true);
    expect(isPublicWebPushAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicWebPushAddress('127.0.0.1')).toBe(false);
    expect(isPublicWebPushAddress('169.254.169.254')).toBe(false);
    expect(isPublicWebPushAddress('10.20.30.40')).toBe(false);
    expect(isPublicWebPushAddress('192.88.99.1')).toBe(false);
    expect(isPublicWebPushAddress('fc00::1')).toBe(false);
    expect(isPublicWebPushAddress('fe80::1')).toBe(false);
    expect(isPublicWebPushAddress('::ffff:8.8.8.8')).toBe(true);
    expect(isPublicWebPushAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicWebPushAddress('2001::1')).toBe(false);
    expect(isPublicWebPushAddress('64:ff9b::808:808')).toBe(false);
    expect(isPublicWebPushAddress('not-an-address')).toBe(false);
    expect(areAllWebPushAddressesPublic(['8.8.8.8', '2001:4860:4860::8888'])).toBe(true);
    expect(areAllWebPushAddressesPublic(['8.8.8.8', '10.0.0.2'])).toBe(false);
    expect(areAllWebPushAddressesPublic([])).toBe(false);
  });

  it('does not treat redirects as provider success', () => {
    expect(mapWebPushFailure(new WebPushError('redirect', 302, {}, '', request.endpoint))).toEqual({
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_PROVIDER_REJECTED',
      invalidate: false,
    });
  });

  it('keeps connect-time egress policy failures terminal without invalidating the endpoint', () => {
    expect(
      mapWebPushFailure(
        Object.assign(new Error('blocked before connect'), { code: 'WEB_PUSH_EGRESS_BLOCKED' }),
      ),
    ).toEqual({
      outcome: 'terminal_failure',
      errorCode: 'WEB_PUSH_EGRESS_BLOCKED',
      invalidate: false,
      suspendPolicy: true,
    });
  });
});
