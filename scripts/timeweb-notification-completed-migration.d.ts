export const COMPLETED_NOTIFICATION_COMPATIBILITY_PATHS: readonly string[];
export function validateCompletedNotificationMigration(value: unknown): unknown;
export function assertCompletedNotificationInputs(
  reference: unknown,
  operation: unknown,
  operationBytes: Buffer,
  plan: unknown,
  read: (path: string, mode: number) => Buffer,
): boolean;
