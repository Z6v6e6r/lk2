import { z } from 'zod';

/**
 * ADR 0029 D5: server-side Viva Admin read of the subscription instances that belong to one
 * mapped Viva client, used only to write `VIVA/subscription` integration mappings.
 *
 * Source: `GET /api/v1/clients/{clientId}/subscriptions` with the server key, the same Admin method
 * and page contract as the residency read (ADR 0027). Never `/end-user/api/` (ADR 0023).
 *
 * The read is all-or-nothing. A page gap, a count mismatch, a duplicate, an unknown status, a
 * malformed identifier or an instance that names another client rejects the whole read, so the
 * caller can never mistake a partial answer for "this client has no such subscription".
 *
 * The result carries only the provider instance identifiers (as Viva returned them) and the
 * observation time. No names, prices, phones or payloads leave the adapter.
 */

export type VivaClientSubscriptionMappingErrorCode =
  | 'CLIENT_SUBSCRIPTIONS_DISABLED'
  | 'CLIENT_SUBSCRIPTIONS_CLIENT_ID_INVALID'
  | 'CLIENT_SUBSCRIPTIONS_UNAVAILABLE'
  | 'CLIENT_SUBSCRIPTIONS_TIMEOUT'
  | 'CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID'
  | 'CLIENT_SUBSCRIPTIONS_PARTIAL'
  | 'CLIENT_SUBSCRIPTIONS_OWNERSHIP_CONFLICT'
  | 'CLIENT_SUBSCRIPTIONS_CIRCUIT_OPEN';

export class VivaClientSubscriptionMappingError extends Error {
  public constructor(
    public readonly code: VivaClientSubscriptionMappingErrorCode,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'VivaClientSubscriptionMappingError';
  }
}

export interface VivaClientSubscriptionMappingRead {
  /** Instances that can still be used or activated; provider ids exactly as Viva returned them. */
  readonly providerSubscriptionIds: readonly string[];
  /** Time of the complete provider read that produced this list. */
  readonly observedAt: string;
}

export interface VivaClientSubscriptionMappingMetric {
  readonly operation: 'client_subscriptions';
  readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
}

export interface VivaClientSubscriptionMappingSourceOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  /** Server-side Viva Admin API origin, for example https://api.vivacrm.ru. */
  readonly apiBaseUrl: string;
  /** Server-only Viva credential. It is never accepted from a client. */
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly onMetric?: (metric: VivaClientSubscriptionMappingMetric) => void;
}

export const CLIENT_SUBSCRIPTIONS_PAGE_SIZE = 200;
/** Upper bound of one read: 5 pages x 200 rows. More is refused as partial, never truncated. */
export const CLIENT_SUBSCRIPTIONS_MAX_PAGES = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Instances that can still be used or activated. Finished ones (EXPIRED, REFUNDED, NO_VISITS) and
 * any status this code does not know are not mapped. Skipping is safe here because this path never
 * unmaps: an unknown status only leaves that one instance without a new mapping.
 */
const MAPPABLE_STATUSES = new Set(['NEW', 'ACTIVE', 'HOLD']);
const RETRY_AFTER_CAP_MS = 1_000;

const subscriptionSchema = z
  .object({
    subscriptionId: z.string().trim().min(8).max(64),
    clientSubscriptionId: z.string().trim().min(8).max(64).optional(),
    clientId: z.string().trim().min(1).max(64).optional(),
    client: z.object({ id: z.string().trim().min(1).max(64).optional() }).nullish(),
    status: z.string().trim().min(1).max(40),
  })
  .passthrough();
