import { createHash } from 'node:crypto';

import type { AppConfig } from '@phub/config';
import type { GameRepository } from '@phub/database';
import {
  parseCommercialBindingRefs,
  type CommercialBindingRefs,
} from '@phub/subscription-runtime-adapter';

import {
  isCommercialCreateFailureCode,
  type CommercialCreateFailureCode,
  type CommercialCreateOwnerOutcome,
  type CommercialCreateOwnerPort,
  type CommercialCreateOwnerRequest,
  type CommercialCreateQuote,
  type CommercialCreateReceiptView,
} from './game-create-commercial.js';

/**
 * Owner transports and runtime composition for the managed commercial CREATE contour.
 *
 * The WARN contour is observation-only: the only activatable transport is the advisory owner,
 * which never prices, reserves, charges or books. The booked-operation transport is the future
 * ENFORCE client for the frozen LK2 -> LK1 reserve/confirm/release contract; it is implemented
 * here so the ENFORCE slice can be wired without a second transport, but it must not be activated
 * before the LK1 CREATE receiver and its approval exist (`packages/config` rejects
 * `GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT=BOOKED_OPERATION` at load time today).
 *
 * Contract and decision record: docs/contracts/game-commercial-create.md.
 */

const advisoryQuoteValidityMs = 15 * 60_000;
const circuitFailureThreshold = 3;
const circuitOpenMs = 10_000;
const reserveResponseLimitBytes = 2_048;
const confirmResponseLimitBytes = 8_192;
/** Public identifier shape used by the managed subscription-runtime contract. */
const ownerIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const ownerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const correlationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const actorDelegationPattern = /^[!-~]{1,4096}$/;
const boundedReferencePattern = /^[!-~]{1,200}$/;
const policyDigestPattern = /^sha256:[a-f0-9]{64}$/;
const managedCreatePaymentModes: readonly string[] = ['SPLIT', 'SUBSCRIPTION'];
const managedCreatePaymentIntents: readonly string[] = [
  'USE_SUBSCRIPTION',
  'AUTO_BEST_PRICE',
  'PAY_FULL_PRICE',
];
const configurationInvalidCode = 'GAME_COMMERCIAL_CREATE_OWNER_CONFIGURATION_INVALID';
const responseInvalidCode = 'GAME_COMMERCIAL_CREATE_OWNER_RESPONSE_INVALID';
const quoteTransportUnavailableCode = 'GAME_COMMERCIAL_CREATE_QUOTE_TRANSPORT_UNAVAILABLE';

