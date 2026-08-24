export const MANAGED_SUBSCRIPTION_RUNTIME_V1_CONTRACT_VERSION = '1';
export const MANAGED_SUBSCRIPTION_RUNTIME_V1_QUOTE_PATH =
  '/api/internal/subscription-runtime/quote';

const actions = [
  'CREATE_GAME',
  'JOIN_GAME',
  'BOOK_GROUP_TRAINING',
  'BOOK_TOURNAMENT',
  'PURCHASE_ADD_ON_PRODUCT',
  'CANCEL_BOOKING',
  'RESCHEDULE_BOOKING',
  'CONFIRM_ATTENDANCE',
  'CONFIRM_NO_SHOW',
] as const;
const outcomes = [
  'ENTITLEMENT_APPLIED',
  'FULL_PRICE_ONLY',
  'SUBSCRIPTION_SELECTION_REQUIRED',
  'PRICE_CONFIRMATION_REQUIRED',
  'SERVICE_BLOCKED',
  'RETRY_LATER',
  'RECONCILIATION_REQUIRED',
] as const;
const paymentIntents = ['AUTO_BEST_PRICE', 'PAY_FULL_PRICE', 'USE_SUBSCRIPTION'] as const;
const targetKinds = ['GAME', 'GROUP_TRAINING', 'TOURNAMENT', 'ADD_ON_PRODUCT', 'BOOKING'] as const;
const benefitKinds = [
  'NONE',
  'FREE_ENTITLEMENT',
  'FIXED_PRICE',
  'FIXED_DISCOUNT',
  'PERCENT_DISCOUNT',
  'PARTIAL_PRICE_PERCENT_DISCOUNT',
] as const;
const reasonCodes = [
  'SERVICE_UNAVAILABLE',
  'SUBSCRIPTION_NOT_FOUND',
  'SUBSCRIPTION_SELECTION_REQUIRED',
  'SUBSCRIPTION_NOT_OWNED_BY_ACTOR',
  'SUBSCRIPTION_TYPE_MISMATCH',
  'SUBSCRIPTION_PENDING_ACTIVATION',
  'SUBSCRIPTION_INACTIVE',
  'SUBSCRIPTION_FROZEN',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_CANCELLED',
  'SUBSCRIPTION_REFUNDED',
  'SUBSCRIPTION_REVOKED',
  'SUBSCRIPTION_INSTANCE_STALE',
  'PROVIDER_IDENTITY_UNAVAILABLE',
  'PROVIDER_STATE_MISMATCH',
  'POLICY_UNAVAILABLE',
  'POLICY_NOT_PUBLISHED',
  'POLICY_NOT_EFFECTIVE',
  'POLICY_STALE',
  'POLICY_VERSION_MISMATCH',
  'POLICY_DIGEST_MISMATCH',
  'POLICY_MAPPING_UNVERIFIED',
  'POLICY_ACTION_DISABLED',
  'TARGET_NOT_FOUND',
  'TARGET_NOT_SERVER_RESOLVED',
  'TARGET_STALE',
  'TARGET_REVISION_MISMATCH',
  'PRICE_UNAVAILABLE',
  'PRICE_STALE',
  'PRICE_REVISION_MISMATCH',
  'CURRENCY_UNSUPPORTED',
  'EVENT_NOT_INCLUDED',
  'PRODUCT_NOT_INCLUDED',
  'DURATION_NOT_ALLOWED',
  'STATION_NOT_ALLOWED',
  'STATION_RULE_AMBIGUOUS',
  'BOOKING_WINDOW_EXCEEDED',
  'BLACKOUT_DATE',
  'ACTIVE_SERVICES_LIMIT_REACHED',
  'ACTIVE_SERVICES_LIMIT_UNAVAILABLE',
  'DAILY_LIMIT_REACHED',
  'WEEKLY_LIMIT_REACHED',
  'MONTHLY_LIMIT_REACHED',
  'FUTURE_BOOKINGS_LIMIT_REACHED',
  'MIN_INTERVAL_NOT_MET',
  'UNITS_EXHAUSTED',
  'USAGE_SNAPSHOT_STALE',
  'USAGE_SNAPSHOT_INVALID',
  'BENEFIT_NOT_APPLICABLE',
  'DISCOUNT_DISABLED',
  'PRICE_CALCULATION_INVALID',
  'PRICE_CHANGED',
  'PRICE_CONFIRMATION_REQUIRED',
  'RESERVATION_CONFLICT',
  'RESERVATION_EXPIRED',
  'RESERVATION_NOT_OWNED_BY_ACTOR',
  'IDEMPOTENCY_CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_REJECTED',
  'PROVIDER_TIMEOUT_AFTER_ACCEPT',
  'PROVIDER_READBACK_MISMATCH',
  'RECONCILIATION_REQUIRED',
  'CROSS_TENANT_REJECTED',
  'LEGACY_FLOW_NOT_MANAGED',
] as const;

