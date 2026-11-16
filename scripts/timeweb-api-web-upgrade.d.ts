export function readInstalledApiBaseline(
  releaseId: string,
  options?: { checkRuntimeSecrets?: boolean },
): {
  path: string;
  bytes: Buffer;
  values: Record<string, string>;
  secretSetReleaseId: string;
  workerGate?: unknown;
};
export function validateUpgradeBackup(
  directory: string,
  previous: Record<string, unknown>,
  profile?: string,
  cutover?: Record<string, unknown>,
): Record<string, unknown>;
export function attestCanonicalBaseline(baseline: unknown): {
  path: string;
  bytes: Buffer;
  values: Record<string, string>;
  secretSetReleaseId: string;
};
export function attestCanonicalBackupOperation(operation: Record<string, unknown>): {
  schema: string;
  canonicalBaselineSha256: string;
  installedDescriptorSha256: string;
  runtimeSecretsChecked: true;
};
export function validateCanonicalHistoricalArtifacts(
  baseline: unknown,
  files: Record<string, Buffer>,
): { schema: string; rolloutReceiptSha256: string; runtimeConsulted: false };
export function readCanonicalPredecessor(
  operation: Record<string, unknown>,
  recovering?: boolean,
): { path: string; bytes: Buffer; values: Record<string, string>; secretSetReleaseId: string };

export function readJoinPost105Backup(
  op: Record<string, unknown>,
  controllerTree: string,
  options?: { fresh?: boolean },
): Record<string, unknown>;

export function readJoinNotificationBaseline(op: Record<string, unknown>): Record<string, string>;

export function readInstalledWorkerGate(receiptPath: string, installedWorkerImage: string): unknown;

export function buildApiWebInstalledDescriptor(
  values: unknown,
  plan: unknown,
  releaseId: string,
  journalPath: string,
): Buffer;

export function overlayBytes(plan: unknown, name: string): string;
export function runManualApiWebUpgrade(
  mode: 'deploy' | 'recover' | 'reconcile',
  requestPath: string,
): Promise<{ status: string; candidate: string; receipt: string }>;

export function readNativeOperatorSnapshot(path: string): Buffer;
export function admitNativeWaiverMonitoring(
  op: Record<string, unknown>,
  transaction: string,
  operationSha256: string,
): Promise<Record<string, string>>;

export function validateCanonicalPredecessorArchive(
  baseline: unknown,
  operationBytes: Buffer,
  archiveBytes: Buffer,
): Buffer;
export function readCanonicalPredecessorManifest(baseline: unknown): Buffer;
