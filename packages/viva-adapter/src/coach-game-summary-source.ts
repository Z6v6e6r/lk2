import { createHash } from 'node:crypto';

import { z } from 'zod';

export type CoachGamePlayerLevel = 'D' | 'D+' | 'C' | 'C+' | 'B' | 'B+' | 'A';

export interface PublicCoachGameSummary {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly stationName: string;
  readonly courtName: string | null;
  readonly level: CoachGamePlayerLevel | null;
  readonly trainer: {
    readonly displayName: string;
    readonly avatarUrl: string | null;
  } | null;
  readonly capacity: {
    readonly total: number;
    readonly occupied: number;
    readonly open: number;
  };
  readonly status: 'JOINABLE' | 'FULL';
}

export interface VivaCoachGameSummaryAdapterOptions {
  readonly apiBaseUrl: string;
  readonly tenantKey: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly freshTtlMs?: number;
  readonly staleTtlMs?: number;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
  readonly onMetric?: (metric: {
    readonly operation: 'coach_game_summary';
    readonly outcome: 'success' | 'failure' | 'cache_fresh' | 'cache_stale' | 'circuit_open';
    readonly durationMs: number;
  }) => void;
}

const namedSchema = z.object({
  name: z.string().trim().min(1).max(300),
});

const trainerSchema = z.object({
  id: z.union([z.string().trim().min(1).max(200), z.number().finite()]).optional(),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().max(120).nullish(),
  photo: z.string().trim().url().max(2_048).nullish(),
});

export interface VivaCoachTrainerAvatarSource {
  readonly provider: 'VIVA';
  readonly providerTrainerId: string;
  readonly displayName: string;
  readonly sourceUrl?: string;
}

const exerciseSchema = z.object({
  id: z.union([z.string().trim().min(1).max(200), z.number().finite()]),
  direction: namedSchema,
  type: namedSchema,
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }),
  studio: namedSchema,
  room: namedSchema.nullish(),
  trainers: z.array(trainerSchema).max(20).default([]),
  maxClientsCount: z.number().int().nonnegative().max(10_000),
  clientsCount: z.number().int().nonnegative().max(10_000),
});

const exercisePageSchema = z.array(exerciseSchema).max(5_000);

interface CoachGameCacheEntry {
  readonly fetchedAt: number;
  readonly items: readonly PublicCoachGameSummary[];
}

