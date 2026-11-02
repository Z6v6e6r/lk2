import {
  tournamentChatRequest,
  type NativeTournamentChatRequest,
} from '../native-tournament-chat-request.js';
import {
  stationStreamRequest,
  type NativeStationStreamRequest,
} from '../native-station-stream-request.js';
import { stationRequest, type NativeStationRequest } from '../native-station-message-request.js';
import { gameCancelRequest } from '../native-game-cancel-request.js';
import { quarterRequest } from '../native-quarter-request.js';
import { registerPlugin } from '@capacitor/core';
import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type { AuthenticatedSession, UserContext } from '@phub/api-sdk';
import { tournamentRequest } from './tournament-routes.js';
import { cabinetReadRequest } from './cabinet-routes.js';
import { messagingRequest } from './messaging-routes.js';

export interface IOSConfiguration {
  readonly apiBaseUrl: string;
  readonly tenantKey: string;
  readonly appVersion: string;
  readonly appBuild: string;
}

interface NativeRequest {
  readonly operation:
    | 'challenge'
    | 'verify'
    | 'refresh'
    | 'logout'
    | 'context'
    | 'read'
    | 'notification'
    | 'quarterCreate'
    | 'gameCancel'
    | 'stationMessage'
    | 'stationStream'
    | 'tournamentChat'
    | 'tournament'
    | 'messaging';
  readonly requestId?: string;
  readonly challengeId?: string;
  readonly operationId?: string;
  readonly resource?: string;
  readonly resourceId?: string;
  readonly query?: Record<string, string>;
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

export function createIOSFetch(
  config: IOSConfiguration,
  plugin: IOSSessionPlugin,
  canDispatchGameCancellation?: (gameId: string) => boolean,
  canDispatchStation?: (request: NativeStationRequest | NativeStationStreamRequest) => boolean,
  canDispatchTournamentChat?: (request: NativeTournamentChatRequest) => boolean,
  canDispatchGameChat?: (gameId: string) => boolean,
): typeof fetch {
  const root = `${config.apiBaseUrl}/user/api/v1/${config.tenantKey}`;
  let cancellationClosed = false;
  let cancellationEpoch = 0;
  return async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    const tournamentChat = value.includes('/chat/')
      ? tournamentChatRequest(value, init, config)
      : null;
    const stream = stationStreamRequest(value, init, config);
    const station = stream ?? stationRequest(value, init, config);
    const cancel = gameCancelRequest(value, init, config);
    const quarter = quarterRequest(value, init, config);
    const tournament = tournamentChat
      ? null
      : tournamentRequest(
          value,
          init?.method ?? 'GET',
          init?.body,
          Object.fromEntries(new Headers(init?.headers).entries()),
          config,
        );
    const read =
      !station && !tournamentChat && !tournament && !quarter && (init?.method ?? 'GET') === 'GET'
        ? cabinetReadRequest(value, config)
        : null;
    // Do not normalize traversal/encoded delimiters into an allowlisted endpoint.
    if (
      !station &&
      !tournamentChat &&
      !tournament &&
      !read &&
      (!value.startsWith(`${root}/`) || /[%?#\\]|\.\./.test(value))
    )
      throw rejectedRequest();
    const path = value.slice(root.length);
    const method = init?.method ?? 'GET';
    let operation: NativeRequest['operation'];
    let challengeId: string | undefined;
    let notification: { resource: string; resourceId?: string } | undefined;
    if (tournamentChat) operation = 'tournamentChat';
    else if (station) operation = stream ? 'stationStream' : 'stationMessage';
    else if (cancel) operation = 'gameCancel';
    else if (quarter) operation = 'quarterCreate';
    else if (tournament) operation = 'tournament';
    else if (read) operation = 'read';
    else if (path.startsWith('/conversations/') || path === '/messaging/realtime-ticket') {
      operation = 'messaging';
      notification = messagingRequest(path, method, init);
    } else if (path === '/auth/challenges' && method === 'POST') operation = 'challenge';
    else if (path === '/auth/session/refresh' && method === 'POST') operation = 'refresh';
    else if (path === '/auth/session' && method === 'DELETE') operation = 'logout';
    else if (path === '/context' && method === 'GET') operation = 'context';
    else if (path === '/notification-endpoints/ios' && method === 'POST') {
      operation = 'notification';
      notification = { resource: 'pushRegister' };
    } else if (
      /^\/notification-endpoints\/ios\/[a-f0-9-]{36}$/i.test(path) &&
      method === 'DELETE'
    ) {
      operation = 'notification';
      notification = { resource: 'pushRevoke', resourceId: path.split('/').at(-1)! };
    } else if (path === '/notifications/preferences' && method === 'PUT') {
      operation = 'notification';
      notification = { resource: 'preferencesUpdate' };
    } else if (path === '/notifications/read-cursor' && method === 'PUT') {
      operation = 'notification';
      notification = { resource: 'readCursor' };
    } else {
      const match = /^\/auth\/challenges\/([a-f0-9-]{36})\/verify$/i.exec(path);
      if (!match || method !== 'POST') throw rejectedRequest();
      operation = 'verify';
      challengeId = match[1];
    }
    if (operation === 'logout') {
      cancellationClosed = true;
      cancellationEpoch++;
    }
    const originalCancellationEpoch = cancellationEpoch;
    const gameChatId =
      notification?.resource === 'createGame'
        ? (JSON.parse(init?.body as string) as { gameId: string }).gameId
        : null;
    if (gameChatId && (cancellationClosed || canDispatchGameChat?.(gameChatId) !== true))
      throw new DOMException('Session changed', 'AbortError');
    if (cancel && (cancellationClosed || canDispatchGameCancellation?.(cancel.resourceId) !== true))
      throw new DOMException('Session changed', 'AbortError');
    if (
      tournamentChat &&
      (cancellationClosed || canDispatchTournamentChat?.(tournamentChat) !== true)
    )
      throw new DOMException('Session changed', 'AbortError');
    if (station && (cancellationClosed || canDispatchStation?.(station) !== true))
      throw new DOMException('Session changed', 'AbortError');
    if (init?.body != null && typeof init.body !== 'string') throw rejectedRequest();
    if (read && init?.body != null) throw rejectedRequest();
    if (init?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    try {
      const result = await plugin.request({
        operation,
        ...(read ?? {}),
        ...(tournament ?? {}),
        ...(notification ?? {}),
        ...(quarter ?? {}),
        ...(cancel ?? {}),
        ...(station ?? {}),
        ...(tournamentChat ?? {}),
        ...(challengeId ? { challengeId } : {}),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (
        gameChatId &&
        (cancellationClosed ||
          originalCancellationEpoch !== cancellationEpoch ||
          canDispatchGameChat?.(gameChatId) !== true)
      )
        throw new DOMException('Session changed', 'AbortError');
      if (
        tournamentChat &&
        new TextEncoder().encode(result.body).length >
          (tournamentChat.resource === 'history' ? 3 : 1) * 1024 * 1024
      )
        throw rejectedRequest();
      if (
        tournamentChat &&
        (cancellationClosed ||
          originalCancellationEpoch !== cancellationEpoch ||
          canDispatchTournamentChat?.(tournamentChat) !== true)
      )
        throw new DOMException('Session changed', 'AbortError');
      if (
        station &&
        (cancellationClosed ||
          originalCancellationEpoch !== cancellationEpoch ||
          canDispatchStation?.(station) !== true)
      )
        throw new DOMException('Session changed', 'AbortError');
      if (
        cancel &&
        (cancellationClosed ||
          originalCancellationEpoch !== cancellationEpoch ||
          canDispatchGameCancellation?.(cancel.resourceId) !== true)
      )
        throw new DOMException('Session changed', 'AbortError');
      if (
        operation === 'verify' &&
        result.status === 200 &&
        originalCancellationEpoch === cancellationEpoch
      )
        cancellationClosed = false;
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
  private generation = 0;
  private quarterClosed = false;
  private quarterEpoch = 0;
  private tournamentClosed = false;
  private tournamentEpoch = 0;
  private readonly reads = new Set<Promise<unknown>>();
  private readonly gameChatRequests = new Map<string, string>();
  private readonly cancellations = new Map<string, string>();
  private readonly stationRequests = new Map<string, string>();
  private readonly tournamentChatRequests = new Map<string, string>();

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
    this.generation++;
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

  public closeQuarterCreate(): void {
    this.quarterClosed = true;
    this.quarterEpoch++;
    this.listeners.forEach((listener) => listener());
  }
  public quarterCreatePrincipal(): string | null {
    if (this.quarterClosed || this.state.status !== 'signed-in') return null;
    const c = this.state.session.context;
    return `${c.tenantId}:${c.userId}:${this.generation}:${this.quarterEpoch}`;
  }
  public async quarterCall<T>(load: (api: PadlHubApiClient) => Promise<T>): Promise<T> {
    const p = this.quarterCreatePrincipal();
    if (!p) throw rejectedRequest();
    const v = await this.read(load);
    if (p !== this.quarterCreatePrincipal())
      throw new DOMException('Session changed', 'AbortError');
    return v;
  }
  public canDispatchGameChat(gameId: string): boolean {
    const original = this.gameChatRequests.get(gameId);
    return original !== undefined && original === this.quarterCreatePrincipal();
  }
  public async openGameChat(
    gameId: string,
  ): ReturnType<PadlHubApiClient['getOrCreateGameConversation']> {
    const original = this.quarterCreatePrincipal();
    if (!original || this.gameChatRequests.has(gameId)) throw rejectedRequest();
    this.gameChatRequests.set(gameId, original);
    try {
      return await this.quarterCall((api) =>
        api.request('/conversations/game', {
          method: 'POST',
          idempotencyKey: crypto.randomUUID(),
          body: JSON.stringify({ gameId }),
          retryOnUnauthorized: false,
        }),
      );
    } finally {
      this.gameChatRequests.delete(gameId);
    }
  }
  public gameCancelPrincipal(): string | null {
    return this.quarterCreatePrincipal();
  }
  public canDispatchGameCancellation(gameId: string): boolean {
    const original = this.cancellations.get(gameId);
    return original !== undefined && original === this.gameCancelPrincipal();
  }
  public async cancelGame(gameId: string): ReturnType<PadlHubApiClient['cancelGame']> {
    const original = this.gameCancelPrincipal();
    if (!original || this.cancellations.has(gameId)) throw rejectedRequest();
    this.cancellations.set(gameId, original);
    try {
      return await this.quarterCall((api) =>
        api.cancelGame(gameId, { reasonCode: 'ORGANIZER_REQUEST' }),
      );
    } finally {
      this.cancellations.delete(gameId);
    }
  }
  public tournamentChatPrincipal(): string | null {
    return this.quarterCreatePrincipal();
  }
  private tournamentChatKey(request: NativeTournamentChatRequest): string {
    return JSON.stringify([
      request.resource,
      request.resourceId,
      request.requestId,
      request.query.limit,
      request.query.cursor,
    ]);
  }
  public canDispatchTournamentChat(request: NativeTournamentChatRequest): boolean {
    const original = this.tournamentChatRequests.get(this.tournamentChatKey(request));
    return original !== undefined && original === this.tournamentChatPrincipal();
  }
  private async tournamentChatCall<T>(
    request: NativeTournamentChatRequest,
    load: (api: PadlHubApiClient) => Promise<T>,
  ): Promise<T> {
    const principal = this.tournamentChatPrincipal(),
      key = this.tournamentChatKey(request);
    if (!principal || this.tournamentChatRequests.has(key)) throw rejectedRequest();
    this.tournamentChatRequests.set(key, principal);
    try {
      return await this.quarterCall(load);
    } finally {
      this.tournamentChatRequests.delete(key);
    }
  }
  public tournamentChatHistory(id: string, limit = 50, cursor?: string) {
    return this.tournamentChatCall(
      {
        resource: 'history',
        resourceId: id,
        query: { limit: String(limit), ...(cursor ? { cursor } : {}) },
      },
      (api) => api.getTournamentChatHistory(id, limit, cursor),
    );
  }
  public sendTournamentChatMessage(
    id: string,
    input: Parameters<PadlHubApiClient['sendTournamentChatMessage']>[1],
  ) {
    return this.tournamentChatCall(
      { resource: 'send', resourceId: id, requestId: input.requestId, query: {} },
      (api) => api.sendTournamentChatMessage(id, input),
    );
  }
  public tournamentChatStatus(id: string, requestId: string) {
    return this.tournamentChatCall(
      { resource: 'status', resourceId: id, requestId, query: {} },
      (api) => api.getTournamentChatRequest(id, requestId),
    );
  }
  public tournamentChatReadPosition(id: string) {
    return this.tournamentChatCall({ resource: 'position', resourceId: id, query: {} }, (api) =>
      api.getTournamentChatReadPosition(id),
    );
  }
  public advanceTournamentChatRead(
    id: string,
    input: Parameters<PadlHubApiClient['advanceTournamentChatRead']>[1],
  ) {
    return this.tournamentChatCall(
      { resource: 'read', resourceId: id, requestId: input.requestId, query: {} },
      (api) => api.advanceTournamentChatRead(id, input),
    );
  }
  public tournamentChatReadStatus(id: string, requestId: string) {
    return this.tournamentChatCall(
      { resource: 'readStatus', resourceId: id, requestId, query: {} },
      (api) => api.getTournamentChatReadRequest(id, requestId),
    );
  }
  public stationMessagePrincipal(): string | null {
    return this.quarterCreatePrincipal();
  }
  private stationKey(
    request: Pick<
      NativeStationRequest | NativeStationStreamRequest,
      'resource' | 'resourceId' | 'requestId'
    > & { readonly query?: Record<string, string> },
  ): string {
    return JSON.stringify([
      request.resource,
      request.resourceId,
      request.requestId,
      request.resource === 'summaries' ? request.query?.communityIds : undefined,
    ]);
  }
  public canDispatchStation(request: NativeStationRequest | NativeStationStreamRequest): boolean {
    const original = this.stationRequests.get(this.stationKey(request));
    return original !== undefined && original === this.stationMessagePrincipal();
  }
  private async stationCall<T>(
    request: Pick<
      NativeStationRequest | NativeStationStreamRequest,
      'resource' | 'resourceId' | 'requestId'
    > & { readonly query?: Record<string, string> },
    load: (api: PadlHubApiClient) => Promise<T>,
  ): Promise<T> {
    const principal = this.stationMessagePrincipal(),
      key = this.stationKey(request);
    if (!principal || this.stationRequests.has(key)) throw rejectedRequest();
    this.stationRequests.set(key, principal);
    try {
      return await this.quarterCall(load);
    } finally {
      this.stationRequests.delete(key);
    }
  }
  public stationStreamSummaries(ids: readonly string[]) {
    return this.stationCall(
      { resource: 'summaries', query: { communityIds: ids.join(',') } },
      (api) => api.listStationStreamSummaries(ids),
    );
  }
  public stationStream(communityId: string, cursor?: string) {
    return this.stationCall({ resource: 'stream', resourceId: communityId }, (api) =>
      api.getStationCommunityStream(communityId, { limit: 50, ...(cursor ? { cursor } : {}) }),
    );
  }
  public stationRead(
    communityId: string,
    input: Parameters<PadlHubApiClient['requestStationCommunityRead']>[1],
  ) {
    return this.stationCall(
      { resource: 'read', resourceId: communityId, requestId: input.requestId },
      (api) => api.requestStationCommunityRead(communityId, input),
    );
  }
  public stationReadStatus(communityId: string, requestId: string) {
    return this.stationCall({ resource: 'readStatus', resourceId: communityId, requestId }, (api) =>
      api.getStationCommunityReadRequest(communityId, requestId),
    );
  }
  public stationHistory(communityId: string, cursor?: string) {
    return this.stationCall({ resource: 'history', resourceId: communityId }, (api) =>
      api.listCommunityReadExperienceChat(communityId, {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      }),
    );
  }
  public sendStationMessage(
    communityId: string,
    input: Parameters<PadlHubApiClient['sendStationCommunityMessage']>[1],
  ) {
    return this.stationCall(
      { resource: 'send', resourceId: communityId, requestId: input.requestId },
      (api) => api.sendStationCommunityMessage(communityId, input),
    );
  }
  public stationMessageStatus(communityId: string, requestId: string) {
    return this.stationCall({ resource: 'status', resourceId: communityId, requestId }, (api) =>
      api.getStationCommunityMessageRequest(communityId, requestId),
    );
  }
  public restore(): Promise<void> {
    if (this.restoration) return this.restoration;
    const operation = this.exclusive(async () => {
      this.update({ status: 'checking' });
      try {
        await Promise.allSettled([...this.reads]);
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
    const quarterEpoch = this.quarterEpoch;
    return this.exclusive(async () => {
      if (this.state.status !== 'signed-out' || !/^\d{4}$/.test(code)) throw rejectedRequest();
      const tournamentEpoch = this.tournamentEpoch;
      await Promise.allSettled([...this.reads]);
      const session = await this.api.verifyAuthChallenge(challengeId, {
        code,
        acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
      });
      if (quarterEpoch === this.quarterEpoch) this.quarterClosed = false;
      if (tournamentEpoch === this.tournamentEpoch) this.tournamentClosed = false;
      this.update({ status: 'signed-in', session });
    });
  }

  public closeTournament(): void {
    this.tournamentClosed = true;
    this.tournamentEpoch++;
  }

  public tournamentPrincipal(): string | null {
    if (this.tournamentClosed || this.state.status !== 'signed-in') return null;
    const { context } = this.state.session;
    return `${context.tenantId}:${context.userId}:${this.generation}`;
  }

  public tournamentCall<T>(load: (api: PadlHubApiClient) => Promise<T>): Promise<T> {
    const principal = this.tournamentPrincipal();
    if (!principal) return Promise.reject(rejectedRequest());
    return this.read(load).then((value) => {
      if (this.tournamentPrincipal() !== principal)
        throw new DOMException('Session changed', 'AbortError');
      return value;
    });
  }

  public logout(): Promise<void> {
    this.closeQuarterCreate();
    this.closeTournament();
    return this.exclusive(async () => {
      this.api.clearAccessToken();
      this.update({ status: 'checking' });
      try {
        // Start native revocation immediately: it journals the intent even behind a slow
        // GET. Then drain SDK retries before allowing another login or releasing access.
        const revocation = this.api.revokeSession();
        const outcome = revocation.then(
          () => null,
          (error: unknown) => ({ error }),
        );
        await Promise.allSettled([...this.reads]);
        this.api.clearAccessToken();
        const result = await outcome;
        if (result) throw result.error;
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

  /** One SDK owns auth and cabinet reads. Discard responses from a previous account/lifecycle. */
  public read<T>(load: (api: PadlHubApiClient) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const operation = this.readCurrent(load);
    this.reads.add(operation);
    return operation
      .finally(() => this.reads.delete(operation))
      .catch(async (error: unknown) => {
        if (
          generation === this.generation &&
          error instanceof ApiClientError &&
          error.status === 401
        ) {
          // A final GET 401 can follow a successful refresh. Revoke the remaining native
          // credential before offering another login, using the same pending-logout journal.
          await this.logout();
        }
        throw error;
      });
  }

  private async readCurrent<T>(load: (api: PadlHubApiClient) => Promise<T>): Promise<T> {
    if (this.state.status !== 'signed-in') throw rejectedRequest();
    const generation = this.generation;
    const result = await load(this.api);
    if (generation !== this.generation) throw new DOMException('Session changed', 'AbortError');
    return result;
  }
}

let startup: Promise<IOSSession> | undefined;

export function getIOSSession(): Promise<IOSSession> {
  startup ??= (async () => {
    const plugin = registerPlugin<IOSSessionPlugin>('PadlHubSession');
    const configuration = await plugin.configuration();
    const api: PadlHubApiClient = new PadlHubApiClient({
      baseUrl: configuration.apiBaseUrl,
      tenantKey: configuration.tenantKey,
      platform: 'ios',
      sessionMode: 'cookie',
      appVersion: configuration.appVersion,
      appBuild: configuration.appBuild,
      fetchImplementation: createIOSFetch(
        configuration,
        plugin,
        (id) => session?.canDispatchGameCancellation(id) === true,
        (request) => session?.canDispatchStation(request) === true,
        (request) => session?.canDispatchTournamentChat(request) === true,
        (id) => session?.canDispatchGameChat(id) === true,
      ),
    });
    const session: IOSSession = new IOSSession(configuration, api);
    await session.restore();
    return session;
  })();
  return startup;
}