function emitMetric(onMetric: ((metric: string) => void) | undefined, metric: string): void {
  try {
    onMetric?.(metric);
  } catch {
    /* Telemetry can never change a commercial decision. */
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** True when the request carries only server-derived, well-formed identifiers and enums. */
/**
 * B2 binding evidence is validated with the shared strict parser before it can reach a wire body,
 * so a malformed decision can never be sent as if it were an authorising reference.
 */
function wellFormedBindingRefs(value: CommercialBindingRefs | undefined): boolean {
  if (value === undefined) return true;
  try {
    parseCommercialBindingRefs(value);
    return true;
  } catch {
    return false;
  }
}

function isWellFormedOwnerRequest(input: CommercialCreateOwnerRequest): boolean {
  return (
    wellFormedBindingRefs(input.bindingRefs) &&
    ownerUuid.test(input.tenantId) &&
    ownerUuid.test(input.userId) &&
    ownerUuid.test(input.operationId) &&
    ownerUuid.test(input.draftGameId) &&
    input.tenantKey.length > 0 &&
    input.tenantKey.length <= 64 &&
    input.sessionId.length > 0 &&
    input.sessionId.length <= 200 &&
    input.idempotencyKey.length > 0 &&
    input.idempotencyKey.length <= 200 &&
    correlationIdPattern.test(input.correlationId) &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision >= 1 &&
    managedCreatePaymentModes.includes(input.paymentMode) &&
    managedCreatePaymentIntents.includes(input.paymentIntent)
  );
}

/**
 * Advisory (WARN) owner for managed commercial CREATE.
 *
 * Owner: P0 commercial CREATE. Purpose: let the WARN contour take a server-owned, recorded quote
 * and an owner consultation without granting this process price authority, without a provider
 * call, without a charge or booking, and without a network dependency.
 *
 * Activation: `GAME_COMMERCIAL_CREATE_ENABLED=true` with the default `ADVISORY` transport. This is
 * the only activatable transport in this release.
 * Removal/review condition: remove or replace when the LK1 reserve/confirm/release contract is
 * approved and the authoritative owner transport becomes the active path.
 *
 * The implementation is deterministic (no clock read outside the injected `now`, no random value)
 * and structurally cannot call `fetch`: an advisory reserve reports `SKIPPED_ADVISORY`.
 */
export function createAdvisoryCommercialCreateOwner(
  options: {
    readonly now?: () => number;
    readonly onMetric?: (metric: string) => void;
  } = {},
): CommercialCreateOwnerPort {
  const currentTime = options.now ?? Date.now;
  const onMetric = options.onMetric;
  return {
    quote(input) {
      const evaluatedAtMs = currentTime();
      // Advisory decisions only need a stable, OpenAPI-pattern-compatible id for observation and
      // deduplication in logs. It is derived from verified claims and the derived operation target.
      const decisionFingerprint = createHash('sha256')
        .update(
          `game-commercial-create:v1\0advisory-decision\0${input.tenantId}\0${input.userId}\0${input.operationId}\0${input.draftGameId}`,
          'utf8',
        )
        .digest('hex')
        .slice(0, 32);
      const quote: CommercialCreateQuote = {
        basis: 'ADVISORY',
        decisionId: `advisory:${decisionFingerprint}`,
        outcome: 'ALLOWED',
        price: null,
        reasonCodes: [],
        evaluatedAt: new Date(evaluatedAtMs).toISOString(),
        expiresAt: new Date(evaluatedAtMs + advisoryQuoteValidityMs).toISOString(),
      };
      return Promise.resolve(quote);
    },
    reserve() {
      // No reservation, no booking, no charge: the local PROVISIONING game stays PENDING for the
      // future ENFORCE/reconciliation slice.
      emitMetric(onMetric, 'advisory_reserve_skipped');
      return Promise.resolve({
        status: 'SKIPPED_ADVISORY',
        reason: 'GAME_COMMERCIAL_CREATE_WARN',
      } as const);
    },
    read() {
      // Nothing owner-side exists behind an advisory quote, so there is nothing to read.
      return Promise.resolve({ status: 'UNKNOWN' } as const);
    },
    release() {
      emitMetric(onMetric, 'advisory_release');
      return Promise.resolve();
    },
  };
}

/** Frozen LK2 -> LK1 reserve/confirm/release paths of the managed subscription-runtime contract. */
export const COMMERCIAL_CREATE_OWNER_RESERVE_PATH =
  '/api/internal/subscription-runtime/lk2/v1/reserve';
export const COMMERCIAL_CREATE_OWNER_CONFIRM_PATH =
  '/api/internal/subscription-runtime/lk2/v1/confirm';
export const COMMERCIAL_CREATE_OWNER_RELEASE_PATH =
  '/api/internal/subscription-runtime/lk2/v1/release';

/**
 * Everything the actor-delegation issuer needs to mint one single-use `CREATE_GAME` delegation.
 * `requestSha256` binds the delegation to the exact JSON body sent on this wire call (prefixed
 * `sha256:`), so a replayed or altered request cannot reuse the delegation.
 */
export interface CommercialCreateDelegationInput {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly action: 'CREATE_GAME';
  readonly requestSha256: string;
}

export interface BookedOperationCreateOwnerClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly environment: 'development' | 'production';
  readonly issueDelegation: (input: CommercialCreateDelegationInput) => Promise<string>;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
  readonly onMetric?: (metric: string) => void;
}

/** Trusted-receipt exchange input. Only the future ENFORCE slice may call this. */
export interface CommercialCreateConfirmInput {
  readonly request: CommercialCreateOwnerRequest;
  readonly reservationId: string;
}

export type CommercialCreateConfirmOutcome =
  | { readonly status: 'CONFIRMED'; readonly receipt: CommercialCreateReceiptView }
  | { readonly status: 'UNKNOWN' };

/**
 * Internal LK1 confirm wire receipt. The identifiers are transport-internal evidence: they are
 * validated here and never exposed to a client. Only the public-safe
 * `CommercialCreateReceiptView` (`provider`, `status`, `confirmedAt`) leaves this module.
 */
interface Lk1CreateReceipt {
  readonly receiptId: string;
  readonly confirmedAt: string;
  readonly appliedRule: string;
  readonly usageRef: string;
  readonly bookingRef: string;
  readonly policyVersion?: number;
  readonly policyDigest?: string;
  readonly decisionId?: string;
}

export interface CommercialCreateReleaseInput {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly operationId: string;
  readonly reason: 'LOCAL_WRITE_REJECTED' | 'RECONCILIATION';
  /** Recovery may name the reservation instead of only the operation. */
  readonly reservationId?: string;
}

/** Internal booked-operation surface. Only the exported factories below may build it. */
interface BookedOperationCreateOwnerTransport {
  readonly port: CommercialCreateOwnerPort;
  readonly confirm: (
    input: CommercialCreateConfirmInput,
  ) => Promise<CommercialCreateConfirmOutcome>;
  readonly release: (input: CommercialCreateReleaseInput) => Promise<void>;
}

type TransportOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'circuit_open' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failure' };

class CommercialCreateOwnerTimeoutError extends Error {
  constructor() {
    super('GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT');
    this.name = 'CommercialCreateOwnerTimeoutError';
  }
}

function validatedOwnerBaseUrl(options: BookedOperationCreateOwnerClientOptions): string {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new Error(configurationInvalidCode);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(options.environment === 'development' && loopback && url.protocol === 'http:')) ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 5_000
  ) {
    throw new Error(configurationInvalidCode);
  }
  return url.toString();
}

