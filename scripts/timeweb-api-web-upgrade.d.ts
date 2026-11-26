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
export function validateScheduleRuntimeBridge(
  identity: { previousSha: string; applicationSha: string; applicationTree: string },
  entries: Array<Record<string, string | null>>,
  tail: Array<Record<string, string | null>>,
): void;
export const validateCupSupportRuntimeBridge: typeof validateScheduleRuntimeBridge;
export function cupSupportAlertScopeSha256(operation: Record<string, unknown>): string;
export function validateCupSupportProviderEvidence(
  evidence: unknown,
  contract: unknown,
  observedAt: string,
  sourceSha: string,
  adapterSourceSha256: string,
): void;
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

export function validateApiWebOperation<T>(value: T): T;
export function validateGameInvitationsDirectObservation<T>(
  value: T,
  op: unknown,
  plan: unknown,
  planSha256: string,
): T;
export function validateUpgradeReceipt<T>(
  value: T,
  planSha256: string,
  op?: unknown,
  plan?: unknown,
  planBytes?: Buffer,
): T;

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

/** In-memory, bounded ZIP reader for retained canonical predecessor custody only. */
export function extractCanonicalPredecessorArtifactPair(archiveBytes: Buffer): Map<string, Buffer>;
export declare function deriveInstalledCanonicalBaseline(
  template: Record<string, unknown>,
): Record<string, unknown>;
