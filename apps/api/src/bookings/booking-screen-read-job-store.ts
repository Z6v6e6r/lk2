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
  readonly size: 1000;
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
  readonly participants?: readonly {
    readonly profileId?: string;
    readonly displayName: string;
    readonly avatarUrl?: string | null;
    readonly level?: string | null;
    readonly levelValue?: number | null;
  }[];
  readonly participantsCount?: number;
  readonly openSlots?: number;
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
  readonly complete: boolean;
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
  claimResult(
    jobId: string,
    commandId: string,
    claimId: string,
    payloadHash: string,
    ttlSeconds: number,
  ): Promise<'claimed' | 'replayed' | 'in_progress' | 'conflict'>;
  completeClaimedResult(
    jobId: string,
    claimId: string,
    payloadHash: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<boolean>;
  releaseResultClaim(
    jobId: string,
    commandId: string,
    claimId: string,
    payloadHash: string,
  ): Promise<void>;
  consumeEgressBudget(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly provider: 'VIVA';
    readonly units: number;
    readonly principalLimit: number;
    readonly providerLimit: number;
    readonly windowSeconds: number;
  }): Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
  >;
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
const RESULT_CLAIM_PREFIX = 'phub:booking-screen-read-result-claim:';
const RESULT_PAYLOAD_HASH_PREFIX = 'phub:booking-screen-read-result-payload-hash:';
const EGRESS_BUDGET_PREFIX = 'phub:provider-egress-budget:';

function resultKey(jobId: string, commandId: string): string {
  return `${RESULT_PREFIX}${jobId}:${commandId}`;
}

function resultClaimKey(jobId: string, commandId: string): string {
  return `${RESULT_CLAIM_PREFIX}${jobId}:${commandId}`;
}

function resultPayloadHashKey(jobId: string, commandId: string): string {
  return `${RESULT_PAYLOAD_HASH_PREFIX}${jobId}:${commandId}`;
}

function resultClaimValue(claimId: string, payloadHash: string): string {
  return `${payloadHash}:${claimId}`;
}

function principalEgressBudgetKey(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: 'VIVA';
}): string {
  return `${EGRESS_BUDGET_PREFIX}${input.tenantId}:${input.userId}:${input.provider}`;
}