/** `sha256:` over the exact JSON body this call sends; binds one delegation to one request. */
function ownerRequestSha256(body: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')}`;
}

function ownerReserveBody(
  input: CommercialCreateOwnerRequest & { readonly quote: CommercialCreateQuote | null },
): {
  readonly operationId: string;
  readonly action: 'CREATE_GAME';
  readonly target: {
    readonly kind: 'GAME';
    readonly id: string;
    readonly expectedRevision: number;
  };
  readonly paymentMode: string;
  readonly paymentIntent: string;
  readonly preferredSubscriptionInstanceId: string | null;
  readonly priceSnapshot: { readonly amountMinor: number; readonly currency: string } | null;
  readonly policyRef?: { readonly policyVersion: number; readonly policyDigest: string };
  readonly decisionId?: string;
  readonly usageRef?: { readonly usageRef: string; readonly reservationUnits?: number };
} {
  const price = input.quote?.price ?? null;
  return {
    operationId: input.operationId,
    action: 'CREATE_GAME',
    target: {
      kind: 'GAME',
      id: input.draftGameId,
      expectedRevision: input.expectedRevision,
    },
    paymentMode: input.paymentMode,
    paymentIntent: input.paymentIntent,
    preferredSubscriptionInstanceId: input.preferredSubscriptionInstanceId ?? null,
    priceSnapshot:
      price === null ? null : { amountMinor: price.amountMinor, currency: price.currency },
    ...(input.bindingRefs
      ? {
          policyRef: input.bindingRefs.policyRef,
          ...(input.bindingRefs.decisionId === undefined
            ? {}
            : { decisionId: input.bindingRefs.decisionId }),
          ...(input.bindingRefs.usageRef === undefined
            ? {}
            : { usageRef: input.bindingRefs.usageRef }),
        }
      : {}),
  };
}

function isValidPriceSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.amountMinor === 'number' &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor >= 0 &&
    value.currency === 'RUB'
  );
}

function isValidPolicyVersion(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0 && value.length <= 200;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict reservation response guard: a malformed owner body must never read as a reservation.
 * When the request carried a B2 binding, the owner response must echo the same decision, otherwise
 * the reservation is not bound and reads as UNKNOWN (reconciliation), never as an authorisation.
 */
function isValidReservationResponse(value: unknown, expected?: CommercialBindingRefs): boolean {
  if (
    !isRecord(value) ||
    typeof value.reservationId !== 'string' ||
    !ownerUuid.test(value.reservationId) ||
    !isInstant(value.expiresAt) ||
    !isValidPolicyVersion(value.policyVersion) ||
    !(value.priceSnapshot === null || isValidPriceSnapshot(value.priceSnapshot))
  )
    return false;
  if (
    value.policyDigest !== undefined &&
    (typeof value.policyDigest !== 'string' || !policyDigestPattern.test(value.policyDigest))
  )
    return false;
  if (value.decisionId !== undefined) {
    if (typeof value.decisionId !== 'string' || !ownerUuid.test(value.decisionId)) return false;
  }
  if (value.reservedUnits !== undefined) {
    if (
      typeof value.reservedUnits !== 'number' ||
      !Number.isSafeInteger(value.reservedUnits) ||
      value.reservedUnits < 1
    )
      return false;
  }
  if (value.remainingUnits !== undefined) {
    if (
      typeof value.remainingUnits !== 'number' ||
      !Number.isSafeInteger(value.remainingUnits) ||
      value.remainingUnits < 0
    )
      return false;
  }
  if (expected === undefined) return true;
  if (value.policyVersion !== expected.policyRef.policyVersion) return false;
  if (value.policyDigest !== expected.policyRef.policyDigest) return false;
  if (expected.decisionId !== undefined && value.decisionId !== expected.decisionId) return false;
  if (
    expected.usageRef?.reservationUnits !== undefined &&
    value.reservedUnits !== expected.usageRef.reservationUnits
  )
    return false;
  return true;
}

function typedRefusalCode(value: unknown): CommercialCreateFailureCode | undefined {
  if (!isRecord(value)) return undefined;
  const reason = value.reason;
  return typeof reason === 'string' && isCommercialCreateFailureCode(reason) ? reason : undefined;
}

/**
 * Trusted receipt guard: every frozen field is required and bounded, nothing is taken on trust.
 * When the request carried a B2 binding, the receipt must echo the same policy decision and usage
 * reservation; a mismatch is UNKNOWN (reconciliation), never a confirmed receipt.
 */
function trustedReceipt(
  value: unknown,
  expected?: CommercialBindingRefs,
): Lk1CreateReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const { receiptId, confirmedAt, appliedRule, usageRef, bookingRef } = value;
  if (typeof receiptId !== 'string' || !ownerIdentifier.test(receiptId)) return undefined;
  if (!isInstant(confirmedAt)) return undefined;
  if (typeof appliedRule !== 'string' || !boundedReferencePattern.test(appliedRule))
    return undefined;
  if (typeof usageRef !== 'string' || !boundedReferencePattern.test(usageRef)) return undefined;
  if (typeof bookingRef !== 'string' || !boundedReferencePattern.test(bookingRef)) return undefined;
  const policyVersion = value.policyVersion;
  const policyDigest = value.policyDigest;
  const decisionId = value.decisionId;
  if (policyVersion !== undefined) {
    if (
      typeof policyVersion !== 'number' ||
      !Number.isSafeInteger(policyVersion) ||
      policyVersion < 1
    )
      return undefined;
  }
  if (policyDigest !== undefined) {
    if (typeof policyDigest !== 'string' || !policyDigestPattern.test(policyDigest))
      return undefined;
  }
  if (decisionId !== undefined) {
    if (typeof decisionId !== 'string' || !ownerUuid.test(decisionId)) return undefined;
  }
  const receipt: Lk1CreateReceipt = {
    receiptId,
    confirmedAt,
    appliedRule,
    usageRef,
    bookingRef,
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(policyDigest === undefined ? {} : { policyDigest }),
    ...(decisionId === undefined ? {} : { decisionId }),
  };
  if (expected === undefined) return receipt;
  if (receipt.policyVersion !== expected.policyRef.policyVersion) return undefined;
  if (receipt.policyDigest !== expected.policyRef.policyDigest) return undefined;
  if (expected.decisionId !== undefined && receipt.decisionId !== expected.decisionId)
    return undefined;
  if (expected.usageRef !== undefined && receipt.usageRef !== expected.usageRef.usageRef)
    return undefined;
  return receipt;
}

