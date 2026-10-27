/**
 * Policy/usage binding refs for one commercial CREATE/JOIN operation (B2).
 *
 * LK2 never stores entitlement, counters or a usage ledger. These refs are the only durable
 * evidence that one operation was authorised by a specific published policy version and consumed a
 * specific usage reservation owned by LK1: `policyRef` identifies the decision, `usageRef` names the
 * reservation and `decisionId` identifies the quote decision that produced them.
 *
 * Every value here is opaque to LK2 and is validated strictly so that a malformed decision or owner
 * receipt can never be persisted (or replayed) as a binding. Version/digest shapes match the CUP
 * publication contract exposed by the read-only policy registry.
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
