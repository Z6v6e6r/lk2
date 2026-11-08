import { createHash } from 'node:crypto';

/**
 * ADR 0028: read-only LK1 owner attestation of the actor's Viva account and subscriptions.
 * The browser never supplies these identifiers; only this strictly parsed owner response may
 * become an `integration.external_entity_map` mapping.
 */
export const PROVIDER_ACCOUNT_ATTESTATION_PATH =
  '/lk/integrations/v1/provider-account-attestations';
export const PROVIDER_ACCOUNT_ATTESTATION_SCOPE = 'lk1:provider-account:attest';
export const PROVIDER_ACCOUNT_ATTESTATION_TYP = 'phub-provider-account-attestation+jwt';
export const PROVIDER_ACCOUNT_TENANT_KEY = 'iSkq6G';
const MAX_SUBSCRIPTIONS = 50;
const MAX_BODY_BYTES = 32768;

export interface ProviderAccountAttestationRequest {
  readonly contractVersion: 1;
  readonly operationId: string;
  readonly target?: { readonly exerciseId: string };
}

export interface AttestedSubscription {
  readonly clientSubscriptionId: string;
  readonly productId: string | null;
  /** Null when the Viva subscription has no name. Display only. */
  readonly title: string | null;
  /** Display only; LK1 re-verifies on every command. NOT_ACTIVATED = Viva NEW, usable for JOIN. */
  readonly state: 'ACTIVE' | 'NOT_ACTIVATED' | 'PAUSED' | 'FINISHED';
  readonly remainingUnits: number | null;
  readonly validUntil: string | null;
}

export interface ProviderAccountTargetProof {
  readonly exerciseId: string;
  readonly startsAt: string;
  /** Owner-computed duration (1..1440); callers enforce their own allowed set. */
  readonly durationMinutes: number;
  readonly ownedClientSubscriptionIds: readonly string[];
  /**
   * Owned ids that LK1 judges applicable to this exact target under the money rules the former
   * lk2 Viva reader enforced (product, enforcement date, lifecycle, visits, activation, expiry,
   * freeze). lk2 requires the selected subscription here; absent field fails closed.
   */
  readonly eligibleClientSubscriptionIds: readonly string[];
}

export interface ProviderAccountAttestation {
  readonly contractVersion: 1;
  readonly operationId: string;
  readonly providerTenantKey: typeof PROVIDER_ACCOUNT_TENANT_KEY;
  readonly providerClientId: string;
  readonly subscriptions: readonly AttestedSubscription[];
  readonly attestedAt: string;
  readonly targetProof?: ProviderAccountTargetProof;
}

export type ProviderAccountOwnerErrorCode =
  'PROVIDER_ACCOUNT_UNAVAILABLE' | 'PROVIDER_ACCOUNT_FORBIDDEN' | 'PROVIDER_ACCOUNT_INVALID';

