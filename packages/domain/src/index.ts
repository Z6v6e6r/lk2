export const DOMAIN_OWNERSHIP_MODES = [
  'VIVA_PRIMARY',
  'SHADOW_COMPARE',
  'LOCAL_PRIMARY',
  'LOCAL_ONLY',
] as const;

export * from './participation-eligibility.js';
export * from './level-assessment.js';

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
  'bookings.history.read',
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
    readonly allowedMediaHosts?: readonly string[];
    /** Server-owned capability: the client hands the provider profile phone back only when asked. */
    readonly providerPhoneSync?: boolean;
  };
}

export type ClientPlatform = 'web' | 'ios' | 'android' | 'cup-admin' | 'internal';

const PADLHUB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stable client-facing profile-photo URL. Temporary S3 signatures are created only inside the
 * media delivery boundary and must never be persisted in profiles or read projections.
 */
export function profilePhotoDeliveryUrl(tenantId: string, deliveryId: string): string {
  if (!PADLHUB_UUID_PATTERN.test(tenantId) || !PADLHUB_UUID_PATTERN.test(deliveryId)) {
    throw new Error('PROFILE_PHOTO_DELIVERY_ID_INVALID');
  }
  return `/public/api/v1/media/profile-photos/${tenantId}/${deliveryId}`;
}

export const PROFILE_PHOTO_DELIVERY_PATH_PATTERN =
  /^\/public\/api\/v1\/media\/profile-photos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Stable client-facing community-logo URL backed by the current private WebP object. */
export function communityLogoDeliveryUrl(tenantId: string, communityId: string): string {
  if (!PADLHUB_UUID_PATTERN.test(tenantId) || !PADLHUB_UUID_PATTERN.test(communityId)) {
    throw new Error('COMMUNITY_LOGO_DELIVERY_ID_INVALID');
  }
  return `/public/api/v1/media/community-logos/${tenantId}/${communityId}`;
}

export const COMMUNITY_LOGO_DELIVERY_PATH_PATTERN =
  /^\/public\/api\/v1\/media\/community-logos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  'ANY',
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
  readonly recommendFriends: boolean;
  readonly recommendationDisplay: 'CARDS' | 'ROWS';
  readonly version: number;
  readonly updatedAt: string | null;
}

export const DEFAULT_BOOKING_PREFERENCES: BookingPreferences = {
  favoriteStationIds: [],
  preferredTimeWindows: [{ weekday: 'ANY', startsAt: '09:00', endsAt: '22:00' }],
  useHistory: true,
  recommendFriends: true,
  recommendationDisplay: 'CARDS',
  version: 0,
  updatedAt: null,
};

export const BOOKING_PREFERENCES_CHANGED_EVENT = 'profile.booking_preferences.changed.v1' as const;

export function isValidIdempotencyKey(value: string): boolean {
  return value.length >= 16 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

export const SUPPORT_TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_USER',
  'RESOLVED',
  'CLOSED',
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];
export const SUPPORT_TICKET_CATEGORIES = [
  'TECHNICAL',
  'ACCOUNT',
  'BOOKING',
  'BILLING',
  'OTHER',
] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];
export const SUPPORT_TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];

/**
 * Policy/usage binding refs for one commercial CREATE/JOIN operation (B2).
 *
 * LK2 never stores entitlement, counters or a usage ledger. These opaque refs name a policy
 * version and an owner-issued reservation; their shape alone proves neither authorization nor
 * consumption. Completion still requires compatible canonical-owner evidence.
 *
 * The adapter and persistence boundary share these strict parsers so malformed stored refs
 * cannot silently become an unbound legacy operation.
 */

const policyDigestPattern = /^sha256:[a-f0-9]{64}$/;
const usageRefPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CommercialBindingRefErrorCode =
  | 'COMMERCIAL_POLICY_REF_INVALID'
  | 'COMMERCIAL_USAGE_REF_INVALID'
  | 'COMMERCIAL_BINDING_REF_INVALID';

export class CommercialBindingRefError extends Error {
  public constructor(public readonly code: CommercialBindingRefErrorCode) {
    super(code);
    this.name = 'CommercialBindingRefError';
  }
}

/** Published policy version + digest that authorised one decision. */
export interface CommercialPolicyRef {
  readonly policyVersion: number;
  readonly policyDigest: string;
}

/** Opaque LK1 usage reservation reference; LK2 only names it, it never owns the counter. */
export interface CommercialUsageRef {
  readonly usageRef: string;
  readonly reservationUnits?: number;
}

