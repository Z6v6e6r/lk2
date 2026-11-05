import { z } from 'zod';

export type VivaResidencySourceErrorCode =
  | 'RESIDENCY_PRODUCT_NOT_CONFIGURED'
  | 'RESIDENCY_SOURCE_DISABLED'
  | 'RESIDENCY_SOURCE_UNAVAILABLE'
  | 'RESIDENCY_SOURCE_TIMEOUT'
  | 'RESIDENCY_SOURCE_RESPONSE_INVALID'
  | 'RESIDENCY_SOURCE_PARTIAL'
  | 'RESIDENCY_PRODUCT_IDENTITY_MISSING'
  | 'RESIDENCY_OWNERSHIP_CONFLICT'
  | 'RESIDENCY_CIRCUIT_OPEN';

export class VivaResidencySourceError extends Error {
  public constructor(
    public readonly code: VivaResidencySourceErrorCode,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'VivaResidencySourceError';
  }
}

/**
 * Provider-free observation of the configured residency product on the
 * authenticated client's own subscriptions. It deliberately carries no
 * provider identifiers: the caller never serializes Viva IDs.
 */
export interface VivaResidencyObservation {
  /** True only for a currently valid instance of the exact configured product. */
  readonly active: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  /** Timestamp of the complete provider read that produced this observation. */
  readonly checkedAt: string;
}

export interface VivaResidencySourceMetric {
  readonly operation: 'residency_subscriptions';
  readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
}

export interface VivaResidencySourceOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  /** Server-side Viva Admin API origin, for example https://api.vivacrm.ru. */
  readonly apiBaseUrl: string;
  /** Server-only Viva credential. It is never accepted from a client. */
  readonly apiKey: string;
  /** Exact Viva subscription product the operator created for residency. Empty means unconfigured. */
  readonly productId: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly timeZone?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly onMetric?: (metric: VivaResidencySourceMetric) => void;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const KNOWN_STATUSES = new Set(['NEW', 'ACTIVE', 'HOLD', 'EXPIRED', 'REFUNDED', 'NO_VISITS']);

