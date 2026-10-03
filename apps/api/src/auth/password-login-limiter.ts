import { createHmac } from 'node:crypto';

export interface PasswordLoginLimiter {
  allow(tenantId: string, emailKey: string, ip: string): Promise<boolean>;
}
interface PasswordAdmissionRedis {
  eval(script: string, numberOfKeys: number, ...keys: string[]): Promise<unknown>;
}

// One atomic admission, two independent buckets. Denials do not indefinitely extend the window.
export const PASSWORD_ADMISSION_SCRIPT = `
local account = tonumber(redis.call('GET', KEYS[1]) or '0')
local address = tonumber(redis.call('GET', KEYS[2]) or '0')
local total = tonumber(redis.call('GET', KEYS[3]) or '0')
if account >= 5 or address >= 20 or total >= 120 then return 0 end
if redis.call('INCR', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], 60) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], 60) end
if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], 60) end
return 1`;

export class RedisPasswordLoginLimiter implements PasswordLoginLimiter {
  constructor(
    private readonly redis: PasswordAdmissionRedis,
    private readonly secret: string,
    private readonly namespace = 'phub:auth:password:v1',
  ) {}

  async allow(tenantId: string, emailKey: string, ip: string): Promise<boolean> {
    const key = (purpose: string, value: string) =>
      `${this.namespace}:${purpose}:` +
      createHmac('sha256', this.secret)
        .update(JSON.stringify([tenantId, value]))
        .digest('hex');
    const globalKey = `${this.namespace}:global`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([
        this.redis.eval(
          PASSWORD_ADMISSION_SCRIPT,
          3,
          key('account', emailKey),
          key('ip', ip),
          globalKey,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('AUTH_PASSWORD_ADMISSION_UNAVAILABLE')), 1500);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result !== 0 && result !== 1) throw new Error('AUTH_PASSWORD_ADMISSION_UNAVAILABLE');
    return result === 1;
  }
}
