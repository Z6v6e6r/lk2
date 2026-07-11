import type { components } from '@phub/api-contracts';

export type AuthChallengeRequest = components['schemas']['AuthChallengeRequest'];
export type AuthChallenge = components['schemas']['AuthChallenge'];
export type VerifyAuthChallengeRequest = components['schemas']['VerifyAuthChallengeRequest'];
export type AuthenticatedSession = components['schemas']['AuthenticatedSession'];
export type AuthenticatedUser = components['schemas']['AuthenticatedUser'];
export type UserContext = components['schemas']['UserContext'];

export type RequestAuthMode = 'none' | 'required';
export type SessionIntent = 'refresh' | 'logout';

export type ApiRequestInit = RequestInit & {
  readonly auth?: RequestAuthMode;
  readonly idempotencyKey?: string;
  readonly retryOnUnauthorized?: boolean;
  readonly sessionIntent?: SessionIntent;
};

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly initialAccessToken?: string;
  readonly platform: 'web' | 'ios' | 'android' | 'cup-admin';
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly fetchImplementation?: typeof fetch;
}

export class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly correlationId: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface RequestPolicy {
  readonly auth: RequestAuthMode;
  readonly idempotencyKey?: string;
  readonly retryOnUnauthorized: boolean;
  readonly sessionIntent?: SessionIntent;
  readonly requestInit: RequestInit;
}

let fallbackRequestSequence = 0;

