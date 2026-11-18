import { RESIDENCY_OWNER_PATHS } from './residency-owner-paths.js';

/**
 * Server-side client for the LK1 residency owner (Z6v6e6r/lk#443, contract
 * residency-lifecycle.v2). LK2 never creates a second payment owner: every operation
 * here is forwarded one-to-one to the owner with the user's server-held Viva actor token.
 *
 * Exactly one attempt is made. A timeout is an ambiguous command and is never retried
 * here; the caller keeps the Idempotency-Key so the same operation can be repeated.
 */

const MAX_BODY_BYTES = 64 * 1024;
const STABLE_OWNER_CODE = /^RESIDENCY_[A-Z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ResidencyOwnerError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ResidencyOwnerError';
  }
}

export interface ResidencyOwnerCredential {
  readonly token: string;
  readonly expiresAt: string;
}

export interface ResidencyOwnerCall {
  readonly credential: ResidencyOwnerCredential;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly returnTarget?: boolean;
}

interface OwnerClientOptions {
  readonly baseUrl: string;
  readonly environment: 'development' | 'production';
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch | undefined;
  readonly onMetric?:
    | ((metric: { operation: string; outcome: 'success' | 'failure'; durationMs: number }) => void)
    | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isOrderId = (value: string): boolean => UUID.test(value);

function assertBaseUrl(baseUrl: string, environment: 'development' | 'production'): void {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (environment === 'production'
      ? url.href !== 'https://padlhub.su/'
      : url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new ResidencyOwnerError(503, 'RESIDENCY_OWNER_UNAVAILABLE', 'Owner base URL is invalid');
}

export class ClientResidencyOwnerClient {
  private failures = 0;
  private openUntil = 0;

  public constructor(private readonly options: OwnerClientOptions) {
    assertBaseUrl(options.baseUrl, options.environment);
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 10_000
    )
      throw new ResidencyOwnerError(503, 'RESIDENCY_OWNER_UNAVAILABLE', 'Owner timeout is invalid');
  }

  public catalog(call: ResidencyOwnerCall): Promise<unknown> {
    return this.send('GET', RESIDENCY_OWNER_PATHS.catalog, call);
  }

  public createOrder(call: ResidencyOwnerCall, body: unknown): Promise<unknown> {
    return this.send('POST', RESIDENCY_OWNER_PATHS.orders, { ...call, returnTarget: true }, body);
  }

  public listOrders(call: ResidencyOwnerCall): Promise<unknown> {
    return this.send('GET', RESIDENCY_OWNER_PATHS.orders + '?state=unresolved', call);
  }

  public readOrder(call: ResidencyOwnerCall, orderId: string): Promise<unknown> {
    return this.send('GET', RESIDENCY_OWNER_PATHS.order(orderId), call);
  }

  public readPayment(call: ResidencyOwnerCall, orderId: string): Promise<unknown> {
    return this.send('GET', RESIDENCY_OWNER_PATHS.payment(orderId), call);
  }

  public reconcileOrder(
    call: ResidencyOwnerCall,
    orderId: string,
    body: unknown,
  ): Promise<unknown> {
    return this.send('POST', RESIDENCY_OWNER_PATHS.reconcile(orderId), call, body);
  }

  public cancelOrder(call: ResidencyOwnerCall, orderId: string): Promise<unknown> {
    return this.send('POST', RESIDENCY_OWNER_PATHS.cancel(orderId), call, {});
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    call: ResidencyOwnerCall,
    body?: unknown,
  ): Promise<unknown> {
    if (!isRecord(call) || typeof call.credential?.token !== 'string') {
      throw new ResidencyOwnerError(
        503,
        'RESIDENCY_OWNER_UNAVAILABLE',
        'Owner credential is missing',
      );
    }
    if (/[\r\n]/.test(call.credential.token) || !/^[!-~]{16,4096}$/.test(call.credential.token)) {
      throw new ResidencyOwnerError(
        503,
        'RESIDENCY_OWNER_UNAVAILABLE',
        'Owner credential is invalid',
      );
    }
    if (
      typeof call.credential.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(call.credential.expiresAt)) ||
      Date.parse(call.credential.expiresAt) <= Date.now() + 10_000
    ) {
      throw new ResidencyOwnerError(
        409,
        'RESIDENCY_REAUTH_REQUIRED',
        'The provider delegation expired',
      );
    }
    if (typeof path !== 'string' || !path.startsWith('/lk/residency/') || /[\r\n]/.test(path)) {
      throw new ResidencyOwnerError(503, 'RESIDENCY_OWNER_UNAVAILABLE', 'Owner path is invalid');
    }
    if (this.openUntil > Date.now()) {
      throw new ResidencyOwnerError(503, 'RESIDENCY_OWNER_UNAVAILABLE', 'The owner is unavailable');
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + call.credential.token,
      'X-Correlation-ID': call.correlationId,
    };
    if (call.idempotencyKey) headers['Idempotency-Key'] = call.idempotencyKey;
    if (call.returnTarget) headers['X-Residency-Return-Target'] = 'lk2';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    let outcome: 'success' | 'failure' = 'failure';
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new ResidencyOwnerError(
            503,
            'RESIDENCY_OWNER_UNAVAILABLE',
            'The owner did not answer in time',
          ),
        );
      }, this.options.timeoutMs);
    });
    const work = async (): Promise<unknown> => {
      const response = await (this.options.fetchImplementation ?? fetch)(
        new URL(path, this.options.baseUrl).href,
        {
          method,
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          headers:
            body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new ResidencyOwnerError(
          503,
          'RESIDENCY_OWNER_UNAVAILABLE',
          'The owner returned a non-JSON answer',
        );
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        await response.body?.cancel();
        throw new ResidencyOwnerError(
          503,
          'RESIDENCY_OWNER_UNAVAILABLE',
          'The owner answer is too large',
        );
      }
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) {
        throw new ResidencyOwnerError(
          503,
          'RESIDENCY_OWNER_UNAVAILABLE',
          'The owner answer is too large',
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ResidencyOwnerError(
          503,
          'RESIDENCY_OWNER_UNAVAILABLE',
          'The owner answer is invalid',
        );
      }
      if (response.status >= 200 && response.status < 300) return parsed;
      const record = isRecord(parsed) ? parsed : {};
      const code =
        typeof record.code === 'string' && STABLE_OWNER_CODE.test(record.code) ? record.code : null;
      const message =
        typeof record.message === 'string' ? record.message.slice(0, 300) : 'Owner request failed';
      if (code && (response.status < 500 || response.status === 503))
        throw new ResidencyOwnerError(response.status, code, message, record.details);
      throw new ResidencyOwnerError(503, 'RESIDENCY_OWNER_UNAVAILABLE', 'The owner is unavailable');
    };
    try {
      const value = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      outcome = 'success';
      return value;
    } catch (error) {
      this.failures += 1;
      if (this.failures >= 3) this.openUntil = Date.now() + 30_000;
      if (error instanceof ResidencyOwnerError) throw error;
      throw new ResidencyOwnerError(503, 'RESIDENCY_OWNER_UNAVAILABLE', 'The owner is unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      try {
        this.options.onMetric?.({
          operation: method + ' ' + path.split('?')[0],
          outcome,
          durationMs: Math.max(0, performance.now() - start),
        });
      } catch {
        /* Telemetry cannot change custody. */
      }
    }
  }
}
