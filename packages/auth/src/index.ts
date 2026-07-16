export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
}

export interface WebAccessTokenStore {
  read(): string | undefined;
  write(accessToken: string): void;
  clear(): void;
}

export class MemoryAccessTokenStore implements WebAccessTokenStore {
  private accessToken: string | undefined;

  public read(): string | undefined {
    return this.accessToken;
  }

  public write(accessToken: string): void {
    this.accessToken = accessToken;
  }

  public clear(): void {
    this.accessToken = undefined;
  }
}

export interface SecureTokenStore {
  read(): Promise<TokenPair | undefined>;
  write(tokens: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryTokenStore implements SecureTokenStore {
  private tokens: TokenPair | undefined;

  public read(): Promise<TokenPair | undefined> {
    return Promise.resolve(this.tokens);
  }

  public write(tokens: TokenPair): Promise<void> {
    this.tokens = tokens;
    return Promise.resolve();
  }

  public clear(): Promise<void> {
    this.tokens = undefined;
    return Promise.resolve();
  }
}

export const MOBILE_TOKEN_STORAGE_REQUIREMENT = 'KEYCHAIN_OR_KEYSTORE' as const;

export type IdentityProviderKey = 'VIVA' | 'LOCAL';

export interface VerifiedExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
  /** Stable provider-owned person identifier used only inside the integration boundary. */
  readonly providerUserId?: string;
  readonly phoneE164?: string;
  readonly displayName: string;
}

export interface IdentityProviderPort {
  readonly key: IdentityProviderKey;
  requestPhoneCode(input: {
    readonly phoneE164: string;
    readonly providerTenantKey: string;
    readonly correlationId: string;
  }): Promise<void>;
  verifyPhoneCode(input: {
    readonly phoneE164: string;
    readonly code: string;
    readonly providerTenantKey: string;
    readonly correlationId: string;
  }): Promise<VerifiedExternalIdentity>;
}

export type VivaOAuthProvider = 'vkid' | 'yandex';

export interface VivaOAuthProviderPort {
  createAuthorizationUrl(input: {
    readonly provider: VivaOAuthProvider;
    readonly tenantKey: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
  }): string;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly providerTenantKey: string;
    readonly redirectUri: string;
    readonly correlationId: string;
  }): Promise<{
    readonly identity: VerifiedExternalIdentity;
    readonly accessToken: string;
    readonly accessExpiresIn?: number;
    readonly refreshToken: string;
    readonly refreshExpiresIn?: number;
  }>;
  refreshUserDelegation(input: {
    readonly refreshToken: string;
    readonly correlationId: string;
  }): Promise<{
    readonly accessToken: string;
    readonly accessExpiresIn?: number;
    readonly refreshToken?: string;
    readonly refreshExpiresIn?: number;
  }>;
}

export type IdentityProviderErrorCode =
  'AUTH_CODE_INVALID' | 'AUTH_RATE_LIMITED' | 'AUTH_PROVIDER_UNAVAILABLE';

export class IdentityProviderError extends Error {
  public constructor(public readonly code: IdentityProviderErrorCode) {
    super(code);
    this.name = 'IdentityProviderError';
  }
}

export function normalizePhoneE164(value: string): string | undefined {
  const digits = value.replace(/\D/g, '');
  const normalized =
    digits.length === 10
      ? `7${digits}`
      : digits.length === 11 && digits.startsWith('8')
        ? `7${digits.slice(1)}`
        : digits;
  return normalized.length === 11 && normalized.startsWith('7') ? `+${normalized}` : undefined;
}

export function maskPhone(phoneE164: string): string {
  return `${phoneE164.slice(0, 2)} *** ***-**-${phoneE164.slice(-2)}`;
}

export function assertNoExternalIdentityToken(tokens: TokenPair & { vivaToken?: never }): void {
  if ('vivaToken' in tokens) {
    throw new Error('External identity tokens must never be stored by PadlHub clients');
  }
}
