export interface GameInvitations0120Target {
  database: string;
  systemIdentifier: string;
  operator: string;
  owner: string;
  ledgerOid: number;
  gamesOid: number;
  usersOid: number;
}

export const GAME_INVITATIONS_0120_TARGET: Readonly<GameInvitations0120Target>;
export const GAME_INVITATIONS_0120: Readonly<{
  filename: string;
  checksum: string;
  before: string;
  after: string;
  backupLedger: string;
  baselineReleaseId: string;
  restoreDecision: string;
  restoreMessageSha256: string;
}>;

export function buildGameInvitations0120Sql(
  bytes: Buffer,
  target: GameInvitations0120Target,
  mode: 'apply' | 'readback',
  expectedCatalogSha256?: string,
): string;

export interface GameInvitations0120Request {
  schema: 'PHUB_TIMEWEB_GAME_INVITATIONS_0120_REQUEST_V1';
  attemptId: string;
  controllerSha: string;
  migrationSourceSha: string;
  postgresContainerId: string;
  expiresAt: string;
  backupReleaseId: string;
  retainedBackupReceiptSha256: string;
  externalRestoreDecision: {
    status: string;
    owner: string;
    referenceSha256: string;
    backupDecisionSha256: string;
  };
}
export function validateGameInvitations0120Request(
  value: unknown,
  enrollment: { controllerSha: string; owner: string },
  now?: number,
): GameInvitations0120Request;
export function validateGameInvitations0120Backup(
  receipt: unknown,
  archive: { isFile(): boolean; nlink: number; size: number },
  expectedPath: string,
  now: number,
): void;
