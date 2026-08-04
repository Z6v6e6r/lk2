import { createHash } from 'node:crypto';

import { z } from 'zod';

export interface VivaExerciseRosterParticipant {
  /** PadlHub-owned pseudonymous identifier. Provider client IDs never leave the adapter. */
  readonly id: string;
  readonly profileId?: string;
  readonly displayName: string;
  readonly avatarUrl: null;
}

export interface VivaExerciseRosterSourceOptions {
  readonly mode: 'mock' | 'sandbox' | 'production' | 'disabled';
  readonly apiBaseUrl: string;
  readonly transport?: 'VIVA_ADMIN' | 'PADLHUB_PROXY';
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly freshTtlMs?: number;
  readonly staleTtlMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  /** Resolves provider identities inside the integration boundary to public PadlHub UUIDs. */
  readonly resolveProfileIds?: (input: {
    readonly tenantId: string;
    readonly externalClientIds: readonly string[];
  }) => Promise<ReadonlyMap<string, string>>;
  readonly onMetric?: (metric: {
    readonly operation: 'exercise_roster';
    readonly outcome: 'success' | 'failure' | 'cache_fresh' | 'cache_stale' | 'circuit_open';
    readonly durationMs: number;
  }) => void;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientSchema = z.object({
  id: z.string().uuid(),
  firstName: z.string().trim().max(120).nullish(),
  lastName: z.string().trim().max(120).nullish(),
  photo: z.string().trim().url().max(2_048).nullish(),
});
const bookingSchema = z.object({
  isCancelled: z.boolean(),
  client: clientSchema,
});
const rosterPageSchema = z.object({
  content: z.array(bookingSchema).max(100),
});
const rosterResponseSchema = z.union([rosterPageSchema, z.array(bookingSchema).max(100)]);

interface CacheEntry {
  readonly fetchedAt: number;
  readonly participants: readonly VivaExerciseRosterParticipant[];
}

interface AvatarEntry {
  readonly fetchedAt: number;
  readonly sourceUrl: string;
}

function participantId(tenantId: string, externalClientId: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`phub-viva-exercise-participant-v1:${tenantId}:${externalClientId}`)
      .digest('hex')
      .slice(0, 32),
    'hex',
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function httpsUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class VivaExerciseRosterSourceAdapter {
  /** Public proxy reads expose only the already-public PadlHub participant listing. */
  public readonly accessScope: 'PUBLIC' | 'BOOKING_OWNER';
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<readonly VivaExerciseRosterParticipant[]>>();
  private readonly avatarSources = new Map<string, AvatarEntry>();
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaExerciseRosterSourceOptions) {
    this.accessScope =
      (options.transport ?? 'VIVA_ADMIN') === 'PADLHUB_PROXY' ? 'PUBLIC' : 'BOOKING_OWNER';
    if (
      (options.transport ?? 'VIVA_ADMIN') === 'VIVA_ADMIN' &&
      (options.mode === 'sandbox' || options.mode === 'production') &&
      !options.apiKey
    ) {
      throw new Error('VIVA_EXERCISE_ROSTER_API_KEY_REQUIRED');
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private emit(
    metric: Parameters<NonNullable<VivaExerciseRosterSourceOptions['onMetric']>>[0],
  ): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change roster behavior.
    }
  }

