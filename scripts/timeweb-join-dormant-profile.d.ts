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
export function validateJoinRuntimeTail(entries: unknown[]): void;
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
