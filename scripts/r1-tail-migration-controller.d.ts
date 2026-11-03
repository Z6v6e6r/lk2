export const R1_TAIL_ROOT: string;
export const R1_TAIL_REQUEST: string;
export function r1TailPaths(operation: unknown): Readonly<Record<string, string>>;
export function validateR1TailOperation(value: unknown, at?: number): unknown;
export function runR1TailAdapter(
  mode: string,
  bytes: Buffer,
  ops: Record<string, unknown>,
): Promise<unknown>;

export function validateR1TailRecord(
  value: unknown,
  operationSha256: string,
  planSha256: string,
): unknown;
export interface R1TailCompletedReference {
  schema: 'PHUB_R1_TAIL_COMPLETED_V1';
  attemptId: string;
  controllerSha: string;
  controllerTree: string;
  files: Record<string, string>;
  backup: unknown;
}
export function validateR1TailCompletedEvidence(
  reference: R1TailCompletedReference,
  blobs: Record<string, Buffer>,
  expectedRoleSourceSha256: string,
): { operation: unknown; plan: unknown; receipt: unknown; cleanup: unknown; roleProof: unknown };