function uuid(value: string): string | null {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function normalizeDate(value: string): string | null {
  if (!DATE_PATTERN.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return value.slice(0, 10);
}

const optionalDateSchema = z.string().trim().min(1).max(40).nullish();
const productRefSchema = z
  .object({
    id: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().max(500).optional(),
  })
  .nullish();
const clientRefSchema = z
  .object({
    id: z.string().trim().min(1).max(64).optional(),
  })
  .nullish();
const subscriptionSchema = z.object({
  subscriptionId: z.string().trim().min(8).max(64),
  clientSubscriptionId: z.string().trim().min(8).max(64).optional(),
  clientId: z.string().trim().min(1).max(64).optional(),
  client: clientRefSchema,
  status: z.string().trim().min(1).max(40),
  productId: z.string().trim().min(1).max(64).optional(),
  product: productRefSchema,
  isFrozen: z.boolean().optional(),
  holdUntil: optionalDateSchema,
  frozenUntil: optionalDateSchema,
  purchaseDate: optionalDateSchema,
  activationDate: optionalDateSchema,
  expirationDate: optionalDateSchema,
});
const pageSchema = z.object({
  content: z.array(subscriptionSchema).max(PAGE_SIZE),
  totalElements: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  number: z.number().int().nonnegative().optional(),
  last: z.boolean().optional(),
  hasNext: z.boolean().optional(),
  empty: z.boolean().optional(),
});

interface NormalizedInstance {
  readonly subscriptionId: string;
  readonly productIdentity: string | null;
  readonly active: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function providerDate(value: string | null | undefined): {
  readonly day: string | null;
  readonly valid: boolean;
} {
  if (value === null || value === undefined) return { day: null, valid: true };
  const day = normalizeDate(value);
  return { day, valid: day !== null };
}

export class VivaResidencySourceAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly productId: string | null;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaResidencySourceOptions) {
    if (
      (options.mode === 'sandbox' || options.mode === 'production') &&
      (!options.apiBaseUrl || !options.apiKey)
    ) {
      throw new Error('VIVA_RESIDENCY_SOURCE_CREDENTIALS_REQUIRED');
    }
    if ((options.maxAttempts ?? 2) < 1 || (options.maxAttempts ?? 2) > 3) {
      throw new Error('Viva residency maxAttempts must be between 1 and 3');
    }
    const baseUrl = options.apiBaseUrl ? new URL(options.apiBaseUrl) : undefined;
    if (
      baseUrl &&
      baseUrl.protocol !== 'https:' &&
      baseUrl.hostname !== 'localhost' &&
      baseUrl.hostname !== '127.0.0.1'
    ) {
      throw new Error('VIVA_RESIDENCY_SOURCE_BASE_URL_INVALID');
    }
    if (baseUrl && baseUrl.pathname !== '/' && baseUrl.pathname !== '') {
      throw new Error('VIVA_RESIDENCY_SOURCE_BASE_URL_INVALID');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.productId = options.productId ? uuid(options.productId) : null;
    if (options.productId && !this.productId) {
      throw new Error('VIVA_RESIDENCY_PRODUCT_ID_INVALID');
    }
  }

  private emit(metric: VivaResidencySourceMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change residency behavior.
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
      operation: 'residency_subscriptions',
      outcome: 'circuit_open',
      attempt: 0,
      durationMs: 0,
    });
    throw new VivaResidencySourceError('RESIDENCY_CIRCUIT_OPEN', true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private formatDay(timestamp: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.options.timeZone ?? 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestamp));
  }

  private async readPage(input: {
    readonly providerClientId: string;
    readonly correlationId: string;
    readonly page: number;
  }): Promise<z.infer<typeof pageSchema>> {
    const url = new URL(
      `/api/v1/clients/${encodeURIComponent(input.providerClientId)}/subscriptions`,
      this.options.apiBaseUrl,
    );
    url.searchParams.set('includeFinished', 'true');
    url.searchParams.set('page', String(input.page));
    url.searchParams.set('size', String(PAGE_SIZE));

    const maxAttempts = this.options.maxAttempts ?? 2;
    let lastError: VivaResidencySourceError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.ensureCircuitClosed();
      const startedAt = this.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.options.apiKey}`,
            'X-Correlation-ID': input.correlationId,
          },
        });
        if (!response.ok) {
          throw new VivaResidencySourceError(
            'RESIDENCY_SOURCE_UNAVAILABLE',
            isRetryableStatus(response.status),
            response.status,
          );
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
        }
        const parsed = pageSchema.safeParse(payload);
        if (!parsed.success) {
          throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
        }
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation: 'residency_subscriptions',
          outcome: 'success',
          attempt,
          status: response.status,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return parsed.data;
      } catch (error) {
        const failure =
          error instanceof VivaResidencySourceError
            ? error
            : error instanceof Error && error.name === 'AbortError'
              ? new VivaResidencySourceError('RESIDENCY_SOURCE_TIMEOUT', true)
              : new VivaResidencySourceError('RESIDENCY_SOURCE_UNAVAILABLE', true);
        lastError = failure;
        this.recordFailure();
        this.emit({
          operation: 'residency_subscriptions',
          outcome: failure.retryable && attempt < maxAttempts ? 'retry' : 'failure',
          attempt,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          durationMs: Math.max(0, this.now() - startedAt),
        });
        if (!failure.retryable || attempt === maxAttempts) throw failure;
        await this.sleep(Math.min((this.options.retryBaseDelayMs ?? 100) * attempt, 1_000));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new VivaResidencySourceError('RESIDENCY_SOURCE_UNAVAILABLE', true);
  }

  private normalizeInstance(
    raw: z.infer<typeof subscriptionSchema>,
    expectedClientId: string,
  ): NormalizedInstance {
    const subscriptionId = uuid(raw.subscriptionId);
    if (!subscriptionId) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
    }
    if (raw.clientSubscriptionId !== undefined) {
      const alias = uuid(raw.clientSubscriptionId);
      if (!alias || alias !== subscriptionId) {
        throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
      }
    }
    const ownerAliases = [raw.clientId, raw.client?.id].filter(
      (value): value is string => value !== undefined,
    );
    for (const owner of ownerAliases) {
      const normalized = uuid(owner);
      if (!normalized) {
        throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
      }
      if (normalized !== expectedClientId) {
        throw new VivaResidencySourceError('RESIDENCY_OWNERSHIP_CONFLICT');
      }
    }
    const productAliases = [raw.productId, raw.product?.id].filter(
      (value): value is string => value !== undefined,
    );
    const normalizedProducts = productAliases.map((value) => uuid(value));
    if (normalizedProducts.some((value) => value === null)) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
    }
    const distinctProducts = [...new Set(normalizedProducts)];
    if (distinctProducts.length > 1) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
    }
    const productIdentity = distinctProducts[0] ?? null;
    const activation = providerDate(raw.activationDate ?? raw.purchaseDate);
    const expiration = providerDate(raw.expirationDate);
    if (!activation.valid || !expiration.valid) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
    }
    const today = this.formatDay(this.now());
    const status = raw.status.trim().toUpperCase();
    if (!KNOWN_STATUSES.has(status)) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
    }
    const withinActivation = activation.day === null || activation.day <= today;
    const withinExpiration = expiration.day === null || expiration.day >= today;
    const suspended = raw.isFrozen === true || raw.holdUntil != null || raw.frozenUntil != null;
    return {
      subscriptionId,
      productIdentity,
      active: status === 'ACTIVE' && withinActivation && withinExpiration && !suspended,
      validFrom: activation.day,
      validUntil: expiration.day,
    };
  }

  /**
   * Reads the authenticated client's complete subscription list through the
   * server-side Viva Admin credential and classifies only the exact configured
   * product. Ownership comes from the server-resolved provider client ID; names,
   * categories and unrelated subscriptions are never used as evidence.
   */
  public async read(input: {
    readonly providerClientId: string;
    readonly correlationId: string;
  }): Promise<VivaResidencyObservation> {
    if (this.options.mode === 'disabled' || this.options.mode === 'mock') {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_DISABLED');
    }
    if (!this.productId) {
      throw new VivaResidencySourceError('RESIDENCY_PRODUCT_NOT_CONFIGURED');
    }
    const providerClientId = uuid(input.providerClientId);
    if (!providerClientId) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
    }

    const instances: NormalizedInstance[] = [];
    const seen = new Set<string>();
    let expectedTotal: number | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.readPage({
        providerClientId,
        correlationId: input.correlationId,
        page,
      });
      if (body.number !== undefined && body.number !== page) {
        throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
      }
      if (body.totalElements !== undefined) {
        if (expectedTotal !== undefined && expectedTotal !== body.totalElements) {
          throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
        }
        expectedTotal = body.totalElements;
      }
      for (const raw of body.content) {
        const instance = this.normalizeInstance(raw, providerClientId);
        if (seen.has(instance.subscriptionId)) {
          throw new VivaResidencySourceError('RESIDENCY_SOURCE_RESPONSE_INVALID');
        }
        seen.add(instance.subscriptionId);
        instances.push(instance);
      }
      const nextKnown =
        body.last === true ||
        body.hasNext === false ||
        (body.totalPages !== undefined && page + 1 >= body.totalPages) ||
        (body.last === undefined &&
          body.hasNext === undefined &&
          body.totalPages === undefined &&
          body.content.length < PAGE_SIZE);
      if (nextKnown) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new VivaResidencySourceError('RESIDENCY_SOURCE_PARTIAL');
    if (expectedTotal !== undefined && expectedTotal !== instances.length) {
      throw new VivaResidencySourceError('RESIDENCY_SOURCE_PARTIAL');
    }

    const matching = instances.filter((instance) => instance.productIdentity === this.productId);
    const active = matching.filter((instance) => instance.active);
    if (active.length > 0) {
      const chosen = [...active].sort((left, right) => {
        if (left.validUntil !== right.validUntil) {
          if (left.validUntil === null) return -1;
          if (right.validUntil === null) return 1;
          return right.validUntil.localeCompare(left.validUntil);
        }
        return left.subscriptionId.localeCompare(right.subscriptionId);
      })[0]!;
      return {
        active: true,
        validFrom: chosen.validFrom,
        validUntil: chosen.validUntil,
        checkedAt: new Date(this.now()).toISOString(),
      };
    }
    if (instances.some((instance) => instance.productIdentity === null)) {
      throw new VivaResidencySourceError('RESIDENCY_PRODUCT_IDENTITY_MISSING');
    }
    const latest = [...matching].sort((left, right) => {
      if (left.validUntil !== right.validUntil) {
        if (left.validUntil === null) return 1;
        if (right.validUntil === null) return -1;
        return right.validUntil.localeCompare(left.validUntil);
      }
      return left.subscriptionId.localeCompare(right.subscriptionId);
    })[0];
    return {
      active: false,
      validFrom: latest?.validFrom ?? null,
      validUntil: latest?.validUntil ?? null,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}
