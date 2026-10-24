export const JOIN_OPERATION: string;
export const JOIN_PLAN: string;
export const JOIN_RECEIPT: string;
export const JOIN_INSTALLED_KIND: string;
export const JOIN_RUNTIME_ANCHOR: string;
export const JOIN_CONTROLLER_FILES: Set<string>;
export const JOIN_PHASES: string[];
export function joinHash(bytes: Buffer | string): string;
export function isJoinOperation(op: unknown): boolean;
export function validateJoinOperation<T>(op: T, requireUnexpired?: boolean, now?: number): T;
export function validateJoinRuntimeTail(
  entries: unknown[],
  runtimeSource?: { fromSha: string; toSha: string; toTree: string },
): void;
export function validateJoinNotificationBinding(
  bundle: Record<
    | 'operation'
    | 'plan'
    | 'capsule'
    | 'receipt'
    | 'observation'
    | 'descriptor'
    | 'apiIdentity'
    | 'workerIdentity',
    Buffer
  >,
  values: Record<string, string>,
  op: Record<string, unknown>,
  currentExcluded: unknown[],
): string;
export function validateJoinBackupLedger(receipt: unknown): void;
export function validateJoinRunningEnvironment(
  actual: Record<string, string>,
  expected: Record<string, string>,
): void;
export function validateJoinReceipt<T>(
  receipt: T,
  planSha256: string,
  op?: unknown,
  plan?: unknown,
  planBytes?: Buffer,
): T;
export function buildJoinInstalledDescriptor(
  values: Record<string, string>,
  plan: {
    candidate: { api: { image: string }; web: { image: string } };
    unchangedServiceImages: { worker: string | null; realtime: string | null };
  },
  id: string,
  journalPath: string,
): Buffer;

export function validateJoinObservation<T>(
  value: T,
  op: Record<string, unknown>,
  plan: Record<string, unknown>,
  planSha256: string,
): T;

export const JOIN_POST105_BACKUP_SCHEMA: string;
export const JOIN_POST105_BACKUP_RECEIPT: string;
export const JOIN_POST105_BACKUP_TERMINAL: string;
export function validateJoinPost105BackupOperation<T>(
  op: T,
  join: Record<string, unknown>,
  controllerTree: string,
): T;
export function validateJoinPost105BackupTerminal<T>(
  value: T,
  receipt: Record<string, unknown>,
  receiptBytes: Buffer,
  preimageBytes: Buffer,
): T;
export function validateJoinPost105BackupBundle(
  bundle: Record<
    'operation' | 'receipt' | 'preimage' | 'golden' | 'descriptor' | 'terminal',
    Buffer
  >,
  join: Record<string, unknown>,
  controllerTree: string,
  actual: { dumpSha256: string; toolSha256: string; installationSha256: string },
  options?: { fresh?: boolean; now?: number },
): Record<string, unknown>;

export function validateJoinPost105SecurityInventory<T>(value: T): T;

export function validateJoinNotificationSnapshot(
  bundle: Record<string, Buffer>,
  values: Record<string, string>,
  op: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): string;
