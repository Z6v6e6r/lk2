import { ApiClientError, PadlHubApiClient } from '@phub/api-sdk';
import type {
  AuthenticatedSession as ApiAuthenticatedSession,
  UserContext as ApiUserContext,
} from '@phub/api-sdk';
import { maskPhone } from '@phub/auth';

export interface NormalizedUser {
  readonly id: string;
  readonly displayName: string;
  readonly phoneMasked?: string;
}

export interface NormalizedTenant {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface UserContext {
  readonly user: NormalizedUser;
  readonly tenant: NormalizedTenant;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface AuthenticatedSession {
  readonly context: UserContext;
}

export interface PhoneChallenge {
  readonly challengeId: string;
  readonly maskedPhone: string;
  readonly expiresAt: string;
  readonly resendAt: string;
}

export interface AuthGateway {
  readonly restoreSession: () => Promise<AuthenticatedSession | null>;
  readonly requestCode: (phoneE164: string) => Promise<PhoneChallenge>;
  readonly verifyCode: (input: {
    readonly challengeId: string;
    readonly code: string;
  }) => Promise<AuthenticatedSession>;
  readonly logout: () => Promise<void>;
}

interface BrowserAuthGatewayOptions {
  readonly baseUrl: string;
  readonly tenantKey: string;
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly fetchImplementation?: typeof fetch;
}

function normalizeContext(payload: ApiUserContext, tenantKey: string): UserContext {
  return {
    user: {
      id: payload.userId,
      displayName: payload.displayName,
      phoneMasked: `•••• ${payload.phoneLast4}`,
    },
    tenant: {
      id: payload.tenantId,
      key: tenantKey,
      name: tenantKey === 'local-padel' ? 'ПаделХАБ' : tenantKey,
    },
    roles: payload.roles,
    permissions: payload.permissions,
  };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 401;
}

/**
 * Browser auth talks only to the public PadlHub API. The refresh credential is
 * an HttpOnly cookie; only the short-lived PadlHub access token reaches JS and
 * it remains in memory for the lifetime of this gateway instance.
 */
export function createBrowserAuthGateway(options: BrowserAuthGatewayOptions): AuthGateway {
  const clientOptions = {
    baseUrl: options.baseUrl.replace(/\/$/, ''),
    tenantKey: options.tenantKey,
    platform: 'web' as const,
    appVersion: options.appVersion,
    ...(options.appBuild ? { appBuild: options.appBuild } : {}),
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  };
  const client = new PadlHubApiClient(clientOptions);

  function normalizeSession(session: ApiAuthenticatedSession): AuthenticatedSession {
    return { context: normalizeContext(session.context, options.tenantKey) };
  }

  async function restore(): Promise<AuthenticatedSession | null> {
    try {
      return normalizeSession(await client.refreshSession());
    } catch (error) {
      client.clearAccessToken();
      if (isUnauthorized(error)) return null;
      throw error;
    }
  }

  // React StrictMode may subscribe twice during development. Coalescing keeps a
  // rotating refresh cookie from being exchanged twice at startup.
  let restorePromise: Promise<AuthenticatedSession | null> | undefined;

  return {
    restoreSession() {
      restorePromise ??= restore();
      return restorePromise;
    },

    async requestCode(phoneE164) {
      const challenge = await client.createAuthChallenge({ method: 'phone_otp', phone: phoneE164 });
      return {
        challengeId: challenge.challengeId,
        maskedPhone: maskPhone(phoneE164),
        expiresAt: challenge.expiresAt,
        resendAt: new Date(Date.now() + challenge.resendAfterSeconds * 1_000).toISOString(),
      };
    },

    async verifyCode(input) {
      const session = await client.verifyAuthChallenge(input.challengeId, { code: input.code });
      return normalizeSession(session);
    },

    async logout() {
      await client.revokeSession();
    },
  };
}
