import type {
  ClosedApplicationKind,
  ClosedApplicationOperation,
} from './timeweb-closed-application-profile.js';
export const CLOSED_APPLICATION_BACKUPS: Readonly<
  Record<
    ClosedApplicationKind,
    {
      schema: string;
      mode: string;
      preCount: number;
      ledgerSha256: string;
      receiptSchema: string;
      terminalSchema: string;
      supervisorSchema: string;
      preimageSchema: string;
    }
  >
>;
export function closedApplicationMigrationBinding(operation: ClosedApplicationOperation): unknown;
export function validateClosedApplicationBackupOperation(
  value: unknown,
  at?: number,
): Record<string, unknown> & { migrationIntent: ClosedApplicationOperation };
export function closedApplicationBackupDirectory(operation: unknown): string;
export function validateClosedApplicationBackupReceipt(
  operation: ClosedApplicationOperation,
  backup: unknown,
  backupBytes: Buffer,
  receiptBytes: Buffer,
  preimageBytes: Buffer,
  options?: { now?: number; fresh?: boolean },
): Readonly<Record<string, unknown>>;
export function closedApplicationBackupBindingSha256(operation: ClosedApplicationOperation): string;
