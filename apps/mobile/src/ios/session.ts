import { registerPlugin } from '@capacitor/core';
import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type { AuthenticatedSession, UserContext } from '@phub/api-sdk';

export interface IOSConfiguration {
  readonly apiBaseUrl: string;
  readonly tenantKey: string;
  readonly appVersion: string;
  readonly appBuild: string;
}

interface NativeRequest {
  readonly operation: 'challenge' | 'verify' | 'refresh' | 'logout' | 'context';
  readonly challengeId?: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface IOSSessionPlugin {
  configuration(): Promise<IOSConfiguration>;
  request(input: NativeRequest): Promise<{
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: string;
  }>;
}

function rejectedRequest(): ApiClientError {
  return new ApiClientError('Native request rejected', 400, 'NATIVE_REQUEST_REJECTED', 'native');
}

export function createIOSFetch(config: IOSConfiguration, plugin: IOSSessionPlugin): typeof fetch {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
  return async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    // Do not normalize traversal/encoded delimiters into an allowlisted endpoint.
    if (!value.startsWith(`${root}/`) || /[%?#\\]|\.\./.test(value)) throw rejectedRequest();
    const path = value.slice(root.length);
    const method = init?.method ?? 'GET';
    let operation: NativeRequest['operation'];
    let challengeId: string | undefined;
    if (path === '/auth/challenges' && method === 'POST') operation = 'challenge';
    else if (path === '/auth/session/refresh' && method === 'POST') operation = 'refresh';
    else if (path === '/auth/session' && method === 'DELETE') operation = 'logout';
    else if (path === '/context' && method === 'GET') operation = 'context';
    else {
      const match = /^\/auth\/challenges\/([a-f0-9-]{36})\/verify$/i.exec(path);
      if (!match || method !== 'POST') throw rejectedRequest();
      operation = 'verify';
      challengeId = match[1];
    }
    if (init?.body != null && typeof init.body !== 'string') throw rejectedRequest();
    if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    try {
      const result = await plugin.request({
        operation,
        ...(challengeId ? { challengeId } : {}),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      const headers = Object.fromEntries(
        Object.entries(result.headers).filter(([name]) =>
          ['content-type', 'x-correlation-id', 'retry-after'].includes(name.toLowerCase()),
        ),
      );
      return new Response(result.status === 204 ? null : result.body, {
        status: result.status,
        headers,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      // The existing SDK retries a network failure once with the SAME idempotency key.
      if (code === 'NATIVE_NETWORK_UNAVAILABLE') {
        // eslint-disable-next-line preserve-caught-error -- Raw native errors can contain credentials; redact at the bridge.
        throw new TypeError('Native network unavailable');
      }
      throw new ApiClientError(
        'Native session unavailable',
        503,
        'NATIVE_SESSION_UNAVAILABLE',
        'native',
      );
    }
  };
}

export type IOSSessionState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly session: AuthenticatedSession }
  | { readonly status: 'offline'; readonly retry: 'restore' | 'logout' };

export class IOSSession {
  private state: IOSSessionState = { status: 'checking' };
  private readonly listeners = new Set<() => void>();
  private busy = false;
  private restoration: Promise<void> | undefined;

  public constructor(
    public readonly configuration: IOSConfiguration,
    private readonly api: PadlHubApiClient,
  ) {}

  public getSnapshot = (): IOSSessionState => this.state;
  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(state: IOSSessionState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Session operation in progress');
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  public restore(): Promise<void> {
    if (this.restoration) return this.restoration;
    const operation = this.exclusive(async () => {
      this.update({ status: 'checking' });
      try {
        const session = await this.api.refreshSession();
        this.update({ status: 'signed-in', session });
      } catch (error) {
        this.update(
          error instanceof ApiClientError && error.status === 401
            ? { status: 'signed-out' }
            : { status: 'offline', retry: 'restore' },
        );
      }
    }).finally(() => {
      this.restoration = undefined;
    });
    this.restoration = operation;
    return operation;
  }

  public requestCode(phone: string): ReturnType<PadlHubApiClient['createAuthChallenge']> {
    return this.exclusive(() => {
      if (this.state.status !== 'signed-out') throw rejectedRequest();
      return this.api.createAuthChallenge({ method: 'phone_otp', phone });
    });
  }

  public verify(challengeId: string, code: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.state.status !== 'signed-out' || !/^\d{4}$/.test(code)) throw rejectedRequest();
      const session = await this.api.verifyAuthChallenge(challengeId, {
        code,
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      });
      this.update({ status: 'signed-in', session });
    });
  }

  public logout(): Promise<void> {
    return this.exclusive(async () => {
      this.api.clearAccessToken();
      this.update({ status: 'checking' });
      try {
        await this.api.revokeSession();
        this.update({ status: 'signed-out' });
      } catch {
        // Native Keychain retains a pending revocation. Relaunch must finish it,
        // rather than silently restoring the account after a failed logout.
        this.update({ status: 'offline', retry: 'logout' });
      } finally {
        this.api.clearAccessToken();
      }
    });
  }

  public checkContext(): Promise<UserContext> {
    return this.exclusive(async () => {
      if (this.state.status !== 'signed-in') throw rejectedRequest();
      try {
        return await this.api.getUserContext();
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 401) {
          this.api.clearAccessToken();
          this.update({ status: 'signed-out' });
        }
        throw error;
      }
    });
  }
}

let startup: Promise<IOSSession> | undefined;

export function getIOSSession(): Promise<IOSSession> {
  startup ??= (async () => {
    const plugin = registerPlugin<IOSSessionPlugin>('PadlHubSession');
    const configuration = await plugin.configuration();
    const api = new PadlHubApiClient({
      baseUrl: configuration.apiBaseUrl,
      tenantKey: configuration.tenantKey,
      platform: 'ios',
      appVersion: configuration.appVersion,
      appBuild: configuration.appBuild,
      fetchImplementation: createIOSFetch(configuration, plugin),
    });
    const session = new IOSSession(configuration, api);
    await session.restore();
    return session;
  })();
  return startup;
}
