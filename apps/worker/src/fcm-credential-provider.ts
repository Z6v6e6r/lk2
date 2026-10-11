import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { FcmAccessTokenProvider } from './fcm-adapter.js';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const REFRESH_SKEW_MS = 60_000;

interface ServiceAccount {
  readonly type: 'service_account';
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: string;
}

interface FileSystem {
  lstat(
    path: string,
  ): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

function base64Url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

async function boundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('FCM_TOKEN_TIMEOUT');
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_TOKEN_RESPONSE_BYTES)
    throw new Error('FCM_TOKEN_RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort(new Error('FCM_TOKEN_TIMEOUT'));
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error('FCM_TOKEN_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class FcmServiceAccountTokenProvider implements FcmAccessTokenProvider {
  private cached: { readonly value: string; readonly expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;

  public static async create(input: {
    readonly credentialFile: string;
    readonly projectId: string;
    readonly fetchImplementation?: typeof fetch;
    readonly now?: () => number;
    readonly filesystem?: FileSystem;
    readonly timeoutMs?: number;
  }): Promise<FcmServiceAccountTokenProvider> {
    const filesystem = input.filesystem ?? { lstat, realpath, readFile };
    if (!isAbsolute(input.credentialFile))
      throw new Error('FCM_CREDENTIAL_FILE_ABSOLUTE_PATH_REQUIRED');
    const stat = await filesystem.lstat(input.credentialFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('FCM_CREDENTIAL_FILE_PERMISSIONS_INVALID');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('FCM_CREDENTIAL_FILE_OWNER_INVALID');
    }
    const canonical = await filesystem.realpath(input.credentialFile);
    if (resolve(canonical) !== resolve(input.credentialFile)) {
      throw new Error('FCM_CREDENTIAL_FILE_SYMLINK_NOT_ALLOWED');
    }
    const raw = await filesystem.readFile(canonical, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_CREDENTIAL_BYTES)
      throw new Error('FCM_CREDENTIAL_FILE_TOO_LARGE');
    let account: ServiceAccount;
    try {
      account = JSON.parse(raw) as ServiceAccount;
    } catch {
      throw new Error('FCM_CREDENTIAL_FILE_INVALID');
    }
    if (
      account.type !== 'service_account' ||
      account.project_id !== input.projectId ||
      account.token_uri !== TOKEN_URI ||
      typeof account.client_email !== 'string' ||
      typeof account.private_key !== 'string'
    )
      throw new Error('FCM_CREDENTIAL_FILE_INVALID');
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(account.private_key);
    } catch {
      throw new Error('FCM_CREDENTIAL_PRIVATE_KEY_INVALID');
    }
    return new FcmServiceAccountTokenProvider({
      account,
      privateKey,
      fetchImplementation: input.fetchImplementation ?? fetch,
      now: input.now ?? Date.now,
      timeoutMs: input.timeoutMs ?? 5_000,
    });
  }

  private constructor(
    private readonly options: {
      readonly account: ServiceAccount;
      readonly privateKey: KeyObject;
      readonly fetchImplementation: typeof fetch;
      readonly now: () => number;
      readonly timeoutMs: number;
    },
  ) {}

  public getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - REFRESH_SKEW_MS > this.options.now())
      return Promise.resolve(this.cached.value);
    this.refreshing ??= this.refresh();
    return this.refreshing;
  }
  public invalidateAccessToken(rejectedToken: string): void {
    if (this.cached?.value === rejectedToken) this.cached = undefined;
  }

  private async refresh(): Promise<string> {
    try {
      const nowSeconds = Math.floor(this.options.now() / 1_000);
      const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const payload = base64Url(
        JSON.stringify({
          iss: this.options.account.client_email,
          scope: SCOPE,
          aud: TOKEN_URI,
          iat: nowSeconds,
          exp: nowSeconds + 3_600,
        }),
      );
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      signer.end();
      const assertion = `${header}.${payload}.${signer.sign(this.options.privateKey).toString('base64url')}`;
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('FCM_TOKEN_TIMEOUT'));
        }, this.options.timeoutMs);
      });
      try {
        const obtain = async (): Promise<string> => {
          const response = await this.options.fetchImplementation(TOKEN_URI, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
              assertion,
            }).toString(),
          });
          const text = await boundedText(response, controller.signal);
          if (controller.signal.aborted) throw new Error('FCM_TOKEN_TIMEOUT');
          if (!response.ok) throw new Error('FCM_TOKEN_PROVIDER_REJECTED');
          const parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
          const expiresIn = parsed.expires_in;
          if (
            typeof parsed.access_token !== 'string' ||
            typeof expiresIn !== 'number' ||
            !Number.isInteger(expiresIn) ||
            expiresIn < 120 ||
            expiresIn > 3_600
          )
            throw new Error('FCM_TOKEN_RESPONSE_INVALID');
          this.cached = {
            value: parsed.access_token,
            expiresAt: this.options.now() + expiresIn * 1_000,
          };
          return parsed.access_token;
        };
        return await Promise.race([obtain(), expired]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      this.refreshing = undefined;
    }
  }
}
