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
  notification?:
    | { operation: unknown; target?: unknown }
    | { closedApplication: { operation: unknown; profile: ClosedAdditiveProfile } },
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
export interface ClosedAdditiveOperation {
  readonly expectedApi: unknown;
  readonly expectedWorker: unknown;
  readonly expectedPostgres: unknown;
  readonly expectedSecretSetReleaseId: string;
  readonly expectedSecretSetFiles: unknown;
  readonly publishedMigrator: { readonly imageId: string };
  readonly controllerSha: string;
  readonly controllerTree: string;
  readonly controllerSourceCiRunId: string;
  readonly expiresAt: string;
}
export interface ClosedAdditiveEffects extends Omit<MigrationEffects, 'backup'> {
  assertPreparedUnclaimed(): unknown;
  inputs(): unknown;
  backup(operation: ClosedAdditiveOperation, options?: { fresh?: boolean }): unknown;
  bootstrap(): unknown;
  cleanup(): unknown;
}
export interface ClosedAdditiveProfile {
  readonly kind: 'location_photo_0102' | 'game_start_0103' | 'subject_link_0104';
  readonly preCount: number;
  readonly postCount: number;
  readonly preLedgerSha256: string;
  readonly postLedgerSha256: string;
  readonly errorPrefix: string;
  readonly schemas: Readonly<{
    receipt: string;
    plan: string;
    roleProof: string;
    cleanupProof: string;
    bootstrapProof: string;
    success: string;
  }>;
  readonly roleProbeSource: string;
  validateOperation(value: unknown, at?: number): ClosedAdditiveOperation;
  validateLedger(value: unknown, phase: string): unknown;
  validateState(value: unknown, phase: string): { readonly target: unknown };
  validateMigratorReadback(value: unknown, phase: string, target: unknown): unknown;
  validatePlan(value: unknown, operationBytes: Buffer): unknown;
  validateReceipt(value: unknown, planSha256: string, operationSha256: string): unknown;
  readState(effects: ClosedAdditiveEffects, phase: string): unknown;
  readProof(effects: ClosedAdditiveEffects, name: string): Buffer | null | Promise<Buffer | null>;
  writeProof(effects: ClosedAdditiveEffects, name: string, bytes: Buffer): unknown;
}
export function validateClosedAdditiveProfile(value: unknown): ClosedAdditiveProfile;
export function runClosedAdditiveMigrationAdapter(
  mode: string,
  operationBytes: Buffer,
  effects: ClosedAdditiveEffects,
  profile: ClosedAdditiveProfile,
): Promise<{ status: string; receipt: string }>;
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

export function sealNotificationPrefetchMetadata(
  path: string,
  bytes: Buffer,
  closedKind?: 'game_start_0103' | 'subject_link_0104',
): void;

export interface ClosedProductionFiles {
  read(path: string, mode?: number): Buffer;
  secure(path: string, mode?: number): { isDirectory(): boolean };
  present(path: string): boolean;
}
export interface ClosedProductionDependencies extends ClosedProductionFiles {
  git(args: string[]): string;
}
export interface ClosedProductionDatabaseDependencies extends ClosedProductionFiles {
  postgresSql(sql: string, readOnly?: boolean, postgresId?: string): unknown;
}
export interface ClosedProductionBinding {
  readonly kind: 'game_start_0103' | 'subject_link_0104';
  readonly kernelProfile: ClosedAdditiveProfile;
  attestSource(operation: unknown, dependencies: ClosedProductionDependencies): unknown;
  validateManifest(operation: unknown, manifest: unknown, bytes: Buffer): unknown;
  backup(
    operation: unknown,
    options: { fresh?: boolean } | undefined,
    dependencies: ClosedProductionFiles,
  ): unknown;
  inputs(operation: unknown, dependencies: ClosedProductionFiles): unknown;
  readState(
    operation: unknown,
    phase: string,
    dependencies: ClosedProductionDatabaseDependencies,
  ): unknown;
  bootstrapSql(operation: unknown, plan: unknown): string | Buffer;
  cleanupSql(operation: unknown, plan: unknown): string | Buffer;
  attestPrevious(operation: unknown, dependencies: ClosedProductionFiles): unknown;
  assertRuntimeFlags(
    operation: unknown,
    environments: { api: readonly string[]; worker: readonly string[] },
    dependencies: ClosedProductionDependencies,
  ): unknown;
}
export interface ClosedApplicationProductionEffects extends ClosedAdditiveEffects {
  closedApplicationState(phase: string): unknown;
  readClosedApplicationProof(name: string): Buffer | null;
  writeClosedApplicationProof(name: string, bytes: Buffer): unknown;
}
export function closedApplicationRequestPath(kind: 'game_start_0103' | 'subject_link_0104'): string;
export function closedApplicationProductionPaths(operation: unknown): Readonly<{
  requestPath: string;
  slug: string;
  candidate: string;
  transactionRoot: string;
  containerName: string;
  prefetchRoot: string;
  prefetchRequestPath: string;
}>;
export function createClosedApplicationProductionEffects(
  operation: unknown,
  owner: { assertOwned(): unknown },
  binding: ClosedProductionBinding,
): ClosedApplicationProductionEffects;

export interface ClosedApplicationManualEntryEffects {
  uid(): number | undefined;
  time(): number;
  assertAmbient(): unknown;
  secureStandard(): unknown;
  readRequest(): Buffer;
  binding(operation: unknown): ClosedProductionBinding;
  acquire(): { close(): void };
  run(
    mode: string,
    bytes: Buffer,
    operation: unknown,
    owner: { close(): void },
    binding: ClosedProductionBinding,
  ): Promise<{ status: string; receipt: string }>;
}
export function runClosedApplicationManualEntryAdapter(
  mode: string,
  kind: 'game_start_0103' | 'subject_link_0104',
  requestPath: string,
  effects: ClosedApplicationManualEntryEffects,
): Promise<{ status: string; receipt: string }>;
export function runManualClosedApplicationMigration(
  mode: string,
  kind: 'game_start_0103' | 'subject_link_0104',
  requestPath: string,
  bindingFactory: (operation: unknown) => ClosedProductionBinding,
): Promise<{ status: string; receipt: string }>;

export function closedApplicationPreviousRequestHashes(
  operation: unknown,
  proof: unknown,
): Readonly<Record<string, string>>;
