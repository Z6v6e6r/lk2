import { z } from 'zod';

export type VivaHomeSourceErrorCode =
  | 'EXTERNAL_SOURCE_DISABLED'
  | 'EXTERNAL_SOURCE_UNAVAILABLE'
  | 'EXTERNAL_SOURCE_TIMEOUT'
  | 'EXTERNAL_SOURCE_RESPONSE_INVALID';

export class VivaHomeSourceError extends Error {
  public constructor(
    public readonly code: VivaHomeSourceErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly issues?: readonly { readonly path: string; readonly code: string }[],
  ) {
    super(code);
    this.name = 'VivaHomeSourceError';
  }
}

export interface VivaHomeProfileSource {
  readonly externalId: string;
  readonly displayName: string;
  readonly firstName?: string;
  /** Provider-owned source URL, consumed only by the server-side media synchronizer. */
  readonly photoUrl?: string;
  readonly phoneLast4?: string;
  readonly balanceMinor: number;
  readonly level: {
    readonly label: string;
    readonly value: number;
    readonly assessmentRequired: boolean;
  };
}

export interface VivaHomeUpcomingSource {
  readonly externalId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly venue: string;
  readonly status: 'confirmed' | 'waitlist' | 'payment_required';
}

export interface VivaHomeSubscriptionSource {
  readonly externalId: string;
  readonly title: string;
  readonly status: 'active' | 'scheduled' | 'paused' | 'exhausted' | 'expired';
  readonly remainingUnits: number;
  readonly validUntil: string | null;
}

export interface VivaHomeSourceSnapshot {
  readonly profile: VivaHomeProfileSource;
  readonly upcoming: readonly VivaHomeUpcomingSource[];
  readonly subscriptions: readonly VivaHomeSubscriptionSource[];
  readonly fetchedAt: string;
}

export interface VivaHomeSourceMetric {
  readonly operation: 'profile' | 'bookings' | 'booking_details' | 'subscriptions';
  readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
  readonly attempt: number;
  readonly status?: number;
  readonly durationMs: number;
}

export interface VivaHomeSourceAdapterOptions {
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
  readonly onMetric?: (metric: VivaHomeSourceMetric) => void;
}

const customFieldSchema = z.object({
  id: z.string().uuid(),
  value: z.array(z.string()),
});

const profileSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().nullish(),
  middleName: z.string().nullish(),
  lastName: z.string().nullish(),
  phone: z.string().nullish(),
  photo: z.string().url().nullish(),
  deposit: z.number().int(),
  customFields: z.array(customFieldSchema),
});

const transactionSchema = z
  .object({
    transactionStatus: z.enum([
      'PAID',
      'UNPAID',
      'REFUND',
      'WAITING',
      'PARTIALLY_REFUNDED',
      'PARTIALLY_PAID',
    ]),
  })
  .nullish();

const activeBookingSchema = z.object({
  id: z.string().uuid(),
  isCancelled: z.boolean(),
});

const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ content: z.array(item).default([]) });

const namedUuidSchema = z.object({ id: z.string().uuid(), name: z.string() });
const exerciseSchema = z.object({
  timeFrom: z.string().datetime({ offset: true }),
  inWaitlist: z.boolean(),
  direction: z.object({ name: z.string() }),
  type: z.object({ name: z.string() }),
  studio: z.object({ name: z.string(), address: z.string() }),
  room: namedUuidSchema,
});
const studioSchema = z.object({ name: z.string(), address: z.string() });
const freeVisitSchema = z.object({ type: z.object({ name: z.string() }) });
const bookingDetailsSchema = z.object({
  id: z.string().uuid(),
  isCancelled: z.boolean(),
  transactionStatus: transactionSchema,
  exercise: exerciseSchema.optional(),
  checkInTime: z.string().datetime({ offset: true }).optional(),
  studio: studioSchema.optional(),
  freeVisit: freeVisitSchema.optional(),
});

const subscriptionSchema = z.object({
  subscriptionId: z.string().uuid(),
  type: z.enum(['INDIVIDUAL', 'GROUP']),
  status: z.enum(['NEW', 'ACTIVE', 'HOLD', 'EXPIRED', 'REFUNDED', 'NO_VISITS']),
  variant: z.enum(['BY_VISITS', 'BY_TIME', 'BY_DURATION', 'BY_UNITS']),
  visitsLeft: z.number().int(),
  availableMinutes: z.number().int(),
  availableDays: z.number().int(),
  // Viva currently returns null for non-BY_UNITS subscriptions although OpenAPI says number.
  unitsLeft: z.number().nullish(),
  expirationDate: z.string().date().optional(),
});

