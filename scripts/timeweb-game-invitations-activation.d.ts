export const GAME_INVITATIONS_ACTIVATION: Readonly<{
  schema: string;
  application: string;
  tree: string;
  suffix: string;
  rolloutReceipt: string;
  observation: string;
  backupSchema: string;
  backupReceipt: string;
  backupPolicy: string;
  migrationReceipt: string;
}>;
export const GAME_INVITATIONS_MONITORING_STATUS: Readonly<{
  providerMonitoringStatus: string;
  alertTestStatus: string;
  ownerMessageSha256: string;
}>;
export function validateGameInvitationsActivationTail(
  anchorTree: string,
  entries: readonly unknown[],
): void;
export function validateGameInvitationsActivationInputs(op: {
  schema: string;
  ownerMessageSha256: string;
  migrationAttemptId: string;
  migrationReceiptSha256: string;
  expectedApi: { releaseId: string };
  expectedWeb: { releaseId: string };
}): void;
export function validateGameInvitationsActivationMigration(
  op: {
    controllerSha: string;
    candidateSha: string;
    publicationRunId: string;
    backupOperationSha256: string;
    migrationAttemptId: string;
    migrationReceiptSha256: string;
    expiresAt: string;
  },
  proof: {
    receiptBytes: Buffer;
    requestBytes: Buffer;
    backupOperationBytes: Buffer;
    backupReceiptBytes: Buffer;
    postgresId: string;
    postgresStartedAt: string;
    owner: string;
  },
): string;
export function validateGameInvitationsActivationReadback(
  readback: unknown,
  catalogSha256: string,
): void;
