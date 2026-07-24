import { z } from 'zod';

export type VivaBookingHistoryKind = 'GAME' | 'TRAINING' | 'TOURNAMENT';
export type VivaBookingHistoryStatus = 'COMPLETED' | 'CANCELLED';

/**
 * Provider references are integration-only correlation keys. They must be mapped to PadlHub UUIDs
 * before a record crosses an API boundary.
 */
export interface VivaBookingHistorySourceRef {
  readonly bookingRef: string;
  readonly exerciseRef?: string;
}

export interface VivaBookingHistoryVenue {
  readonly name: string;
  readonly address?: string;
  readonly room?: string;
}

export interface VivaBookingHistoryRecord {
  readonly sourceRef: VivaBookingHistorySourceRef;
  readonly kind: VivaBookingHistoryKind;
  readonly status: VivaBookingHistoryStatus;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly venue: VivaBookingHistoryVenue;
  readonly routeHint: 'GAME_DETAILS' | 'TOURNAMENT_DETAILS' | 'NONE';
}

export interface VivaBookingHistoryPage {
  readonly records: readonly VivaBookingHistoryRecord[];
  readonly page: number;
  readonly size: number;
  readonly totalElements: number;
  readonly isLastPage: boolean;
  readonly nextPage: number | null;
}

export interface VivaBookingHistorySourcePort {
  /**
   * The calling server process owns token acquisition and rotation. This source never stores it.
   */
  readPage(input: {
    /** Server-issued Viva user access token. It must never be forwarded to a client. */
    readonly accessToken: string;
    readonly correlationId: string;
    readonly page?: number;
    readonly size?: number;
  }): Promise<VivaBookingHistoryPage>;
}

export type VivaBookingHistorySourceErrorCode =
  | 'EXTERNAL_SOURCE_DISABLED'
  | 'EXTERNAL_SOURCE_UNAVAILABLE'
  | 'EXTERNAL_SOURCE_TIMEOUT'
  | 'EXTERNAL_SOURCE_RESPONSE_INVALID';

export class VivaBookingHistorySourceError extends Error {
  public constructor(
    public readonly code: VivaBookingHistorySourceErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly issues?: readonly { readonly path: string; readonly code: string }[],
  ) {
    super(code);
    this.name = 'VivaBookingHistorySourceError';
  }
}

export interface VivaBookingHistorySourceMetric {
  readonly operation: 'booking_history';
  readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
}

export interface VivaBookingHistorySourceAdapterOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  readonly apiBaseUrl: string;
  readonly tenantKey: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly onMetric?: (metric: VivaBookingHistorySourceMetric) => void;
}

const externalRefSchema = z.union([z.string().trim().min(1).max(200), z.number().finite()]);
const numericIdSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/)])
  .transform((value) => Number(value));
const namedNumericIdSchema = z.object({
  id: numericIdSchema,
  name: z.string().trim().min(1).max(300),
});
const studioSchema = z.object({
  name: z.string().trim().min(1).max(300),
  address: z.string().trim().max(500).nullish(),
});
const roomSchema = z.object({ name: z.string().trim().min(1).max(300) });
const exerciseSchema = z.object({
  id: externalRefSchema.optional(),
  direction: namedNumericIdSchema,
  type: namedNumericIdSchema,
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }).optional(),
  studio: studioSchema,
  room: roomSchema.optional(),
});
const bookingSchema = z.object({
  id: externalRefSchema,
  isCancelled: z.boolean(),
  // Viva history can also contain non-exercise visits. They are outside this source contract.
  exercise: exerciseSchema.optional(),
});
const historyPageSchema = z.object({
  content: z.array(bookingSchema),
  totalPages: z.number().int().nonnegative(),
  totalElements: z.number().int().nonnegative(),
  last: z.boolean(),
  numberOfElements: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  number: z.number().int().nonnegative(),
  empty: z.boolean(),
});

const OPEN_GAME_DIRECTION_IDS = new Set([4588]);
const OPEN_GAME_TYPE_IDS = new Set([1613]);
const GROUP_TRAINING_TYPE_IDS = new Set([605, 847, 963, 1208]);
const TOURNAMENT_DIRECTION_IDS = new Set([2617, 3284, 4769]);
const TOURNAMENT_TYPE_IDS = new Set([839, 1013]);
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

function normalizeMarker(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-z0-9а-я]+/g, '');
}

function includesAnyMarker(markers: readonly string[], values: readonly string[]): boolean {
  return markers.some((marker) => values.some((value) => marker.includes(value)));
}

function classifyExercise(exercise: z.infer<typeof exerciseSchema>): VivaBookingHistoryKind | null {
  if (
    OPEN_GAME_TYPE_IDS.has(exercise.type.id) ||
    OPEN_GAME_DIRECTION_IDS.has(exercise.direction.id)
  ) {
    return 'GAME';
  }
  if (
    TOURNAMENT_TYPE_IDS.has(exercise.type.id) ||
    TOURNAMENT_DIRECTION_IDS.has(exercise.direction.id)
  ) {
    return 'TOURNAMENT';
  }
  if (GROUP_TRAINING_TYPE_IDS.has(exercise.type.id)) return 'TRAINING';

  const markers = [normalizeMarker(exercise.direction.name), normalizeMarker(exercise.type.name)];
  if (
    includesAnyMarker(markers, [
      'турнир',
      'tournament',
      'американо',
      'americano',
      'мексикано',
      'mexicano',
      'roundrobin',
    ])
  ) {
    return 'TOURNAMENT';
  }
  if (includesAnyMarker(markers, ['трен', 'training', 'coach', 'групп', 'group'])) {
    return 'TRAINING';
  }
  if (
    includesAnyMarker(markers, [
      'свояигра',
      'открытаяигра',
      'opengame',
      'сплит',
      'split',
      'игра',
      'game',
    ])
  ) {
    return 'GAME';
  }
  return null;
}