const LEVEL_FIELD_IDS = [
  'eabfe27b-3f72-4496-9185-1a2ec6e6465e',
  '9018d922-6427-41a6-9ac0-4a2c0440eb8a',
  'f9790818-25fd-4b73-a781-79c02720727d',
] as const;

function levelLabel(value: number): string {
  if (value < 2) return 'D';
  if (value < 3) return 'D+';
  if (value < 3.5) return 'C';
  if (value < 4) return 'C+';
  if (value < 4.7) return 'B';
  if (value < 5.5) return 'B+';
  return 'A';
}

function readLevel(fields: z.infer<typeof customFieldSchema>[]): VivaHomeProfileSource['level'] {
  for (const fieldId of LEVEL_FIELD_IDS) {
    const raw = fields.find((field) => field.id === fieldId)?.value[0];
    if (!raw) continue;
    const value = Number(raw.replace(',', '.'));
    if (Number.isFinite(value) && value >= 0 && value <= 10) {
      return { label: levelLabel(value), value, assessmentRequired: false };
    }
  }
  return { label: 'D', value: 0, assessmentRequired: true };
}

function bounded(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function venue(name: string, address: string): string {
  const joined = [name.trim(), address.trim()].filter(Boolean).join(' · ');
  return bounded(joined || 'ПаделХАБ', 160);
}

function bookingStatus(
  item: z.infer<typeof bookingDetailsSchema>,
): VivaHomeUpcomingSource['status'] {
  if (item.exercise?.inWaitlist) return 'waitlist';
  if (
    item.transactionStatus &&
    ['UNPAID', 'WAITING', 'PARTIALLY_PAID'].includes(item.transactionStatus.transactionStatus)
  ) {
    return 'payment_required';
  }
  return 'confirmed';
}

function subscriptionStatus(
  value: z.infer<typeof subscriptionSchema>['status'],
): VivaHomeSubscriptionSource['status'] {
  if (value === 'ACTIVE') return 'active';
  if (value === 'NEW') return 'scheduled';
  if (value === 'HOLD') return 'paused';
  if (value === 'NO_VISITS') return 'exhausted';
  return 'expired';
}

function subscriptionRemaining(item: z.infer<typeof subscriptionSchema>): number {
  const raw =
    item.variant === 'BY_VISITS'
      ? item.visitsLeft
      : item.variant === 'BY_TIME'
        ? item.availableMinutes
        : item.variant === 'BY_DURATION'
          ? item.availableDays
          : Math.floor(item.unitsLeft ?? 0);
  return Math.max(0, raw);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class VivaHomeSourceAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaHomeSourceAdapterOptions) {
    if (options.maxAttempts !== undefined && (options.maxAttempts < 1 || options.maxAttempts > 3)) {
      throw new Error('Viva Home maxAttempts must be between 1 and 3');
    }
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private emit(metric: VivaHomeSourceMetric): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must not change source behavior.
    }
  }

  private ensureCircuitClosed(operation: VivaHomeSourceMetric['operation']): void {
    if (this.circuitOpenedAt === undefined) return;
    if (this.now() - this.circuitOpenedAt >= (this.options.circuitResetMs ?? 30_000)) {
      this.circuitOpenedAt = undefined;
      this.consecutiveFailures = 0;
      return;
    }
    this.emit({ operation, outcome: 'circuit_open', attempt: 0, durationMs: 0 });
    throw new VivaHomeSourceError('EXTERNAL_SOURCE_UNAVAILABLE', true);
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 5)) {
      this.circuitOpenedAt = this.now();
    }
  }

  private async getJson<TSchema extends z.ZodType>(input: {
    readonly url: URL;
    readonly accessToken: string;
    readonly correlationId: string;
    readonly operation: VivaHomeSourceMetric['operation'];
    readonly schema: TSchema;
  }): Promise<z.infer<TSchema>> {
    const maxAttempts = this.options.maxAttempts ?? 2;
    let lastError: VivaHomeSourceError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.ensureCircuitClosed(input.operation);
      const startedAt = this.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImplementation(input.url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            'X-Correlation-ID': input.correlationId,
          },
        });
        if (!response.ok) {
          throw new VivaHomeSourceError(
            'EXTERNAL_SOURCE_UNAVAILABLE',
            isRetryableStatus(response.status),
            response.status,
          );
        }
        const parsed = input.schema.safeParse(await response.json());
        if (!parsed.success) {
          throw new VivaHomeSourceError(
            'EXTERNAL_SOURCE_RESPONSE_INVALID',
            false,
            undefined,
            parsed.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              code: issue.code,
            })),
          );
        }
        this.consecutiveFailures = 0;
        this.emit({
          operation: input.operation,
          outcome: 'success',
          attempt,
          status: response.status,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return parsed.data;
      } catch (error) {
        const failure =
          error instanceof VivaHomeSourceError
            ? error
            : error instanceof Error && error.name === 'AbortError'
              ? new VivaHomeSourceError('EXTERNAL_SOURCE_TIMEOUT', true)
              : new VivaHomeSourceError('EXTERNAL_SOURCE_UNAVAILABLE', true);
        lastError = failure;
        this.recordFailure();
        this.emit({
          operation: input.operation,
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
    throw lastError ?? new VivaHomeSourceError('EXTERNAL_SOURCE_UNAVAILABLE', true);
  }

  private endpoint(version: 'v1' | 'v2', path: string): URL {
    return new URL(
      `${this.options.apiBaseUrl.replace(/\/$/, '')}/${version}/${encodeURIComponent(this.options.tenantKey)}${path}`,
    );
  }

  public async read(input: {
    readonly accessToken: string;
    readonly correlationId: string;
  }): Promise<VivaHomeSourceSnapshot> {
    if (this.options.mode === 'disabled' || this.options.mode === 'mock') {
      throw new VivaHomeSourceError('EXTERNAL_SOURCE_DISABLED', false);
    }

    const profile = await this.getJson({
      url: this.endpoint('v1', '/profile'),
      accessToken: input.accessToken,
      correlationId: input.correlationId,
      operation: 'profile',
      schema: profileSchema,
    });
    const activeBookings = await this.getJson({
      url: this.endpoint('v2', '/bookings?page=0&size=6&sort=id,asc'),
      accessToken: input.accessToken,
      correlationId: input.correlationId,
      operation: 'bookings',
      schema: pageSchema(activeBookingSchema),
    });
    const activeIds = activeBookings.content
      .filter((booking) => !booking.isCancelled)
      .map((booking) => booking.id)
      .slice(0, 6);
    const detailsUrl = this.endpoint('v1', '/bookings/list');
    for (const bookingId of activeIds) detailsUrl.searchParams.append('bookingIds', bookingId);
    const bookingDetails =
      activeIds.length === 0
        ? []
        : await this.getJson({
            url: detailsUrl,
            accessToken: input.accessToken,
            correlationId: input.correlationId,
            operation: 'booking_details',
            schema: z.array(bookingDetailsSchema),
          });
    const subscriptions = await this.getJson({
      url: this.endpoint('v1', '/subscriptions?includeFinished=false&page=0&size=6'),
      accessToken: input.accessToken,
      correlationId: input.correlationId,
      operation: 'subscriptions',
      schema: pageSchema(subscriptionSchema),
    });

    const displayName = [profile.firstName, profile.middleName, profile.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');
    const phoneDigits = profile.phone?.replace(/\D/g, '') ?? '';
    const upcoming = bookingDetails
      .filter((item) => !item.isCancelled)
      .flatMap<VivaHomeUpcomingSource>((item) => {
        if (item.exercise) {
          return [
            {
              externalId: item.id,
              title: bounded(item.exercise.type.name || item.exercise.direction.name, 160),
              startsAt: item.exercise.timeFrom,
              venue: venue(item.exercise.studio.name, item.exercise.studio.address),
              status: bookingStatus(item),
            },
          ];
        }
        if (item.freeVisit && item.checkInTime && item.studio) {
          return [
            {
              externalId: item.id,
              title: bounded(item.freeVisit.type.name, 160),
              startsAt: item.checkInTime,
              venue: venue(item.studio.name, item.studio.address),
              status: bookingStatus(item),
            },
          ];
        }
        return [];
      })
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))
      .slice(0, 6);

    return {
      profile: {
        externalId: profile.id,
        displayName: bounded(displayName || 'Игрок ПаделхАБ', 200),
        ...(profile.firstName?.trim() ? { firstName: bounded(profile.firstName, 100) } : {}),
        ...(profile.photo ? { photoUrl: profile.photo } : {}),
        ...(phoneDigits.length >= 4 ? { phoneLast4: phoneDigits.slice(-4) } : {}),
        balanceMinor: profile.deposit,
        level: readLevel(profile.customFields),
      },
      upcoming,
      subscriptions: subscriptions.content.slice(0, 6).map((item) => ({
        externalId: item.subscriptionId,
        title: item.type === 'INDIVIDUAL' ? 'Индивидуальный абонемент' : 'Групповой абонемент',
        status: subscriptionStatus(item.status),
        remainingUnits: subscriptionRemaining(item),
        validUntil: item.expirationDate ? `${item.expirationDate}T23:59:59.000Z` : null,
      })),
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }
}
