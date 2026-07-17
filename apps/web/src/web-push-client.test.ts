// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthGateway } from './auth-gateway.js';
import { disableWebPush } from './web-push-client.js';

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
  } else {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  }
  if (originalSecureContext) {
    Object.defineProperty(window, 'isSecureContext', originalSecureContext);
  } else {
    Reflect.deleteProperty(window, 'isSecureContext');
  }
});

describe('Web Push browser lifecycle', () => {
  it('removes the local subscription even when backend revocation is temporarily unavailable', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue({ unsubscribe }),
          },
        }),
      },
    });
    vi.stubGlobal('PushManager', class PushManager {});
    vi.stubGlobal('Notification', { permission: 'granted' });
    localStorage.setItem('phub.webPush.installationId', '11111111-1111-4111-8111-111111111111');
    const revokeWebPushEndpoint = vi.fn().mockRejectedValue(new Error('network'));
    const gateway = { revokeWebPushEndpoint } as unknown as AuthGateway;

    await expect(
      disableWebPush({
        gateway,
        serviceWorkerUrl: '/phub-notification-sw.js',
      }),
    ).rejects.toThrow('network');

    expect(revokeWebPushEndpoint).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(localStorage.getItem('phub.webPush.installationId')).toBeNull();
  });
});