/** Only the public-safe receipt projection crosses the API boundary. */
function publicReceiptView(receipt: Lk1CreateReceipt): CommercialCreateReceiptView {
  return { provider: 'VIVA', status: 'CONFIRMED', confirmedAt: receipt.confirmedAt };
}

async function readBoundedJsonBody(response: Response, limitBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(responseInvalidCode);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > limitBytes) throw new Error(responseInvalidCode);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed;
}

/** An error/refusal body is optional evidence; a body that cannot be parsed is simply absent. */
async function readOptionalJsonBody(response: Response, limitBytes: number): Promise<unknown> {
  try {
    return await readBoundedJsonBody(response, limitBytes);
  } catch {
    return null;
  }
}

/**
 * Booked-operation owner client: the future ENFORCE transport for the frozen LK2 -> LK1
 * reserve/confirm/release contract.
 *
 * NOT activatable in this release. `packages/config` rejects
 * `GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT=BOOKED_OPERATION` at load time and the LK1 CREATE
 * receiver does not exist yet (it answers `503 BOOKED_OPERATION_CREATE_ADMISSION_UNAVAILABLE`).
 *
 * Activation: only after the LK1 reserve/confirm/release contract has its own approval and the
 * configuration gate is opened. Removal/review condition: replace this client when the LK1
 * receiver ships a shared adapter.
 *
 * Safety properties: bounded timeout with `AbortController`, `redirect: 'error'`, no automatic
 * write retry (a lost response is recovered only by repeating the same `operationId`), strict
 * response validation, a bounded circuit breaker (3 consecutive failures open for 10s, then a
 * single half-open probe) and redacted metrics only — never a token, body or identifier.
 *
 * The authoritative `quote()` is intentionally unavailable: the LK1 quote wire contract needs a
 * draft target the deployed quote receiver does not serve yet, and guessing a price here would
 * grant this process price authority. The orchestrator already treats a quote failure as
 * observation-only in WARN.
 */
export function createBookedOperationCreateOwnerClient(
  options: BookedOperationCreateOwnerClientOptions,
): CommercialCreateOwnerPort {
  return buildBookedOperationCreateOwnerTransport(options).port;
}

/**
 * Standalone trusted-receipt exchange for the future ENFORCE slice. The frozen WARN port has no
 * `confirm` member (only optional `read`/`release`), so the exchange is a function rather than a
 * port method and the orchestrator file stays untouched.
 *
 * This is a single recovery exchange: it builds its own bounded transport state, issues one
 * delegation bound to the confirm body, sends exactly one POST, and never retries. The long-lived
 * reserve client keeps the reserve circuit; confirm reports `UNKNOWN` on every non-trusted answer
 * and only a strictly validated LK1 receipt maps to the public-safe receipt view.
 */
export function confirmCommercialCreateReservation(
  options: BookedOperationCreateOwnerClientOptions,
  input: CommercialCreateConfirmInput,
): Promise<CommercialCreateConfirmOutcome> {
  return buildBookedOperationCreateOwnerTransport(options).confirm(input);
}

/**
 * Reservation-aware release for the future ENFORCE recovery path. The frozen WARN port `release`
 * input carries no reservation id, so the wire contract's optional `reservationId` is reachable
 * only through this standalone function. Like the port release it is idempotent by operation id,
 * never retried and never throws.
 */
