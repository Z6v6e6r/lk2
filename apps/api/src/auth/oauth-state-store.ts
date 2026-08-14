import type Redis from 'ioredis';

import type { VivaOAuthProvider } from '@phub/auth';
import { vivaRefreshLockRedisKey } from '@phub/auth/viva-delegation';

export interface VivaOAuthState {
  readonly state: string;
  readonly tenantKey: string;
  readonly provider: VivaOAuthProvider;
  readonly codeVerifier: string;
  readonly publicOfferAccepted: boolean;
  readonly personalDataPolicyAccepted: boolean;
  readonly publicOfferVersion: string;
  readonly personalDataPolicyVersion: string;
  /** Hash of the short-lived HttpOnly browser nonce that initiated this OAuth flow. */
  readonly browserNonceHash: string;
  /** Binds a consent-preserving recovery flow to its already authenticated user. */
  readonly recoveryUserId?: string;
}

export interface VivaOAuthStart {
  readonly state: VivaOAuthState;
  readonly browserNonce: string;
}

export type VivaOAuthStartReservation =
  | { readonly outcome: 'created' | 'replay'; readonly start: VivaOAuthStart }
  | { readonly outcome: 'conflict' };

export interface VivaOAuthStateStore {
  reserveStart(input: {
    readonly commandKey: string;
    readonly requestHash: string;
    readonly start: VivaOAuthStart;
    readonly ttlSeconds: number;
  }): Promise<VivaOAuthStartReservation>;
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

const LEGACY_STATE_PREFIX = 'phub:auth:viva-oauth:';
const STATE_PREFIX = 'phub:auth:v2:viva-oauth:';
const START_PREFIX = 'phub:auth:v2:viva-oauth-start:';
const HANDOFF_PREFIX = 'phub:auth:viva-handoff:';

interface StoredVivaOAuthStart {
  readonly requestHash: string;
  readonly start: VivaOAuthStart;
}

interface ExpiringValue<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function isStringPair(value: unknown): value is [string, string] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const items: readonly unknown[] = value;
  return typeof items[0] === 'string' && typeof items[1] === 'string';
}

export class RedisVivaOAuthStateStore implements VivaOAuthStateStore {
  public constructor(private readonly redis: Redis) {}

  public async reserveStart(input: {
    readonly commandKey: string;
    readonly requestHash: string;
    readonly start: VivaOAuthStart;
    readonly ttlSeconds: number;
  }): Promise<VivaOAuthStartReservation> {
    const stored = JSON.stringify({
      requestHash: input.requestHash,
      start: input.start,
    } satisfies StoredVivaOAuthStart);
    const result = await this.redis.eval(
      `
        local existing = redis.call('GET', KEYS[1])
        if existing then return {'replay', existing} end
        if redis.call('EXISTS', KEYS[2]) == 1 then return {'collision', ''} end
        redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
        redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
        return {'created', ARGV[1]}
      `,
      2,
      `${START_PREFIX}${input.commandKey}`,
      `${STATE_PREFIX}${input.start.state.state}`,
      stored,
      JSON.stringify(input.start.state),
      String(input.ttlSeconds),
    );
    if (!isStringPair(result) || result[0] === 'collision') {
      throw new Error('VIVA_OAUTH_STATE_RESERVATION_FAILED');
    }
    const outcome = result[0];
    const serialized = result[1];
    if ((outcome !== 'created' && outcome !== 'replay') || typeof serialized !== 'string') {
      throw new Error('VIVA_OAUTH_STATE_RESERVATION_FAILED');
    }
    let reservation: StoredVivaOAuthStart;
    try {
      reservation = JSON.parse(serialized) as StoredVivaOAuthStart;
    } catch {
      throw new Error('VIVA_OAUTH_STATE_RESERVATION_FAILED');
    }
    if (reservation.requestHash !== input.requestHash) return { outcome: 'conflict' };
    return { outcome, start: reservation.start };
  }

