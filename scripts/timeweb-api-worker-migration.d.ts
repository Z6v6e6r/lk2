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
  notification?: { operation: unknown; target?: unknown },
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
export interface LocationPhotoManualEntryEffects {
  uid(): number | undefined;
  time(): number;
  assertAmbient(): void;
  secureStandard(): unknown;
  readRequest(): Buffer;
  acquire(): { close(): void };
  run(
    mode: string,
    bytes: Buffer,
    operation: unknown,
    owner: { close(): void },
  ): Promise<{ status: string; receipt: string }>;
}
export function runLocationPhotoManualEntryAdapter(
  mode: string,
  requestPath: string,
  effects: LocationPhotoManualEntryEffects,
): Promise<{ status: string; receipt: string }>;
export function runManualLocationPhotoMigration(
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
): 'disk' | 'namespace' | 'legacy';
export function validateLegacyBackupRestoreMounts(row: unknown): void;

export function validateDiskRestoreToolBytes(
  installedBytes: Buffer,
  sourceBytes: Buffer,
  expectedSha256: string,
): void;

/** Independent read-only /proc, cgroup, unit and private-socket proof; never excludes a host container. */
export interface NamespaceRestoreProcess {
  pid: number;
  startTicks: string;
  executable: string;
  cmdline: string[];
  mountNamespace: number;
  uid: number[];
  gid: number[];
  cgroup: string;
}
export interface NamespaceRestoreKernelSnapshot {
  selfNamespace: number;
  afterSelfNamespace: number;
  processes: Record<
    'broker' | 'daemon' | 'source' | 'container' | 'containerd' | 'shim',
    NamespaceRestoreProcess
  >;
  afterProcesses: NamespaceRestoreKernelSnapshot['processes'];
  mountinfo: Record<keyof NamespaceRestoreKernelSnapshot['processes'], string>;
  afterMountinfo: NamespaceRestoreKernelSnapshot['mountinfo'];
  socket: Record<'dev' | 'ino' | 'uid' | 'gid' | 'mode' | 'nlink', number>;
  sourceImage: unknown;
  privateImage: unknown;
  container: unknown;
  afterContainer: unknown;
  runtime: unknown;
  afterRuntime: unknown;
  alias: unknown;
  afterAlias: unknown;
  network: Record<keyof NamespaceRestoreKernelSnapshot['processes'], number>;
  afterNetwork: NamespaceRestoreKernelSnapshot['network'];
  networkSandboxKey: string;
  afterNetworkSandboxKey: string;
}
export function validateNamespaceRestoreKernelSnapshot(
  attestation: unknown,
  actual: unknown,
): asserts actual is NamespaceRestoreKernelSnapshot;
export function namespaceRestoreClientOptions(
  attestation: unknown,
  actual: unknown,
): { host: 'unix:///media/.runtime/docker.sock'; cwd: '/media' };

export function readNotificationDatabaseState(operation: unknown, phase?: string): unknown;
export function notificationBackupProof(operation: unknown): unknown;
export function readNotificationMigrationProof(operation: unknown): unknown;
export function validateNotificationMigrationProofBundle(
  bundle: Record<string, Buffer>,
  expected: unknown,
): unknown;
export function validateNotificationMigrationPlan(value: unknown, operationBytes: Buffer): unknown;
export function validateNotificationMigrationReceipt(
  value: unknown,
  planSha: string,
  operationSha: string,
): unknown;
export function runNotificationMigrationAdapter(
  mode: string,
  operationBytes: Buffer,
  ops: unknown,
): Promise<unknown>;
export function runNotificationMigratorPrefetchAdapter(
  mode: string,
  requestBytes: Buffer,
  ops: unknown,
): Promise<unknown>;
export function runManualNotificationMigratorPrefetch(
  mode: string,
  requestPath: string,
): Promise<unknown>;
export function attestNotificationMigratorPrefetchForBackup(operation: unknown): Promise<unknown>;

export function readLocationPhotoDatabaseState(operation: unknown, phase?: string): unknown;
export function locationPhotoBackupProof(
  operation: unknown,
  options?: { fresh?: boolean },
): unknown;
export function validateLocationPhotoCompletedBackupBinding(
  backupOperation: unknown,
  operationBytes: Buffer,
  receipt: unknown,
): unknown;
export function validateLocationPhotoMigrationPlan(value: unknown, operationBytes: Buffer): unknown;
export function validateLocationPhotoMigrationReceipt(
  value: unknown,
  planSha: string,
  operationSha: string,
): unknown;
export function runLocationPhotoMigrationAdapter(
  mode: string,
  operationBytes: Buffer,
  ops: unknown,
): Promise<unknown>;
export function runLocationPhotoMigratorPrefetchAdapter(
  mode: string,
  requestBytes: Buffer,
  ops: unknown,
): Promise<unknown>;
export function runManualLocationPhotoMigratorPrefetch(
  mode: string,
  requestPath: string,
): Promise<unknown>;
export function attestLocationPhotoMigratorPrefetchForBackup(operation: unknown): Promise<unknown>;

export function sealNotificationPrefetchMetadata(path: string, bytes: Buffer): void;
