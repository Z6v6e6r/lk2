export const LOCATION_PHOTO_BACKUP_SCHEMA: string;
export const LOCATION_PHOTO_MIGRATION_SCHEMA: string;
export const LOCATION_PHOTO_PREFETCH_SCHEMA: string;
export const LOCATION_PHOTO_PRE_LEDGER: string;
export const LOCATION_PHOTO_POST_LEDGER: string;
export const LOCATION_PHOTO_MIGRATION: Readonly<Record<string, string>>;
export const LOCATION_PHOTO_PUBLISHED_MIGRATOR: Readonly<Record<string, string | number>>;
export const LOCATION_PHOTO_TARGET: Readonly<{
  hostname: string;
  serverId: number;
  projectId: number;
}>;
export const LOCATION_PHOTO_DATABASE_TARGET: Readonly<{
  databaseName: 'phub_beta';
  systemIdentifier: '7679125609183186977';
}>;
export const LOCATION_PHOTO_EDITOR_ACL: ReadonlyArray<readonly [string, string]>;
export const LOCATION_PHOTO_SECRET_NAMES: readonly string[];
export const LOCATION_PHOTO_MIGRATOR_PROBE_SOURCE: string;
export function validateLocationPhotoPackage(bytes: string | Buffer): unknown;
export function validateLocationPhotoOperation(value: unknown, at?: number): unknown;
export function validateLocationPhotoBackupOperation(value: unknown, at?: number): unknown;
export function validateLocationPhotoMigratorReadback(
  value: unknown,
  phase: 'pre' | 'bootstrap',
  target: { databaseName: string; systemIdentifier: string },
): unknown;
export function attestLocationPhotoControllerSource(
  value: unknown,
  deps: {
    git(args: string[]): string;
    read(path: string, mode?: number): Buffer;
    secure(path: string, mode?: number): { isDirectory(): boolean };
    present(path: string): boolean;
    assertGitConfig?: (git: (args: string[]) => string) => void;
  },
): unknown;
export function attestLocationPhotoBackupSource(
  value: unknown,
  deps: {
    git(args: string[]): string;
    read(path: string, mode?: number): Buffer;
    secure(path: string, mode?: number): { isDirectory(): boolean };
    present(path: string): boolean;
  },
): unknown;
export function validateLocationPhotoManifest(
  operation: unknown,
  manifest: unknown,
  bytes: Buffer,
): unknown;
export function validateLocationPhotoLedger(rows: unknown, phase: string): string;
export function validateLocationPhotoState(
  value: unknown,
  phase: string,
  expectedTarget?: { databaseName: string; systemIdentifier: string },
): unknown;
export function locationPhotoStateSql(phase: string): string;
export function locationPhotoHash(value: string | Buffer): string;
