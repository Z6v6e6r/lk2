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

export const CLIENT_ROUTING_MODES = ['PADLHUB_ONLY', 'MIXED_END_USER_READS'] as const;
export type ClientRoutingMode = (typeof CLIENT_ROUTING_MODES)[number];

export const DIRECT_VIVA_READ_OPERATIONS = [
  'profile.read',
  'bookings.read',
  'bookings.details.read',
  'subscriptions.read',
  'schedule.read',
] as const;
export type DirectVivaReadOperation = (typeof DIRECT_VIVA_READ_OPERATIONS)[number];

/**
 * Direct transport is enabled only after an operation can return PadlHub-owned
 * identifiers without exposing provider identifiers to a client. Viva profile
 * is currently the only end-user contract that meets that boundary: its
 * provider id is discarded and the authenticated PadlHub user id is retained.
 */
export const DIRECT_VIVA_CONTRACT_READY_OPERATIONS = [
  'profile.read',
] as const satisfies readonly DirectVivaReadOperation[];

export type ClientRoutingTransport = 'PADLHUB_API' | 'DIRECT_VIVA';
export type ClientRoutingFallback = 'PADLHUB_API' | 'UNAVAILABLE';

export interface ClientRoutingOperationPlan {
  readonly operation: DirectVivaReadOperation;
  readonly transport: ClientRoutingTransport;
  readonly fallback: ClientRoutingFallback;
}

export interface ClientRoutingPlan {
  readonly revision: string;
  readonly mode: ClientRoutingMode;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly operations: readonly ClientRoutingOperationPlan[];
  readonly directViva?: {
    readonly apiBaseUrl: string;
    readonly providerTenantKey: string;
    readonly accessTokenPath: '/auth/viva/access';
    readonly allowedRequestHeaders: readonly ['Authorization'];
  };
}

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
  | 'notifications'
  | 'moderation';

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

export const PROFILE_ACTION_POLICIES = ['AUTHORIZED', 'NOBODY'] as const;
export type ProfileActionPolicy = (typeof PROFILE_ACTION_POLICIES)[number];

export interface ProfilePrivacySettings {
  readonly contactPolicy: ProfileActionPolicy;
  readonly chatPolicy: ProfileActionPolicy;
  readonly version: number;
  readonly updatedAt: string | null;
}

export const DEFAULT_PROFILE_PRIVACY_SETTINGS: ProfilePrivacySettings = {
  contactPolicy: 'AUTHORIZED',
  chatPolicy: 'AUTHORIZED',
  version: 0,
  updatedAt: null,
};

export const PROFILE_PRIVACY_CHANGED_EVENT = 'profile.privacy.changed.v1' as const;

export const BOOKING_PREFERENCE_WEEKDAYS = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
] as const;
export type BookingPreferenceWeekday = (typeof BOOKING_PREFERENCE_WEEKDAYS)[number];

export interface BookingPreferenceTimeWindow {
  readonly weekday: BookingPreferenceWeekday;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface BookingPreferences {
  readonly favoriteStationIds: readonly string[];
  readonly preferredTimeWindows: readonly BookingPreferenceTimeWindow[];
  readonly useHistory: boolean;
  readonly version: number;
  readonly updatedAt: string | null;
}

export const DEFAULT_BOOKING_PREFERENCES: BookingPreferences = {
  favoriteStationIds: [],
  preferredTimeWindows: [],
  useHistory: true,
  version: 0,
  updatedAt: null,
};

export const BOOKING_PREFERENCES_CHANGED_EVENT = 'profile.booking_preferences.changed.v1' as const;

export function isValidIdempotencyKey(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}
