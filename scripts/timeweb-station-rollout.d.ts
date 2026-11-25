export const STATION_OPERATION: 'PHUB_TIMEWEB_STATION_ROLLOUT_OPERATION_V1';
export const STATION_PLAN: 'PHUB_TIMEWEB_STATION_ROLLOUT_PLAN_V1';
export const STATION_RECEIPT: 'PHUB_TIMEWEB_STATION_ROLLOUT_RECEIPT_V1';
export const STATION_KIND: 'API_WORKER_WEB_STATION_ROLLOUT';
export const STATION_APPLICATION: string;
export const STATION_TREE: string;
export const STATION_WAIVER_SHA256: string;
export const STATION_PREVIOUS: Readonly<{
  api: Readonly<{ id: string; image: string; releaseId: string }>;
  web: Readonly<{ id: string; image: string; releaseId: string }>;
  worker: Readonly<{ id: string; image: string; releaseId: null; revision: string }>;
}>;
export const STATION_BACKUP: Readonly<{
  policy: 'DUMP_INTEGRITY_ONLY_OWNER_ACCEPTED';
  restoreVerified: false;
  snapshotCatalogVerified: false;
  dumpPath: string;
  dumpBytes: number;
  dumpSha256: string;
  receiptSha256: string;
  tocSha256: string;
  completedAt: string;
  cupReceiptSha256: string;
  cupRequestSha256: string;
  cupCatalogSha256: string;
}>;
export function stationScopeHash(value: unknown): string;
export function validateStationWindow(
  op: { expiresAt: string },
  now?: number,
  minimumMs?: number,
): void;
export function validateStationSourceTail(entries: unknown[]): void;
export function validateStationBackupMetadata(
  receipt: Buffer,
  toc: Buffer,
  cup: Buffer,
  cupRequest: Buffer,
): void;
export function validateStationDatabaseReadback(value: unknown): void;
export function validateStationRetainedAdmission(admission: unknown, op: unknown): void;

export function validateStationRuntimeEnvironment(
  running: string[],
  imageDefaults: string[] | null,
  rendered: Record<string, string | number | boolean | null>,
): void;