/** Everything an operation binds: the policy decision and, when issued, its usage reservation. */
export interface CommercialBindingRefs {
  readonly policyRef: CommercialPolicyRef;
  readonly decisionId?: string;
  readonly usageRef?: CommercialUsageRef;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(row).sort().join(',') === [...expected].sort().join(',');
}

function usageRefKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.includes('usageRef') &&
    keys.length <= 2 &&
    keys.every((key) => key === 'usageRef' || key === 'reservationUnits')
  );
}

function invalid(code: CommercialBindingRefErrorCode): never {
  throw new CommercialBindingRefError(code);
}

/** Strict parser for the decision-level policy ref. Extra keys are a contract violation. */
export function parseCommercialPolicyRef(value: unknown): CommercialPolicyRef {
  if (!record(value) || !exactKeys(value, ['policyVersion', 'policyDigest']))
    invalid('COMMERCIAL_POLICY_REF_INVALID');
  if (
    typeof value.policyVersion !== 'number' ||
    !Number.isSafeInteger(value.policyVersion) ||
    value.policyVersion < 1 ||
    typeof value.policyDigest !== 'string' ||
    !policyDigestPattern.test(value.policyDigest)
  )
    invalid('COMMERCIAL_POLICY_REF_INVALID');
  return { policyVersion: value.policyVersion, policyDigest: value.policyDigest };
}

/** Strict parser for the opaque usage reservation ref. `reservationUnits` is optional and bounded. */
export function parseCommercialUsageRef(value: unknown): CommercialUsageRef {
  if (!record(value) || !usageRefKeys(value)) invalid('COMMERCIAL_USAGE_REF_INVALID');
  if (typeof value.usageRef !== 'string' || !usageRefPattern.test(value.usageRef))
    invalid('COMMERCIAL_USAGE_REF_INVALID');
  const reservationUnits = value.reservationUnits;
  if (
    reservationUnits !== undefined &&
    (typeof reservationUnits !== 'number' ||
      !Number.isSafeInteger(reservationUnits) ||
      reservationUnits < 1)
  )
    invalid('COMMERCIAL_USAGE_REF_INVALID');
  return {
    usageRef: value.usageRef,
    ...(reservationUnits === undefined ? {} : { reservationUnits }),
  };
}

/** Strict parser for the full binding set: policy ref is mandatory, usage decision is optional. */
export function parseCommercialBindingRefs(value: unknown): CommercialBindingRefs {
  if (!record(value)) invalid('COMMERCIAL_BINDING_REF_INVALID');
  const allowed = new Set(['policyRef', 'decisionId', 'usageRef']);
  if (
    !Object.prototype.hasOwnProperty.call(value, 'policyRef') ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    invalid('COMMERCIAL_BINDING_REF_INVALID');
  const policyRef = parseCommercialPolicyRef(value.policyRef);
  const decisionId = value.decisionId;
  if (decisionId !== undefined && (typeof decisionId !== 'string' || !uuidPattern.test(decisionId)))
    invalid('COMMERCIAL_BINDING_REF_INVALID');
  const usageRef =
    value.usageRef === undefined ? undefined : parseCommercialUsageRef(value.usageRef);
  return {
    policyRef,
    ...(decisionId === undefined ? {} : { decisionId }),
    ...(usageRef === undefined ? {} : { usageRef }),
  };
}

/** Field-for-field equality used to compare a decision binding with an owner receipt echo. */
export function commercialPolicyRefsEqual(
  left: CommercialPolicyRef,
  right: CommercialPolicyRef,
): boolean {
  return left.policyVersion === right.policyVersion && left.policyDigest === right.policyDigest;
}

export function commercialUsageRefsEqual(
  left: CommercialUsageRef,
  right: CommercialUsageRef,
): boolean {
  return left.usageRef === right.usageRef && left.reservationUnits === right.reservationUnits;
}

export function commercialBindingRefsEqual(
  left: CommercialBindingRefs,
  right: CommercialBindingRefs,
): boolean {
  return (
    commercialPolicyRefsEqual(left.policyRef, right.policyRef) &&
    left.decisionId === right.decisionId &&
    (left.usageRef === undefined
      ? right.usageRef === undefined
      : right.usageRef !== undefined && commercialUsageRefsEqual(left.usageRef, right.usageRef))
  );
}

/** Exact internal managed JOIN contracts shared by the API and its persistence boundary. */
export interface ManagedJoinExpectations {
  readonly schemaVersion: 1;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly targetSnapshot: {
    readonly snapshotId: string;
    readonly revision: number;
    readonly evidenceRef: string;
  };
}
export interface ManagedJoinEntitlement {
  readonly subscriptionInstanceId: string;
  readonly expectations: ManagedJoinExpectations;
}
export interface ManagedJoinBinding {
  readonly contractVersion: 2;
  /** Original public request fingerprint, without generated policy/usage references. */
  readonly requestFingerprint: string;
  readonly entitlement: ManagedJoinEntitlement;
}
export interface ManagedJoinReceipt {
  readonly contractVersion: 2;
  readonly source: 'LK1_SUBSCRIPTION_BOOKING_OWNER';
  readonly operationId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly gameId: string;
  readonly reservationId: string;
  readonly providerClientId: string;
  readonly providerClientSubscriptionId: string;
  readonly providerExerciseId: string;
  readonly providerMappingId: string;
  readonly targetMappingId: string;
  readonly targetVersion: string;
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly bookingId: string;
  readonly verifiedAt: string;
  readonly entitlement: {
    readonly subscriptionInstanceId: string;
    readonly policyRef: { readonly policyVersion: number; readonly policyDigest: string };
    readonly usageRef: { readonly usageRef: string; readonly reservationUnits: number };
  };
}
const managedObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const managedKeys = (value: unknown, expected: string): value is Record<string, unknown> =>
  managedObject(value) && Object.keys(value).sort().join() === expected.split(',').sort().join();
const managedId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value) &&
  !/[\r\n]/.test(value);
