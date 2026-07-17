import type { AuthGateway, WebPushEndpointRegistration } from './auth-gateway.js';

const INSTALLATION_STORAGE_KEY = 'phub.webPush.installationId';

export type WebPushBrowserState = 'unsupported' | 'default' | 'denied' | 'ready' | 'subscribed';

function fallbackUuid(): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function getOrCreateInstallationId(): string {
  const stored = localStorage.getItem(INSTALLATION_STORAGE_KEY);
  if (stored) return stored;
  const installationId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : fallbackUuid();
  localStorage.setItem(INSTALLATION_STORAGE_KEY, installationId);
  return installationId;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function serviceWorkerScriptUrl(value: string): URL {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin)
    throw new Error('WEB_PUSH_SERVICE_WORKER_CROSS_ORIGIN');
  return url;
}

function registrationInput(
  installationId: string,
  subscription: PushSubscription,
): WebPushEndpointRegistration {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error('WEB_PUSH_SUBSCRIPTION_INVALID');
  }
  return {
    installationId,
    subscription: {
      endpoint: json.endpoint,
      expirationTime: json.expirationTime ?? null,
      keys: {
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
    },
  };
}

export function webPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getWebPushBrowserState(
  serviceWorkerUrl: string,
): Promise<WebPushBrowserState> {
  if (!webPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'default') return 'default';
  serviceWorkerScriptUrl(serviceWorkerUrl);
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return 'ready';
  return (await registration.pushManager.getSubscription()) ? 'subscribed' : 'ready';
}

export async function enableWebPush(input: {
  readonly gateway: AuthGateway;
  readonly publicKey: string;
  readonly serviceWorkerUrl: string;
}): Promise<void> {
  if (!webPushSupported()) throw new Error('WEB_PUSH_UNSUPPORTED');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('WEB_PUSH_PERMISSION_DENIED');
  const scriptUrl = serviceWorkerScriptUrl(input.serviceWorkerUrl);
  const registration = await navigator.serviceWorker.register(scriptUrl.pathname, { scope: '/' });
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(input.publicKey),
    }));
  await input.gateway.registerWebPushEndpoint(
    registrationInput(getOrCreateInstallationId(), subscription),
  );
}

export async function disableWebPush(input: {
  readonly gateway: AuthGateway;
  readonly serviceWorkerUrl: string;
}): Promise<void> {
  if (!webPushSupported()) return;
  const installationId = localStorage.getItem(INSTALLATION_STORAGE_KEY);
  let revokeError: unknown;
  if (installationId) {
    try {
      await input.gateway.revokeWebPushEndpoint(installationId);
    } catch (error) {
      revokeError = error;
    }
  }
  serviceWorkerScriptUrl(input.serviceWorkerUrl);
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
  localStorage.removeItem(INSTALLATION_STORAGE_KEY);
  if (revokeError instanceof Error) throw revokeError;
  if (revokeError) throw new Error('WEB_PUSH_REVOKE_FAILED', { cause: revokeError });
}
