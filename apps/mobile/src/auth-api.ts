import { Capacitor } from '@capacitor/core';
import { PadlHubApiClient } from '@phub/api-sdk';

export type OAuthProvider = 'vkid' | 'yandex';

export interface LegalAcceptance {
  readonly publicOfferAccepted: true;
  readonly personalDataPolicyAccepted: true;
}

export interface MobileAuthApi {
  createAuthChallenge(input: {
    readonly method: 'phone_otp';
    readonly phone: string;
  }): Promise<{ readonly challengeId: string }>;
  verifyAuthChallenge(
    challengeId: string,
    input: {
      readonly code: string;
      readonly acceptance: LegalAcceptance;
    },
  ): Promise<{ readonly user: { readonly displayName: string } }>;
  createVivaOAuthAuthorization(input: {
    readonly provider: OAuthProvider;
    readonly acceptance: LegalAcceptance;
  }): Promise<{ readonly redirectUrl: string }>;
}

function currentPlatform(): 'web' | 'ios' | 'android' {
  const platform = Capacitor.getPlatform();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

export function createMobileAuthApi(): MobileAuthApi {
  const baseUrl = (import.meta.env.VITE_PHUB_API_BASE_URL ?? window.location.origin).replace(
    /\/$/,
    '',
  );
  const client = new PadlHubApiClient({
    baseUrl,
    tenantKey: import.meta.env.VITE_PHUB_TENANT_KEY ?? 'local-padel',
    platform: currentPlatform(),
    appVersion: import.meta.env.VITE_APP_VERSION ?? 'development',
  });

  return {
    createAuthChallenge: (input) => client.createAuthChallenge(input),
    verifyAuthChallenge: (challengeId, input) => client.verifyAuthChallenge(challengeId, input),
    createVivaOAuthAuthorization: (input) => client.createVivaOAuthAuthorization(input),
  };
}