function publicCoachGameId(tenantKey: string, externalId: string): string {
  const bytes = Buffer.from(
    createHash('sha256')
      .update(`phub-public-coach-game-v1:${tenantKey}:${externalId}`)
      .digest('hex')
      .slice(0, 32),
    'hex',
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isCoachGame(typeName: string): boolean {
  return typeName.replace(/\s+/gu, '').toLocaleLowerCase('ru-RU') === 'игра+тренер';
}

function playerLevel(directionName: string): CoachGamePlayerLevel | null {
  const match = /уровень\s*([ABCD](?:\+)?)(?:\s|$)/iu.exec(directionName);
  const value = match?.[1]?.toUpperCase();
  return value && ['D', 'D+', 'C', 'C+', 'B', 'B+', 'A'].includes(value)
    ? (value as CoachGamePlayerLevel)
    : null;
}

function trainerName(trainers: z.infer<typeof trainerSchema>[]): string | null {
  const trainer = trainers[0];
  if (!trainer) return null;
  return [trainer.firstName, trainer.lastName].filter(Boolean).join(' ').slice(0, 160);
}

function trainerAvatarSource(trainers: z.infer<typeof trainerSchema>[]): string | undefined {
  const candidate = trainers[0]?.photo;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export class VivaCoachGameSummaryAdapter {
  private readonly cache = new Map<string, CoachGameCacheEntry>();
  private readonly pending = new Map<string, Promise<readonly PublicCoachGameSummary[]>>();
  private readonly avatarSources = new Map<
    string,
    { readonly source: VivaCoachTrainerAvatarSource; readonly fetchedAt: number }
  >();
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | undefined;

  public constructor(private readonly options: VivaCoachGameSummaryAdapterOptions) {}

  private emit(
    metric: Parameters<NonNullable<VivaCoachGameSummaryAdapterOptions['onMetric']>>[0],
  ): void {
    try {
      this.options.onMetric?.(metric);
    } catch {
      // Telemetry must never change discovery behavior.
    }
  }

  private async fetchDate(date: string): Promise<readonly PublicCoachGameSummary[]> {
    const startedAt = Date.now();
    const now = this.options.now?.() ?? Date.now();
    const resetMs = this.options.circuitResetMs ?? 30_000;
    if (this.circuitOpenedAt !== undefined && now - this.circuitOpenedAt < resetMs) {
      this.emit({ operation: 'coach_game_summary', outcome: 'circuit_open', durationMs: 0 });
      throw new Error('COACH_GAME_SUMMARY_CIRCUIT_OPEN');
    }

    const baseUrl = new URL(this.options.apiBaseUrl);
    if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
      throw new Error('COACH_GAME_SUMMARY_BASE_URL_INVALID');
    }
    const tenantKey = this.options.tenantKey.trim();
    if (!/^[A-Za-z0-9_-]{2,80}$/.test(tenantKey)) {
      throw new Error('COACH_GAME_SUMMARY_TENANT_KEY_INVALID');
    }
    const url = new URL(`v1/${encodeURIComponent(tenantKey)}/exercises`, `${baseUrl.toString()}/`);
    url.searchParams.set('date', date);

    try {
      const response = await (this.options.fetchImplementation ?? fetch)(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
      });
      if (!response.ok) throw new Error('COACH_GAME_SUMMARY_SOURCE_UNAVAILABLE');
      const maxBytes = this.options.maxResponseBytes ?? 5 * 1_024 * 1_024;
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('COACH_GAME_SUMMARY_RESPONSE_TOO_LARGE');
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxBytes) throw new Error('COACH_GAME_SUMMARY_RESPONSE_TOO_LARGE');
      const exercises = exercisePageSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      );
      const items = exercises
        .filter((exercise) => isCoachGame(exercise.type.name))
        .flatMap((exercise) => {
          if (Date.parse(exercise.timeTo) <= Date.parse(exercise.timeFrom)) return [];
          const total = exercise.maxClientsCount;
          if (total <= 0) return [];
          const occupied = Math.max(0, Math.min(total, exercise.clientsCount));
          const level = playerLevel(exercise.direction.name);
          const coachName = trainerName(exercise.trainers);
          const id = publicCoachGameId(tenantKey, String(exercise.id));
          const avatarSourceUrl = trainerAvatarSource(exercise.trainers);
          const providerTrainerId = exercise.trainers[0]?.id;
          if (coachName && providerTrainerId !== undefined) {
            this.avatarSources.set(id, {
              source: {
                provider: 'VIVA',
                providerTrainerId: String(providerTrainerId),
                displayName: coachName,
                ...(avatarSourceUrl ? { sourceUrl: avatarSourceUrl } : {}),
              },
              fetchedAt: now,
            });
          }
          const item: PublicCoachGameSummary = {
            id,
            title: level ? `Игра с тренером · ${level}` : 'Игра с тренером',
            startsAt: new Date(exercise.timeFrom).toISOString(),
            endsAt: new Date(exercise.timeTo).toISOString(),
            stationName: exercise.studio.name.slice(0, 160),
            courtName: exercise.room?.name.slice(0, 160) ?? null,
            level,
            trainer: coachName ? { displayName: coachName, avatarUrl: null } : null,
            capacity: {
              total,
              occupied,
              open: Math.max(0, total - occupied),
            },
            status: occupied >= total ? 'FULL' : 'JOINABLE',
          };
          return [item];
        })
        .sort(
          (left, right) =>
            left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id),
        );
      this.consecutiveFailures = 0;
      this.circuitOpenedAt = undefined;
      this.emit({
        operation: 'coach_game_summary',
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });
      return items;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= (this.options.circuitFailureThreshold ?? 3)) {
        this.circuitOpenedAt = now;
      }
      this.emit({
        operation: 'coach_game_summary',
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  public readDate(date: string): Promise<readonly PublicCoachGameSummary[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Promise.reject(new Error('COACH_GAME_SUMMARY_DATE_INVALID'));
    }
    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(date);
    if (cached && now - cached.fetchedAt <= (this.options.freshTtlMs ?? 60_000)) {
      this.emit({ operation: 'coach_game_summary', outcome: 'cache_fresh', durationMs: 0 });
      return Promise.resolve(cached.items);
    }
    const existing = this.pending.get(date);
    if (existing) return existing;
    const request = this.fetchDate(date)
      .then((items) => {
        this.cache.set(date, { fetchedAt: now, items });
        return items;
      })
      .catch((error) => {
        if (cached && now - cached.fetchedAt <= (this.options.staleTtlMs ?? 600_000)) {
          this.emit({ operation: 'coach_game_summary', outcome: 'cache_stale', durationMs: 0 });
          return cached.items;
        }
        throw error;
      })
      .finally(() => {
        if (this.pending.get(date) === request) this.pending.delete(date);
      });
    this.pending.set(date, request);
    return request;
  }

  /**
   * Returns an integration-only media source for a summary already loaded through readDate().
   * Public routes proxy this URL and never serialize it into a browser DTO.
   */
  public readAvatarSource(summaryId: string): string | undefined {
    const value = this.avatarSources.get(summaryId);
    if (!value) return undefined;
    const now = this.options.now?.() ?? Date.now();
    if (now - value.fetchedAt > (this.options.staleTtlMs ?? 600_000)) {
      this.avatarSources.delete(summaryId);
      return undefined;
    }
    return value.source.sourceUrl;
  }

  public readTrainerAvatarSource(summaryId: string): VivaCoachTrainerAvatarSource | undefined {
    const value = this.avatarSources.get(summaryId);
    if (!value) return undefined;
    const now = this.options.now?.() ?? Date.now();
    if (now - value.fetchedAt > (this.options.staleTtlMs ?? 600_000)) {
      this.avatarSources.delete(summaryId);
      return undefined;
    }
    return value.source;
  }
}
