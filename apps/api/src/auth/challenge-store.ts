import { createHash } from 'node:crypto';

import type Redis from 'ioredis';

import type { IdentityProviderKey } from '@phub/auth';

export interface AuthChallenge {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly provider: IdentityProviderKey;
  readonly providerTenantKey: string;
  readonly phoneE164: string;
  readonly attempts: number;
  readonly expiresAt: string;
  readonly resendAt: string;
}

export interface AuthChallengeStore {
  put(challenge: AuthChallenge, ttlSeconds: number, cooldownSeconds: number): Promise<boolean>;
  get(challengeId: string): Promise<AuthChallenge | undefined>;
  claim(challengeId: string, claimId: string, leaseSeconds: number): Promise<boolean>;
  release(challengeId: string, claimId: string): Promise<void>;
  incrementAttempts(challengeId: string): Promise<number | undefined>;
  delete(challengeId: string): Promise<void>;
}

const KEY_PREFIX = 'phub:auth:challenge:';

function challengeKey(challengeId: string): string {
  return `${KEY_PREFIX}${challengeId}`;
}

function claimKey(challengeId: string): string {
  return `${challengeKey(challengeId)}:claim`;
}

function cooldownKey(challenge: Pick<AuthChallenge, 'tenantId' | 'phoneE164'>): string {
  const phoneHash = createHash('sha256').update(challenge.phoneE164).digest('base64url');
  return `${KEY_PREFIX}cooldown:${challenge.tenantId}:${phoneHash}`;
}

function parseChallenge(value: Record<string, string>): AuthChallenge | undefined {
  const attempts = Number(value.attempts);
  if (
    !value.id ||
    !value.tenantId ||
    !value.tenantKey ||
    (value.provider !== 'VIVA' && value.provider !== 'LOCAL') ||
    !value.providerTenantKey ||
    !value.phoneE164 ||
    !Number.isInteger(attempts) ||
    !value.expiresAt ||
    !value.resendAt
  ) {
    return undefined;
  }
  return {
    id: value.id,
    tenantId: value.tenantId,
    tenantKey: value.tenantKey,
    provider: value.provider,
    providerTenantKey: value.providerTenantKey,
    phoneE164: value.phoneE164,
    attempts,
    expiresAt: value.expiresAt,
    resendAt: value.resendAt,
  };
}

export class RedisAuthChallengeStore implements AuthChallengeStore {
  public constructor(private readonly redis: Redis) {}

  public async put(
    challenge: AuthChallenge,
    ttlSeconds: number,
    cooldownSeconds: number,
  ): Promise<boolean> {
    const key = challengeKey(challenge.id);
    const cooldown = cooldownKey(challenge);
    const reserved = await this.redis.set(cooldown, challenge.id, 'EX', cooldownSeconds, 'NX');
    if (reserved !== 'OK') return false;
    try {
      await this.redis
        .multi()
        .hset(key, {
          id: challenge.id,
          tenantId: challenge.tenantId,
          tenantKey: challenge.tenantKey,
          provider: challenge.provider,
          providerTenantKey: challenge.providerTenantKey,
          phoneE164: challenge.phoneE164,
          attempts: String(challenge.attempts),
          expiresAt: challenge.expiresAt,
          resendAt: challenge.resendAt,
        })
        .expire(key, ttlSeconds)
        .exec();
      return true;
    } catch (error) {
      await this.redis.del(cooldown);
      throw error;
    }
  }

  public async get(challengeId: string): Promise<AuthChallenge | undefined> {
    const value = await this.redis.hgetall(challengeKey(challengeId));
    return parseChallenge(value);
  }

  public async incrementAttempts(challengeId: string): Promise<number | undefined> {
    const result = await this.redis.eval(
      "if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end return redis.call('HINCRBY', KEYS[1], 'attempts', 1)",
      1,
      challengeKey(challengeId),
    );
    return typeof result === 'number' && result >= 0 ? result : undefined;
  }

  public async claim(challengeId: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.redis.set(claimKey(challengeId), claimId, 'EX', leaseSeconds, 'NX');
    return result === 'OK';
  }

  public async release(challengeId: string, claimId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      claimKey(challengeId),
      claimId,
    );
  }

  public async delete(challengeId: string): Promise<void> {
    const challenge = await this.get(challengeId);
    const keys = [challengeKey(challengeId), claimKey(challengeId)];
    if (challenge) keys.push(cooldownKey(challenge));
    await this.redis.del(...keys);
  }
}

export class MemoryAuthChallengeStore implements AuthChallengeStore {
  private readonly values = new Map<string, AuthChallenge>();
  private readonly cooldowns = new Map<string, number>();
  private readonly claims = new Map<string, { claimId: string; expiresAt: number }>();

  public put(
    challenge: AuthChallenge,
    _ttlSeconds: number,
    cooldownSeconds: number,
  ): Promise<boolean> {
    const key = cooldownKey(challenge);
    const cooldownUntil = this.cooldowns.get(key) ?? 0;
    if (cooldownUntil > Date.now()) return Promise.resolve(false);
    this.cooldowns.set(key, Date.now() + cooldownSeconds * 1000);
    this.values.set(challenge.id, challenge);
    return Promise.resolve(true);
  }

  public get(challengeId: string): Promise<AuthChallenge | undefined> {
    return Promise.resolve(this.values.get(challengeId));
  }

  public incrementAttempts(challengeId: string): Promise<number | undefined> {
    const challenge = this.values.get(challengeId);
    if (!challenge) return Promise.resolve(undefined);
    const attempts = challenge.attempts + 1;
    this.values.set(challengeId, { ...challenge, attempts });
    return Promise.resolve(attempts);
  }

  public claim(challengeId: string, claimId: string, leaseSeconds: number): Promise<boolean> {
    const existing = this.claims.get(challengeId);
    if (existing && existing.expiresAt > Date.now()) return Promise.resolve(false);
    this.claims.set(challengeId, { claimId, expiresAt: Date.now() + leaseSeconds * 1000 });
    return Promise.resolve(true);
  }

  public release(challengeId: string, claimId: string): Promise<void> {
    if (this.claims.get(challengeId)?.claimId === claimId) this.claims.delete(challengeId);
    return Promise.resolve();
  }

  public delete(challengeId: string): Promise<void> {
    const challenge = this.values.get(challengeId);
    if (challenge) this.cooldowns.delete(cooldownKey(challenge));
    this.values.delete(challengeId);
    this.claims.delete(challengeId);
    return Promise.resolve();
  }
}
