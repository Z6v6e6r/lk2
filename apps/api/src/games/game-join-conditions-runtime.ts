import type { AppConfig } from '@phub/config';
import type { Pool } from 'pg';
import { createOwnedHubSubscriptionReader } from '@phub/viva-adapter';
import { createGameJoinConditionsContextRepository } from '../../../../packages/database/src/game-join-conditions-context-repository.js';
import type { AuthService } from '../auth/auth-service.js';
import { createGameJoinConditionsOwner } from './game-join-conditions-owner.js';
import { createLk1GamePricePreviewRead } from './game-join-conditions.js';

type JoinReadConfig = Pick<
  AppConfig,
  | 'GAMES_READ_ENABLED'
  | 'VIVA_DIRECT_READ_ENABLED'
  | 'VIVA_OAUTH_ENABLED'
  | 'VIVA_MODE'
  | 'VIVA_AUTH_TENANT_KEY'
  | 'VIVA_END_USER_API_URL'
  | 'LEGACY_GAMES_PUBLIC_BASE_URL'
>;

function isTrustedEndpoint(value: string, expected: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href.replace(/\/$/, '') === expected
    );
  } catch {
    return false;
  }
}

/** Compose existing server reads; construction performs no token, DB or provider operation. */
export function createGameJoinConditionsRuntime(options: {
  readonly config: JoinReadConfig;
  readonly pool: Pool;
  readonly authService: Pick<AuthService, 'issueVivaAccessToken'>;
}) {
  const { config, pool, authService } = options;
  if (
    !config.GAMES_READ_ENABLED ||
    !config.VIVA_DIRECT_READ_ENABLED ||
    !config.VIVA_OAUTH_ENABLED ||
    !['sandbox', 'production'].includes(config.VIVA_MODE) ||
    config.VIVA_AUTH_TENANT_KEY !== 'iSkq6G' ||
    !isTrustedEndpoint(config.VIVA_END_USER_API_URL, 'https://api.vivacrm.ru/end-user/api') ||
    !isTrustedEndpoint(config.LEGACY_GAMES_PUBLIC_BASE_URL, 'https://padlhub.su')
  )
    return undefined;

  return createGameJoinConditionsOwner({
    contextRepository: createGameJoinConditionsContextRepository(pool, config.VIVA_AUTH_TENANT_KEY),
    getAccessToken: async (actor) => (await authService.issueVivaAccessToken(actor)).accessToken,
    readOwnedSubscription: createOwnedHubSubscriptionReader({
      apiBaseUrl: config.VIVA_END_USER_API_URL,
      providerTenantKey: config.VIVA_AUTH_TENANT_KEY,
    }),
    readPreview: createLk1GamePricePreviewRead(config.LEGACY_GAMES_PUBLIC_BASE_URL),
    providerMode: 'LIVE',
  });
}
