import type { AppConfig } from '@phub/config';
import type { StoredClientRoutingPlan } from '@phub/database';
import {
  DIRECT_VIVA_CONTRACT_READY_OPERATIONS,
  DIRECT_VIVA_READ_OPERATIONS,
  type ClientPlatform,
  type ClientRoutingPlan,
} from '@phub/domain';

function supportsDirectViva(platform: ClientPlatform): boolean {
  return platform === 'web' || platform === 'ios' || platform === 'android';
}

export function canUseDirectViva(input: {
  readonly config: AppConfig;
  readonly stored: StoredClientRoutingPlan;
  readonly platform: ClientPlatform;
}): boolean {
  return Boolean(
    input.config.VIVA_DIRECT_READ_ENABLED &&
    input.stored.mode === 'MIXED_END_USER_READS' &&
    input.stored.delegationReady &&
    input.stored.providerTenantKey &&
    DIRECT_VIVA_CONTRACT_READY_OPERATIONS.some((operation) =>
      input.stored.directOperations.includes(operation),
    ) &&
    supportsDirectViva(input.platform),
  );
}

export function buildClientRoutingPlan(input: {
  readonly config: AppConfig;
  readonly stored: StoredClientRoutingPlan;
  readonly platform: ClientPlatform;
  readonly now?: Date;
}): ClientRoutingPlan {
  const issuedAt = input.now ?? new Date();
  const directEnabled = canUseDirectViva(input);
  const directOperations = new Set(
    input.stored.directOperations.filter((operation) =>
      DIRECT_VIVA_CONTRACT_READY_OPERATIONS.includes(
        operation as (typeof DIRECT_VIVA_CONTRACT_READY_OPERATIONS)[number],
      ),
    ),
  );
  const hasDirectOperations =
    directEnabled &&
    DIRECT_VIVA_READ_OPERATIONS.some((operation) => directOperations.has(operation));
  return {
    revision: input.stored.revision,
    mode: hasDirectOperations ? 'MIXED_END_USER_READS' : 'PADLHUB_ONLY',
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + input.stored.validForSeconds * 1_000).toISOString(),
    operations: DIRECT_VIVA_READ_OPERATIONS.map((operation) => {
      const direct = hasDirectOperations && directOperations.has(operation);
      return {
        operation,
        transport: direct ? 'DIRECT_VIVA' : 'PADLHUB_API',
        fallback: direct ? 'UNAVAILABLE' : 'PADLHUB_API',
      };
    }),
    ...(hasDirectOperations && input.stored.providerTenantKey
      ? {
          directViva: {
            apiBaseUrl: input.config.VIVA_END_USER_API_URL,
            providerTenantKey: input.stored.providerTenantKey,
            accessTokenPath: '/auth/viva/access' as const,
            allowedRequestHeaders: ['Authorization'] as const,
          },
        }
      : {}),
  };
}