  public async put(value: VivaOAuthState, ttlSeconds: number): Promise<void> {
    await this.redis.set(
      `${STATE_PREFIX}${value.state}`,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
      'NX',
    );
  }

  public async take(state: string): Promise<VivaOAuthState | undefined> {
    const value =
      (await this.redis.getdel(`${STATE_PREFIX}${state}`)) ??
      (await this.redis.getdel(`${LEGACY_STATE_PREFIX}${state}`));
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
      (await this.redis.set(vivaRefreshLockRedisKey(key), claimId, 'EX', ttlSeconds, 'NX')) === 'OK'
    );
  }

  public async releaseRefresh(key: string, claimId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      vivaRefreshLockRedisKey(key),
      claimId,
    );
  }
}

export class MemoryVivaOAuthStateStore implements VivaOAuthStateStore {
  private readonly values = new Map<string, ExpiringValue<VivaOAuthState>>();
  private readonly starts = new Map<string, ExpiringValue<StoredVivaOAuthStart>>();
  private readonly handoffs = new Map<string, ExpiringValue<VivaAccessHandoff>>();
  private readonly refreshClaims = new Map<string, ExpiringValue<string>>();

  public constructor(private readonly now: () => number = Date.now) {}

  private expiresAt(ttlSeconds: number): number {
    return this.now() + ttlSeconds * 1_000;
  }

  private liveValue<T>(entry: ExpiringValue<T> | undefined): T | undefined {
    return entry && entry.expiresAt > this.now() ? entry.value : undefined;
  }

  public reserveStart(input: {
    readonly commandKey: string;
    readonly requestHash: string;
    readonly start: VivaOAuthStart;
    readonly ttlSeconds: number;
  }): Promise<VivaOAuthStartReservation> {
    const existing = this.starts.get(input.commandKey);
    const existingValue = this.liveValue(existing);
    if (existingValue) {
      if (existingValue.requestHash !== input.requestHash) {
        return Promise.resolve({ outcome: 'conflict' });
      }
      return Promise.resolve({ outcome: 'replay', start: existingValue.start });
    }
    if (existing) this.starts.delete(input.commandKey);
    const stored = { requestHash: input.requestHash, start: input.start };
    const expiresAt = this.expiresAt(input.ttlSeconds);
    this.starts.set(input.commandKey, { value: stored, expiresAt });
    this.values.set(input.start.state.state, { value: input.start.state, expiresAt });
    return Promise.resolve({ outcome: 'created', start: input.start });
  }

  public put(value: VivaOAuthState, ttlSeconds: number): Promise<void> {
    this.values.set(value.state, { value, expiresAt: this.expiresAt(ttlSeconds) });
    return Promise.resolve();
  }

  public take(state: string): Promise<VivaOAuthState | undefined> {
    const entry = this.values.get(state);
    this.values.delete(state);
    return Promise.resolve(this.liveValue(entry));
  }

  public putHandoff(value: VivaAccessHandoff, ttlSeconds: number): Promise<void> {
    this.handoffs.set(value.code, { value, expiresAt: this.expiresAt(ttlSeconds) });
    return Promise.resolve();
  }

  public takeHandoff(code: string): Promise<VivaAccessHandoff | undefined> {
    const entry = this.handoffs.get(code);
    this.handoffs.delete(code);
    return Promise.resolve(this.liveValue(entry));
  }

  public claimRefresh(key: string, claimId: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.refreshClaims.get(key);
    if (this.liveValue(existing)) return Promise.resolve(false);
    if (existing) this.refreshClaims.delete(key);
    this.refreshClaims.set(key, { value: claimId, expiresAt: this.expiresAt(ttlSeconds) });
    return Promise.resolve(true);
  }

  public releaseRefresh(key: string, claimId: string): Promise<void> {
    if (this.liveValue(this.refreshClaims.get(key)) === claimId) this.refreshClaims.delete(key);
    return Promise.resolve();
  }
}
