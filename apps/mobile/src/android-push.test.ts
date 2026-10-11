import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAndroidPushController,
  safeNotificationRoute,
  type AndroidPushPlugin,
} from './android-push.js';

type Listener = () => void;

const windowListeners = new Map<string, Set<Listener>>();
const windowStub = {
  addEventListener(event: string, listener: Listener) {
    const listeners = windowListeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    windowListeners.set(event, listeners);
  },
  removeEventListener(event: string, listener: Listener) {
    windowListeners.get(event)?.delete(listener);
  },
  dispatchEvent(event: { readonly type: string }) {
    for (const listener of windowListeners.get(event.type) ?? []) listener();
    return true;
  },
  history: { pushState: vi.fn() },
};

function gateway(overrides: Record<string, unknown> = {}) {
  return {
    getAndroidPushConfiguration: vi.fn().mockResolvedValue({ enabled: true }),
    registerAndroidPushEndpoint: vi.fn().mockResolvedValue({ endpointId: 'endpoint-1' }),
    revokeAndroidPushEndpoint: vi.fn().mockResolvedValue({ endpointId: 'endpoint-1' }),
    ...overrides,
  };
}

function plugin(overrides: Partial<AndroidPushPlugin> = {}) {
  const callbacks: Record<'registrationChanged' | 'notificationOpened', Listener[]> = {
    registrationChanged: [],
    notificationOpened: [],
  };
  const removes: ReturnType<typeof vi.fn>[] = [];
  const addListener = vi.fn(
    (event: 'registrationChanged' | 'notificationOpened', callback: Listener) => {
      callbacks[event].push(callback);
      const remove = vi.fn(() => {
        callbacks[event] = callbacks[event].filter((item) => item !== callback);
        return Promise.resolve();
      });
      removes.push(remove);
      return Promise.resolve({
        remove,
      });
    },
  );
  return {
    transport: {
      status: vi.fn().mockResolvedValue({
        configured: true,
        state: 'prompt',
        installationId: 'install-1',
        pendingRevoke: false,
      }),
      registration: vi.fn().mockResolvedValue({
        installationId: 'install-1',
        token: 'fcm-token',
        idempotencyKey: 'native-key-1',
      }),
      activate: vi.fn().mockResolvedValue(undefined),
      suspend: vi.fn().mockResolvedValue({
        installationId: 'install-1',
        pendingRevoke: true,
        idempotencyKey: 'revoke-key-1',
      }),
      finishRevoke: vi.fn().mockResolvedValue(undefined),
      takeOpened: vi.fn().mockResolvedValue({}),
      addListener,
      ...overrides,
    } satisfies AndroidPushPlugin,
    callbacks,
    removes,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', windowStub);
  vi.stubGlobal(
    'PopStateEvent',
    class {
      public constructor(public readonly type: string) {}
    },
  );
});

afterEach(() => {
  windowListeners.clear();
  windowStub.history.pushState.mockClear();
  vi.unstubAllGlobals();
});

