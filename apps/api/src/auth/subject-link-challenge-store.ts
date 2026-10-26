import type Redis from 'ioredis';

export const SUBJECT_LINK_PURPOSE = 'SUBJECT_LINK' as const;

export interface SubjectLinkChallenge {
  readonly id: string;
  readonly purpose: typeof SUBJECT_LINK_PURPOSE;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly actorUserId: string;
  readonly sessionFamilyId: string;
  readonly audience: 'client';
  readonly provider: 'VIVA';
  readonly providerTenantKey: string;
  /** HMAC of the canonical phone. The Redis value never contains the phone itself. */
  readonly phoneHash: string;
  readonly attempts: number;
  readonly expiresAt: string;
  readonly resendAt: string;
}

export interface SubjectLinkChallengeStore {
  put(
    challenge: SubjectLinkChallenge,
    ttlSeconds: number,
    cooldownSeconds: number,
  ): Promise<boolean>;
  get(challengeId: string): Promise<SubjectLinkChallenge | undefined>;
  claim(challengeId: string, claimId: string, leaseSeconds: number): Promise<boolean>;
  release(challengeId: string, claimId: string): Promise<void>;
  incrementAttempts(challengeId: string): Promise<number | undefined>;
  delete(challengeId: string): Promise<void>;
}

const KEY_PREFIX = 'phub:auth:subject-link:challenge:';

function challengeKey(challengeId: string): string {
  return `${KEY_PREFIX}${challengeId}`;
}

function claimKey(challengeId: string): string {
  return `${challengeKey(challengeId)}:claim`;
}

function cooldownKey(challenge: SubjectLinkChallenge): string {
  return `${KEY_PREFIX}cooldown:${challenge.tenantId}:${challenge.actorUserId}:${challenge.phoneHash}`;
}

function parseChallenge(value: Record<string, string>): SubjectLinkChallenge | undefined {
  const attempts = Number(value.attempts);
  if (
    !value.id ||
    value.purpose !== SUBJECT_LINK_PURPOSE ||
    !value.tenantId ||
    !value.tenantKey ||
    !value.actorUserId ||
    !value.sessionFamilyId ||
    value.audience !== 'client' ||
    value.provider !== 'VIVA' ||
    !value.providerTenantKey ||
    !/^[0-9a-f]{64}$/.test(value.phoneHash ?? '') ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    !value.expiresAt ||
    !value.resendAt
  ) {
    return undefined;
  }
  return {
    id: value.id,
    purpose: SUBJECT_LINK_PURPOSE,
    tenantId: value.tenantId,
    tenantKey: value.tenantKey,
    actorUserId: value.actorUserId,
    sessionFamilyId: value.sessionFamilyId,
    audience: 'client',
    provider: 'VIVA',
    providerTenantKey: value.providerTenantKey,
    phoneHash: value.phoneHash as string,
    attempts,
    expiresAt: value.expiresAt,
    resendAt: value.resendAt,
  };
}

export class RedisSubjectLinkChallengeStore implements SubjectLinkChallengeStore {
  public constructor(private readonly redis: Redis) {}

  public async put(
    challenge: SubjectLinkChallenge,
    ttlSeconds: number,
    cooldownSeconds: number,
  ): Promise<boolean> {
    const cooldown = cooldownKey(challenge);
    const reserved = await this.redis.set(cooldown, challenge.id, 'EX', cooldownSeconds, 'NX');
    if (reserved !== 'OK') return false;
    try {
      await this.redis
        .multi()
        .hset(challengeKey(challenge.id), {
          id: challenge.id,
          purpose: challenge.purpose,
          tenantId: challenge.tenantId,
          tenantKey: challenge.tenantKey,
          actorUserId: challenge.actorUserId,
          sessionFamilyId: challenge.sessionFamilyId,
          audience: challenge.audience,
          provider: challenge.provider,
          providerTenantKey: challenge.providerTenantKey,
          phoneHash: challenge.phoneHash,
          attempts: String(challenge.attempts),
          expiresAt: challenge.expiresAt,
          resendAt: challenge.resendAt,
        })
        .expire(challengeKey(challenge.id), ttlSeconds)
        .exec();
      return true;
    } catch (error) {
      await this.redis.del(cooldown);
      throw error;
    }
  }

  public async get(challengeId: string): Promise<SubjectLinkChallenge | undefined> {
    return parseChallenge(await this.redis.hgetall(challengeKey(challengeId)));
  }

  public async claim(challengeId: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    return (
      (await this.redis.set(claimKey(challengeId), claimId, 'EX', leaseSeconds, 'NX')) === 'OK'
    );
  }

  public async release(challengeId: string, claimId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      claimKey(challengeId),
      claimId,
    );
  }

  public async incrementAttempts(challengeId: string): Promise<number | undefined> {
    const result = await this.redis.eval(
      "if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end return redis.call('HINCRBY', KEYS[1], 'attempts', 1)",
      1,
      challengeKey(challengeId),
    );
    return typeof result === 'number' && result >= 0 ? result : undefined;
  }

  public async delete(challengeId: string): Promise<void> {
    const challenge = await this.get(challengeId);
    const keys = [challengeKey(challengeId), claimKey(challengeId)];
    if (challenge) keys.push(cooldownKey(challenge));
    await this.redis.del(...keys);
  }
}

export class MemorySubjectLinkChallengeStore implements SubjectLinkChallengeStore {
  private readonly values = new Map<string, SubjectLinkChallenge>();
  private readonly claims = new Map<string, { claimId: string; expiresAt: number }>();
  private readonly cooldowns = new Map<string, number>();

  public put(
    challenge: SubjectLinkChallenge,
    _ttlSeconds: number,
    cooldownSeconds: number,
  ): Promise<boolean> {
    const cooldown = cooldownKey(challenge);
    if ((this.cooldowns.get(cooldown) ?? 0) > Date.now()) return Promise.resolve(false);
    this.cooldowns.set(cooldown, Date.now() + cooldownSeconds * 1000);
    this.values.set(challenge.id, challenge);
    return Promise.resolve(true);
  }

  public get(challengeId: string): Promise<SubjectLinkChallenge | undefined> {
    return Promise.resolve(this.values.get(challengeId));
  }

  public claim(challengeId: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    const current = this.claims.get(challengeId);
    if (current && current.expiresAt > Date.now()) return Promise.resolve(false);
    this.claims.set(challengeId, { claimId, expiresAt: Date.now() + leaseSeconds * 1000 });
    return Promise.resolve(true);
  }

  public release(challengeId: string, claimId: string): Promise<void> {
    if (this.claims.get(challengeId)?.claimId === claimId) this.claims.delete(challengeId);
    return Promise.resolve();
  }

  public incrementAttempts(challengeId: string): Promise<number | undefined> {
    const current = this.values.get(challengeId);
    if (!current) return Promise.resolve(undefined);
    const attempts = current.attempts + 1;
    this.values.set(challengeId, { ...current, attempts });
    return Promise.resolve(attempts);
  }

  public delete(challengeId: string): Promise<void> {
    const current = this.values.get(challengeId);
    if (current) this.cooldowns.delete(cooldownKey(current));
    this.values.delete(challengeId);
    this.claims.delete(challengeId);
    return Promise.resolve();
  }
}