export function releaseCommercialCreateReservation(
  options: BookedOperationCreateOwnerClientOptions,
  input: CommercialCreateReleaseInput,
): Promise<void> {
  return buildBookedOperationCreateOwnerTransport(options).release(input);
}

function buildBookedOperationCreateOwnerTransport(
  options: BookedOperationCreateOwnerClientOptions,
): BookedOperationCreateOwnerTransport {
  const baseUrl = validatedOwnerBaseUrl(options);
  const currentTime = options.now ?? Date.now;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const emit = (metric: string): void => emitMetric(options.onMetric, metric);
  const circuit = { failures: 0, openUntil: 0, failureVersion: 0, probeInFlight: false };

  const resetIfUnchanged = (version: number): void => {
    if (version !== circuit.failureVersion) return;
    circuit.failures = 0;
    circuit.openUntil = 0;
  };

  const dispatch = async (input: {
    readonly path: string;
    readonly body: unknown;
    readonly actor: {
      readonly tenantId: string;
      readonly tenantKey: string;
      readonly userId: string;
      readonly sessionId: string;
      readonly operationId: string;
      readonly correlationId: string;
      readonly idempotencyKey: string;
    };
    readonly responseLimit: number;
    readonly circuit: 'write' | 'none';
  }): Promise<TransportOutcome> => {
    const guarded = input.circuit === 'write';
    if (guarded && (circuit.openUntil > currentTime() || circuit.probeInFlight))
      return { kind: 'circuit_open' };
    const halfOpen = guarded && circuit.openUntil !== 0;
    const failureVersion = circuit.failureVersion;
    if (guarded && halfOpen) circuit.probeInFlight = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CommercialCreateOwnerTimeoutError());
      }, options.timeoutMs);
    });
    const execute = async (): Promise<TransportOutcome> => {
      let delegation: string;
      try {
        delegation = await options.issueDelegation({
          tenantId: input.actor.tenantId,
          tenantKey: input.actor.tenantKey,
          userId: input.actor.userId,
          sessionId: input.actor.sessionId,
          operationId: input.actor.operationId,
          correlationId: input.actor.correlationId,
          idempotencyKey: input.actor.idempotencyKey,
          action: 'CREATE_GAME',
          requestSha256: ownerRequestSha256(input.body),
        });
      } catch {
        // No delegation, no owner write: the operation stays unresolved instead of being retried.
        return { kind: 'failure' };
      }
      if (!actorDelegationPattern.test(delegation)) return { kind: 'failure' };
      // No automatic write retry: exactly one POST per call, whatever happens afterwards.
      const response = await fetchImplementation(new URL(input.path, baseUrl), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': input.actor.correlationId,
          'Idempotency-Key': input.actor.idempotencyKey,
          'X-Subscription-Actor-Delegation': delegation,
        },
        body: JSON.stringify(input.body),
      });
      if (response.status === 409) {
        await response.body?.cancel();
        resetIfUnchanged(failureVersion);
        return { kind: 'response', status: 409, body: null };
      }
      if (response.status >= 500) {
        await response.body?.cancel();
        return { kind: 'failure' };
      }
      if (response.status < 200 || response.status >= 300) {
        const refusal = await readOptionalJsonBody(response, reserveResponseLimitBytes);
        resetIfUnchanged(failureVersion);
        return { kind: 'response', status: response.status, body: refusal };
      }
      const body = await readBoundedJsonBody(response, input.responseLimit);
      resetIfUnchanged(failureVersion);
      return { kind: 'response', status: response.status, body };
    };
    let outcome: TransportOutcome;
    try {
      outcome = await Promise.race([execute(), deadline]);
    } catch (error) {
      outcome =
        error instanceof CommercialCreateOwnerTimeoutError ||
        (error instanceof Error && error.name === 'AbortError')
          ? { kind: 'timeout' }
          : { kind: 'failure' };
    } finally {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (guarded && halfOpen) circuit.probeInFlight = false;
    }
    if (guarded && (outcome.kind === 'failure' || outcome.kind === 'timeout')) {
      circuit.failures += 1;
      circuit.failureVersion += 1;
      if (halfOpen || circuit.failures >= circuitFailureThreshold)
        circuit.openUntil = currentTime() + circuitOpenMs;
    }
    return outcome;
  };

  const reserve = async (
    input: CommercialCreateOwnerRequest & { readonly quote: CommercialCreateQuote | null },
  ): Promise<CommercialCreateOwnerOutcome> => {
    if (!isWellFormedOwnerRequest(input)) {
      emit('reserve_failure');
      return { status: 'UNKNOWN' };
    }
    const outcome = await dispatch({
      path: COMMERCIAL_CREATE_OWNER_RESERVE_PATH,
      body: ownerReserveBody(input),
      actor: input,
      responseLimit: reserveResponseLimitBytes,
      circuit: 'write',
    });
    if (outcome.kind === 'circuit_open') {
      emit('reserve_circuit_open');
      return { status: 'UNKNOWN' };
    }
    if (outcome.kind === 'timeout') {
      emit('reserve_timeout');
      return { status: 'UNKNOWN' };
    }
    if (outcome.kind === 'failure') {
      emit('reserve_failure');
      return { status: 'UNKNOWN' };
    }
    if (outcome.status === 409) {
      // A conflict is resolved by repeating the same operationId, never by a replacement write.
      emit('reserve_conflict');
      return { status: 'UNKNOWN' };
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      if (!isValidReservationResponse(outcome.body, input.bindingRefs)) {
        emit('reserve_failure');
        return { status: 'UNKNOWN' };
      }
      // A reservation is not financial success. The frozen WARN port outcome carries no
      // reservation view, so it is validated and recorded as PENDING for the ENFORCE slice.
      emit('reserve_success');
      return { status: 'PENDING' };
    }
    const code = typedRefusalCode(outcome.body);
    if (code !== undefined) {
      emit('reserve_rejected');
      return { status: 'REJECTED', code };
    }
    emit('reserve_failure');
    return { status: 'UNKNOWN' };
  };

  const confirm = async (
    input: CommercialCreateConfirmInput,
  ): Promise<CommercialCreateConfirmOutcome> => {
    const request = input.request;
    if (!isWellFormedOwnerRequest(request) || !ownerUuid.test(input.reservationId)) {
      emit('confirm_unknown');
      return { status: 'UNKNOWN' };
    }
    const outcome = await dispatch({
      path: COMMERCIAL_CREATE_OWNER_CONFIRM_PATH,
      body: { operationId: request.operationId, reservationId: input.reservationId },
      actor: request,
      responseLimit: confirmResponseLimitBytes,
      circuit: 'write',
    });
    if (outcome.kind !== 'response' || outcome.status < 200 || outcome.status >= 300) {
      emit('confirm_unknown');
      return { status: 'UNKNOWN' };
    }
    const receipt = trustedReceipt(outcome.body, request.bindingRefs);
    if (receipt === undefined) {
      emit('confirm_unknown');
      return { status: 'UNKNOWN' };
    }
    emit('confirm_success');
    // Only the public-safe view leaves the transport: receiptId/appliedRule/usageRef/bookingRef
    // stay internal owner evidence.
    return { status: 'CONFIRMED', receipt: publicReceiptView(receipt) };
  };

  const release = async (input: CommercialCreateReleaseInput): Promise<void> => {
    try {
      if (!ownerUuid.test(input.operationId)) return;
      await dispatch({
        path: COMMERCIAL_CREATE_OWNER_RELEASE_PATH,
        // The receiver releases by operation id and, when known, by reservation id.
        body: {
          operationId: input.operationId,
          ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
        },
        actor: {
          tenantId: input.tenantId,
          tenantKey: input.tenantKey,
          userId: input.userId,
          sessionId: input.sessionId,
          operationId: input.operationId,
          correlationId: input.correlationId,
          // The frozen port release input carries no request key of its own. The operation id is
          // its stable idempotency binding; a repeated release must stay the same release.
          idempotencyKey: input.operationId,
        },
        responseLimit: reserveResponseLimitBytes,
        // Recovery must not be blocked by the reserve circuit, and release failures must not feed
        // it either: this is a best-effort rollback path whose caller stays on reconciliation.
        circuit: 'none',
      });
    } catch {
      /* Recovery path: release swallows every transport error and never retries a write. */
    } finally {
      emit('release');
    }
  };

  return {
    port: {
      quote() {
        return Promise.reject(new Error(quoteTransportUnavailableCode));
      },
      reserve,
      release,
    },
    confirm,
    release,
  };
}

