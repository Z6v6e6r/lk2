export const PRESERVED_NOTIFICATION_ROLLOUT_SCHEMA: string;
export const PRESERVED_NOTIFICATION_PLAN_SCHEMA: string;
export const PRESERVED_NOTIFICATION_RECEIPT_SCHEMA: string;
export function isPreservedNotificationRollout(op: unknown): boolean;
export function validateAndroidGateExpectation(value: unknown): unknown;
export function androidGateSnapshotSha256(value: unknown): string;
export function assertAndroidGateSnapshot(value: unknown, expected: unknown): boolean;
export const ANDROID_GATE_SNAPSHOT_SQL: string;
export const ANDROID_ALL_SENDING_SQL: string;
export function validateFcmDrainProof(value: unknown, op: unknown, planSha256: string): unknown;

export function validateFcmRollbackProof(
  value: unknown,
  operation: unknown,
  planSha256: string,
): unknown;

export function verifyFcmHeldRollback(
  operation: unknown,
  planSha256: string,
  io: {
    readGateState(): string;
    readDatabase(requireQuiescent: boolean): Promise<unknown>;
    readFirstProof(): unknown;
    writeFirstProof(proof: unknown): void;
    now(): string;
  },
): Promise<unknown>;
