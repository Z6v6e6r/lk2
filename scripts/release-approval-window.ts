/**
 * Approval-window decision for a release package (ADR-0026).
 *
 * A release approval is bound to the exact package inputs. A fresh preflight may extend its expiry
 * while those inputs are byte-identical; a changed request, source identity or target requires a
 * new human approval. This module is pure and does not read or write any approval store.
 */
export const DEFAULT_MAX_EXTENSION_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_MAX_TOTAL_MS = 12 * 60 * 60 * 1000;

export interface ApprovalWindowInput {
  /** SHA-256 of the approved request/package as the human approved it. */
  readonly approvedRequestSha256: string;
  /** SHA-256 of the request/package the fresh preflight is about to use. */
  readonly currentRequestSha256: string;
  /** Canonical ISO timestamps. */
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly now: string;
  readonly maxExtensionMs?: number;
  readonly maxTotalMs?: number;
}

export type ApprovalWindowDecision =
  | {
      readonly extend: true;
      readonly expiresAt: string;
      readonly reason: 'UNCHANGED_INPUTS';
    }
  | {
      readonly extend: false;
      readonly reason:
        'INPUTS_CHANGED' | 'MALFORMED_APPROVAL' | 'EXTENSION_LIMIT' | 'EXTENSION_NOT_NEEDED';
    };

const SHA256 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;

function parse(value: string): number {
  if (!ISO.test(value)) return Number.NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NaN;
}

/**
 * Decide whether the recorded approval can be extended for the current preflight.
 *
 * The rule is deliberately narrow: same request hash, well-formed timestamps, extension capped by
 * `maxExtensionMs` from now and by `maxTotalMs` from the original approval. Any new input needs a new
 * approval; no execution authority is created here.
 */
export function decideApprovalExtension(input: ApprovalWindowInput): ApprovalWindowDecision {
  const maxExtensionMs = input.maxExtensionMs ?? DEFAULT_MAX_EXTENSION_MS;
  const maxTotalMs = input.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const approvedAt = parse(input.approvedAt);
  const expiresAt = parse(input.expiresAt);
  const now = parse(input.now);
  if (
    !SHA256.test(input.approvedRequestSha256) ||
    !SHA256.test(input.currentRequestSha256) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(maxExtensionMs) ||
    !Number.isFinite(maxTotalMs) ||
    maxExtensionMs <= 0 ||
    maxTotalMs <= 0 ||
    expiresAt <= approvedAt
  )
    return { extend: false, reason: 'MALFORMED_APPROVAL' };
  if (input.approvedRequestSha256 !== input.currentRequestSha256)
    return { extend: false, reason: 'INPUTS_CHANGED' };
  const totalLimit = approvedAt + maxTotalMs;
  const extended = Math.min(now + maxExtensionMs, totalLimit);
  if (extended <= expiresAt) return { extend: false, reason: 'EXTENSION_NOT_NEEDED' };
  if (extended <= now) return { extend: false, reason: 'EXTENSION_LIMIT' };
  return {
    extend: true,
    expiresAt: new Date(extended).toISOString(),
    reason: 'UNCHANGED_INPUTS',
  };
}
