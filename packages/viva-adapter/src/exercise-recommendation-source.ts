import { createHash } from 'node:crypto';

export type VivaExerciseRecommendationKind = 'TRAINING' | 'TOURNAMENT';

export interface VivaExerciseRecommendation {
  readonly id: string;
  readonly kind: VivaExerciseRecommendationKind;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: 'Europe/Moscow';
  readonly station: {
    readonly id: string;
    readonly name: string;
    readonly shortAddress: string | null;
  };
  readonly levelRange: {
    readonly from: string;
    readonly to: string;
  } | null;
  readonly capacity: {
    readonly total: number | null;
    readonly open: number | null;
  };
  readonly route: string;
}

export interface VivaExerciseRecommendationSourceOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  readonly apiBaseUrl: string;
  readonly providerTenantKey: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly onMetric?: (metric: {
    readonly outcome: 'success' | 'failure' | 'retry' | 'circuit_open';
    readonly attempt: number;
    readonly durationMs: number;
    readonly status?: number;
  }) => void;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function namedElement(value: unknown): { readonly id?: string; readonly name?: string } {
  const record = recordValue(value);
  const id = stringValue(record?.id);
  const name = stringValue(record?.name);
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
  };
}

function normalizeMarker(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-z0-9а-я]+/g, '');
}

const TRAINING_TYPE_IDS = new Set(['605', '847', '963', '1208']);
const TOURNAMENT_TYPE_IDS = new Set(['839', '1013']);
const TOURNAMENT_DIRECTION_IDS = new Set(['2617', '3284', '4769', '5278']);

function classifyExercise(item: Record<string, unknown>): VivaExerciseRecommendationKind | null {
  const type = namedElement(item.type);
  const direction = namedElement(item.direction);
  if (
    (type.id && TOURNAMENT_TYPE_IDS.has(type.id)) ||
    (direction.id && TOURNAMENT_DIRECTION_IDS.has(direction.id))
  ) {
    return 'TOURNAMENT';
  }
  if (type.id && TRAINING_TYPE_IDS.has(type.id)) return 'TRAINING';
  const markers = [normalizeMarker(type.name), normalizeMarker(direction.name)];
  if (
    markers.some((marker) =>
      ['турнир', 'tournament', 'американо', 'americano', 'мексикано', 'mexicano'].some((word) =>
        marker.includes(word),
      ),
    )
  ) {
    return 'TOURNAMENT';
  }
  if (
    markers.some((marker) =>
      ['трен', 'training', 'coach', 'групп', 'group'].some((word) => marker.includes(word)),
    )
  ) {
    return 'TRAINING';
  }
  return null;
}