const managedDigest = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const managedPositive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const managedUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const managedInvalid = (): never => {
  throw new Error('MANAGED_JOIN_BINDING_INVALID');
};
export function parseManagedJoinEntitlement(value: unknown): ManagedJoinEntitlement {
  if (
    !managedKeys(value, 'subscriptionInstanceId,expectations') ||
    !managedId(value.subscriptionInstanceId)
  )
    return managedInvalid();
  const e = value.expectations;
  if (
    !managedKeys(e, 'schemaVersion,policyVersion,policyDigest,targetSnapshot') ||
    e.schemaVersion !== 1 ||
    !managedPositive(e.policyVersion) ||
    !managedDigest(e.policyDigest) ||
    !managedKeys(e.targetSnapshot, 'snapshotId,revision,evidenceRef') ||
    !managedId(e.targetSnapshot.snapshotId) ||
    !managedPositive(e.targetSnapshot.revision) ||
    !managedId(e.targetSnapshot.evidenceRef)
  )
    return managedInvalid();
  return {
    subscriptionInstanceId: value.subscriptionInstanceId,
    expectations: {
      schemaVersion: 1,
      policyVersion: e.policyVersion,
      policyDigest: e.policyDigest,
      targetSnapshot: {
        snapshotId: e.targetSnapshot.snapshotId,
        revision: e.targetSnapshot.revision,
        evidenceRef: e.targetSnapshot.evidenceRef,
      },
    },
  };
}
export function parseManagedJoinBinding(value: unknown): ManagedJoinBinding {
  if (
    !managedKeys(value, 'contractVersion,requestFingerprint,entitlement') ||
    value.contractVersion !== 2 ||
    typeof value.requestFingerprint !== 'string' ||
    value.requestFingerprint.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.requestFingerprint)
  )
    return managedInvalid();
  return {
    contractVersion: 2,
    requestFingerprint: value.requestFingerprint,
    entitlement: parseManagedJoinEntitlement(value.entitlement),
  };
}
export function parseManagedJoinReceipt(value: unknown): ManagedJoinReceipt {
  const ids = [
    'operationId',
    'tenantId',
    'userId',
    'gameId',
    'reservationId',
    'providerMappingId',
    'targetMappingId',
  ];
  const providerIds = [
    'providerClientId',
    'providerClientSubscriptionId',
    'providerExerciseId',
    'bookingId',
  ];
  if (
    !managedKeys(
      value,
      [
        ...ids,
        ...providerIds,
        'contractVersion',
        'source',
        'targetVersion',
        'requestSha256',
        'idempotencyKeySha256',
        'verifiedAt',
        'entitlement',
      ].join(),
    ) ||
    value.contractVersion !== 2 ||
    value.source !== 'LK1_SUBSCRIPTION_BOOKING_OWNER' ||
    ids.some((key) => !managedUuid(value[key])) ||
    providerIds.some(
      (key) =>
        typeof value[key] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value[key]) ||
        /[\r\n]/.test(value[key]),
    ) ||
    !managedDigest(value.requestSha256) ||
    !managedDigest(value.idempotencyKeySha256) ||
    typeof value.targetVersion !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.targetVersion) ||
    /[\r\n]/.test(value.targetVersion) ||
    typeof value.verifiedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.verifiedAt)) ||
    new Date(value.verifiedAt).toISOString() !== value.verifiedAt
  )
    return managedInvalid();
  const e = value.entitlement;
  if (
    !managedKeys(e, 'subscriptionInstanceId,policyRef,usageRef') ||
    !managedId(e.subscriptionInstanceId) ||
    !managedKeys(e.policyRef, 'policyVersion,policyDigest') ||
    !managedPositive(e.policyRef.policyVersion) ||
    !managedDigest(e.policyRef.policyDigest) ||
    !managedKeys(e.usageRef, 'usageRef,reservationUnits') ||
    typeof e.usageRef.usageRef !== 'string' ||
    !/^booking:[a-f0-9]{48}$/.test(e.usageRef.usageRef) ||
    e.usageRef.usageRef.length !== 56 ||
    !managedPositive(e.usageRef.reservationUnits)
  )
    return managedInvalid();
  return {
    ...structuredClone(value),
    entitlement: {
      subscriptionInstanceId: e.subscriptionInstanceId,
      policyRef: {
        policyVersion: e.policyRef.policyVersion,
        policyDigest: e.policyRef.policyDigest,
      },
      usageRef: { usageRef: e.usageRef.usageRef, reservationUnits: e.usageRef.reservationUnits },
    },
  } as unknown as ManagedJoinReceipt;
}
export function managedJoinReceiptMatchesEntitlement(
  receipt: ManagedJoinReceipt,
  expected: ManagedJoinEntitlement,
): boolean {
  return (
    receipt.entitlement.subscriptionInstanceId === expected.subscriptionInstanceId &&
    receipt.entitlement.policyRef.policyVersion === expected.expectations.policyVersion &&
    receipt.entitlement.policyRef.policyDigest === expected.expectations.policyDigest
  );
}

