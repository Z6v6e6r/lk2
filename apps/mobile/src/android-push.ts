import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { ApiClientError } from '@phub/api-sdk';
import type { AuthGateway } from '../../web/src/auth-gateway.js';
import type { WebPushBrowserState } from '../../web/src/web-push-client.js';

interface PendingRevoke {
  readonly installationId: string;
  readonly pendingRevoke: boolean;
  readonly idempotencyKey?: string;
  readonly revokeCurrentAccount?: boolean;
}
export interface AndroidPushPlugin {
  status(): Promise<
    PendingRevoke & {
      readonly configured: boolean;
      readonly active?: boolean;
      readonly state: 'unsupported' | 'prompt' | 'denied' | 'subscribed';
    }
  >;
  registration(input: { readonly requestPermission: boolean }): Promise<{
    readonly installationId: string;
    readonly token: string;
    readonly idempotencyKey: string;
  }>;
  activate(input: { readonly idempotencyKey: string; readonly endpointId: string }): Promise<void>;
  suspend(): Promise<PendingRevoke>;
  finishRevoke(input: { readonly idempotencyKey: string }): Promise<void>;
  takeOpened(): Promise<{ readonly route?: string }>;
  addListener(
    event: 'registrationChanged' | 'notificationOpened',
    callback: () => void,
  ): Promise<PluginListenerHandle>;
}
export interface AndroidPushSnapshot {
  readonly enabled: boolean;
  readonly state: WebPushBrowserState;
  readonly busy: boolean;
  readonly error?: string | undefined;
}
const native = registerPlugin<AndroidPushPlugin>('PadlHubAndroidPush');
export const initialAndroidPushState: AndroidPushSnapshot = {
  enabled: false,
  state: 'unsupported',
  busy: false,
};

export function safeNotificationRoute(value: string): string {
  return /^\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : '/notifications';
}

/** Provider tokens exist only during a registration call; native code owns all durable journals. */
export function createAndroidPushController(
  gateway: AuthGateway,
  publish: (state: AndroidPushSnapshot) => void,
  transport: AndroidPushPlugin = native,
) {
  let alive = true;
  let snapshot = initialAndroidPushState;
  let operation: Promise<void> | undefined;
  const update = (next: Partial<AndroidPushSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    if (alive) publish(snapshot);
  };
  const configuration = async (): Promise<boolean> => {
    if (!gateway.getAndroidPushConfiguration) return false;
    return (await gateway.getAndroidPushConfiguration()).enabled;
  };
  const revoke = async (pending: PendingRevoke): Promise<void> => {
    if (!pending.pendingRevoke || pending.revokeCurrentAccount === false) return;
    if (!pending.idempotencyKey || !gateway.revokeAndroidPushEndpoint)
      throw new Error('NATIVE_PUSH_UNAVAILABLE');
    try {
      await gateway.revokeAndroidPushEndpoint(pending.installationId, pending.idempotencyKey);
    } catch (error) {
      // A canonical not-found for this same account means there is no endpoint left to revoke.
      if (!(
        error instanceof ApiClientError &&
        error.status === 404 &&
        error.code === 'ANDROID_PUSH_ENDPOINT_NOT_FOUND'
      ))
        throw error;
    }
    await transport.finishRevoke({ idempotencyKey: pending.idempotencyKey });
  };
  const register = async (prompt: boolean): Promise<void> => {
    const status = await transport.status();
    if (!status.configured || !(await configuration())) {
      update({
        enabled: false,
        state: status.configured ? 'ready' : 'unsupported',
        busy: false,
        error: undefined,
      });
      return;
    }
    await revoke(status);
    const registration = await transport.registration({ requestPermission: prompt });
    if (!alive) return;
    if (!gateway.registerAndroidPushEndpoint) throw new Error('NATIVE_PUSH_UNAVAILABLE');
    const result = await gateway.registerAndroidPushEndpoint(
      { installationId: registration.installationId, token: registration.token },
      registration.idempotencyKey,
    );
    if (!alive) return;
    await transport.activate({
      idempotencyKey: registration.idempotencyKey,
      endpointId: result.endpointId,
    });
    update({ enabled: true, state: 'subscribed', busy: false, error: undefined });
  };
  const run = (task: () => Promise<void>): Promise<void> => {
    if (operation) return operation;
    update({ busy: true, error: undefined });
    const pending = task()
      .catch((error: unknown) => {
        const denied =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'NATIVE_PUSH_PERMISSION_DENIED';
        update({
          busy: false,
          ...(denied ? { state: 'denied' as const } : {}),
          error: denied
            ? 'Разрешите уведомления в настройках приложения.'
            : 'Не удалось настроить уведомления. Повторите попытку.',
        });
        throw error;
      })
      .finally(() => {
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };
  const refresh = (): Promise<void> =>
    run(async () => {
      const status = await transport.status();
      await revoke(status);
      const enabled = status.configured && (await configuration());
      if (
        (status.active || status.state === 'subscribed') &&
        (!enabled || status.state === 'denied')
      )
        await revoke(await transport.suspend());
      update({
        enabled,
        state: status.state === 'prompt' ? 'ready' : status.state,
        busy: false,
        error: undefined,
      });
      if (enabled && status.state === 'subscribed') await register(false);
    });
  const open = async (): Promise<void> => {
    const { route } = await transport.takeOpened();
    if (!alive || !route) return;
    window.history.pushState({}, '', safeNotificationRoute(route));
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  return {
    refresh,
    sessionReady: (): void => {
      void Promise.resolve(operation)
        .catch(() => undefined)
        .then(refresh)
        .catch(() => undefined);
    },
    sessionExpired: (): void => {
      void transport.suspend().catch(() => undefined);
    },
    enable: () => run(() => register(true)),
    disable: () =>
      run(async () => {
        await revoke(await transport.suspend());
        update({ state: 'ready', busy: false, error: undefined });
      }),
    beforeLogout: async (): Promise<void> => {
      // Suspension is durable and invalidates any late Firebase token callback before network waits.
      const pending = await transport.suspend();
      if (operation) await operation.catch(() => undefined);
      await revoke(pending);
    },
    mount(): () => void {
      alive = true;
      const listeners = [
        transport.addListener('registrationChanged', () => {
          void refresh().catch(() => undefined);
        }),
        transport.addListener('notificationOpened', () => {
          void open().catch(() => undefined);
        }),
      ].map((listener) => listener.catch(() => undefined));
      const focus = (): void => {
        void refresh().catch(() => undefined);
        void open().catch(() => undefined);
      };
      window.addEventListener('focus', focus);
      void refresh().catch(() => undefined);
      void open().catch(() => undefined);
      return () => {
        alive = false;
        window.removeEventListener('focus', focus);
        for (const listener of listeners)
          void listener.then((handle) => handle?.remove()).catch(() => undefined);
      };
    },
  };
}