function providerEgressBudgetKey(input: {
  readonly tenantId: string;
  readonly provider: 'VIVA';
}): string {
  return `${EGRESS_BUDGET_PREFIX}${input.tenantId}:${input.provider}`;
}

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

  public async claimResult(
    jobId: string,
    commandId: string,
    claimId: string,
    payloadHash: string,
    ttlSeconds: number,
  ): Promise<'claimed' | 'replayed' | 'in_progress' | 'conflict'> {
    const outcome = await this.redis.eval(
      "if redis.call('EXISTS', KEYS[1]) == 1 then if redis.call('GET', KEYS[3]) == ARGV[2] then return 2 end return 3 end local active=redis.call('GET', KEYS[2]) if active then if string.sub(active, 1, 64) == ARGV[2] then return 0 end return 3 end redis.call('SET', KEYS[2], ARGV[2] .. ':' .. ARGV[1], 'EX', ARGV[3]) return 1",
      3,
      resultKey(jobId, commandId),
      resultClaimKey(jobId, commandId),
      resultPayloadHashKey(jobId, commandId),
      claimId,
      payloadHash,
      String(ttlSeconds),
    );
    return outcome === 1
      ? 'claimed'
      : outcome === 2
        ? 'replayed'
        : outcome === 3
          ? 'conflict'
          : 'in_progress';
  }

  public async completeClaimedResult(
    jobId: string,
    claimId: string,
    payloadHash: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<boolean> {
    const outcome = await this.redis.eval(
      "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[3]) redis.call('DEL', KEYS[1]) return 1",
      3,
      resultClaimKey(jobId, result.commandId),
      resultKey(jobId, result.commandId),
      resultPayloadHashKey(jobId, result.commandId),
      resultClaimValue(claimId, payloadHash),
      JSON.stringify(result),
      String(ttlSeconds),
      payloadHash,
    );
    return outcome === 1;
  }

  public async releaseResultClaim(
    jobId: string,
    commandId: string,
    claimId: string,
    payloadHash: string,
  ): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      resultClaimKey(jobId, commandId),
      resultClaimValue(claimId, payloadHash),
    );
  }

  public async consumeEgressBudget(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly provider: 'VIVA';
    readonly units: number;
    readonly principalLimit: number;
    readonly providerLimit: number;
    readonly windowSeconds: number;
  }): Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
  > {
    if (input.units <= 0) return { allowed: true };
    const outcome = await this.redis.eval(
      "local units=tonumber(ARGV[1]) local principal=tonumber(redis.call('GET', KEYS[1]) or '0') local provider=tonumber(redis.call('GET', KEYS[2]) or '0') local principal_exceeded=principal + units > tonumber(ARGV[2]) local provider_exceeded=provider + units > tonumber(ARGV[3]) if principal_exceeded or provider_exceeded then local retry=0 if principal_exceeded then retry=redis.call('TTL', KEYS[1]) end if provider_exceeded then retry=math.max(retry, redis.call('TTL', KEYS[2])) end if retry < 1 then retry=tonumber(ARGV[4]) end return {0, retry} end local principal_next=redis.call('INCRBY', KEYS[1], units) local provider_next=redis.call('INCRBY', KEYS[2], units) if principal_next == units then redis.call('EXPIRE', KEYS[1], ARGV[4]) end if provider_next == units then redis.call('EXPIRE', KEYS[2], ARGV[4]) end return {1, math.max(redis.call('TTL', KEYS[1]), redis.call('TTL', KEYS[2]))}",
      2,
      principalEgressBudgetKey(input),
      providerEgressBudgetKey(input),
      String(input.units),
      String(input.principalLimit),
      String(input.providerLimit),
      String(input.windowSeconds),
    );
    const values = Array.isArray(outcome) ? outcome : [];
    return values[0] === 1
      ? { allowed: true }
      : {
          allowed: false,
          retryAfterSeconds: Math.max(1, Number(values[1]) || input.windowSeconds),
        };
  }

  public async putResult(
    jobId: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'> {
    const stored = await this.redis.set(
      resultKey(jobId, result.commandId),
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
      ...commandIds.map((commandId) => resultKey(jobId, commandId)),
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
  private readonly claims = new Map<
    string,
    { readonly claimId: string; readonly payloadHash: string; readonly expiresAt: number }
  >();
  private readonly resultPayloadHashes = new Map<string, string>();
  private readonly egressBudgets = new Map<
    string,
    { readonly units: number; readonly expiresAt: number }
  >();

  private deleteExpired(now = Date.now()): void {
    for (const [key, value] of this.jobs) {
      if (value.expiresAt <= now) this.jobs.delete(key);
    }
    for (const [key, value] of this.results) {
      if (value.expiresAt <= now) {
        this.results.delete(key);
        this.resultPayloadHashes.delete(key);
      }
    }
    for (const [key, value] of this.claims) {
      if (value.expiresAt <= now) this.claims.delete(key);
    }
    for (const [key, value] of this.egressBudgets) {
      if (value.expiresAt <= now) this.egressBudgets.delete(key);
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

  public claimResult(
    jobId: string,
    commandId: string,
    claimId: string,
    payloadHash: string,
    ttlSeconds: number,
  ): Promise<'claimed' | 'replayed' | 'in_progress' | 'conflict'> {
    this.deleteExpired();
    const key = `${jobId}:${commandId}`;
    if (this.results.has(key)) {
      return Promise.resolve(
        this.resultPayloadHashes.get(key) === payloadHash ? 'replayed' : 'conflict',
      );
    }
    const active = this.claims.get(key);
    if (active)
      return Promise.resolve(active.payloadHash === payloadHash ? 'in_progress' : 'conflict');
    this.claims.set(key, {
      claimId,
      payloadHash,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    return Promise.resolve('claimed');
  }

  public completeClaimedResult(
    jobId: string,
    claimId: string,
    payloadHash: string,
    result: BookingScreenReadResult,
    ttlSeconds: number,
  ): Promise<boolean> {
    this.deleteExpired();
    const key = `${jobId}:${result.commandId}`;
    const claim = this.claims.get(key);
    if (claim?.claimId !== claimId || claim.payloadHash !== payloadHash) {
      return Promise.resolve(false);
    }
    this.results.set(key, { result, expiresAt: Date.now() + ttlSeconds * 1_000 });
    this.resultPayloadHashes.set(key, payloadHash);
    this.claims.delete(key);
    return Promise.resolve(true);
  }

  public releaseResultClaim(
    jobId: string,
    commandId: string,
    claimId: string,
    payloadHash: string,
  ): Promise<void> {
    const key = `${jobId}:${commandId}`;
    const claim = this.claims.get(key);
    if (claim?.claimId === claimId && claim.payloadHash === payloadHash) this.claims.delete(key);
    return Promise.resolve();
  }

  public consumeEgressBudget(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly provider: 'VIVA';
    readonly units: number;
    readonly principalLimit: number;
    readonly providerLimit: number;
    readonly windowSeconds: number;
  }): Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
  > {
    this.deleteExpired();
    if (input.units <= 0) return Promise.resolve({ allowed: true });
    const principalKey = principalEgressBudgetKey(input);
    const providerKey = providerEgressBudgetKey(input);
    const principal = this.egressBudgets.get(principalKey);
    const provider = this.egressBudgets.get(providerKey);
    const principalExceeded = (principal?.units ?? 0) + input.units > input.principalLimit;
    const providerExceeded = (provider?.units ?? 0) + input.units > input.providerLimit;
    if (principalExceeded || providerExceeded) {
      return Promise.resolve({
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          ...[
            ...(principalExceeded ? [principal?.expiresAt] : []),
            ...(providerExceeded ? [provider?.expiresAt] : []),
          ].map((expiresAt) =>
            Math.ceil(
              ((expiresAt ?? Date.now() + input.windowSeconds * 1_000) - Date.now()) / 1_000,
            ),
          ),
        ),
      });
    }
    this.egressBudgets.set(principalKey, {
      units: (principal?.units ?? 0) + input.units,
      expiresAt: principal?.expiresAt ?? Date.now() + input.windowSeconds * 1_000,
    });
    this.egressBudgets.set(providerKey, {
      units: (provider?.units ?? 0) + input.units,
      expiresAt: provider?.expiresAt ?? Date.now() + input.windowSeconds * 1_000,
    });
    return Promise.resolve({ allowed: true });
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