function bounded(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function normalizeRecord(booking: z.infer<typeof bookingSchema>): VivaBookingHistoryRecord | null {
  if (!booking.exercise) return null;
  const kind = classifyExercise(booking.exercise);
  if (!kind) return null;
  const address = booking.exercise.studio.address?.trim();
  const room = booking.exercise.room?.name.trim();
  return {
    sourceRef: {
      bookingRef: String(booking.id),
      ...(booking.exercise.id === undefined ? {} : { exerciseRef: String(booking.exercise.id) }),
    },
    kind,
    status: booking.isCancelled ? 'CANCELLED' : 'COMPLETED',
    title: bounded(booking.exercise.type.name || booking.exercise.direction.name, 160),
    startsAt: booking.exercise.timeFrom,
    ...(booking.exercise.timeTo ? { endsAt: booking.exercise.timeTo } : {}),
    venue: {
      name: bounded(booking.exercise.studio.name, 160),
      ...(address ? { address: bounded(address, 300) } : {}),
      ...(room ? { room: bounded(room, 160) } : {}),
    },
    routeHint:
      kind === 'GAME' ? 'GAME_DETAILS' : kind === 'TOURNAMENT' ? 'TOURNAMENT_DETAILS' : 'NONE',
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}

export class VivaBookingHistorySourceAdapter implements VivaBookingHistorySourcePort {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaBookingHistorySourceAdapterOptions) {
    if (options.maxAttempts !== undefined && (options.maxAttempts < 1 || options.maxAttempts > 3)) {
      throw new Error('Viva booking history maxAttempts must be between 1 and 3');
    }
    if (
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30_000
    ) {
      throw new Error('Viva booking history timeoutMs must be between 1 and 30000');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private emit(metric: VivaBookingHistorySourceMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must not change source behavior.
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
      operation: 'booking_history',
      outcome: 'circuit_open',
      attempt: 0,
      durationMs: 0,
    });
    throw new VivaBookingHistorySourceError('EXTERNAL_SOURCE_UNAVAILABLE', true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private endpoint(page: number, size: number): URL {
    const base = this.options.apiBaseUrl.replace(/\/$/, '');
    const url = new URL(
      `${base}/v2/${encodeURIComponent(this.options.tenantKey)}/bookings/history`,
    );
    url.searchParams.set('includeCanceled', 'true');
    url.searchParams.set('page', String(page));
    url.searchParams.set('size', String(size));
    return url;
  }

  public async readPage(input: {
    readonly accessToken: string;
    readonly correlationId: string;
    readonly page?: number;
    readonly size?: number;
  }): Promise<VivaBookingHistoryPage> {
    const page = boundedInteger(input.page, 0, 0, Number.MAX_SAFE_INTEGER);
    const size = boundedInteger(input.size, DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, MAX_PAGE_SIZE);
    if (this.options.mode === 'disabled') {
      throw new VivaBookingHistorySourceError('EXTERNAL_SOURCE_DISABLED', false);
    }
    if (this.options.mode === 'mock') {
      return {
        records: [],
        page,
        size,
        totalElements: 0,
        isLastPage: true,
        nextPage: null,
      };
    }

    const maxAttempts = this.options.maxAttempts ?? 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.ensureCircuitClosed();
      const startedAt = this.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(this.endpoint(page, size), {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            'X-Correlation-ID': input.correlationId,
          },
        });
        if (!response.ok) {
          throw new VivaBookingHistorySourceError(
            'EXTERNAL_SOURCE_UNAVAILABLE',
            isRetryableStatus(response.status),
            response.status,
          );
        }
        const parsed = historyPageSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new VivaBookingHistorySourceError(
            'EXTERNAL_SOURCE_RESPONSE_INVALID',
            false,
            undefined,
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
            })),
          );
        }
        const isLastPage = parsed.data.last || parsed.data.number + 1 >= parsed.data.totalPages;
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation: 'booking_history',
          outcome: 'success',
          attempt,
          status: response.status,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return {
          records: parsed.data.content.flatMap((booking) => {
            const normalized = normalizeRecord(booking);
            return normalized ? [normalized] : [];
          }),
          page: parsed.data.number,
          size: parsed.data.size,
          totalElements: parsed.data.totalElements,
          isLastPage,
          nextPage: isLastPage ? null : parsed.data.number + 1,
        };
      } catch (error) {
        const failure =
          error instanceof VivaBookingHistorySourceError
            ? error
            : error instanceof Error && error.name === 'AbortError'
              ? new VivaBookingHistorySourceError('EXTERNAL_SOURCE_TIMEOUT', true)
              : new VivaBookingHistorySourceError('EXTERNAL_SOURCE_UNAVAILABLE', true);
        this.recordFailure();
        this.emit({
          operation: 'booking_history',
          outcome: failure.retryable && attempt < maxAttempts ? 'retry' : 'failure',
          attempt,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          durationMs: Math.max(0, this.now() - startedAt),
        });
        if (!failure.retryable || attempt === maxAttempts) throw failure;
      } finally {
        clearTimeout(timeout);
      }
      await this.sleep((this.options.retryBaseDelayMs ?? 100) * attempt);
    }
    throw new VivaBookingHistorySourceError('EXTERNAL_SOURCE_UNAVAILABLE', true);
  }
}
