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
