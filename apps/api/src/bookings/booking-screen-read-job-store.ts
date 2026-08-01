import type { VivaBookingHistoryPage, VivaExerciseRecommendation } from '@phub/viva-adapter';
import type Redis from 'ioredis';

import type { TrainingEventCatalogQuery } from './training-event-catalog.js';
import type { GamesEventCatalogQuery } from './games-event-catalog.js';

export interface BookingScreenScheduleReadCommand {
  readonly commandId: string;
  readonly operation: 'schedule.read';
  readonly date: string;
}

export interface BookingScreenUpcomingReadCommand {
  readonly commandId: string;
  readonly operation: 'bookings.read';
  readonly detailsOperation: 'bookings.details.read';
  readonly page: 0;
  readonly size: 50;
}

export interface BookingScreenActivityHistoryReadCommand {
  readonly commandId: string;
  readonly operation: 'bookings.history.read';
  readonly page: number;
  readonly size: number;
}

export type BookingScreenReadCommand =
  | BookingScreenScheduleReadCommand
  | BookingScreenUpcomingReadCommand
  | BookingScreenActivityHistoryReadCommand;

export interface BookingScreenReadJob {
  readonly jobId: string;
  readonly screen:
    'FOR_ME' | 'GROUP_TRAININGS' | 'MY_BOOKINGS' | 'EVENT_CATALOG' | 'ACTIVITY_HISTORY';
  readonly tenantId: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly commands: readonly BookingScreenReadCommand[];
  readonly catalogQuery?: TrainingEventCatalogQuery | GamesEventCatalogQuery;
  readonly historyReason?: 'UNCOVERED' | 'STALE' | 'NEXT_PAGE';
}

export interface BookingScreenUpcomingItem {
  readonly id: string;
  readonly kind: 'game' | 'training' | 'tournament';
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly venue: string;
  readonly status: 'confirmed' | 'waitlist' | 'payment_required';
  readonly route: string;
}

export interface BookingScreenScheduleReadResult {
  readonly commandId: string;
  readonly kind: 'schedule';
  readonly activities: readonly VivaExerciseRecommendation[];
  readonly gameAssociations?: readonly {
    readonly activityId: string;
    readonly gameId: string;
  }[];
  readonly acceptedAt: string;
}

export interface BookingScreenUpcomingReadResult {
  readonly commandId: string;
  readonly kind: 'upcoming';
  readonly bookings: readonly BookingScreenUpcomingItem[];
  readonly acceptedAt: string;
}

export interface BookingScreenActivityHistoryReadResult {
  readonly commandId: string;
  readonly kind: 'history';
  readonly page: VivaBookingHistoryPage;
  readonly acceptedAt: string;
}

export type BookingScreenReadResult =
  | BookingScreenScheduleReadResult
  | BookingScreenUpcomingReadResult
  | BookingScreenActivityHistoryReadResult;

export interface BookingScreenReadJobStore {
  create(job: BookingScreenReadJob, ttlSeconds: number): Promise<boolean>;
  get(jobId: string): Promise<BookingScreenReadJob | undefined>;
  putResult(
    jobId: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'>;
  getResults(
    jobId: string,
    commandIds: readonly string[],
  ): Promise<readonly BookingScreenReadResult[]>;
}

const JOB_PREFIX = 'phub:booking-screen-read-job:';
const RESULT_PREFIX = 'phub:booking-screen-read-result:';

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export class RedisBookingScreenReadJobStore implements BookingScreenReadJobStore {
  public constructor(private readonly redis: Redis) {}

  public async create(job: BookingScreenReadJob, ttlSeconds: number): Promise<boolean> {
    return (
      (await this.redis.set(
        `${JOB_PREFIX}${job.jobId}`,
        JSON.stringify(job),
        'EX',
        ttlSeconds,
        'NX',
      )) === 'OK'
    );
  }

  public async get(jobId: string): Promise<BookingScreenReadJob | undefined> {
    return parseJson<BookingScreenReadJob>(await this.redis.get(`${JOB_PREFIX}${jobId}`));
  }

  public async putResult(
    jobId: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'> {
    const stored = await this.redis.set(
      `${RESULT_PREFIX}${jobId}:${result.commandId}`,
      JSON.stringify(result),
      'EX',
      ttlSeconds,
      'NX',
    );
    return stored === 'OK' ? 'accepted' : 'replayed';
  }

  public async getResults(
    jobId: string,
    commandIds: readonly string[],
  ): Promise<readonly BookingScreenReadResult[]> {
    if (commandIds.length === 0) return [];
    const values = await this.redis.mget(
      ...commandIds.map((commandId) => `${RESULT_PREFIX}${jobId}:${commandId}`),
    );
    return values.flatMap((value) => {
      const result = parseJson<BookingScreenReadResult>(value);
      return result ? [result] : [];
    });
  }
}

export class MemoryBookingScreenReadJobStore implements BookingScreenReadJobStore {
  private readonly jobs = new Map<
    string,
    { readonly job: BookingScreenReadJob; readonly expiresAt: number }
  >();
  private readonly results = new Map<
    string,
    { readonly result: BookingScreenReadResult; readonly expiresAt: number }
  >();

  private deleteExpired(now = Date.now()): void {
    for (const [key, value] of this.jobs) {
      if (value.expiresAt <= now) this.jobs.delete(key);
    }
    for (const [key, value] of this.results) {
      if (value.expiresAt <= now) this.results.delete(key);
    }
  }

  public create(job: BookingScreenReadJob, ttlSeconds: number): Promise<boolean> {
    this.deleteExpired();
    if (this.jobs.has(job.jobId)) return Promise.resolve(false);
    this.jobs.set(job.jobId, { job, expiresAt: Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve(true);
  }

  public get(jobId: string): Promise<BookingScreenReadJob | undefined> {
    this.deleteExpired();
    return Promise.resolve(this.jobs.get(jobId)?.job);
  }

  public putResult(
    jobId: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'> {
    this.deleteExpired();
    const key = `${jobId}:${result.commandId}`;
    if (this.results.has(key)) return Promise.resolve('replayed');
    this.results.set(key, { result, expiresAt: Date.now() + ttlSeconds * 1_000 });
    return Promise.resolve('accepted');
  }

  public getResults(
    jobId: string,
    commandIds: readonly string[],
  ): Promise<readonly BookingScreenReadResult[]> {
    this.deleteExpired();
    return Promise.resolve(
      commandIds.flatMap((commandId) => {
        const result = this.results.get(`${jobId}:${commandId}`)?.result;
        return result ? [result] : [];
      }),
    );
  }
}