function publicUuid(namespace: string, externalId: string): string {
  const bytes = Buffer.from(
    createHash('sha256').update(`phub-viva-exercise-v1:${namespace}:${externalId}`).digest('hex'),
    'hex',
  ).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function levelLabel(value: number): string {
  if (value < 2) return 'D';
  if (value < 3) return 'D+';
  if (value < 3.5) return 'C';
  if (value < 4) return 'C+';
  if (value < 4.7) return 'B';
  if (value < 5.5) return 'B+';
  return 'A';
}

function levelRange(value: unknown): VivaExerciseRecommendation['levelRange'] {
  const values = Array.isArray(value)
    ? value
        .slice(0, 100)
        .map(numericValue)
        .filter((item): item is number => item !== undefined && item >= 0 && item <= 10)
    : [];
  if (values.length === 0) return null;
  return {
    from: levelLabel(Math.min(...values)),
    to: levelLabel(Math.max(...values)),
  };
}

function exerciseArray(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = recordValue(payload);
  if (Array.isArray(record?.content)) return record.content;
  if (Array.isArray(record?.items)) return record.items;
  return [];
}

function normalizeExercise(value: unknown): VivaExerciseRecommendation | undefined {
  const item = recordValue(value);
  if (!item) return undefined;
  const kind = classifyExercise(item);
  const externalId = stringValue(item.id);
  const type = namedElement(item.type);
  const direction = namedElement(item.direction);
  const studio = recordValue(item.studio);
  const startsAtValue = stringValue(item.timeFrom) ?? stringValue(item.startsAt);
  if (!kind || !externalId || !startsAtValue || Number.isNaN(Date.parse(startsAtValue))) {
    return undefined;
  }
  const startsAt = new Date(startsAtValue).toISOString();
  const endsAtValue = stringValue(item.timeTo) ?? stringValue(item.endsAt);
  const endsAt =
    endsAtValue && !Number.isNaN(Date.parse(endsAtValue))
      ? new Date(endsAtValue).toISOString()
      : new Date(Date.parse(startsAt) + 90 * 60 * 1_000).toISOString();
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return undefined;
  const stationExternalId =
    stringValue(studio?.id) ?? stringValue(studio?.uuid) ?? stringValue(studio?.name);
  const stationName = stringValue(studio?.name);
  const title = type.name ?? direction.name;
  if (!stationExternalId || !stationName || !title) return undefined;
  const total = numericValue(item.maxClients) ?? numericValue(item.capacity);
  const explicitOpen =
    numericValue(item.freePlaces) ??
    numericValue(item.availablePlaces) ??
    numericValue(item.openPlaces);
  const registered =
    numericValue(item.clientsCount) ??
    numericValue(item.bookedClientsCount) ??
    numericValue(item.participantsCount);
  const safeTotal = total === undefined ? null : Math.max(0, Math.min(10_000, Math.trunc(total)));
  const safeOpen =
    explicitOpen !== undefined
      ? Math.max(0, Math.min(10_000, Math.trunc(explicitOpen)))
      : safeTotal !== null && registered !== undefined
        ? Math.max(0, safeTotal - Math.max(0, Math.trunc(registered)))
        : null;
  const id = publicUuid('exercise', externalId);
  return {
    id,
    kind,
    title: title.slice(0, 160),
    startsAt,
    endsAt,
    timezone: 'Europe/Moscow',
    station: {
      id: publicUuid('station', stationExternalId),
      name: stationName.slice(0, 160),
      shortAddress: stringValue(studio?.address)?.slice(0, 240) ?? null,
    },
    levelRange: levelRange(item.accessLevels ?? item.ratings),
    capacity: { total: safeTotal, open: safeOpen },
    route:
      kind === 'TOURNAMENT'
        ? `/tournaments?event=${encodeURIComponent(id)}`
        : `/trainings?event=${encodeURIComponent(id)}`,
  };
}

class VivaExerciseSourceError extends Error {
  public constructor(
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super('VIVA_EXERCISE_RECOMMENDATION_SOURCE_UNAVAILABLE');
  }
}

export class VivaExerciseRecommendationSourceAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaExerciseRecommendationSourceOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  private emit(
    metric: Parameters<NonNullable<VivaExerciseRecommendationSourceOptions['onMetric']>>[0],
  ): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Metrics must never change recommendation behavior.
    }
  }

  public async readDate(input: {
    readonly date: string;
    readonly accessToken: string;
    readonly correlationId: string;
  }): Promise<readonly VivaExerciseRecommendation[]> {
    if (
      this.options.mode === 'disabled' ||
      this.options.mode === 'mock' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      !input.accessToken
    ) {
      return [];
    }
    const now = this.now();
    if (
      this.circuitOpenedAt !== undefined &&
      now - this.circuitOpenedAt < (this.options.circuitResetMs ?? 30_000)
    ) {
      this.emit({ outcome: 'circuit_open', attempt: 0, durationMs: 0 });
      throw new Error('VIVA_EXERCISE_RECOMMENDATION_CIRCUIT_OPEN');
    }
    const baseUrl = new URL(this.options.apiBaseUrl);
    const url = new URL(
      `v1/${encodeURIComponent(this.options.providerTenantKey)}/exercises`,
      baseUrl.toString().endsWith('/') ? baseUrl : new URL(`${baseUrl.toString()}/`),
    );
    url.searchParams.set('date', input.date);
    const attempts = Math.max(1, Math.min(3, this.options.maxAttempts ?? 2));
    const startedAt = this.now();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImplementation(url, {
          method: 'GET',
          credentials: 'omit',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${input.accessToken}`,
            'X-Correlation-ID': input.correlationId,
          },
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (!response.ok) {
          throw new VivaExerciseSourceError(
            response.status === 408 || response.status === 429 || response.status >= 500,
            response.status,
          );
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 5 * 1_024 * 1_024) throw new VivaExerciseSourceError(false);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        const items = exerciseArray(payload)
          .slice(0, 500)
          .flatMap((item) => {
            const normalized = normalizeExercise(item);
            return normalized ? [normalized] : [];
          })
          .sort(
            (left, right) =>
              left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
          );
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({ outcome: 'success', attempt, durationMs: this.now() - startedAt });
        return items;
      } catch (error) {
        const sourceError =
          error instanceof VivaExerciseSourceError ? error : new VivaExerciseSourceError(true);
        if (!sourceError.retryable || attempt === attempts) {
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) {
            this.circuitOpenedAt = now;
          }
          this.emit({
            outcome: 'failure',
            attempt,
            durationMs: this.now() - startedAt,
            ...(sourceError.status ? { status: sourceError.status } : {}),
          });
          throw sourceError;
        }
        this.emit({
          outcome: 'retry',
          attempt,
          durationMs: this.now() - startedAt,
          ...(sourceError.status ? { status: sourceError.status } : {}),
        });
        await this.sleep((this.options.retryBaseDelayMs ?? 100) * attempt);
      }
    }
    throw new Error('VIVA_EXERCISE_RECOMMENDATION_SOURCE_UNAVAILABLE');
  }
}