describe('Android push controller', () => {
  it('handles unavailable native listeners immediately and can still clean up', async () => {
    const { transport } = plugin({
      addListener: vi.fn().mockRejectedValue(new Error('native listener unavailable')),
      status: vi.fn().mockResolvedValue({
        configured: false,
        state: 'unsupported',
        installationId: 'install-1',
        pendingRevoke: false,
      }),
    });
    const publish = vi.fn();
    const controller = createAndroidPushController(gateway() as never, publish, transport);
    const cleanup = controller.mount();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: false,
          state: 'unsupported',
          busy: false,
        }),
      ),
    );
    cleanup();
    expect(transport.registration).not.toHaveBeenCalled();
    expect(windowListeners.get('focus')?.size).toBe(0);
  });

  it('keeps the native registration key across a lost response and activates only after acknowledgement', async () => {
    const registerAndroidPushEndpoint = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ endpointId: 'endpoint-1' });
    const auth = gateway({ registerAndroidPushEndpoint });
    const { transport } = plugin();
    const controller = createAndroidPushController(auth as never, vi.fn(), transport);

    await expect(controller.enable()).rejects.toThrow('offline');
    expect(transport.activate).not.toHaveBeenCalled();
    await controller.enable();

    expect(registerAndroidPushEndpoint).toHaveBeenNthCalledWith(
      1,
      { installationId: 'install-1', token: 'fcm-token' },
      'native-key-1',
    );
    expect(registerAndroidPushEndpoint).toHaveBeenNthCalledWith(
      2,
      { installationId: 'install-1', token: 'fcm-token' },
      'native-key-1',
    );
    expect(transport.activate).toHaveBeenCalledTimes(1);
  });

  it('suspends and revokes before logout, but never revokes an old account journal', async () => {
    const events: string[] = [];
    const auth = gateway({
      revokeAndroidPushEndpoint: vi.fn(() => {
        events.push('revoke');
        return Promise.resolve({ endpointId: 'endpoint-1' });
      }),
    });
    const { transport } = plugin({
      suspend: vi.fn(() => {
        events.push('suspend');
        return Promise.resolve({
          installationId: 'install-1',
          pendingRevoke: true,
          idempotencyKey: 'revoke-key-1',
        });
      }),
    });
    const controller = createAndroidPushController(auth as never, vi.fn(), transport);
    await controller.beforeLogout();
    expect(events).toEqual(['suspend', 'revoke']);
    expect(transport.finishRevoke).toHaveBeenCalledWith({ idempotencyKey: 'revoke-key-1' });

    const oldAccount = gateway();
    const oldPlugin = plugin({
      status: vi.fn().mockResolvedValue({
        configured: true,
        state: 'prompt',
        installationId: 'install-old',
        pendingRevoke: true,
        revokeCurrentAccount: false,
        idempotencyKey: 'old-key',
      }),
    });
    await createAndroidPushController(oldAccount as never, vi.fn(), oldPlugin.transport).refresh();
    expect(oldAccount.revokeAndroidPushEndpoint).not.toHaveBeenCalled();
    expect(oldPlugin.transport.finishRevoke).not.toHaveBeenCalled();
  });

  it('does not register when native or server configuration is disabled', async () => {
    const nativeDisabled = plugin({
      status: vi.fn().mockResolvedValue({
        configured: false,
        state: 'unsupported',
        installationId: 'install-1',
        pendingRevoke: false,
      }),
    });
    const nativeAuth = gateway();
    await createAndroidPushController(
      nativeAuth as never,
      vi.fn(),
      nativeDisabled.transport,
    ).enable();
    expect(nativeDisabled.transport.registration).not.toHaveBeenCalled();

    const serverDisabled = plugin();
    const serverAuth = gateway({
      getAndroidPushConfiguration: vi.fn().mockResolvedValue({ enabled: false }),
    });
    await createAndroidPushController(
      serverAuth as never,
      vi.fn(),
      serverDisabled.transport,
    ).enable();
    expect(serverDisabled.transport.registration).not.toHaveBeenCalled();
  });

  it('denies external and traversal notification routes', () => {
    expect(safeNotificationRoute('/chats/22222222-2222-4222-8222-222222222222')).toBe(
      '/chats/22222222-2222-4222-8222-222222222222',
    );
    for (const route of [
      'https://evil.test',
      '//evil.test',
      '/chats/../notifications',
      '/notifications?next=https://evil.test',
    ]) {
      expect(safeNotificationRoute(route)).toBe('/notifications');
    }
  });

  it('suspends and revokes an active endpoint when OS permission is denied', async () => {
    const auth = gateway();
    const { transport } = plugin({
      status: vi.fn().mockResolvedValue({
        configured: true,
        active: true,
        state: 'denied',
        installationId: 'install-1',
        pendingRevoke: false,
      }),
    });
    const publish = vi.fn();
    await createAndroidPushController(auth as never, publish, transport).refresh();
    expect(transport.suspend).toHaveBeenCalledOnce();
    expect(auth.revokeAndroidPushEndpoint).toHaveBeenCalledWith('install-1', 'revoke-key-1');
    expect(transport.finishRevoke).toHaveBeenCalledWith({ idempotencyKey: 'revoke-key-1' });
    expect(transport.registration).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'denied', busy: false }),
    );
  });

  it('removes the first listener set on a StrictMode-style remount', async () => {
    const auth = gateway();
    const { transport, removes } = plugin();
    const controller = createAndroidPushController(auth as never, vi.fn(), transport);
    const firstUnmount = controller.mount();
    await Promise.resolve();
    firstUnmount();
    const secondUnmount = controller.mount();
    await Promise.resolve();
    secondUnmount();
    await Promise.resolve();
    await Promise.resolve();

    expect(removes).toHaveLength(4);
    expect(removes.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  });
});
