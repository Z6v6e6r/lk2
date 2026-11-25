export const CUP_0119: Readonly<{
  source: string;
  filename: string;
  checksum: string;
  before: string;
  after: string;
}>;
export const CUP_0119_BACKUP: Readonly<{
  releaseId: string;
  baselineReleaseId: string;
  ledger: string;
}>;
interface Cup0119Target {
  database: string;
  systemIdentifier: string;
  projectionOwner: string;
  ledgerOwner: string;
  projectionOid: number;
  ledgerOid: number;
}
export const CUP_0119_TARGET: Readonly<Cup0119Target>;
export function buildCup0119Sql(
  bytes: Buffer,
  target: Cup0119Target,
  mode: 'apply' | 'readback',
  expectedCatalogSha256?: string,
): string;
export interface Cup0119Request {
  schema: 'PHUB_TIMEWEB_CUP_0119_REQUEST_V1';
  attemptId: string;
  controllerSha: string;
  migrationSourceSha: string;
  postgresContainerId: string;
  expiresAt: string;
  retainedBackupReceiptSha256: string;
  externalRestoreDecision: {
    status: 'OWNER_WAIVED_EXTERNAL_RESTORE_FOR_CUP_0119';
    owner: string;
    referenceSha256: string;
  };
}
export function validateCup0119Request(
  value: unknown,
  enrollment: { controllerSha: string; owner: string },
  now?: number,
): Cup0119Request;
export function validateCup0119RetainedBackup(
  receipt: unknown,
  archive: { isFile(): boolean; nlink: number; size: number },
  expectedPath: string,
): void;
