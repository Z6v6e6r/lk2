import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

export const ANDROID_OAUTH_REDIRECT = 'https://lk2.padlhub.su/android/oauth/yandex';
export const ANDROID_OAUTH_START_TTL = 300;
export const ANDROID_OAUTH_HANDOFF_TTL = 120;

export interface AndroidOAuthBinding {
  readonly client: 'ANDROID_NATIVE';
  readonly codeChallenge: string;
  readonly clientState: string;
}

export interface AndroidOAuthLaunch extends AndroidOAuthBinding {
  readonly code: string;
  readonly tenantKey: string;
}

export interface AndroidOAuthHandoff extends AndroidOAuthBinding {
  readonly tenantKey: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
}

interface StartInput {
  readonly commandKey: string;
  readonly requestHash: string;
  readonly launch: AndroidOAuthLaunch;
}
interface ClaimInput {
  readonly code: string;
  readonly tenantKey: string;
  readonly codeChallenge: string;
  readonly clientState: string;
  readonly idempotencyKey: string;
}
interface Reservation {
  readonly requestHash: string;
  readonly launch: AndroidOAuthLaunch;
}
interface HandoffRecord {
  readonly handoff: AndroidOAuthHandoff;
  readonly idempotencyKey?: string;
}
type StartResult = { readonly launch: AndroidOAuthLaunch } | { readonly conflict: true };
type ClaimResult =
  { readonly handoff: AndroidOAuthHandoff } | { readonly rejected: 'missing' | 'conflict' };

export interface AndroidOAuthStore {
  reserveStart(input: StartInput): Promise<StartResult>;
  takeLaunch(code: string, tenantKey: string): Promise<AndroidOAuthLaunch | undefined>;
  putHandoff(code: string, handoff: AndroidOAuthHandoff): Promise<void>;
  claimHandoff(input: ClaimInput): Promise<ClaimResult>;
}

const prefix = 'phub:auth:android-oauth:v1:';
function key(kind: string, value: string): string {
  return `${prefix}${kind}:${createHash('sha256').update(value).digest('hex')}`;
}

/** Redis contains identity metadata and S256 challenges, never provider or PadlHub tokens. */
export class RedisAndroidOAuthStore implements AndroidOAuthStore {
  public constructor(private readonly redis: Redis) {}

  public async reserveStart(input: StartInput): Promise<StartResult> {
    const encoded = JSON.stringify({ requestHash: input.requestHash, launch: input.launch });
    const result = await this.redis.eval(
      `local existing = redis.call('GET', KEYS[1])
       if existing then return existing end
       if redis.call('EXISTS', KEYS[2]) == 1 then return false end
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
       redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
       return ARGV[1]`,
      2,
      key('start', input.commandKey),
      key('launch', input.launch.code),
      encoded,
      JSON.stringify(input.launch),
      ANDROID_OAUTH_START_TTL,
    );
    if (typeof result !== 'string') throw new Error('ANDROID_OAUTH_STORE_UNAVAILABLE');
    const saved = JSON.parse(result) as Reservation;
    return saved.requestHash === input.requestHash ? { launch: saved.launch } : { conflict: true };
  }

  public async takeLaunch(
    code: string,
    tenantKey: string,
  ): Promise<AndroidOAuthLaunch | undefined> {
    const result = await this.redis.eval(
      `local encoded = redis.call('GET', KEYS[1])
       if not encoded then return false end
       local pending = cjson.decode(encoded)
       if pending.tenantKey ~= ARGV[1] then return false end
       redis.call('DEL', KEYS[1])
       return encoded`,
      1,
      key('launch', code),
      tenantKey,
    );
    return typeof result === 'string' ? (JSON.parse(result) as AndroidOAuthLaunch) : undefined;
  }

  public async putHandoff(code: string, handoff: AndroidOAuthHandoff): Promise<void> {
    const result = await this.redis.set(
      key('handoff', code),
      JSON.stringify({ handoff }),
      'EX',
      ANDROID_OAUTH_HANDOFF_TTL,
      'NX',
    );
    if (result !== 'OK') throw new Error('ANDROID_OAUTH_STORE_UNAVAILABLE');
  }

