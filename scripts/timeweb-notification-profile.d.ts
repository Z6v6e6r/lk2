export const JOIN_POST105_BACKUP_SCHEMA: string;
export const NOTIFICATION_BACKUP_SCHEMA: string;
export const NOTIFICATION_MIGRATION_SCHEMA: string;
export const NOTIFICATION_ROLLOUT_SCHEMA: string;
export const NOTIFICATION_PRE_LEDGER: string;
export const NOTIFICATION_POST_LEDGER: string;
export const NOTIFICATION_SOURCE: string;
export const notificationIdFields: string[];
export const notificationSecretNames: string[];
export function isNotificationOperation(value: unknown): boolean;
export function notificationHash(value: string | Buffer): string;
export function notificationSame(a: unknown, b: unknown): boolean;
export function notificationExact(value: unknown, keys: string[]): void;
export function validateNotificationBaseline(value: unknown, service: string): void;
export function validateNotificationOperation(value: unknown, at?: number): unknown;
export function validateNotificationCatalogFile(
  bytes: string | Buffer,
  descriptor: string | Buffer,
): unknown;
export function attestNotificationSource(value: unknown, io: unknown): boolean;
export function validateNotificationManifest(value: unknown, manifest: unknown): unknown;
export function validateNotificationRoleReadback(
  value: unknown,
  kind: string,
  target: unknown,
  phase?: string,
  catalogSha?: string,
): unknown;
export function notificationStateSql(phase: string, bootstrapSql: string): string;
export function validateNotificationState(
  value: unknown,
  phase: string,
  golden: string | Buffer,
  descriptor: string | Buffer,
): unknown;
export function assertNotificationRuntimeOff(bytes: string | Buffer): boolean;
export function validateNotificationMonitoringBinding(value: unknown): unknown;
export function validateNotificationMonitoring(
  provider: string | Buffer,
  alerts: string | Buffer,
  contract: unknown,
  at: string,
  previous?: unknown,
): { provider: string; alerts: string; providerSha256: string; alertSha256: string };

export const NOTIFICATION_OBSERVATION_POLICY: Readonly<Record<string, string | number>>;
export const NOTIFICATION_OBSERVATION_POLICY_SHA256: string;
export function validateNotificationObservationPolicy(value: unknown): unknown;
export function validateNotificationObservation(
  value: unknown,
  operationSha256: string,
  planSha256: string,
): unknown;