export class ProviderAccountOwnerError extends Error {
  constructor(
    public readonly code: ProviderAccountOwnerErrorCode,
    public readonly status: number,
  ) {
    super(code);
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const uuid = (v: unknown): v is string => typeof v === 'string' && uuidPattern.test(v);
const providerId = (v: unknown): v is string => typeof v === 'string' && providerIdPattern.test(v);
const iso = (v: unknown): v is string =>
  typeof v === 'string' && isoPattern.test(v) && Number.isFinite(Date.parse(v));
const exactKeys = (v: unknown, required: string, optional = ''): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = new Set([...required.split(','), ...optional.split(',')].filter(Boolean));
  const present = Object.keys(v);
  return (
    present.every((key) => allowed.has(key)) &&
    required
      .split(',')
      .filter(Boolean)
      .every((key) => Object.prototype.hasOwnProperty.call(v, key))
  );
};

const invalid = (): never => {
  throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_INVALID', 502);
};

export function parseProviderAccountAttestationRequest(
  value: unknown,
): ProviderAccountAttestationRequest {
  if (
    !exactKeys(value, 'contractVersion,operationId', 'target') ||
    value.contractVersion !== 1 ||
    !uuid(value.operationId)
  )
    throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_INVALID', 400);
  if (value.target === undefined) return { contractVersion: 1, operationId: value.operationId };
  if (!exactKeys(value.target, 'exerciseId') || !providerId(value.target.exerciseId))
    throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_INVALID', 400);
  return {
    contractVersion: 1,
    operationId: value.operationId,
    target: { exerciseId: value.target.exerciseId },
  };
}

/** Canonical request digest bound into the delegation as `request_sha256`. */
export function providerAccountAttestationRequestSha256(
  input: ProviderAccountAttestationRequest,
): string {
  const request = parseProviderAccountAttestationRequest(input);
  const canonical = {
    contractVersion: 1,
    operationId: request.operationId,
    target: request.target ? { exerciseId: request.target.exerciseId } : null,
  };
  return `sha256:${createHash('sha256')
    .update(`provider-account-attestation:v1\0${JSON.stringify(canonical)}`, 'utf8')
    .digest('hex')}`;
}

const displayTitle = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= 120 &&
  ![...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

function parseSubscription(value: unknown): AttestedSubscription {
  if (
    !exactKeys(value, 'clientSubscriptionId,productId,title,state,remainingUnits,validUntil') ||
    !providerId(value.clientSubscriptionId) ||
    !(value.productId === null || uuid(value.productId)) ||
    !(value.title === null || displayTitle(value.title)) ||
    !['ACTIVE', 'NOT_ACTIVATED', 'PAUSED', 'FINISHED'].includes(value.state as string) ||
    !(
      value.remainingUnits === null ||
      (Number.isInteger(value.remainingUnits) &&
        (value.remainingUnits as number) >= 0 &&
        (value.remainingUnits as number) <= 100000)
    ) ||
    !(value.validUntil === null || iso(value.validUntil))
  )
    return invalid();
  return {
    clientSubscriptionId: value.clientSubscriptionId,
    productId: value.productId,
    title: value.title,
    state: value.state as AttestedSubscription['state'],
    remainingUnits: value.remainingUnits as number | null,
    validUntil: value.validUntil,
  };
}

function parseTargetProof(value: unknown, exerciseId: string): ProviderAccountTargetProof {
  if (
    !exactKeys(
      value,
      'exerciseId,startsAt,durationMinutes,ownedClientSubscriptionIds,eligibleClientSubscriptionIds',
    ) ||
    value.exerciseId !== exerciseId ||
    !iso(value.startsAt) ||
    !Number.isInteger(value.durationMinutes) ||
    (value.durationMinutes as number) < 1 ||
    (value.durationMinutes as number) > 1440 ||
    !Array.isArray(value.ownedClientSubscriptionIds) ||
    value.ownedClientSubscriptionIds.length > MAX_SUBSCRIPTIONS ||
    !value.ownedClientSubscriptionIds.every(providerId) ||
    new Set(value.ownedClientSubscriptionIds).size !== value.ownedClientSubscriptionIds.length ||
    !Array.isArray(value.eligibleClientSubscriptionIds) ||
    value.eligibleClientSubscriptionIds.length > MAX_SUBSCRIPTIONS ||
    !value.eligibleClientSubscriptionIds.every(providerId) ||
    new Set(value.eligibleClientSubscriptionIds).size !== value.eligibleClientSubscriptionIds.length
  )
    return invalid();
  const owned = new Set(value.ownedClientSubscriptionIds.map((id) => id.toLowerCase()));
  if (!value.eligibleClientSubscriptionIds.every((id) => owned.has(id.toLowerCase())))
    return invalid();
  return {
    exerciseId,
    startsAt: value.startsAt,
    durationMinutes: value.durationMinutes as number,
    ownedClientSubscriptionIds: [...value.ownedClientSubscriptionIds],
    eligibleClientSubscriptionIds: [...value.eligibleClientSubscriptionIds],
  };
}

export function parseProviderAccountAttestation(
  value: unknown,
  request: ProviderAccountAttestationRequest,
  now: number = Date.now(),
): ProviderAccountAttestation {
  const withTarget = request.target !== undefined;
  if (
    !exactKeys(
      value,
      'contractVersion,operationId,providerTenantKey,providerClientId,subscriptions,attestedAt' +
        (withTarget ? ',targetProof' : ''),
    ) ||
    value.contractVersion !== 1 ||
    value.operationId !== request.operationId ||
    value.providerTenantKey !== PROVIDER_ACCOUNT_TENANT_KEY ||
    !providerId(value.providerClientId) ||
    !Array.isArray(value.subscriptions) ||
    value.subscriptions.length > MAX_SUBSCRIPTIONS ||
    !iso(value.attestedAt) ||
    // An attestation is a fresh owner read: reject clocks skewed by more than two minutes.
    Math.abs(Date.parse(value.attestedAt) - now) > 120_000
  )
    return invalid();
  const subscriptions = value.subscriptions.map(parseSubscription);
  if (new Set(subscriptions.map((s) => s.clientSubscriptionId)).size !== subscriptions.length)
    return invalid();
  const result: ProviderAccountAttestation = {
    contractVersion: 1,
    operationId: request.operationId,
    providerTenantKey: PROVIDER_ACCOUNT_TENANT_KEY,
    providerClientId: value.providerClientId,
    subscriptions,
    attestedAt: value.attestedAt,
  };
  if (!request.target) return result;
  const targetProof = parseTargetProof(value.targetProof, request.target.exerciseId);
  // lk#303: the proof covers every subscription of the account, not only the <=50 listed ones.
  return { ...result, targetProof };
}

interface Envelope {
  readonly actorDelegation: string;
  readonly actorToken: { readonly token: string; readonly expiresAt: string };
  readonly correlationId: string;
}

/** LK1 error bodies are `{code}` only; classification is by HTTP status (lk#303 contract). */
const statusCode = (status: number): ProviderAccountOwnerErrorCode =>
  status === 401 || status === 403
    ? 'PROVIDER_ACCOUNT_FORBIDDEN'
    : status === 400 || status === 409
      ? 'PROVIDER_ACCOUNT_INVALID'
      : 'PROVIDER_ACCOUNT_UNAVAILABLE';

/** Server-to-server LK1 client. One bounded call; the caller owns retry policy. */
export class ProviderAccountOwnerClient {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly environment: 'development' | 'production';
      readonly timeoutMs: number;
      readonly fetchImplementation?: typeof fetch;
      readonly now?: () => number;
    },
  ) {
    const url = new URL(options.baseUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          options.environment === 'development' &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 100 ||
      options.timeoutMs > 5000
    )
      throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_UNAVAILABLE', 503);
  }