function createCorrelationId(): string {
  const webCrypto = typeof globalThis === 'object' ? globalThis.crypto : undefined;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  // Correlation and idempotency keys are opaque operation identifiers, not
  // credentials. Some embedded browsers expose fetch but omit Web Crypto, so
  // retain retry safety instead of failing before the request can be sent.
  fallbackRequestSequence = (fallbackRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `phub-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuthenticatedSession(value: unknown): value is AuthenticatedSession {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.context)) return false;
  return (
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0 &&
    value.tokenType === 'Bearer' &&
    typeof value.expiresAt === 'string' &&
    typeof value.user.id === 'string' &&
    typeof value.user.displayName === 'string' &&
    typeof value.context.tenantId === 'string' &&
    typeof value.context.userId === 'string'
  );
}

function jsonRequestBody(value: unknown): string {
  return JSON.stringify(value);
}

export class PadlHubApiClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly apiRoot: string;
  private accessToken: string | undefined;
  private refreshInFlight: Promise<AuthenticatedSession> | undefined;

  public constructor(private readonly options: ApiClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.apiRoot = `${options.baseUrl.replace(/\/$/, '')}/user/api/v1/${encodeURIComponent(options.tenantKey)}`;
    this.accessToken = options.initialAccessToken?.trim() || undefined;
  }

  public setAccessToken(accessToken: string | undefined): void {
    const normalized = accessToken?.trim();
    this.accessToken = normalized ? normalized : undefined;
  }

  public clearAccessToken(): void {
    this.setAccessToken(undefined);
  }

  public getAccessToken(): string | undefined {
    return this.accessToken;
  }

  public async request<TResponse>(path: string, init: ApiRequestInit = {}): Promise<TResponse> {
    const {
      auth = 'required',
      idempotencyKey,
      retryOnUnauthorized = true,
      sessionIntent,
      ...requestInit
    } = init;
    const policy: RequestPolicy = {
      auth,
      retryOnUnauthorized,
      requestInit,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(sessionIntent === undefined ? {} : { sessionIntent }),
    };
    return this.requestWithPolicy<TResponse>(path, policy, createCorrelationId(), true);
  }

  public createAuthChallenge(input: AuthChallengeRequest): Promise<AuthChallenge> {
    const idempotencyKey = createCorrelationId();
    return this.retryOnceOnNetworkFailure(() =>
      this.request<AuthChallenge>('/auth/challenges', {
        method: 'POST',
        auth: 'none',
        credentials: 'include',
        idempotencyKey,
        body: jsonRequestBody(input),
      }),
    );
  }

  public async verifyAuthChallenge(
    challengeId: string,
    input: VerifyAuthChallengeRequest,
  ): Promise<AuthenticatedSession> {
    const idempotencyKey = createCorrelationId();
    const session = await this.retryOnceOnNetworkFailure(() =>
      this.request<AuthenticatedSession>(
        `/auth/challenges/${encodeURIComponent(challengeId)}/verify`,
        {
          method: 'POST',
          auth: 'none',
          credentials: 'include',
          idempotencyKey,
          body: jsonRequestBody(input),
        },
      ),
    );
    this.applyAuthenticatedSession(session);
    return session;
  }

  public refreshSession(): Promise<AuthenticatedSession> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const refresh = this.performSessionRefresh().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  public async revokeSession(): Promise<void> {
    const idempotencyKey = createCorrelationId();
    await this.retryOnceOnNetworkFailure(() =>
      this.request<void>('/auth/session', {
        method: 'DELETE',
        auth: 'none',
        credentials: 'include',
        retryOnUnauthorized: false,
        sessionIntent: 'logout',
        idempotencyKey,
      }),
    );
    this.clearAccessToken();
  }

  public getUserContext(): Promise<UserContext> {
    return this.request<UserContext>('/context');
  }

  private async performSessionRefresh(): Promise<AuthenticatedSession> {
    try {
      const idempotencyKey = createCorrelationId();
      let session: AuthenticatedSession;
      try {
        session = await this.retryOnceOnNetworkFailure(() =>
          this.requestSessionRefresh(idempotencyKey),
        );
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'AUTH_REFRESH_RACE') throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
        session = await this.retryOnceOnNetworkFailure(() =>
          this.requestSessionRefresh(idempotencyKey),
        );
      }
      this.applyAuthenticatedSession(session);
      return session;
    } catch (error) {
      this.clearAccessToken();
      throw error;
    }
  }

  private requestSessionRefresh(idempotencyKey: string): Promise<AuthenticatedSession> {
    return this.request<AuthenticatedSession>('/auth/session/refresh', {
      method: 'POST',
      auth: 'none',
      credentials: 'include',
      retryOnUnauthorized: false,
      sessionIntent: 'refresh',
      idempotencyKey,
    });
  }

  private async retryOnceOnNetworkFailure<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return operation();
    }
  }

  private applyAuthenticatedSession(session: AuthenticatedSession): void {
    if (!isAuthenticatedSession(session)) {
      this.clearAccessToken();
      throw new Error('PadlHub authentication response is invalid');
    }
    this.setAccessToken(session.accessToken);
  }

  private async requestWithPolicy<TResponse>(
    path: string,
    policy: RequestPolicy,
    correlationId: string,
    allowRefresh: boolean,
  ): Promise<TResponse> {
    const headers = new Headers(policy.requestInit.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Correlation-ID', correlationId);
    headers.set('X-App-Platform', this.options.platform);
    headers.set('X-App-Version', this.options.appVersion);
    if (this.options.appBuild) headers.set('X-App-Build', this.options.appBuild);
    if (policy.idempotencyKey) headers.set('Idempotency-Key', policy.idempotencyKey);
    if (policy.sessionIntent) headers.set('X-Session-Intent', policy.sessionIntent);
    if (policy.requestInit.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    if (policy.auth === 'required') {
      const accessToken = this.getAccessToken();
      if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
      else headers.delete('Authorization');
    } else {
      headers.delete('Authorization');
    }

    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const response = await this.fetchImplementation(`${this.apiRoot}${normalizedPath}`, {
      ...policy.requestInit,
      credentials: policy.requestInit.credentials ?? 'same-origin',
      headers,
    });

    if (
      response.status === 401 &&
      policy.auth === 'required' &&
      policy.retryOnUnauthorized &&
      allowRefresh
    ) {
      await this.refreshSession();
      return this.requestWithPolicy<TResponse>(path, policy, correlationId, false);
    }

    if (!response.ok) throw await this.toApiClientError(response, correlationId);
    if (response.status === 204) return undefined as TResponse;
    return (await response.json()) as TResponse;
  }

  private async toApiClientError(
    response: Response,
    fallbackCorrelationId: string,
  ): Promise<ApiClientError> {
    const body = (await response.json().catch(() => undefined)) as
      { code?: string; message?: string; correlationId?: string } | undefined;
    return new ApiClientError(
      body?.message ?? 'Запрос не выполнен.',
      response.status,
      body?.code ?? 'UNEXPECTED_API_ERROR',
      body?.correlationId ?? response.headers.get('X-Correlation-ID') ?? fallbackCorrelationId,
    );
  }
}
