/**
 * Read-only client for the CUP published-policy registry.
 *
 * The endpoint is an internal, integration-token protected read. The client never sends actor
 * identity, provider identifiers, prices or policy values: it only reads what CUP already
 * persisted. Malformed or oversized responses fail closed and are never partially merged into an
 * operator view.
 */
export const SUBSCRIPTION_POLICY_REGISTRY_PATH = '/api/internal/subscriptions/policy-registry';

export type SubscriptionPolicyRegistrySource = 'CUP_PUBLISHED';

export interface SubscriptionPolicyRegistryPublication {
  readonly publicationId: string;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly state: 'PUBLISHED' | 'SUPERSEDED' | 'DISABLED_FOR_NEW_OPERATIONS';
  readonly effectiveAt: string;
  readonly applyTo: 'NEW_ONLY' | 'ACTIVE_AND_NEW';
  readonly publishedAt: string;
  readonly supersededAt: string | null;
  readonly runtimeCompatibility: {
    readonly adapterId: string;
    readonly contractVersion: number;
    readonly capabilityDigest: string;
  } | null;
}

export interface SubscriptionPolicyRegistryVersion {
  readonly policyVersion: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  readonly modelVersion: 2 | 3;
  readonly effectiveAt: string;
  readonly applyTo: 'NEW_ONLY' | 'ACTIVE_AND_NEW';
  readonly publicationState: 'PUBLISHED' | 'SUPERSEDED' | 'DISABLED_FOR_NEW_OPERATIONS' | null;
}

export interface SubscriptionPolicyRegistryLastDecision {
  readonly at: string;
  readonly source: 'LEDGER' | 'OPERATION';
  readonly eventType: string | null;
  readonly operationState: string | null;
  readonly action: string | null;
  readonly policyVersion: number;
  readonly policyDigest: string;
  readonly usageDelta: number | null;
  readonly moneyDeltaMinor: number | null;
}

export interface SubscriptionPolicyRegistryItem {
  readonly subscriptionTypeId: string;
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  readonly currentPolicyVersion: number | null;
  readonly publication: SubscriptionPolicyRegistryPublication | null;
  /** Immutable compiled runtime projection of the current publication; opaque to LK2. */
  readonly rules: Record<string, unknown> | null;
  readonly surfaces: readonly string[];
  /** Verified provider product ids bound to this subscription type, when CUP exposes them. */
  readonly providerProductIds?: readonly string[];
  readonly versions: readonly SubscriptionPolicyRegistryVersion[];
  readonly instances: {
    readonly total: number;
    readonly byPolicyVersion: readonly {
      readonly policyVersion: number;
      readonly count: number;
    }[];
  };
  readonly lastDecision: SubscriptionPolicyRegistryLastDecision | null;
  /** Newest persisted quote decision for this subscription type, when the operator view exposes it. */
  readonly lastQuoteDecision?: {
    readonly at: string;
    readonly channel?: 'LK2' | 'LK1';
    readonly outcome: string;
    readonly serviceAllowed: boolean;
    readonly subscriptionBenefitAllowed: boolean;
    readonly blockers: readonly string[];
    readonly policyVersion: number | null;
    readonly policyDigest: string | null;
  } | null;
}

export interface SubscriptionPolicyRegistryResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly items: readonly SubscriptionPolicyRegistryItem[];
  readonly totals: {
    readonly subscriptionTypes: number;
    readonly publishedPolicies: number;
    readonly draftPolicies: number;
    readonly instances: number;
  };
}

export class SubscriptionPolicyRegistryError extends Error {
  public constructor(
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'SubscriptionPolicyRegistryError';
  }
}

const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nullableNonNegative = (value: unknown): value is number | null =>
  value === null || nonNegative(value);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new SubscriptionPolicyRegistryError('SUBSCRIPTION_POLICY_REGISTRY_RESPONSE_INVALID');
}

function assertPublication(value: unknown): void {
  if (value === null) return;
  if (
    !record(value) ||
    typeof value.publicationId !== 'string' ||
    typeof value.policyDigest !== 'string' ||
    !positive(value.policyVersion) ||
    !['PUBLISHED', 'SUPERSEDED', 'DISABLED_FOR_NEW_OPERATIONS'].includes(String(value.state)) ||
    !instant(value.effectiveAt) ||
    !['NEW_ONLY', 'ACTIVE_AND_NEW'].includes(String(value.applyTo)) ||
    !instant(value.publishedAt) ||
    (value.supersededAt !== null && !instant(value.supersededAt)) ||
    (value.runtimeCompatibility !== null &&
      (!record(value.runtimeCompatibility) ||
        typeof value.runtimeCompatibility.adapterId !== 'string' ||
        !positive(value.runtimeCompatibility.contractVersion) ||
        typeof value.runtimeCompatibility.capabilityDigest !== 'string'))
  )
    invalid();
}

