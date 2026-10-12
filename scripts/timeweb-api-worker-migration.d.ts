export const API_WORKER_MIGRATION_BRIDGE: Readonly<
  Record<string, string> & {
    preLedgerSha256: string;
    postLedgerSha256: string;
    migratorImage: string;
  }
>;
export function validateApiWorkerMigrationOperation(value: unknown, at?: number): unknown;
export function validateMigrationControllerClosure(value: unknown): void;
export function validateApiWorkerMigrationLedger(value: unknown, expected: string): string;
export function validateMigrationPlan(value: unknown, operationBytes: Buffer): unknown;
export function validateMigrationReceipt(
  value: unknown,
  planSha: string,
  operationSha: string,
): unknown;
export function encodeApiWorkerMigrationCapsule(operationBytes: Buffer, planBytes: Buffer): Buffer;
export function readApiWorkerMigrationCapsule(value: Buffer): {
  operationBytes: Buffer;
  planBytes: Buffer;
  operation: unknown;
  plan: unknown;
};
export function migrationCreateArgs(
  name: string,
  operationSha: string,
  envFile: string,
  kind?: string,
  runtimeRole?: string,
): string[];
export function validateMigrationContainer(
  value: unknown,
  id: string,
  operationSha: string,
  state: string,
  spec: { kind: string; name: string; imageId: string; env: string[]; runtimeRole?: string },
): void;
export interface MigrationEffects {
  time(): number;
  receiptPath: string;
  assertUnused(): unknown;
  assertSource(op: unknown): unknown;
  authority(op: unknown): unknown;
  snapshot(): unknown;
  secrets(): unknown;
  ledger(): unknown;
  backup(op: unknown): unknown;
  image(): unknown;
  target(): unknown;
  prepare(bytes: Buffer): unknown;
  preparation(): Buffer | Promise<Buffer>;
  claim(planBytes: Buffer, operationSha: string): unknown;
  loadPlan(plan: unknown, bytes: Buffer, operationSha: string): unknown;
  assertOwned(): unknown;
  writeReceipt(value: unknown): unknown;
  receipt(): unknown;
  create(
    kind: string,
    imageId: string,
    operationSha: string,
    runtimeRole?: string,
  ): string | Promise<string>;
  start(id: string, kind: string): unknown;
  wait(id: string, kind: string): unknown;
  logs(id: string): unknown;
  lookup(kind: string, imageId: string, operationSha: string): unknown;
  writeRoleProof(bytes: Buffer): unknown;
  readRoleProof(): Buffer | Promise<Buffer>;
  attestRoleContainers(value: unknown): unknown;
  attestStoppedProbes(): unknown;
  successProof(): Buffer | null | Promise<Buffer | null>;
  writeSuccess(bytes: Buffer): unknown;
  release(): unknown;
}
export function runMigrationAdapter(
  mode: string,
  operationBytes: Buffer,
  ops: MigrationEffects,
): Promise<{ status: string; receipt: string }>;
export function validateMigrationProofBundle(
  bundle: { preparation: Buffer; plan: Buffer; role: Buffer; success: Buffer; receipt: Buffer },
  expected: unknown,
): {
  operation: unknown;
  operationBytes: Buffer;
  plan: unknown;
  planBytes: Buffer;
  role: unknown;
  success: unknown;
};
export function attestMigrationBackupProof(
  expected: unknown,
  restore?: unknown,
): Promise<{ schema: string; containerId: string; imageId: string; proofSha256: string }>;
export function runManualApiWorkerMigration(
  mode: string,
  requestPath: string,
): Promise<{ status: string; receipt: string }>;

export function validateMigrationReleaseState(active: boolean, provision: boolean): void;

export interface DiskRestoreMountinfoRecord {
  id: string;
  parent: string;
  device: string;
  root: string;
  target: string;
  options: string[];
  optional: string[];
  fstype: string;
  source: string;
  superOptions: string[];
}
export function parseDiskRestoreMountinfo(raw: string): DiskRestoreMountinfoRecord[];
export function validateDiskRestoreReadback(
  value: unknown,
  expected: unknown,
  reference: unknown,
  operationBytes: Buffer,
): unknown;
export function validateDiskRestoreKernelSnapshot(
  row: unknown,
  attestation: unknown,
  actual: unknown,
): void;

export function validateMigrationBackupRestoreReference(
  operationBytes: Buffer,
  expected: unknown,
  reference: unknown,
): 'disk' | 'legacy';
export function validateLegacyBackupRestoreMounts(row: unknown): void;

export function validateDiskRestoreToolBytes(
  installedBytes: Buffer,
  sourceBytes: Buffer,
  expectedSha256: string,
): void;