/** Options the Lead wires into the routes; the route keeps its old refusal when this is absent. */
export interface GameCommercialCreateOptions {
  readonly repository: Pick<GameRepository, 'create'>;
  readonly owner: CommercialCreateOwnerPort;
}

type CommercialCreateConfig = Pick<
  AppConfig,
  | 'APP_ENV'
  | 'GAME_COMMERCIAL_CREATE_ENABLED'
  | 'GAME_COMMERCIAL_CREATE_OWNER_BASE_URL'
  | 'GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS'
  | 'GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT'
>;

export interface GameCommercialCreateRuntimeOptions {
  readonly config: CommercialCreateConfig;
  readonly repository: Pick<GameRepository, 'create'>;
  /**
   * Future ENFORCE boundary. It issues the single-use `CREATE_GAME` actor delegation from the
   * existing subscription-runtime delegation issuer. Without it the booked-operation transport
   * fails closed and the runtime factory returns `undefined`.
   */
  readonly bookedOperationBoundary?: {
    readonly issueCreateDelegation: (input: CommercialCreateDelegationInput) => Promise<string>;
  };
  readonly onMetric?: (metric: string) => void;
}

function environment(config: CommercialCreateConfig): 'development' | 'production' {
  return config.APP_ENV === 'local' || config.APP_ENV === 'ci' ? 'development' : 'production';
}