export type ManagedSubscriptionRuntimeV1Action = (typeof actions)[number];
export type ManagedSubscriptionRuntimeV1Outcome = (typeof outcomes)[number];
export type ManagedSubscriptionRuntimeV1PaymentIntent = (typeof paymentIntents)[number];
export type ManagedSubscriptionRuntimeV1TargetKind = (typeof targetKinds)[number];
export type ManagedSubscriptionRuntimeV1BenefitKind = (typeof benefitKinds)[number];
export type ManagedSubscriptionRuntimeV1ReasonCode = (typeof reasonCodes)[number];
const actionTargetKinds: Record<
  ManagedSubscriptionRuntimeV1Action,
  ManagedSubscriptionRuntimeV1TargetKind
> = {
  CREATE_GAME: 'GAME',
  JOIN_GAME: 'GAME',
  BOOK_GROUP_TRAINING: 'GROUP_TRAINING',
  BOOK_TOURNAMENT: 'TOURNAMENT',
  PURCHASE_ADD_ON_PRODUCT: 'ADD_ON_PRODUCT',
  CANCEL_BOOKING: 'BOOKING',
  RESCHEDULE_BOOKING: 'BOOKING',
  CONFIRM_ATTENDANCE: 'BOOKING',
  CONFIRM_NO_SHOW: 'BOOKING',
};

export interface ManagedSubscriptionRuntimeV1QuoteRequest {
  readonly action: ManagedSubscriptionRuntimeV1Action;
  readonly target: {
    readonly kind: ManagedSubscriptionRuntimeV1TargetKind;
    readonly id: string;
    readonly expectedRevision?: number;
  };
  readonly preferredSubscriptionInstanceId?: string;
  readonly paymentIntent: ManagedSubscriptionRuntimeV1PaymentIntent;
}
export interface ManagedSubscriptionRuntimeServerEnvelope {
  readonly authorization: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}
export interface ManagedSubscriptionRuntimeV1PriceSnapshot {
  readonly priceRevision: number;
  readonly basePriceMinor: number;
  readonly discountMinor: number;
  readonly surchargeMinor: number;
  readonly finalPriceMinor: number;
  readonly currency: 'RUB';
}
export interface ManagedSubscriptionRuntimeV1QuoteOutcome {
  readonly contractVersion: 1;
  readonly nonBinding: true;
  readonly requiresReservationRecheck: true;
  readonly outcome: ManagedSubscriptionRuntimeV1Outcome;
  readonly paymentIntent: ManagedSubscriptionRuntimeV1PaymentIntent;
  readonly decisionId: string;
  readonly serviceAllowed: boolean;
  readonly subscriptionBenefitAllowed: boolean;
  readonly selectedSubscription: {
    readonly subscriptionInstanceId: string;
    readonly policyVersion: number;
    readonly policyDigest: string;
  } | null;
  readonly benefit: {
    readonly kind: ManagedSubscriptionRuntimeV1BenefitKind;
    readonly ruleId: string | null;
    readonly usageUnits: number;
  } | null;
  readonly price: ManagedSubscriptionRuntimeV1PriceSnapshot | null;
  readonly limits: {
    readonly activeServices: number | null;
    readonly activeServicesLimit: number | null;
    readonly dailyUsed: number | null;
    readonly dailyLimit: number | null;
    readonly weeklyUsed: number | null;
    readonly weeklyLimit: number | null;
    readonly monthlyUsed: number | null;
    readonly monthlyLimit: number | null;
    readonly remainingUnits: number | null;
  };
  readonly blockers: readonly { readonly code: ManagedSubscriptionRuntimeV1ReasonCode }[];
  readonly warnings: readonly { readonly code: ManagedSubscriptionRuntimeV1ReasonCode }[];
  readonly alternatives: readonly {
    readonly paymentIntent: 'PAY_FULL_PRICE';
    readonly requiresExplicitUserConfirmation: true;
  }[];
  readonly evaluatedAt: string;
  readonly expiresAt: string;
}
export interface ManagedSubscriptionRuntimeQuoteClientOptions {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly integrationToken?: string;
  readonly timeoutMs?: number;
  readonly environment?: 'production' | 'development' | 'test';
  readonly fetchImplementation?: typeof fetch;
}
export class ManagedSubscriptionRuntimeQuoteClientError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'ManagedSubscriptionRuntimeQuoteClientError';
  }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const headerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const authorizationPattern = /^Bearer [^\s]{1,4096}$/;