const pageSchema = z.object({
  content: z.array(subscriptionSchema).max(CLIENT_SUBSCRIPTIONS_PAGE_SIZE),
  totalElements: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  number: z.number().int().nonnegative().optional(),
  last: z.boolean().optional(),
  hasNext: z.boolean().optional(),
});

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` in seconds, capped so a bounded login step never sleeps longer than 1 s. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header || !/^\d{1,4}$/.test(header.trim())) return undefined;
  return Math.min(Number(header.trim()) * 1_000, RETRY_AFTER_CAP_MS);
}

export class VivaClientSubscriptionMappingSource {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaClientSubscriptionMappingSourceOptions) {
    if (
      (options.mode === 'sandbox' || options.mode === 'production') &&
      (!options.apiBaseUrl || !options.apiKey)
    ) {
      throw new Error('VIVA_CLIENT_SUBSCRIPTIONS_CREDENTIALS_REQUIRED');
    }
    const attempts = options.maxAttempts ?? 2;
    if (attempts < 1 || attempts > 3) {
      throw new Error('Viva client subscriptions maxAttempts must be between 1 and 3');
    }
    const baseUrl = options.apiBaseUrl ? new URL(options.apiBaseUrl) : undefined;
    if (
      baseUrl &&
      ((baseUrl.protocol !== 'https:' &&
        baseUrl.hostname !== 'localhost' &&
        baseUrl.hostname !== '127.0.0.1') ||
        (baseUrl.pathname !== '/' && baseUrl.pathname !== '') ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.search ||
        baseUrl.hash)
    ) {
      throw new Error('VIVA_CLIENT_SUBSCRIPTIONS_BASE_URL_INVALID');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /**
   * Reads every subscription instance of `providerClientId`. The client id must come from the
   * server-side `viva_profile` mapping of the authenticated user, never from a request.
   */
  public async read(input: {
    readonly providerClientId: string;
    readonly correlationId: string;
  }): Promise<VivaClientSubscriptionMappingRead> {
    if (this.options.mode !== 'sandbox' && this.options.mode !== 'production') {
      throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_DISABLED');
    }
    if (!UUID_PATTERN.test(input.providerClientId)) {
      throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_CLIENT_ID_INVALID');
    }
    const clientKey = input.providerClientId.toLowerCase();
    const seen = new Set<string>();
    const mappable: string[] = [];
    let total = 0;
    let expectedTotal: number | undefined;
    for (let page = 0; page < CLIENT_SUBSCRIPTIONS_MAX_PAGES; page += 1) {
      const body = await this.readPage(input.providerClientId, input.correlationId, page);
      if (body.number !== undefined && body.number !== page) this.invalid();
      if (body.totalElements !== undefined) {
        if (expectedTotal !== undefined && expectedTotal !== body.totalElements) this.invalid();
        expectedTotal = body.totalElements;
      }
      for (const row of body.content) {
        const id = row.subscriptionId;
        if (!UUID_PATTERN.test(id)) this.invalid();
        const key = id.toLowerCase();
        if (
          row.clientSubscriptionId !== undefined &&
          row.clientSubscriptionId.toLowerCase() !== key
        ) {
          this.invalid();
        }
        for (const owner of [row.clientId, row.client?.id]) {
          if (owner === undefined) continue;
          if (!UUID_PATTERN.test(owner)) this.invalid();
          if (owner.toLowerCase() !== clientKey) {
            throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_OWNERSHIP_CONFLICT');
          }
        }
        const status = row.status.toUpperCase();
        if (seen.has(key)) this.invalid();
        seen.add(key);
        total += 1;
        if (MAPPABLE_STATUSES.has(status)) mappable.push(id);
      }
      const last =
        body.last === true ||
        body.hasNext === false ||
        (body.totalPages !== undefined && page + 1 >= body.totalPages) ||
        (body.last === undefined &&
          body.hasNext === undefined &&
          body.totalPages === undefined &&
          body.content.length < CLIENT_SUBSCRIPTIONS_PAGE_SIZE);
      if (last) {
        if (expectedTotal !== undefined && expectedTotal !== total) {
          throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_PARTIAL');
        }
        return {
          providerSubscriptionIds: mappable,
          observedAt: new Date(this.now()).toISOString(),
        };
      }
    }
    throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_PARTIAL');
  }

  private invalid(): never {
    throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID');
  }

  private emit(metric: VivaClientSubscriptionMappingMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change read behavior.
    }
  }

  private ensureCircuitClosed(): void {
    if (this.circuitOpenedAt === undefined) return;
    if (this.now() - this.circuitOpenedAt >= (this.options.circuitResetMs ?? 30_000)) {
      this.circuitOpenedAt = undefined;
      this.consecutiveFailures = 0;
      return;
    }
    this.emit({
      operation: 'client_subscriptions',
      outcome: 'circuit_open',
      attempt: 0,
      durationMs: 0,
    });
    throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_CIRCUIT_OPEN', true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private async readPage(
    providerClientId: string,
    correlationId: string,
    page: number,
  ): Promise<z.infer<typeof pageSchema>> {
    const url = new URL(
      `/api/v1/clients/${encodeURIComponent(providerClientId)}/subscriptions`,
      this.options.apiBaseUrl,
    );
    url.searchParams.set('includeFinished', 'true');
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(CLIENT_SUBSCRIPTIONS_PAGE_SIZE));
    const maxAttempts = this.options.maxAttempts ?? 2;
    let lastError: VivaClientSubscriptionMappingError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.ensureCircuitClosed();
      const startedAt = this.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let waitMs: number | undefined;
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
            'X-Correlation-ID': correlationId,
          },
        });
        if (!response.ok) {
          waitMs = retryAfterMs(response);
          await response.body?.cancel().catch(() => undefined);
          throw new VivaClientSubscriptionMappingError(
            'CLIENT_SUBSCRIPTIONS_UNAVAILABLE',
            isRetryableStatus(response.status),
            response.status,
          );
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID');
        }
        const parsed = pageSchema.safeParse(payload);
        if (!parsed.success) {
          throw new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_RESPONSE_INVALID');
        }
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation: 'client_subscriptions',
          outcome: 'success',
          attempt,
          status: response.status,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return parsed.data;
      } catch (error) {
        const failure =
          error instanceof VivaClientSubscriptionMappingError
            ? error
            : error instanceof Error && error.name === 'AbortError'
              ? new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_TIMEOUT', true)
              : new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_UNAVAILABLE', true);
        lastError = failure;
        // One client's 404 or malformed answer must not stop the sync for everyone else: only
        // transport/retryable failures and a rejected server key count towards the breaker.
        if (failure.retryable || failure.status === 401 || failure.status === 403) {
          this.recordFailure();
        }
        const retry = failure.retryable && attempt < maxAttempts;
        this.emit({
          operation: 'client_subscriptions',
          outcome: retry ? 'retry' : 'failure',
          attempt,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          durationMs: Math.max(0, this.now() - startedAt),
        });
        if (!retry) throw failure;
        await this.sleep(
          waitMs ?? Math.min((this.options.retryBaseDelayMs ?? 100) * attempt, RETRY_AFTER_CAP_MS),
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw (
      lastError ?? new VivaClientSubscriptionMappingError('CLIENT_SUBSCRIPTIONS_UNAVAILABLE', true)
    );
  }
}
