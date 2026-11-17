import type Redis from 'ioredis';

/** Contract TTL: a device has two minutes to read Viva and relay the payload back. */
export const PROFILE_PROVIDER_READ_JOB_TTL_SECONDS = 120;
/**
 * A job stays addressable for this grace period after expiresAt so an expired command can be
 * answered with the stable 410 PROFILE_READ_JOB_EXPIRED code instead of an indistinguishable 404.
 * The route deadline remains expiresAt; the retained row is never accepted.
 */
export const PROFILE_PROVIDER_READ_RETENTION_GRACE_SECONDS = 60;

export interface ProfileProviderReadJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly operation: 'profile.read';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ProfileProviderReadResult {
  readonly commandId: string;
  readonly observedAt: string;
  readonly acceptedAt: string;
}

export interface ProfileProviderReadJobStore {
  create(job: ProfileProviderReadJob, ttlSeconds: number): Promise<boolean>;
  get(jobId: string): Promise<ProfileProviderReadJob | undefined>;
  putResult(
    jobId: string,
    result: ProfileProviderReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'>;
  getResult(jobId: string, commandId: string): Promise<ProfileProviderReadResult | undefined>;
  /** Consumes a completed job so a repeated completion cannot replay it forever. */
  consume(jobId: string, commandId: string): Promise<void>;
}

const JOB_PREFIX = 'phub:profile-provider-read-job:';
const RESULT_PREFIX = 'phub:profile-provider-read-result:';

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function retentionSeconds(ttlSeconds: number): number {
  return Math.max(1, ttlSeconds) + PROFILE_PROVIDER_READ_RETENTION_GRACE_SECONDS;
}

export class RedisProfileProviderReadJobStore implements ProfileProviderReadJobStore {
  public constructor(private readonly redis: Redis) {}

  public async create(job: ProfileProviderReadJob, ttlSeconds: number): Promise<boolean> {
    return (
      (await this.redis.set(
        `${JOB_PREFIX}${job.jobId}`,
        JSON.stringify(job),
        'EX',
        retentionSeconds(ttlSeconds),
        'NX',
      )) === 'OK'
    );
  }

  public async get(jobId: string): Promise<ProfileProviderReadJob | undefined> {
    return parseJson<ProfileProviderReadJob>(await this.redis.get(`${JOB_PREFIX}${jobId}`));
  }

  public async putResult(
    jobId: string,
    result: ProfileProviderReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'> {
    const stored = await this.redis.set(
      `${RESULT_PREFIX}${jobId}:${result.commandId}`,
      JSON.stringify(result),
      'EX',
      retentionSeconds(ttlSeconds),
      'NX',
    );
    return stored === 'OK' ? 'accepted' : 'replayed';
  }

  public async getResult(
    jobId: string,
    commandId: string,
  ): Promise<ProfileProviderReadResult | undefined> {
    return parseJson<ProfileProviderReadResult>(
      await this.redis.get(`${RESULT_PREFIX}${jobId}:${commandId}`),
    );
  }

  public async consume(jobId: string, commandId: string): Promise<void> {
    await this.redis.del(`${JOB_PREFIX}${jobId}`, `${RESULT_PREFIX}${jobId}:${commandId}`);
  }
}

export class MemoryProfileProviderReadJobStore implements ProfileProviderReadJobStore {
  private readonly jobs = new Map<
    string,
    { readonly job: ProfileProviderReadJob; readonly expiresAt: number }
  >();
  private readonly results = new Map<
    string,
    { readonly result: ProfileProviderReadResult; readonly expiresAt: number }
  >();

  private deleteExpired(now = Date.now()): void {
    for (const [key, value] of this.jobs) {
      if (value.expiresAt <= now) this.jobs.delete(key);
    }
    for (const [key, value] of this.results) {
      if (value.expiresAt <= now) this.results.delete(key);
    }
  }

  public create(job: ProfileProviderReadJob, ttlSeconds: number): Promise<boolean> {
    this.deleteExpired();
    if (this.jobs.has(job.jobId)) return Promise.resolve(false);
    this.jobs.set(job.jobId, {
      job,
      expiresAt: Date.now() + retentionSeconds(ttlSeconds) * 1_000,
    });
    return Promise.resolve(true);
  }

  public get(jobId: string): Promise<ProfileProviderReadJob | undefined> {
    this.deleteExpired();
    return Promise.resolve(this.jobs.get(jobId)?.job);
  }

  public putResult(
    jobId: string,
    result: ProfileProviderReadResult,
    ttlSeconds: number,
  ): Promise<'accepted' | 'replayed'> {
    this.deleteExpired();
    const key = `${jobId}:${result.commandId}`;
    if (this.results.has(key)) return Promise.resolve('replayed');
    this.results.set(key, {
      result,
      expiresAt: Date.now() + retentionSeconds(ttlSeconds) * 1_000,
    });
    return Promise.resolve('accepted');
  }

  public getResult(
    jobId: string,
    commandId: string,
  ): Promise<ProfileProviderReadResult | undefined> {
    this.deleteExpired();
    return Promise.resolve(this.results.get(`${jobId}:${commandId}`)?.result);
  }

  public consume(jobId: string, commandId: string): Promise<void> {
    this.jobs.delete(jobId);
    this.results.delete(`${jobId}:${commandId}`);
    return Promise.resolve();
  }
}