function assertVersion(value: unknown): void {
  if (!record(value)) invalid();
  const publicationState = value.publicationState;
  if (
    !positive(value.policyVersion) ||
    !['DRAFT', 'PUBLISHED', 'SUPERSEDED'].includes(String(value.status)) ||
    ![2, 3].includes(Number(value.modelVersion)) ||
    !instant(value.effectiveAt) ||
    !['NEW_ONLY', 'ACTIVE_AND_NEW'].includes(String(value.applyTo)) ||
    !(
      publicationState === null ||
      (typeof publicationState === 'string' &&
        ['PUBLISHED', 'SUPERSEDED', 'DISABLED_FOR_NEW_OPERATIONS'].includes(publicationState))
    )
  )
    invalid();
}

function assertLastDecision(value: unknown): void {
  if (value === null) return;
  if (
    !record(value) ||
    !instant(value.at) ||
    !['LEDGER', 'OPERATION'].includes(String(value.source)) ||
    !nullableNonNegative(value.usageDelta) ||
    !nullableNonNegative(value.moneyDeltaMinor) ||
    !positive(value.policyVersion) ||
    typeof value.policyDigest !== 'string' ||
    !(value.eventType === null || typeof value.eventType === 'string') ||
    !(value.operationState === null || typeof value.operationState === 'string') ||
    !(value.action === null || typeof value.action === 'string')
  )
    invalid();
}

function assertLastQuoteDecision(value: unknown): void {
  if (value === undefined || value === null) return;
  if (
    !record(value) ||
    !instant(value.at) ||
    !(value.channel === undefined || value.channel === 'LK2' || value.channel === 'LK1') ||
    typeof value.outcome !== 'string' ||
    typeof value.serviceAllowed !== 'boolean' ||
    typeof value.subscriptionBenefitAllowed !== 'boolean' ||
    !Array.isArray(value.blockers) ||
    !value.blockers.every((blocker) => typeof blocker === 'string') ||
    !(value.policyVersion === null || positive(value.policyVersion)) ||
    !(value.policyDigest === null || typeof value.policyDigest === 'string')
  )
    invalid();
}

function assertItem(value: unknown): void {
  if (
    !record(value) ||
    typeof value.subscriptionTypeId !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.title !== 'string' ||
    !(value.description === null || typeof value.description === 'string') ||
    !['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(String(value.state)) ||
    !(value.currentPolicyVersion === null || positive(value.currentPolicyVersion)) ||
    !(value.rules === null || record(value.rules)) ||
    !Array.isArray(value.surfaces) ||
    !value.surfaces.every((surface) => typeof surface === 'string') ||
    !(
      value.providerProductIds === undefined ||
      (Array.isArray(value.providerProductIds) &&
        value.providerProductIds.every((id) => typeof id === 'string'))
    ) ||
    !Array.isArray(value.versions) ||
    !record(value.instances) ||
    !nonNegative(value.instances.total) ||
    !Array.isArray(value.instances.byPolicyVersion) ||
    !(value.instances.byPolicyVersion as unknown[]).every(
      (entry: unknown) =>
        record(entry) && positive(entry.policyVersion) && nonNegative(entry.count),
    )
  )
    invalid();
  assertPublication(value.publication);
  value.versions.forEach(assertVersion);
  assertLastDecision(value.lastDecision);
  assertLastQuoteDecision(value.lastQuoteDecision);
}

export function parseSubscriptionPolicyRegistryResult(
  value: unknown,
): SubscriptionPolicyRegistryResult {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !instant(value.generatedAt) ||
    !Array.isArray(value.items) ||
    !record(value.totals) ||
    !nonNegative(value.totals.subscriptionTypes) ||
    !nonNegative(value.totals.publishedPolicies) ||
    !nonNegative(value.totals.draftPolicies) ||
    !nonNegative(value.totals.instances)
  )
    invalid();
  value.items.forEach(assertItem);
  return value as unknown as SubscriptionPolicyRegistryResult;
}

