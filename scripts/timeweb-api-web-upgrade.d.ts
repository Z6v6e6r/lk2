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
