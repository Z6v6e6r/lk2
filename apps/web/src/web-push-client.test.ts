// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthGateway } from './auth-gateway.js';
import {
  disableWebPush,
  enableWebPush,
  getWebPushBrowserState,
  iosHomeScreenState,
} from './web-push-client.js';

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
const originalStandalone = Object.getOwnPropertyDescriptor(navigator, 'standalone');

/**
 * A browser that reports itself as an iOS device. `standalone` is set only when iOS launched the site
 * from the Home Screen, which is the one context where its Web Push API exists.
 */
function iosBrowser(
  options: { readonly userAgent?: string; readonly standalone?: boolean } = {},
): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: options.userAgent ?? IPHONE_SAFARI_USER_AGENT,
  });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  Object.defineProperty(navigator, 'standalone', {
    configurable: true,
    value: options.standalone === true,
  });
}

const IPHONE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/23F77 Safari/604.1';
const IPAD_DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const INSTALLATION_STORAGE_KEY = 'phub.webPush.installationId';
const VAPID_PUBLIC_KEY = 'AQAB';

function supportedBrowser(overrides?: {
  readonly requestPermission?: () => Promise<NotificationPermission>;
  readonly register?: (url: string, options: { readonly scope: string }) => Promise<unknown>;
  readonly ready?: () => Promise<unknown>;
}): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: overrides?.register ?? vi.fn(),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      get ready() {
        return overrides?.ready ? overrides.ready() : Promise.resolve(undefined);
      },
    },
  });
  vi.stubGlobal('PushManager', class PushManager {});
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: overrides?.requestPermission ?? vi.fn().mockResolvedValue('granted'),
  });
}

function subscriptionFixture() {
  return {
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-subscription',
      expirationTime: null,
      keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) },
    }),
  };
}

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
  for (const [key, descriptor] of [
    ['userAgent', originalUserAgent],
    ['maxTouchPoints', originalMaxTouchPoints],
    ['standalone', originalStandalone],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(navigator, key, descriptor);
    } else {
      Reflect.deleteProperty(navigator, key);
    }
  }
});

