import { z } from 'zod';

/**
 * ADR 0029 D5: server-side Viva Admin lookup of the client that owns an OTP-verified phone.
 *
 * Viva `GET /api/v2/search/clients?q=` is a relevance search: a full 11-digit phone returns the
 * exact owner together with near matches (pinned from a redacted cabinet HAR, 2026-11-09). The
 * search result is therefore only a candidate list. The decision is made on each candidate's card
 * (`GET /api/v1/clients/{id}`) by exact comparison of its `phone` field. Exactly one active exact
 * match is `MATCHED`; zero is `NOT_FOUND`; more than one, or a candidate list that may be truncated,
 * is `AMBIGUOUS`. Every other uncertainty is an error, never `NOT_FOUND`.
 *
 * The adapter performs GET requests only and returns no phone, name or provider payload.
 */

export type VivaClientPhoneLookupErrorCode =
  | 'CLIENT_PHONE_LOOKUP_DISABLED'
  | 'CLIENT_PHONE_LOOKUP_PHONE_INVALID'
  | 'CLIENT_PHONE_LOOKUP_UNAVAILABLE'
  | 'CLIENT_PHONE_LOOKUP_TIMEOUT'
  | 'CLIENT_PHONE_LOOKUP_RESPONSE_INVALID'
  | 'CLIENT_PHONE_LOOKUP_CIRCUIT_OPEN';

export class VivaClientPhoneLookupError extends Error {
  public constructor(
    public readonly code: VivaClientPhoneLookupErrorCode,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'VivaClientPhoneLookupError';
  }
}

export type VivaClientPhoneLookupResult =
  | { readonly kind: 'MATCHED'; readonly providerClientId: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'AMBIGUOUS' };

export interface VivaClientPhoneLookupMetric {
  readonly operation: 'client_search' | 'client_card';
  readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
}

export interface VivaClientPhoneLookupOptions {
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
  readonly onMetric?: (metric: VivaClientPhoneLookupMetric) => void;
}

/** Viva pages search results at 20 rows; a full page may hide further exact owners. */
export const CLIENT_SEARCH_PAGE_LIMIT = 20;
/** A full phone normally yields a handful of near matches; more is treated as ambiguous. */
export const CLIENT_SEARCH_MAX_CANDIDATES = 5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RU_E164_PATTERN = /^\+7\d{10}$/;

const searchSchema = z.array(z.object({ clientId: z.string() }).passthrough());
const cardSchema = z
  .object({
    id: z.string(),
    // Required: a card without the field cannot prove it is not a second owner of the phone.
    phone: z.string().nullable(),
    deleted: z.boolean().optional(),
  })
  .passthrough();

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Viva stores Russian phones as 11 digits starting with 7 (no '+'). */
function vivaPhoneDigits(phoneE164: string): string {
  return phoneE164.slice(1);
}

function normalizeVivaPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return `7${digits.slice(1)}`;
  }
  return null;
}

export class VivaClientPhoneLookupAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaClientPhoneLookupOptions) {
    if (
      (options.mode === 'sandbox' || options.mode === 'production') &&
      (!options.apiBaseUrl || !options.apiKey)
    ) {
      throw new Error('VIVA_CLIENT_PHONE_LOOKUP_CREDENTIALS_REQUIRED');
    }
    const attempts = options.maxAttempts ?? 2;
    if (attempts < 1 || attempts > 3) {
      throw new Error('Viva client phone lookup maxAttempts must be between 1 and 3');
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
      throw new Error('VIVA_CLIENT_PHONE_LOOKUP_BASE_URL_INVALID');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  public async lookup(input: {
    readonly phoneE164: string;
    readonly correlationId: string;
  }): Promise<VivaClientPhoneLookupResult> {
    if (this.options.mode !== 'sandbox' && this.options.mode !== 'production') {
      throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_DISABLED');
    }
    if (!RU_E164_PATTERN.test(input.phoneE164)) {
      throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_PHONE_INVALID');
    }
    const wanted = vivaPhoneDigits(input.phoneE164);

    const searchUrl = new URL('/api/v2/search/clients', this.options.apiBaseUrl);
    searchUrl.searchParams.set('q', wanted);
    const rows = searchSchema.safeParse(
      await this.getJson(searchUrl, 'client_search', input.correlationId),
    );
    if (!rows.success) throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_RESPONSE_INVALID');
    if (rows.data.length >= CLIENT_SEARCH_PAGE_LIMIT) return { kind: 'AMBIGUOUS' };

    // Deduplicate case-insensitively but keep the identifier exactly as Viva returned it: the other
    // `viva_profile` writers store the raw provider value and paid-flow readers match it exactly.
    const candidates = new Map<string, string>();
    for (const row of rows.data) {
      if (!UUID_PATTERN.test(row.clientId)) {
        throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_RESPONSE_INVALID');
      }
      const key = row.clientId.toLowerCase();
      if (!candidates.has(key)) candidates.set(key, row.clientId);
    }
    if (candidates.size === 0) return { kind: 'NOT_FOUND' };
    if (candidates.size > CLIENT_SEARCH_MAX_CANDIDATES) return { kind: 'AMBIGUOUS' };

    // Card reads are independent; reading them together bounds the login latency to one round.
    const cards = await Promise.all(
      [...candidates].map(async ([key, candidate]) => {
        const cardUrl = new URL(
          `/api/v1/clients/${encodeURIComponent(candidate)}`,
          this.options.apiBaseUrl,
        );
        const card = cardSchema.safeParse(
          await this.getJson(cardUrl, 'client_card', input.correlationId),
        );
        if (!card.success || card.data.id.toLowerCase() !== key) {
          throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_RESPONSE_INVALID');
        }
        return card.data;
      }),
    );
    const exact = cards
      .filter((card) => card.deleted !== true && normalizeVivaPhone(card.phone) === wanted)
      .map((card) => card.id);
    if (exact.length === 0) return { kind: 'NOT_FOUND' };
    if (exact.length > 1) return { kind: 'AMBIGUOUS' };
    return { kind: 'MATCHED', providerClientId: exact[0] as string };
  }

  private emit(metric: VivaClientPhoneLookupMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change lookup behavior.
    }
  }

  private ensureCircuitClosed(operation: VivaClientPhoneLookupMetric['operation']): void {
    if (this.circuitOpenedAt === undefined) return;
    if (this.now() - this.circuitOpenedAt >= (this.options.circuitResetMs ?? 30_000)) {
      this.circuitOpenedAt = undefined;
      this.consecutiveFailures = 0;
      return;
    }
    this.emit({ operation, outcome: 'circuit_open', attempt: 0, durationMs: 0 });
    throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_CIRCUIT_OPEN', true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private async getJson(
    url: URL,
    operation: VivaClientPhoneLookupMetric['operation'],
    correlationId: string,
  ): Promise<unknown> {
    const maxAttempts = this.options.maxAttempts ?? 2;
    let lastError: VivaClientPhoneLookupError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.ensureCircuitClosed(operation);
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
            'X-Correlation-ID': correlationId,
          },
        });
        if (!response.ok) {
          throw new VivaClientPhoneLookupError(
            'CLIENT_PHONE_LOOKUP_UNAVAILABLE',
            isRetryableStatus(response.status),
            response.status,
          );
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_RESPONSE_INVALID');
        }
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation,
          outcome: 'success',
          attempt,
          status: response.status,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return payload;
      } catch (error) {
        const failure =
          error instanceof VivaClientPhoneLookupError
            ? error
            : error instanceof Error && error.name === 'AbortError'
              ? new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_TIMEOUT', true)
              : new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_UNAVAILABLE', true);
        lastError = failure;
        this.recordFailure();
        this.emit({
          operation,
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
    throw lastError ?? new VivaClientPhoneLookupError('CLIENT_PHONE_LOOKUP_UNAVAILABLE', true);
  }
}
