import type Redis from 'ioredis';

import type { VivaOAuthProvider } from '@phub/auth';

export interface VivaOAuthState {
  readonly state: string;
  readonly tenantKey: string;
  readonly provider: VivaOAuthProvider;
  readonly codeVerifier: string;
  readonly publicOfferAccepted: boolean;
  readonly personalDataPolicyAccepted: boolean;
  readonly publicOfferVersion: string;
  readonly personalDataPolicyVersion: string;
}

export interface VivaOAuthStateStore {
  put(value: VivaOAuthState, ttlSeconds: number): Promise<void>;
  take(state: string): Promise<VivaOAuthState | undefined>;
  putHandoff(value: VivaAccessHandoff, ttlSeconds: number): Promise<void>;
  takeHandoff(code: string): Promise<VivaAccessHandoff | undefined>;
  claimRefresh(key: string, claimId: string, ttlSeconds: number): Promise<boolean>;
  releaseRefresh(key: string, claimId: string): Promise<void>;
}

export interface VivaAccessHandoff {
  readonly code: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly expiresAt: string;
}

const PREFIX = 'phub:auth:viva-oauth:';
const HANDOFF_PREFIX = 'phub:auth:viva-handoff:';
const REFRESH_LOCK_PREFIX = 'phub:auth:viva-refresh-lock:';

export class RedisVivaOAuthStateStore implements VivaOAuthStateStore {
  public constructor(private readonly redis: Redis) {}

  public async put(value: VivaOAuthState, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${PREFIX}${value.state}`, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
  }

  public async take(state: string): Promise<VivaOAuthState | undefined> {
    const value = await this.redis.getdel(`${PREFIX}${state}`);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as VivaOAuthState;
    } catch {
      return undefined;
    }
  }

  public async putHandoff(value: VivaAccessHandoff, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      `${HANDOFF_PREFIX}${value.code}`,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
      'NX',
    );
  }

  public async takeHandoff(code: string): Promise<VivaAccessHandoff | undefined> {
    const value = await this.redis.getdel(`${HANDOFF_PREFIX}${code}`);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as VivaAccessHandoff;
    } catch {
      return undefined;
    }
  }

  public async claimRefresh(key: string, claimId: string, ttlSeconds: number): Promise<boolean> {
    return (
      (await this.redis.set(`${REFRESH_LOCK_PREFIX}${key}`, claimId, 'EX', ttlSeconds, 'NX')) ===
      'OK'
    );
  }

  public async releaseRefresh(key: string, claimId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      `${REFRESH_LOCK_PREFIX}${key}`,
      claimId,
    );
  }
}

export class MemoryVivaOAuthStateStore implements VivaOAuthStateStore {
  private readonly values = new Map<string, VivaOAuthState>();
  private readonly handoffs = new Map<string, VivaAccessHandoff>();
  private readonly refreshClaims = new Map<string, string>();

  public put(value: VivaOAuthState, _ttlSeconds: number): Promise<void> {
    void _ttlSeconds;
    this.values.set(value.state, value);
    return Promise.resolve();
  }

  public take(state: string): Promise<VivaOAuthState | undefined> {
    const value = this.values.get(state);
    this.values.delete(state);
    return Promise.resolve(value);
  }

  public putHandoff(value: VivaAccessHandoff, _ttlSeconds: number): Promise<void> {
    void _ttlSeconds;
    this.handoffs.set(value.code, value);
    return Promise.resolve();
  }

  public takeHandoff(code: string): Promise<VivaAccessHandoff | undefined> {
    const value = this.handoffs.get(code);
    this.handoffs.delete(code);
    return Promise.resolve(value);
  }

  public claimRefresh(key: string, claimId: string, _ttlSeconds: number): Promise<boolean> {
    void _ttlSeconds;
    if (this.refreshClaims.has(key)) return Promise.resolve(false);
    this.refreshClaims.set(key, claimId);
    return Promise.resolve(true);
  }

  public releaseRefresh(key: string, claimId: string): Promise<void> {
    if (this.refreshClaims.get(key) === claimId) this.refreshClaims.delete(key);
    return Promise.resolve();
  }
}
