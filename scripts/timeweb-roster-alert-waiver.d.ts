export const WAIVER_OPERATION: string;
export const WAIVER_PLAN: string;
export const WAIVER_RECEIPT: string;
export const WAIVER_KIND: string;
export const WAIVER_POLICY: string;
export const WAIVER_STATUS: string;
export const ADMISSION_SCHEMA: string;
export const OWNER_DECISION_SHA256: string;
export const NATIVE_INPUTS: string[];
export const NATIVE_DERIVED: string;
export const NATIVE_ENVELOPE: string;
export function decodeNativeInputEnvelope(
  bytes: Buffer,
  operationSha256: string,
): Record<string, Buffer>;
export function isWaivedRosterCutover(op: unknown): boolean;
export function nativeEvidenceBytes(value: unknown): Buffer;
export function nativeEvidenceHash(value: string | Uint8Array): string;
export function validateRosterAlertWaiver(
  op: Record<string, unknown>,
  baselineHash: string,
  fresh?: boolean,
  now?: number,
): Record<string, unknown>;
export function validateNativeAdmissionBinding(
  op: Record<string, unknown>,
  admission: Record<string, string>,
  operationSha256: string,
): Record<string, string>;
export function createNativeWaiverAdmission(
  op: Record<string, unknown>,
  inputs: Record<string, Buffer>,
  source: { adapterSourceSha256: string; reviewValidatorSha256: string },
  admittedAt: string,
  operationSha256: string,
): {
  admission: Record<string, string>;
  evidence: Record<string, Buffer>;
};
export function validateRetainedNativeAdmission(
  op: Record<string, unknown>,
  admission: Record<string, string>,
  operationSha256: string,
  evidence: Record<string, Buffer>,
): { historicalAdmission: true; authorizesDeploy: false };
export function validateSealedNativeAdmission(
  op: Record<string, unknown>,
  admission: Record<string, string>,
  operationSha256: string,
  evidence: Record<string, Buffer>,
): void;
export function nativeAdmissionReceipt(
  admission: Record<string, string>,
): Record<string, string | undefined>;

export function ownerWaiverScopeSha256(op: Record<string, unknown>): string;

export const OWNER_OPERATION: string;
export const OWNER_PLAN: string;
export const OWNER_RECEIPT: string;
export const OWNER_KIND: string;
export const CANONICAL_OPERATION: string;
export const CANONICAL_PLAN: string;
export const CANONICAL_RECEIPT: string;
export const CANONICAL_KIND: string;
export const CANONICAL_FRESH_OPERATION: string;
export const CANONICAL_FRESH_RECEIPT: string;
export const CANONICAL_OWNER_POLICY: string;
export const CANONICAL_PRIOR_RESTORE_POLICY: string;
export function isCanonicalOwnerDirectedUpgrade(op: unknown): boolean;
export const OWNER_POLICY: string;
export const PROVIDER_SKIPPED: string;
export const PRIOR_RESTORE_POLICY: string;
export const FRESH_BACKUP_OPERATION: string;
export const FRESH_BACKUP_RECEIPT: string;
export function isOwnerDirectedCutover(op: unknown): boolean;
export function ownerDirectedScopeSha256(op: Record<string, unknown>): string;
export function validateOwnerDirectedDecisions(
  op: Record<string, unknown>,
  fresh?: boolean,
  now?: number,
): Record<string, unknown>;
export function createOwnerDirectedBinding(
  op: Record<string, unknown>,
  operationSha256: string,
): Record<string, string>;
export function validateOwnerDirectedBinding(
  op: Record<string, unknown>,
  binding: Record<string, string>,
  operationSha256: string,
): Record<string, string>;
export function ownerDirectedReceipt(binding: Record<string, string>): Record<string, string>;