/** Backend-only immutable authority for the concrete managed FREE SELF return. */
export interface ManagedSelfLeaveRequest {
  readonly contractVersion: 1;
  readonly action: 'LEAVE_GAME';
  readonly target: { readonly id: string; readonly expectedRevision: number };
  readonly participationId: string;
  readonly reservationId: string;
  readonly joinOperationId: string;
  readonly joinReceiptSha256: string;
  readonly returnMode: 'SERVICE';
}
export interface ManagedSelfLeaveReceipt {
  readonly contractVersion: 1;
  readonly source: 'LK1_MANAGED_SELF_LEAVE_OWNER';
  readonly operationId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly gameId: string;
  readonly participationId: string;
  readonly reservationId: string;
  readonly joinOperationId: string;
  readonly joinReceiptSha256: string;
  readonly legacyGameId: string;
  readonly ownerLeaveOperationId: string;
  readonly membershipVersion: string;
  readonly providerClientId: string;
  readonly providerClientSubscriptionId: string;
  readonly providerExerciseId: string;
  readonly providerBookingId: string;
  readonly completedAt: string;
  readonly compensation: {
    readonly schemaVersion: 1;
    readonly operationId: string;
    readonly subscriptionInstanceId: string;
    readonly operationState: 'COMPENSATED';
    readonly compensationState: 'APPLIED';
    readonly releaseReason: 'BOOKING_CANCELLED';
    readonly providerBookingId: string;
  };
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly providerMappingId: string;
  readonly legacyGameMappingId: string;
  readonly legacyGameMappingVersion: string;
}
export interface ManagedSelfLeaveAuthority {
  readonly operationId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly request: ManagedSelfLeaveRequest;
  readonly requestSha256: string;
  readonly idempotencyKeySha256: string;
  readonly originalJoinReceipt: ManagedJoinReceipt;
  readonly legacyGameId: string;
  readonly legacyGameMappingId: string;
  readonly legacyGameMappingVersion: string;
}
const selfLeaveId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v) && !/[\r\n]/.test(v);
const selfLeaveIso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const selfLeaveInvalid = (): never => {
  throw new Error('MANAGED_SELF_LEAVE_BINDING_INVALID');
};
export function parseManagedSelfLeaveRequest(value: unknown): ManagedSelfLeaveRequest {
  if (
    !managedKeys(
      value,
      'contractVersion,action,target,participationId,reservationId,joinOperationId,joinReceiptSha256,returnMode',
    ) ||
    value.contractVersion !== 1 ||
    value.action !== 'LEAVE_GAME' ||
    value.returnMode !== 'SERVICE' ||
    !managedKeys(value.target, 'id,expectedRevision') ||
    !managedUuid(value.target.id) ||
    !managedPositive(value.target.expectedRevision) ||
    ![value.participationId, value.reservationId, value.joinOperationId].every(managedUuid) ||
    !managedDigest(value.joinReceiptSha256)
  )
    return selfLeaveInvalid();
  return {
    contractVersion: 1,
    action: 'LEAVE_GAME',
    target: { id: value.target.id, expectedRevision: value.target.expectedRevision },
    participationId: value.participationId as string,
    reservationId: value.reservationId as string,
    joinOperationId: value.joinOperationId as string,
    joinReceiptSha256: value.joinReceiptSha256,
    returnMode: 'SERVICE',
  };
}
export function parseManagedSelfLeaveReceipt(value: unknown): ManagedSelfLeaveReceipt {
  const ids = [
    'operationId',
    'tenantId',
    'userId',
    'gameId',
    'participationId',
    'reservationId',
    'joinOperationId',
    'providerMappingId',
    'legacyGameMappingId',
  ];
  const opaque = [
    'legacyGameId',
    'membershipVersion',
    'providerClientId',
    'providerClientSubscriptionId',
    'providerExerciseId',
    'providerBookingId',
    'legacyGameMappingVersion',
  ];
  if (
    !managedKeys(
      value,
      [
        ...ids,
        ...opaque,
        'contractVersion',
        'source',
        'ownerLeaveOperationId',
        'joinReceiptSha256',
        'completedAt',
        'compensation',
        'requestSha256',
        'idempotencyKeySha256',
      ].join(),
    ) ||
    value.contractVersion !== 1 ||
    value.source !== 'LK1_MANAGED_SELF_LEAVE_OWNER' ||
    ids.some((k) => !managedUuid(value[k])) ||
    opaque.some((k) => !selfLeaveId(value[k])) ||
    ![value.joinReceiptSha256, value.requestSha256, value.idempotencyKeySha256].every(
      managedDigest,
    ) ||
    !selfLeaveIso(value.completedAt) ||
    value.ownerLeaveOperationId !==
      `self-leave:${String(value.legacyGameId)}:${String(value.providerClientId)}:${String(value.membershipVersion)}`
  )
    return selfLeaveInvalid();
  const c = value.compensation;
  if (
    !managedKeys(
      c,
      'schemaVersion,operationId,subscriptionInstanceId,operationState,compensationState,releaseReason,providerBookingId',
    ) ||
    c.schemaVersion !== 1 ||
    c.operationState !== 'COMPENSATED' ||
    c.compensationState !== 'APPLIED' ||
    c.releaseReason !== 'BOOKING_CANCELLED' ||
    typeof c.operationId !== 'string' ||
    c.operationId.length !== 56 ||
    !/^booking:[a-f0-9]{48}$/.test(c.operationId) ||
    !managedId(c.subscriptionInstanceId) ||
    c.providerBookingId !== value.providerBookingId
  )
    return selfLeaveInvalid();
  return {
    ...structuredClone(value),
    compensation: {
      schemaVersion: 1,
      operationId: c.operationId,
      subscriptionInstanceId: c.subscriptionInstanceId,
      operationState: 'COMPENSATED',
      compensationState: 'APPLIED',
      releaseReason: 'BOOKING_CANCELLED',
      providerBookingId: c.providerBookingId,
    },
  } as unknown as ManagedSelfLeaveReceipt;
}
/** Match every persisted authority field; used before local mutation and completed replay. */
export function managedSelfLeaveReceiptMatches(
  receipt: ManagedSelfLeaveReceipt,
  authority: ManagedSelfLeaveAuthority,
): boolean {
  const r = parseManagedSelfLeaveReceipt(receipt),
    a = authority,
    j = parseManagedJoinReceipt(a.originalJoinReceipt),
    q = parseManagedSelfLeaveRequest(a.request);
  return (
    r.operationId === a.operationId &&
    r.tenantId === a.tenantId &&
    r.userId === a.userId &&
    j.tenantId === a.tenantId &&
    j.userId === a.userId &&
    j.gameId === q.target.id &&
    j.reservationId === q.reservationId &&
    j.operationId === q.joinOperationId &&
    r.gameId === q.target.id &&
    r.participationId === q.participationId &&
    r.reservationId === q.reservationId &&
    r.joinOperationId === q.joinOperationId &&
    r.joinReceiptSha256 === q.joinReceiptSha256 &&
    r.requestSha256 === a.requestSha256 &&
    r.idempotencyKeySha256 === a.idempotencyKeySha256 &&
    r.legacyGameId === a.legacyGameId &&
    r.legacyGameMappingId === a.legacyGameMappingId &&
    r.legacyGameMappingVersion === a.legacyGameMappingVersion &&
    r.providerClientId === j.providerClientId &&
    r.providerMappingId === j.providerMappingId &&
    r.providerClientSubscriptionId === j.providerClientSubscriptionId &&
    r.providerExerciseId === j.providerExerciseId &&
    r.providerBookingId === j.bookingId &&
    r.compensation.operationId === j.entitlement.usageRef.usageRef &&
    r.compensation.subscriptionInstanceId === j.entitlement.subscriptionInstanceId
  );
}
/** Lazy crypto keeps frozen browser/operator bundle initialization unchanged. */
export async function managedSelfLeaveRequestSha256(
  value: ManagedSelfLeaveRequest,
): Promise<string> {
  const { createHash } = await import('node:crypto');
  return (
    'sha256:' +
    createHash('sha256')
      .update(
        'managed-self-leave-admission:v1\0' + JSON.stringify(parseManagedSelfLeaveRequest(value)),
      )
      .digest('hex')
  );
}
export async function managedSelfLeaveReceiptSha256(
  value: ManagedSelfLeaveReceipt,
): Promise<string> {
  const { createHash } = await import('node:crypto');
  return (
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify(
          Object.entries(parseManagedSelfLeaveReceipt(value)).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      )
      .digest('hex')
  );
}
export async function managedSelfLeaveJoinReceiptSha256(
  value: ManagedJoinReceipt,
): Promise<string> {
  const { createHash } = await import('node:crypto');
  return (
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify(
          Object.entries(parseManagedJoinReceipt(value)).sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      .digest('hex')
  );
}
export async function managedSelfLeaveOperationId(input: {
  tenantId: string;
  userId: string;
  idempotencyKeySha256: string;
}): Promise<string> {
  if (
    !managedUuid(input.tenantId) ||
    !managedUuid(input.userId) ||
    !managedDigest(input.idempotencyKeySha256)
  )
    return selfLeaveInvalid();
  const { createHash } = await import('node:crypto');
  const chars = createHash('sha256')
    .update(
      'managed-self-leave-operation:v1\0' +
        input.tenantId +
        '\0' +
        input.userId +
        '\0' +
        input.idempotencyKeySha256,
    )
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16]!, 16) & 3) | 8).toString(16);
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function assertManagedSelfLeaveAuthority(a: ManagedSelfLeaveAuthority): Promise<void> {
  const q = parseManagedSelfLeaveRequest(a.request),
    j = parseManagedJoinReceipt(a.originalJoinReceipt);
  if (
    !managedUuid(a.operationId) ||
    !managedUuid(a.tenantId) ||
    !managedUuid(a.userId) ||
    !managedDigest(a.idempotencyKeySha256) ||
    !selfLeaveId(a.legacyGameId) ||
    !managedUuid(a.legacyGameMappingId) ||
    !selfLeaveId(a.legacyGameMappingVersion) ||
    j.tenantId !== a.tenantId ||
    j.userId !== a.userId ||
    j.gameId !== q.target.id ||
    j.reservationId !== q.reservationId ||
    j.operationId !== q.joinOperationId ||
    (await managedSelfLeaveOperationId({
      tenantId: a.tenantId,
      userId: a.userId,
      idempotencyKeySha256: a.idempotencyKeySha256,
    })) !== a.operationId ||
    (await managedSelfLeaveRequestSha256(q)) !== a.requestSha256 ||
    (await managedSelfLeaveJoinReceiptSha256(j)) !== q.joinReceiptSha256
  )
    return selfLeaveInvalid();
}

export * from './tournament-local.js';