  public async claimHandoff(input: ClaimInput): Promise<ClaimResult> {
    const result = await this.redis.eval(
      `local encoded = redis.call('GET', KEYS[1])
       if not encoded then return 'missing' end
       local pending = cjson.decode(encoded)
       local handoff = pending.handoff
       if handoff.tenantKey ~= ARGV[1] or handoff.codeChallenge ~= ARGV[2]
         or handoff.clientState ~= ARGV[3] then return 'missing' end
       if pending.idempotencyKey and pending.idempotencyKey ~= ARGV[4] then return 'conflict' end
       pending.idempotencyKey = ARGV[4]
       redis.call('SET', KEYS[1], cjson.encode(pending), 'KEEPTTL')
       return cjson.encode(handoff)`,
      1,
      key('handoff', input.code),
      input.tenantKey,
      input.codeChallenge,
      input.clientState,
      input.idempotencyKey,
    );
    if (result === 'missing' || result === 'conflict') return { rejected: result };
    if (typeof result !== 'string') throw new Error('ANDROID_OAUTH_STORE_UNAVAILABLE');
    return { handoff: JSON.parse(result) as AndroidOAuthHandoff };
  }
}

export class MemoryAndroidOAuthStore implements AndroidOAuthStore {
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();
  public constructor(private readonly now: () => number = Date.now) {}
  private read<T>(name: string): T | undefined {
    const saved = this.values.get(name);
    if (!saved || saved.expiresAt <= this.now()) {
      this.values.delete(name);
      return undefined;
    }
    return saved.value as T;
  }
  public reserveStart(input: StartInput): Promise<StartResult> {
    const name = key('start', input.commandKey);
    let saved = this.read<Reservation>(name);
    if (!saved) {
      saved = { requestHash: input.requestHash, launch: input.launch };
      const expiresAt = this.now() + ANDROID_OAUTH_START_TTL * 1000;
      this.values.set(name, { value: saved, expiresAt });
      this.values.set(key('launch', input.launch.code), { value: input.launch, expiresAt });
    }
    return Promise.resolve(
      saved.requestHash === input.requestHash ? { launch: saved.launch } : { conflict: true },
    );
  }
  public takeLaunch(code: string, tenantKey: string): Promise<AndroidOAuthLaunch | undefined> {
    const name = key('launch', code);
    const launch = this.read<AndroidOAuthLaunch>(name);
    if (launch?.tenantKey !== tenantKey) return Promise.resolve(undefined);
    this.values.delete(name);
    return Promise.resolve(launch);
  }
  public putHandoff(code: string, handoff: AndroidOAuthHandoff): Promise<void> {
    const name = key('handoff', code);
    if (this.read(name)) return Promise.reject(new Error('ANDROID_OAUTH_STORE_UNAVAILABLE'));
    this.values.set(name, {
      value: { handoff },
      expiresAt: this.now() + ANDROID_OAUTH_HANDOFF_TTL * 1000,
    });
    return Promise.resolve();
  }
  public claimHandoff(input: ClaimInput): Promise<ClaimResult> {
    const name = key('handoff', input.code);
    const saved = this.read<HandoffRecord>(name);
    if (
      !saved ||
      saved.handoff.tenantKey !== input.tenantKey ||
      saved.handoff.codeChallenge !== input.codeChallenge ||
      saved.handoff.clientState !== input.clientState
    )
      return Promise.resolve({ rejected: 'missing' });
    if (saved.idempotencyKey && saved.idempotencyKey !== input.idempotencyKey)
      return Promise.resolve({ rejected: 'conflict' });
    const expiry = this.values.get(name);
    if (expiry)
      this.values.set(name, {
        ...expiry,
        value: { ...saved, idempotencyKey: input.idempotencyKey },
      });
    return Promise.resolve({ handoff: saved.handoff });
  }
}