/**
 * Runtime composition of the managed commercial CREATE path.
 *
 * Owner: P0 commercial CREATE. Purpose: compose the owner port together with the existing games
 * write owner so the route can execute the WARN contour. Activation:
 * `GAME_COMMERCIAL_CREATE_ENABLED=true`; the default `ADVISORY` transport needs no network.
 * Removal/review condition: review with the flag at the next delivery batch and replace the
 * advisory owner when ENFORCE is approved.
 *
 * Fail-closed: when the flag is off, or when `BOOKED_OPERATION` is requested without both the
 * delegation boundary and an owner base URL, the factory returns `undefined` and the route keeps
 * answering `GAME_PAYMENT_REQUIRED` exactly as before.
 */
export function createGameCommercialCreateRuntime(
  options: GameCommercialCreateRuntimeOptions,
): GameCommercialCreateOptions | undefined {
  const { config } = options;
  if (!config.GAME_COMMERCIAL_CREATE_ENABLED) return undefined;
  if (config.GAME_COMMERCIAL_CREATE_OWNER_TRANSPORT === 'BOOKED_OPERATION') {
    const baseUrl = config.GAME_COMMERCIAL_CREATE_OWNER_BASE_URL;
    const boundary = options.bookedOperationBoundary;
    if (!boundary || !baseUrl) return undefined;
    return {
      repository: options.repository,
      owner: createBookedOperationCreateOwnerClient({
        baseUrl,
        timeoutMs: config.GAME_COMMERCIAL_CREATE_OWNER_TIMEOUT_MS,
        environment: environment(config),
        issueDelegation: boundary.issueCreateDelegation,
        ...(options.onMetric === undefined ? {} : { onMetric: options.onMetric }),
      }),
    };
  }
  return {
    repository: options.repository,
    owner: createAdvisoryCommercialCreateOwner(
      options.onMetric === undefined ? {} : { onMetric: options.onMetric },
    ),
  };
}
