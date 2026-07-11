import { z } from 'zod';

export * from './identity.js';

export interface InternalAvailableSlot {
  readonly id: string;
  readonly stationId: string;
  readonly spaceId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly price?: { readonly amount: number; readonly currency: string };
}

export interface VivaIntegrationPort {
  readAvailability(input: {
    readonly tenantId: string;
    readonly stationId: string;
    readonly date: string;
    readonly correlationId: string;
  }): Promise<readonly InternalAvailableSlot[]>;
}

export interface VivaAdapterOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  readonly apiUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly resolveInternalId?: (input: {
    readonly tenantId: string;
    readonly entityType: 'availability_slot' | 'station' | 'space';
    readonly externalId: string;
  }) => Promise<string>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly onMetric?: (metric: VivaAdapterMetric) => void;
}

export interface VivaAdapterMetric {
  readonly name: 'request' | 'retry' | 'circuit_open';
  readonly outcome: 'success' | 'failure' | 'rejected';
  readonly attempt: number;
  readonly status?: number;
}

const vivaSlotSchema = z.object({
  id: z.union([z.string(), z.number()]),
  station_id: z.union([z.string(), z.number()]),
  space_id: z.union([z.string(), z.number()]),
  starts_at: z.string(),
  ends_at: z.string(),
  price_minor: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});
const INTERNAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertServerCredentials(options: VivaAdapterOptions): void {
  if ((options.mode === 'sandbox' || options.mode === 'production') && !options.apiUrl) {
    throw new Error('Viva server adapter requires a server-side URL');
  }
  if (options.mode === 'production' && (!options.apiUrl || !options.apiKey)) {
    throw new Error('Viva production adapter requires server-side URL and API key');
  }
  if ((options.mode === 'sandbox' || options.mode === 'production') && !options.resolveInternalId) {
    throw new Error('Viva server adapter requires an external ID mapper');
  }
  if ((options.maxAttempts ?? 2) < 1 || (options.maxAttempts ?? 2) > 3) {
    throw new Error('Viva maxAttempts must be between 1 and 3');
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

class ExternalSourceError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class VivaAdapter implements VivaIntegrationPort {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaAdapterOptions) {
    assertServerCredentials(options);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private emit(metric: VivaAdapterMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change integration behavior.
    }
  }

  private assertCircuitAllowsRequest(): void {
    if (this.circuitOpenedAt === undefined) return;
    if (this.now() - this.circuitOpenedAt >= (this.options.circuitResetMs ?? 30_000)) {
      this.circuitOpenedAt = undefined;
      return;
    }
    this.emit({ name: 'circuit_open', outcome: 'rejected', attempt: 0 });
    throw new Error('EXTERNAL_SOURCE_UNAVAILABLE');
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private async requestAvailability(
    endpoint: URL,
    tenantId: string,
    correlationId: string,
    attempt: number,
  ): Promise<readonly InternalAvailableSlot[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImplementation(endpoint, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.apiKey ?? ''}`,
          'X-Correlation-ID': correlationId,
        },
      });
      if (!response.ok) {
        throw new ExternalSourceError(
          'EXTERNAL_SOURCE_REQUEST_FAILED',
          isRetryableStatus(response.status),
          response.status,
        );
      }
      const body = z.array(vivaSlotSchema).parse(await response.json());
      const normalized = await Promise.all(
        body.map(async (slot) => {
          const [id, stationId, spaceId] = await Promise.all([
            this.options.resolveInternalId?.({
              tenantId,
              entityType: 'availability_slot',
              externalId: String(slot.id),
            }),
            this.options.resolveInternalId?.({
              tenantId,
              entityType: 'station',
              externalId: String(slot.station_id),
            }),
            this.options.resolveInternalId?.({
              tenantId,
              entityType: 'space',
              externalId: String(slot.space_id),
            }),
          ]);
          if (
            !id ||
            !INTERNAL_UUID_PATTERN.test(id) ||
            !stationId ||
            !INTERNAL_UUID_PATTERN.test(stationId) ||
            !spaceId ||
            !INTERNAL_UUID_PATTERN.test(spaceId)
          ) {
            throw new ExternalSourceError('EXTERNAL_ID_MAPPING_MISSING', false);
          }
          return {
            id,
            stationId,
            spaceId,
            startsAt: slot.starts_at,
            endsAt: slot.ends_at,
            ...(slot.price_minor === undefined
              ? {}
              : { price: { amount: slot.price_minor, currency: slot.currency ?? 'RUB' } }),
          };
        }),
      );
      this.emit({ name: 'request', outcome: 'success', attempt, status: response.status });
      return normalized;
    } catch (error) {
      if (error instanceof ExternalSourceError) throw error;
      if (error instanceof z.ZodError) {
        throw new ExternalSourceError('EXTERNAL_SOURCE_RESPONSE_INVALID', false);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ExternalSourceError('EXTERNAL_SOURCE_TIMEOUT', true);
      }
      throw new ExternalSourceError('EXTERNAL_SOURCE_REQUEST_FAILED', true);
    } finally {
      clearTimeout(timeout);
    }
  }

  public async readAvailability(input: {
    readonly tenantId: string;
    readonly stationId: string;
    readonly date: string;
    readonly correlationId: string;
  }): Promise<readonly InternalAvailableSlot[]> {
    if (this.options.mode === 'disabled') throw new Error('EXTERNAL_SOURCE_DISABLED');
    if (this.options.mode === 'mock') return [];

    this.assertCircuitAllowsRequest();

    const endpoint = new URL('/availability', this.options.apiUrl);
    endpoint.searchParams.set('stationId', input.stationId);
    endpoint.searchParams.set('date', input.date);
    const maxAttempts = this.options.maxAttempts ?? 2;
    let finalError: ExternalSourceError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.requestAvailability(
          endpoint,
          input.tenantId,
          input.correlationId,
          attempt,
        );
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        return result;
      } catch (error) {
        finalError =
          error instanceof ExternalSourceError
            ? error
            : new ExternalSourceError('EXTERNAL_SOURCE_REQUEST_FAILED', false);
        this.emit({
          name: 'request',
          outcome: 'failure',
          attempt,
          ...(finalError.status === undefined ? {} : { status: finalError.status }),
        });
        if (!finalError.retryable || attempt === maxAttempts) break;
        this.emit({
          name: 'retry',
          outcome: 'failure',
          attempt,
          ...(finalError.status === undefined ? {} : { status: finalError.status }),
        });
        await this.sleep(
          Math.min((this.options.retryBaseDelayMs ?? 100) * 2 ** (attempt - 1), 1_000),
        );
      }
    }

    this.recordFailure();
    throw new Error(finalError?.message ?? 'EXTERNAL_SOURCE_REQUEST_FAILED');
  }
}