describe('Web Push browser lifecycle', () => {
  it('grants permission once, subscribes with the VAPID key and registers the endpoint', async () => {
    const subscription = subscriptionFixture();
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const register = vi.fn().mockResolvedValue({
      pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
    });
    supportedBrowser({ register });
    const registerWebPushEndpoint = vi.fn().mockResolvedValue(undefined);
    const gateway = { registerWebPushEndpoint } as unknown as AuthGateway;

    await expect(
      enableWebPush({
        gateway,
        publicKey: VAPID_PUBLIC_KEY,
        serviceWorkerUrl: '/phub-notification-sw.js',
      }),
    ).resolves.toBeUndefined();

    expect(register).toHaveBeenCalledWith('/phub-notification-sw.js', { scope: '/' });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const subscribeOptions = subscribe.mock.calls[0]?.[0] as {
      readonly userVisibleOnly: boolean;
      readonly applicationServerKey: Uint8Array;
    };
    expect(subscribeOptions.userVisibleOnly).toBe(true);
    expect(Array.from(subscribeOptions.applicationServerKey)).toEqual([1, 0, 1]);
    expect(registerWebPushEndpoint).toHaveBeenCalledTimes(1);
    const registration = registerWebPushEndpoint.mock.calls[0]?.[0] as {
      readonly installationId: string;
      readonly subscription: {
        readonly endpoint: string;
        readonly expirationTime: null;
        readonly keys: { readonly p256dh: string; readonly auth: string };
      };
    };
    expect(registration.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(registration.subscription).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-subscription',
      expirationTime: null,
      keys: { p256dh: 'B'.repeat(65), auth: 'a'.repeat(22) },
    });
    expect(localStorage.getItem(INSTALLATION_STORAGE_KEY)).toBe(registration.installationId);
  });

  it('reuses the existing browser subscription instead of creating a second one', async () => {
    const subscription = subscriptionFixture();
    const subscribe = vi.fn();
    supportedBrowser({
      register: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe },
      }),
    });
    const registerWebPushEndpoint = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(INSTALLATION_STORAGE_KEY, '11111111-1111-4111-8111-111111111111');

    await enableWebPush({
      gateway: { registerWebPushEndpoint } as unknown as AuthGateway,
      publicKey: VAPID_PUBLIC_KEY,
      serviceWorkerUrl: '/phub-notification-sw.js',
    });

    expect(subscribe).not.toHaveBeenCalled();
    expect(registerWebPushEndpoint.mock.calls[0]?.[0]).toMatchObject({
      installationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('stops before the service worker when the user denies permission', async () => {
    const register = vi.fn();
    supportedBrowser({
      register,
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });
    const registerWebPushEndpoint = vi.fn();

    await expect(
      enableWebPush({
        gateway: { registerWebPushEndpoint } as unknown as AuthGateway,
        publicKey: VAPID_PUBLIC_KEY,
        serviceWorkerUrl: '/phub-notification-sw.js',
      }),
    ).rejects.toThrow('WEB_PUSH_PERMISSION_DENIED');

    expect(register).not.toHaveBeenCalled();
    expect(registerWebPushEndpoint).not.toHaveBeenCalled();
    expect(localStorage.getItem(INSTALLATION_STORAGE_KEY)).toBeNull();
  });

  it('rejects a cross-origin service worker before requesting permission', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    supportedBrowser({ requestPermission });

    await expect(
      enableWebPush({
        gateway: { registerWebPushEndpoint: vi.fn() } as unknown as AuthGateway,
        publicKey: VAPID_PUBLIC_KEY,
        serviceWorkerUrl: 'https://other.example.test/phub-notification-sw.js',
      }),
    ).rejects.toThrow('WEB_PUSH_SERVICE_WORKER_CROSS_ORIGIN');

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('reports an unsupported browser without prompting or registering', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn(), getRegistration: vi.fn() },
    });
    const requestPermission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });

    await expect(
      enableWebPush({
        gateway: { registerWebPushEndpoint: vi.fn() } as unknown as AuthGateway,
        publicKey: VAPID_PUBLIC_KEY,
        serviceWorkerUrl: '/phub-notification-sw.js',
      }),
    ).rejects.toThrow('WEB_PUSH_UNSUPPORTED');

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('waits for the first service worker activation before subscribing', async () => {
    const subscription = subscriptionFixture();
    const subscribe = vi.fn().mockResolvedValue(subscription);
    let resolveReady: (() => void) | undefined;
    let markReadyRequested: (() => void) | undefined;
    const readyRequested = new Promise<void>((resolveRequested) => {
      markReadyRequested = resolveRequested;
    });
    const ready = vi.fn(
      () =>
        new Promise((resolveActivation) => {
          resolveReady = () => resolveActivation(undefined);
          markReadyRequested?.();
        }),
    );
    const installing = { state: 'installing', addEventListener: vi.fn() };
    supportedBrowser({
      ready,
      register: vi.fn().mockResolvedValue({
        active: null,
        installing,
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
      }),
    });
    const registerWebPushEndpoint = vi.fn().mockResolvedValue(undefined);

    const enabling = enableWebPush({
      gateway: { registerWebPushEndpoint } as unknown as AuthGateway,
      publicKey: VAPID_PUBLIC_KEY,
      serviceWorkerUrl: '/phub-notification-sw.js',
    });
    await readyRequested;
    expect(subscribe).not.toHaveBeenCalled();

    resolveReady?.();
    await expect(enabling).resolves.toBeUndefined();
    expect(ready).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(registerWebPushEndpoint).toHaveBeenCalledOnce();
  });

  it('subscribes without waiting when the service worker is already active', async () => {
    const subscription = subscriptionFixture();
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const ready = vi.fn(() => Promise.resolve(undefined));
    supportedBrowser({
      ready,
      register: vi.fn().mockResolvedValue({
        active: { state: 'activated' },
        installing: null,
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
      }),
    });

    await enableWebPush({
      gateway: { registerWebPushEndpoint: vi.fn() } as unknown as AuthGateway,
      publicKey: VAPID_PUBLIC_KEY,
      serviceWorkerUrl: '/phub-notification-sw.js',
    });

    expect(ready).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledOnce();
  });

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

