export const DOMAIN_OWNERSHIP_MODES = [
  'VIVA_PRIMARY',
  'SHADOW_COMPARE',
  'LOCAL_PRIMARY',
  'LOCAL_ONLY',
] as const;

export type DomainOwnershipMode = (typeof DOMAIN_OWNERSHIP_MODES)[number];

export const SOURCE_STRATEGIES = [
  'LOCAL',
  'SERVER_VIVA',
  'DIRECT_VIVA',
  'STALE_LOCAL',
  'UNAVAILABLE',
] as const;

export type SourceStrategy = (typeof SOURCE_STRATEGIES)[number];

export type ClientPlatform = 'web' | 'ios' | 'android' | 'cup-admin' | 'internal';

export type DomainName =
  | 'identity'
  | 'profile'
  | 'catalog'
  | 'schedule'
  | 'booking'
  | 'commerce'
  | 'games'
  | 'tournaments'
  | 'community'
  | 'messaging'
  | 'notifications';

export interface SourcePolicy {
  readonly operation: string;
  readonly domain: DomainName;
  readonly preferredSource: SourceStrategy;
  readonly fallback: readonly SourceStrategy[];
  readonly criticalCommand: boolean;
  readonly directVivaAllowed: boolean;
}

export interface SourceRoutingContext {
  readonly tenantId: string;
  readonly platform: ClientPlatform;
  readonly localState: 'fresh' | 'stale' | 'missing';
  readonly serverVivaAvailable: boolean;
  readonly serverVivaRateLimitRemaining: number;
  readonly directVivaFeatureEnabled: boolean;
  readonly directVivaDelegationSupported: boolean;
  readonly clientSupportsDirectViva: boolean;
}

export interface SourceDecision {
  readonly strategy: SourceStrategy;
  readonly operation: string;
  readonly reason: 'LOCAL_FRESH' | 'POLICY_FALLBACK' | 'CRITICAL_COMMAND' | 'NO_SAFE_SOURCE';
}

function canUseStrategy(
  strategy: SourceStrategy,
  policy: SourcePolicy,
  context: SourceRoutingContext,
): boolean {
  switch (strategy) {
    case 'LOCAL':
      return context.localState === 'fresh';
    case 'STALE_LOCAL':
      return context.localState === 'stale';
    case 'SERVER_VIVA':
      return context.serverVivaAvailable && context.serverVivaRateLimitRemaining > 0;
    case 'DIRECT_VIVA':
      return (
        !policy.criticalCommand &&
        policy.directVivaAllowed &&
        context.directVivaFeatureEnabled &&
        context.directVivaDelegationSupported &&
        context.clientSupportsDirectViva &&
        context.platform !== 'web' &&
        context.platform !== 'cup-admin' &&
        context.platform !== 'internal'
      );
    case 'UNAVAILABLE':
      return true;
  }
}

export class SourceRouter {
  public decide(policy: SourcePolicy, context: SourceRoutingContext): SourceDecision {
    if (policy.criticalCommand) {
      if (canUseStrategy('SERVER_VIVA', policy, context)) {
        return {
          strategy: 'SERVER_VIVA',
          operation: policy.operation,
          reason: 'CRITICAL_COMMAND',
        };
      }

      if (policy.preferredSource === 'LOCAL' && context.localState === 'fresh') {
        return {
          strategy: 'LOCAL',
          operation: policy.operation,
          reason: 'CRITICAL_COMMAND',
        };
      }

      return {
        strategy: 'UNAVAILABLE',
        operation: policy.operation,
        reason: 'NO_SAFE_SOURCE',
      };
    }

    if (canUseStrategy(policy.preferredSource, policy, context)) {
      return {
        strategy: policy.preferredSource,
        operation: policy.operation,
        reason: policy.preferredSource === 'LOCAL' ? 'LOCAL_FRESH' : 'POLICY_FALLBACK',
      };
    }

    for (const strategy of policy.fallback) {
      if (canUseStrategy(strategy, policy, context)) {
        return { strategy, operation: policy.operation, reason: 'POLICY_FALLBACK' };
      }
    }

    return {
      strategy: 'UNAVAILABLE',
      operation: policy.operation,
      reason: 'NO_SAFE_SOURCE',
    };
  }
}

export interface SourceMetadata {
  readonly source: 'local' | 'viva' | 'viva_via_client';
  readonly sourceVersion: string;
  readonly lastSyncedAt: string;
  readonly validUntil: string;
  readonly syncStatus: 'pending' | 'synced' | 'failed';
  readonly trustLevel: 'verified' | 'unverified';
}

export interface OutboxEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly payload: TPayload;
}

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly details?: readonly { readonly field?: string; readonly issue: string }[];
}

export function isValidIdempotencyKey(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}
