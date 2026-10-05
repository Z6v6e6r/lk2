import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Fixed, versioned parameters: database input cannot select a cheaper or unbounded KDF.
const PREFIX = 'phub-scrypt-v1$131072$8$1$';
const HASH_PATTERN = /^phub-scrypt-v1\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
let activeDerivations = 0;
let activeLogins = 0;

export class PasswordCapacityError extends Error {
  constructor() {
    super('AUTH_PASSWORD_CAPACITY_EXCEEDED');
  }
}

/** Bound the entire login operation before any tenant/credential DB lookup, without a queue. */
export function reservePasswordLoginSlot(): () => void {
  if (activeLogins >= 2) throw new PasswordCapacityError();
  activeLogins += 1;
  let released = false;
  return () => {
    if (!released) {
      activeLogins -= 1;
      released = true;
    }
  };
}

export function normalizeLoginEmail(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length > 254 || !/^[\x21-\x7e]+$/.test(trimmed)) return undefined;
  const email = trimmed.toLowerCase();
  const parts = email.split('@');
  const [local, domain] = parts;
  if (parts.length !== 2 || !local || !domain || local.length > 64) return undefined;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return undefined;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return undefined;
  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return undefined;
  return email;
}

export function validLocalPassword(value: string): boolean {
  // Preserve every character, including spaces and Unicode; no trim/normalization/truncation.
  const length = Array.from(value).length;
  return (
    length >= 15 &&
    length <= 128 &&
    Buffer.byteLength(value, 'utf8') <= 512 &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  );
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // No in-memory queue: two workers cap KDF memory at ~256 MiB per API process.
  if (activeDerivations >= 2) throw new PasswordCapacityError();
  activeDerivations += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (error, key) => {
          if (error) reject(new Error('AUTH_PASSWORD_DERIVATION_FAILED'));
          else resolve(key);
        },
      );
    });
  } finally {
    activeDerivations -= 1;
  }
}

/** For the future trusted enrollment/reset writer only; never proof of email ownership. */
export async function hashLocalPassword(password: string): Promise<string> {
  if (!validLocalPassword(password)) throw new Error('AUTH_PASSWORD_POLICY_INVALID');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyLocalPassword(password: string, encoded?: string): Promise<boolean> {
  if (!validLocalPassword(password)) return false;
  const match = encoded?.match(HASH_PATTERN);
  const salt = match ? Buffer.from(match[1]!, 'base64url') : Buffer.alloc(16);
  const expected = match ? Buffer.from(match[2]!, 'base64url') : Buffer.alloc(64);
  const canonical =
    !!match &&
    salt.toString('base64url') === match[1] &&
    expected.toString('base64url') === match[2];
  // Unknown account, disabled method and malformed hashes still perform the same bounded KDF.
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && canonical;
}