describe('iOS Home Screen requirement', () => {
  it('treats a desktop user agent with touch points as an iPad and a Mac without them as a desktop', () => {
    expect(
      iosHomeScreenState(
        { userAgent: IPHONE_SAFARI_USER_AGENT, maxTouchPoints: 5, standalone: false },
        false,
      ),
    ).toBe('needs_home_screen');
    expect(
      iosHomeScreenState(
        { userAgent: IPHONE_SAFARI_USER_AGENT, maxTouchPoints: 5, standalone: true },
        false,
      ),
    ).toBe('home_screen');
    // iPadOS 13+ claims to be a Macintosh; only the touch capability separates it from a desktop Mac.
    expect(
      iosHomeScreenState(
        { userAgent: IPAD_DESKTOP_USER_AGENT, maxTouchPoints: 5, standalone: false },
        false,
      ),
    ).toBe('needs_home_screen');
    expect(
      iosHomeScreenState(
        { userAgent: IPAD_DESKTOP_USER_AGENT, maxTouchPoints: 0, standalone: false },
        false,
      ),
    ).toBe('not_ios');
    expect(
      iosHomeScreenState(
        {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          maxTouchPoints: 0,
          standalone: false,
        },
        false,
      ),
    ).toBe('not_ios');
    // The display-mode media query is the non-Apple way an installed app reports itself.
    expect(
      iosHomeScreenState(
        { userAgent: IPHONE_SAFARI_USER_AGENT, maxTouchPoints: 5, standalone: false },
        true,
      ),
    ).toBe('home_screen');
  });

  it('asks a Safari tab on iOS for the Home Screen install before calling push unsupported', async () => {
    iosBrowser();

    // A tab has no usable PushManager, which is exactly why the install instruction must win.
    await expect(getWebPushBrowserState('/phub-notification-sw.js')).resolves.toBe('needs_install');
  });

  it('reports the normal pre-permission state once iOS runs the site from the Home Screen', async () => {
    iosBrowser({ standalone: true });
    supportedBrowser({
      register: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
      }),
    });

    // `default` is the ordinary "permission not decided yet" state, so the Home Screen app offers the button.
    await expect(getWebPushBrowserState('/phub-notification-sw.js')).resolves.toBe('default');
  });

  it('refuses to spend the one-time permission prompt in an iOS tab', async () => {
    iosBrowser();
    const requestPermission = vi.fn().mockResolvedValue('granted');
    supportedBrowser({ requestPermission });

    await expect(
      enableWebPush({
        gateway: {} as unknown as AuthGateway,
        publicKey: VAPID_PUBLIC_KEY,
        serviceWorkerUrl: '/phub-notification-sw.js',
      }),
    ).rejects.toThrow('WEB_PUSH_HOME_SCREEN_REQUIRED');

    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('subscribes normally inside the iOS Home Screen app', async () => {
    iosBrowser({ standalone: true });
    const subscription = subscriptionFixture();
    const subscribe = vi.fn().mockResolvedValue(subscription);
    supportedBrowser({
      register: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe },
      }),
    });
    const registerWebPushEndpoint = vi.fn().mockResolvedValue(undefined);

    await enableWebPush({
      gateway: { registerWebPushEndpoint } as unknown as AuthGateway,
      publicKey: VAPID_PUBLIC_KEY,
      serviceWorkerUrl: '/phub-notification-sw.js',
    });

    expect(subscribe).toHaveBeenCalledOnce();
    expect(registerWebPushEndpoint).toHaveBeenCalledOnce();
  });
});