  private async fetchRoster(input: {
    readonly tenantId: string;
    readonly exerciseExternalId: string;
    readonly correlationId: string;
  }): Promise<readonly VivaExerciseRosterParticipant[]> {
    const startedAt = this.now();
    const now = this.now();
    if (
      this.circuitOpenedAt !== undefined &&
      now - this.circuitOpenedAt < (this.options.circuitResetMs ?? 30_000)
    ) {
      this.emit({ operation: 'exercise_roster', outcome: 'circuit_open', durationMs: 0 });
      throw new Error('VIVA_EXERCISE_ROSTER_CIRCUIT_OPEN');
    }
    const baseUrl = new URL(this.options.apiBaseUrl);
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
      throw new Error('VIVA_EXERCISE_ROSTER_BASE_URL_INVALID');
    }
    const directAdmin = (this.options.transport ?? 'VIVA_ADMIN') === 'VIVA_ADMIN';
    const url = directAdmin
      ? new URL(
          `/api/v1/exercises/${encodeURIComponent(input.exerciseExternalId)}/bookings`,
          baseUrl,
        )
      : new URL('/lk/tournaments/participants', baseUrl);
    if (directAdmin) {
      url.searchParams.set('showCancelled', 'false');
      url.searchParams.set('page', '0');
    } else {
      url.searchParams.set('exerciseId', input.exerciseExternalId);
    }
    url.searchParams.set('size', '20');
    const attempts = Math.max(1, Math.min(3, this.options.maxAttempts ?? 2));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await (this.options.fetchImplementation ?? fetch)(url, {
          headers: {
            Accept: 'application/json',
            ...(directAdmin ? { Authorization: `Bearer ${this.options.apiKey ?? ''}` } : {}),
            'X-Correlation-ID': input.correlationId,
          },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 4_000),
        });
        if (!response.ok) {
          const error = new Error(`VIVA_EXERCISE_ROSTER_HTTP_${response.status}`);
          if (!retryableStatus(response.status)) throw error;
          lastError = error;
          if (attempt < attempts) await (this.options.sleep ?? delay)(attempt * 100);
          continue;
        }
        const responseBody = rosterResponseSchema.parse(await response.json());
        const body = Array.isArray(responseBody) ? responseBody : responseBody.content;
        const externalClientIds = body
          .filter((booking) => !booking.isCancelled)
          .map((booking) => booking.client.id);
        const profileIds = this.options.resolveProfileIds
          ? await this.options.resolveProfileIds({
              tenantId: input.tenantId,
              externalClientIds,
            })
          : new Map<string, string>();
        const seen = new Set<string>();
        const participants = body
          .flatMap((booking) => {
            if (booking.isCancelled || seen.has(booking.client.id)) return [];
            const displayName = [booking.client.firstName, booking.client.lastName]
              .filter((part): part is string => Boolean(part))
              .join(' ')
              .trim()
              .slice(0, 160);
            if (!displayName) return [];
            seen.add(booking.client.id);
            const id = participantId(input.tenantId, booking.client.id);
            const sourceUrl = httpsUrl(booking.client.photo);
            if (sourceUrl && directAdmin) {
              this.avatarSources.set(id, { sourceUrl, fetchedAt: now });
            }
            const profileId = profileIds.get(booking.client.id);
            return [
              {
                id,
                ...(profileId ? { profileId } : {}),
                displayName,
                avatarUrl: null,
              } satisfies VivaExerciseRosterParticipant,
            ];
          })
          .slice(0, 4);
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = undefined;
        this.emit({
          operation: 'exercise_roster',
          outcome: 'success',
          durationMs: this.now() - startedAt,
        });
        return participants;
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /^VIVA_EXERCISE_ROSTER_HTTP_4\d\d$/.test(error.message)) {
          break;
        }
      }
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) {
      this.circuitOpenedAt = now;
    }
    this.emit({
      operation: 'exercise_roster',
      outcome: 'failure',
      durationMs: this.now() - startedAt,
    });
    throw lastError instanceof Error
      ? lastError
      : new Error('VIVA_EXERCISE_ROSTER_SOURCE_UNAVAILABLE');
  }

  public read(input: {
    readonly tenantId: string;
    readonly exerciseExternalId: string;
    readonly correlationId: string;
  }): Promise<readonly VivaExerciseRosterParticipant[]> {
    if (
      this.options.mode === 'mock' ||
      this.options.mode === 'disabled' ||
      !UUID_PATTERN.test(input.tenantId) ||
      !UUID_PATTERN.test(input.exerciseExternalId)
    ) {
      return Promise.resolve([]);
    }
    const cacheKey = `${input.tenantId}:${input.exerciseExternalId}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.fetchedAt <= (this.options.freshTtlMs ?? 30_000)) {
      this.emit({ operation: 'exercise_roster', outcome: 'cache_fresh', durationMs: 0 });
      return Promise.resolve(cached.participants);
    }
    const pending = this.pending.get(cacheKey);
    if (pending) return pending;
    const request = this.fetchRoster(input)
      .then((participants) => {
        this.cache.set(cacheKey, { fetchedAt: this.now(), participants });
        return participants;
      })
      .catch((error) => {
        if (cached && now - cached.fetchedAt <= (this.options.staleTtlMs ?? 600_000)) {
          this.emit({ operation: 'exercise_roster', outcome: 'cache_stale', durationMs: 0 });
          return cached.participants;
        }
        throw error;
      })
      .finally(() => {
        if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
      });
    this.pending.set(cacheKey, request);
    return request;
  }

  public readAvatarSource(participantIdValue: string): string | undefined {
    const entry = this.avatarSources.get(participantIdValue);
    if (!entry) return undefined;
    if (this.now() - entry.fetchedAt > (this.options.staleTtlMs ?? 600_000)) {
      this.avatarSources.delete(participantIdValue);
      return undefined;
    }
    return entry.sourceUrl;
  }
}
