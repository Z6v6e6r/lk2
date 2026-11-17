import type { AppConfig } from '@phub/config';
import type { Pool } from 'pg';
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
  /**
   * ADR 0028: LK1-attested ownership proof. Viva rejects End User reads from lk2 egress (403),
   * so production composes this reader instead of the server-side Viva reader.
   */
  readonly ownedSubscriptionReader?: Parameters<
    typeof createGameJoinConditionsOwner
  >[0]['readOwnedSubscription'];
}) {
  const { config, pool, authService } = options;
  // ADR 0028/0023: PadlHub egress never reads Viva End User data; without the LK1 owner reader
  // join conditions stay unavailable instead of falling back to the server Viva reader.
  if (!options.ownedSubscriptionReader) return undefined;
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
    getAccessToken: async (actor) => {
      const issued = await authService.issueVivaAccessToken(actor);
      return { accessToken: issued.accessToken, expiresAt: issued.expiresAt };
    },
    readOwnedSubscription: options.ownedSubscriptionReader,
    readPreview: createLk1GamePricePreviewRead(config.LEGACY_GAMES_PUBLIC_BASE_URL),
    providerMode: 'LIVE',
  });
}