const invalid = (code: string): never => {
  throw new ManagedSubscriptionRuntimeQuoteClientError(code);
};
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const oneOf = (value: unknown, values: readonly string[]): value is string =>
  typeof value === 'string' && values.includes(value);
const id = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function assertRequest(request: ManagedSubscriptionRuntimeV1QuoteRequest): void {
  if (
    !record(request) ||
    !exactKeys(
      request,
      request.preferredSubscriptionInstanceId === undefined
        ? ['action', 'target', 'paymentIntent']
        : ['action', 'target', 'preferredSubscriptionInstanceId', 'paymentIntent'],
    ) ||
    !oneOf(request.action, actions) ||
    !record(request.target) ||
    !exactKeys(
      request.target,
      request.target.expectedRevision === undefined
        ? ['kind', 'id']
        : ['kind', 'id', 'expectedRevision'],
    ) ||
    !oneOf(request.target.kind, targetKinds) ||
    actionTargetKinds[request.action] !== request.target.kind ||
    !id(request.target.id) ||
    (request.target.expectedRevision !== undefined && !positive(request.target.expectedRevision)) ||
    (request.preferredSubscriptionInstanceId !== undefined &&
      !id(request.preferredSubscriptionInstanceId)) ||
    !oneOf(request.paymentIntent, paymentIntents)
  )
    invalid('SUBSCRIPTION_RUNTIME_QUOTE_REQUEST_INVALID');
}
function assertEnvelope(envelope: ManagedSubscriptionRuntimeServerEnvelope): void {
  if (
    !record(envelope) ||
    !exactKeys(envelope, ['authorization', 'correlationId', 'idempotencyKey']) ||
    !authorizationPattern.test(envelope.authorization) ||
    !headerPattern.test(envelope.correlationId) ||
    !headerPattern.test(envelope.idempotencyKey)
  )
    invalid('SUBSCRIPTION_RUNTIME_SERVER_ENVELOPE_INVALID');
}
function configuration(options: ManagedSubscriptionRuntimeQuoteClientOptions): {
  readonly baseUrl: URL;
  readonly integrationToken: string;
  readonly timeoutMs: number;
} {
  if (!options.enabled) invalid('SUBSCRIPTION_RUNTIME_DISABLED');
  const token = options.integrationToken?.trim();
  const timeoutMs = options.timeoutMs;
  const baseUrlInput = options.baseUrl;
  if (
    baseUrlInput === undefined ||
    !token ||
    !/^[!-~]{32,4096}$/.test(token) ||
    timeoutMs === undefined ||
    !positive(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 10_000
  )
    invalid('SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID');
  const configuredBaseUrl = baseUrlInput ?? invalid('SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID');
  const configuredToken = token ?? invalid('SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID');
  const configuredTimeoutMs = timeoutMs ?? invalid('SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID');
  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    return invalid('SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID');
  }
  const localHttp =
    (options.environment === 'development' || options.environment === 'test') &&
    ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
  if (
    (baseUrl.protocol !== 'https:' && !localHttp) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.hash ||
    baseUrl.search ||
    baseUrl.pathname !== '/'
  )
    invalid('SUBSCRIPTION_RUNTIME_CONFIGURATION_INVALID');
  return { baseUrl, integrationToken: configuredToken, timeoutMs: configuredTimeoutMs };
}
function reasons(
  value: unknown,
): value is readonly { readonly code: ManagedSubscriptionRuntimeV1ReasonCode }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => record(item) && exactKeys(item, ['code']) && oneOf(item.code, reasonCodes),
    )
  );
}
function assertQuoteResponse(
  raw: unknown,
): asserts raw is ManagedSubscriptionRuntimeV1QuoteOutcome {
  if (!record(raw)) invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  const value = raw as ManagedSubscriptionRuntimeV1QuoteOutcome & Record<string, unknown>;
  if (
    !exactKeys(value, [
      'contractVersion',
      'nonBinding',
      'requiresReservationRecheck',
      'outcome',
      'paymentIntent',
      'decisionId',
      'serviceAllowed',
      'subscriptionBenefitAllowed',
      'selectedSubscription',
      'benefit',
      'price',
      'limits',
      'blockers',
      'warnings',
      'alternatives',
      'evaluatedAt',
      'expiresAt',
    ]) ||
    value.contractVersion !== 1 ||
    value.nonBinding !== true ||
    value.requiresReservationRecheck !== true ||
    !oneOf(value.outcome, outcomes) ||
    !oneOf(value.paymentIntent, paymentIntents) ||
    !id(value.decisionId) ||
    typeof value.serviceAllowed !== 'boolean' ||
    typeof value.subscriptionBenefitAllowed !== 'boolean' ||
    !instant(value.evaluatedAt) ||
    !instant(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.evaluatedAt) ||
    !reasons(value.blockers) ||
    !reasons(value.warnings)
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  if (
    value.selectedSubscription !== null &&
    (!record(value.selectedSubscription) ||
      !exactKeys(value.selectedSubscription, [
        'subscriptionInstanceId',
        'policyVersion',
        'policyDigest',
      ]) ||
      !id(value.selectedSubscription.subscriptionInstanceId) ||
      !positive(value.selectedSubscription.policyVersion) ||
      typeof value.selectedSubscription.policyDigest !== 'string' ||
      !digestPattern.test(value.selectedSubscription.policyDigest))
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  if (
    value.benefit !== null &&
    (!record(value.benefit) ||
      !exactKeys(value.benefit, ['kind', 'ruleId', 'usageUnits']) ||
      !oneOf(value.benefit.kind, benefitKinds) ||
      (value.benefit.ruleId !== null && !id(value.benefit.ruleId)) ||
      !positive(value.benefit.usageUnits))
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  if (
    value.price !== null &&
    (!record(value.price) ||
      !exactKeys(value.price, [
        'priceRevision',
        'basePriceMinor',
        'discountMinor',
        'surchargeMinor',
        'finalPriceMinor',
        'currency',
      ]) ||
      !positive(value.price.priceRevision) ||
      !nonNegative(value.price.basePriceMinor) ||
      !nonNegative(value.price.discountMinor) ||
      !nonNegative(value.price.surchargeMinor) ||
      !nonNegative(value.price.finalPriceMinor) ||
      value.price.currency !== 'RUB' ||
      value.price.discountMinor > value.price.basePriceMinor ||
      BigInt(value.price.basePriceMinor) -
        BigInt(value.price.discountMinor) +
        BigInt(value.price.surchargeMinor) !==
        BigInt(value.price.finalPriceMinor))
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  if (
    !record(value.limits) ||
    !exactKeys(value.limits, [
      'activeServices',
      'activeServicesLimit',
      'dailyUsed',
      'dailyLimit',
      'weeklyUsed',
      'weeklyLimit',
      'monthlyUsed',
      'monthlyLimit',
      'remainingUnits',
    ]) ||
    !Object.values(value.limits).every((item) => item === null || nonNegative(item))
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  if (
    !Array.isArray(value.alternatives) ||
    value.alternatives.length > 1 ||
    !value.alternatives.every(
      (item) =>
        record(item) &&
        exactKeys(item, ['paymentIntent', 'requiresExplicitUserConfirmation']) &&
        item.paymentIntent === 'PAY_FULL_PRICE' &&
        item.requiresExplicitUserConfirmation === true,
    )
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
  const blockers = value.blockers.map((item) => item.code);
  const warnings = value.warnings.map((item) => item.code);
  const alternative = value.alternatives.length === 1;
  const selection =
    value.outcome === 'ENTITLEMENT_APPLIED' || value.outcome === 'PRICE_CONFIRMATION_REQUIRED';
  const priced = !['SERVICE_BLOCKED', 'RETRY_LATER', 'RECONCILIATION_REQUIRED'].includes(
    value.outcome,
  );
  const retryable = new Set([
    'SUBSCRIPTION_INSTANCE_STALE',
    'PROVIDER_IDENTITY_UNAVAILABLE',
    'PROVIDER_STATE_MISMATCH',
    'POLICY_UNAVAILABLE',
    'POLICY_STALE',
    'POLICY_VERSION_MISMATCH',
    'POLICY_DIGEST_MISMATCH',
    'POLICY_MAPPING_UNVERIFIED',
    'TARGET_NOT_SERVER_RESOLVED',
    'TARGET_STALE',
    'TARGET_REVISION_MISMATCH',
    'PRICE_UNAVAILABLE',
    'PRICE_STALE',
    'PRICE_REVISION_MISMATCH',
    'STATION_RULE_AMBIGUOUS',
    'ACTIVE_SERVICES_LIMIT_UNAVAILABLE',
    'USAGE_SNAPSHOT_STALE',
    'USAGE_SNAPSHOT_INVALID',
    'PRICE_CALCULATION_INVALID',
    'RESERVATION_CONFLICT',
    'RESERVATION_EXPIRED',
    'PROVIDER_UNAVAILABLE',
  ]);
  const reconciliation = new Set([
    'RECONCILIATION_REQUIRED',
    'PROVIDER_TIMEOUT_AFTER_ACCEPT',
    'PROVIDER_READBACK_MISMATCH',
  ]);
  if (
    new Set(blockers).size !== blockers.length ||
    new Set(warnings).size !== warnings.length ||
    (selection && (value.selectedSubscription === null || value.benefit === null)) ||
    (!selection && (value.selectedSubscription !== null || value.benefit !== null)) ||
    (priced && value.price === null) ||
    (!priced && value.price !== null) ||
    (value.outcome === 'ENTITLEMENT_APPLIED' &&
      (!value.serviceAllowed ||
        !value.subscriptionBenefitAllowed ||
        value.paymentIntent === 'PAY_FULL_PRICE' ||
        blockers.length > 0 ||
        alternative)) ||
    (value.outcome === 'FULL_PRICE_ONLY' &&
      (!value.serviceAllowed ||
        value.subscriptionBenefitAllowed ||
        (value.paymentIntent === 'PAY_FULL_PRICE'
          ? blockers.length > 0 || alternative
          : !alternative || blockers.length === 0))) ||
    (value.outcome === 'SUBSCRIPTION_SELECTION_REQUIRED' &&
      (!value.serviceAllowed ||
        value.subscriptionBenefitAllowed ||
        value.paymentIntent === 'PAY_FULL_PRICE' ||
        blockers.length === 0)) ||
    (value.outcome === 'PRICE_CONFIRMATION_REQUIRED' &&
      (!value.serviceAllowed ||
        !value.subscriptionBenefitAllowed ||
        value.paymentIntent === 'PAY_FULL_PRICE' ||
        !blockers.includes('PRICE_CHANGED'))) ||
    (value.outcome === 'SERVICE_BLOCKED' &&
      (value.serviceAllowed ||
        value.subscriptionBenefitAllowed ||
        blockers.length === 0 ||
        alternative)) ||
    (value.outcome === 'RETRY_LATER' &&
      (value.serviceAllowed ||
        value.subscriptionBenefitAllowed ||
        !blockers.some((code) => retryable.has(code)))) ||
    (value.outcome === 'RECONCILIATION_REQUIRED' &&
      (value.serviceAllowed ||
        value.subscriptionBenefitAllowed ||
        !blockers.some((code) => reconciliation.has(code))))
  )
    invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
}
export class ManagedSubscriptionRuntimeQuoteClient {
  private readonly fetchImplementation: typeof fetch;
  public constructor(private readonly options: ManagedSubscriptionRuntimeQuoteClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  }
  public async quote(
    request: ManagedSubscriptionRuntimeV1QuoteRequest,
    envelope: ManagedSubscriptionRuntimeServerEnvelope,
  ): Promise<ManagedSubscriptionRuntimeV1QuoteOutcome> {
    const options = configuration(this.options);
    assertRequest(request);
    assertEnvelope(envelope);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await this.fetchImplementation(
        new URL(MANAGED_SUBSCRIPTION_RUNTIME_V1_QUOTE_PATH, options.baseUrl),
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: envelope.authorization,
            'Content-Type': 'application/json',
            'X-Correlation-ID': envelope.correlationId,
            'Idempotency-Key': envelope.idempotencyKey,
            'X-Subscription-Runtime-Contract-Version':
              MANAGED_SUBSCRIPTION_RUNTIME_V1_CONTRACT_VERSION,
            'X-Subscriptions-Integration-Token': options.integrationToken,
          },
          body: JSON.stringify({
            action: request.action,
            target:
              request.target.expectedRevision === undefined
                ? { kind: request.target.kind, id: request.target.id }
                : {
                    kind: request.target.kind,
                    id: request.target.id,
                    expectedRevision: request.target.expectedRevision,
                  },
            ...(request.preferredSubscriptionInstanceId === undefined
              ? {}
              : { preferredSubscriptionInstanceId: request.preferredSubscriptionInstanceId }),
            paymentIntent: request.paymentIntent,
          }),
        },
      );
      if (!response.ok) invalid('SUBSCRIPTION_RUNTIME_REQUEST_FAILED');
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return invalid('SUBSCRIPTION_RUNTIME_RESPONSE_INVALID');
      }
      assertQuoteResponse(payload);
      return payload;
    } catch (error) {
      if (error instanceof ManagedSubscriptionRuntimeQuoteClientError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        invalid('SUBSCRIPTION_RUNTIME_TIMEOUT');
      return invalid('SUBSCRIPTION_RUNTIME_REQUEST_FAILED');
    } finally {
      clearTimeout(timeout);
    }
  }
}