  async attest(
    request: ProviderAccountAttestationRequest,
    envelope: Envelope,
  ): Promise<ProviderAccountAttestation> {
    const body = parseProviderAccountAttestationRequest(request);
    const now = this.options.now ?? Date.now;
    if (
      !/^[!-~]{1,4096}$/.test(envelope.actorDelegation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.correlationId) ||
      !/^[!-~]{16,4096}$/.test(envelope.actorToken.token) ||
      !Number.isFinite(Date.parse(envelope.actorToken.expiresAt)) ||
      Date.parse(envelope.actorToken.expiresAt) <= now()
    )
      throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_INVALID', 400);
    if (now() < this.openUntil)
      throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_UNAVAILABLE', 503);
    const url = new URL(PROVIDER_ACCOUNT_ATTESTATION_PATH, this.options.baseUrl).href;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ProviderAccountOwnerError('PROVIDER_ACCOUNT_UNAVAILABLE', 504));
      }, this.options.timeoutMs);
    });
    const work = async (): Promise<ProviderAccountAttestation> => {
      const response = await (this.options.fetchImplementation ?? fetch)(url, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Subscription-Actor-Delegation': envelope.actorDelegation,
          'X-Subscription-Actor-Token': envelope.actorToken.token,
          'X-Correlation-ID': envelope.correlationId,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok || (response.url && response.url !== url)) {
        await response.body?.cancel();
        throw new ProviderAccountOwnerError(
          response.ok ? 'PROVIDER_ACCOUNT_UNAVAILABLE' : statusCode(response.status),
          response.status,
        );
      }
      const text = await readBounded(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return invalid();
      }
      return parseProviderAccountAttestation(parsed, body, now());
    };
    try {
      const result = await Promise.race([work(), deadline]);
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      // Only LK1-wide transport failures open the shared circuit: network errors and our own
      // deadline. HTTP answers (including an actor-scoped 503 or 429) never block other users.
      if (
        !(error instanceof ProviderAccountOwnerError) ||
        (error.code === 'PROVIDER_ACCOUNT_UNAVAILABLE' && error.status === 504)
      ) {
        this.failures += 1;
        if (this.failures >= 3) {
          this.openUntil = now() + 30_000;
          this.failures = 0;
        }
      }
      if (error instanceof ProviderAccountOwnerError) throw error;
      throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_UNAVAILABLE', 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_UNAVAILABLE', 503);
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ProviderAccountOwnerError('PROVIDER_ACCOUNT_INVALID', 502);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return text;
}