export interface SubscriptionPolicyRegistryClientOptions {
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly integrationToken?: string;
  readonly timeoutMs?: number;
  readonly environment?: 'production' | 'development' | 'test';
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
  readonly onMetric?: (metric: {
    readonly operation: 'subscription_policy_registry_read';
    readonly outcome: 'success' | 'rejected' | 'failure' | 'timeout';
    readonly durationMs: number;
    readonly statusClass?: '2xx' | '3xx' | '4xx' | '5xx';
  }) => void;
}

export class SubscriptionPolicyRegistryClient {
  private readonly baseUrl: URL;
  private readonly integrationToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: SubscriptionPolicyRegistryClientOptions) {
    const token = options.integrationToken?.trim();
    const timeoutMs = options.timeoutMs;
    if (
      !options.enabled ||
      !options.baseUrl ||
      !token ||
      !/^[!-~]{32,4096}$/.test(token) ||
      timeoutMs === undefined ||
      !positive(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 10_000
    )
      throw new SubscriptionPolicyRegistryError(
        'SUBSCRIPTION_POLICY_REGISTRY_CONFIGURATION_INVALID',
      );
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new SubscriptionPolicyRegistryError(
        'SUBSCRIPTION_POLICY_REGISTRY_CONFIGURATION_INVALID',
      );
    }
    const localHttp =
      (options.environment === 'development' || options.environment === 'test') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
    if (
      (baseUrl.protocol !== 'https:' && !localHttp) ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.hash ||
      baseUrl.search ||
      baseUrl.pathname !== '/'
    )
      throw new SubscriptionPolicyRegistryError(
        'SUBSCRIPTION_POLICY_REGISTRY_CONFIGURATION_INVALID',
      );
    this.baseUrl = baseUrl;
    this.integrationToken = token;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async read(correlationId: string): Promise<SubscriptionPolicyRegistryResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(correlationId))
      throw new SubscriptionPolicyRegistryError('SUBSCRIPTION_POLICY_REGISTRY_REQUEST_INVALID');
    const startedAt = (this.options.now ?? Date.now)();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(
        new URL(SUBSCRIPTION_POLICY_REGISTRY_PATH, this.baseUrl),
        {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'X-Correlation-ID': correlationId,
            'X-Subscriptions-Integration-Token': this.integrationToken,
          },
        },
      );
      const statusClass =
        response.status >= 500
          ? '5xx'
          : response.status >= 400
            ? '4xx'
            : response.status >= 300
              ? '3xx'
              : '2xx';
      if (!response.ok) {
        await response.body?.cancel();
        this.emit('rejected', startedAt, statusClass);
        throw new SubscriptionPolicyRegistryError(
          'SUBSCRIPTION_POLICY_REGISTRY_UNAVAILABLE',
          response.status,
        );
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > 1_048_576) {
        this.emit('failure', startedAt, statusClass);
        throw new SubscriptionPolicyRegistryError('SUBSCRIPTION_POLICY_REGISTRY_RESPONSE_INVALID');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        this.emit('failure', startedAt, statusClass);
        throw new SubscriptionPolicyRegistryError('SUBSCRIPTION_POLICY_REGISTRY_RESPONSE_INVALID');
      }
      const result = parseSubscriptionPolicyRegistryResult(parsed);
      this.emit('success', startedAt, statusClass);
      return result;
    } catch (error) {
      if (error instanceof SubscriptionPolicyRegistryError) throw error;
      this.emit(controller.signal.aborted ? 'timeout' : 'failure', startedAt, undefined);
      throw new SubscriptionPolicyRegistryError(
        controller.signal.aborted
          ? 'SUBSCRIPTION_POLICY_REGISTRY_TIMEOUT'
          : 'SUBSCRIPTION_POLICY_REGISTRY_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private emit(
    outcome: 'success' | 'rejected' | 'failure' | 'timeout',
    startedAt: number,
    statusClass?: '2xx' | '3xx' | '4xx' | '5xx',
  ): void {
    try {
      const now = (this.options.now ?? Date.now)();
      this.options.onMetric?.({
        operation: 'subscription_policy_registry_read',
        outcome,
        durationMs: Math.max(0, now - startedAt),
        ...(statusClass ? { statusClass } : {}),
      });
    } catch {
      /* telemetry cannot change the read */
    }
  }
}
