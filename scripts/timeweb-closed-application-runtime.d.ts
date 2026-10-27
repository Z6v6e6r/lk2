import type { ClosedApplicationOperation } from './timeweb-closed-application-profile.js';
import type {
  ClosedProductionBinding,
  ClosedProductionDependencies,
  ClosedProductionFiles,
  ClosedProductionDatabaseDependencies,
  createClosedApplicationProductionEffects,
} from './timeweb-api-worker-migration.js';
export interface ClosedRuntimeDependencies extends ClosedProductionFiles {
  terminal?(args: string[]): Buffer;
  effects?: typeof createClosedApplicationProductionEffects;
}
export function attestClosedApplicationBackupSource(
  backup: unknown,
  deps?: ClosedProductionDependencies,
): unknown;
export function readClosedApplicationDatabaseState(
  operation: ClosedApplicationOperation,
  phase: string,
  deps: ClosedProductionDatabaseDependencies,
): unknown;
export function readClosedApplicationBackupProof(
  operation: ClosedApplicationOperation,
  options?: { fresh?: boolean; retained?: boolean; now?: number },
  deps?: ClosedRuntimeDependencies,
): Readonly<Record<string, unknown>>;
export function attestClosedApplicationPrevious(
  operation: ClosedApplicationOperation,
  deps?: ClosedRuntimeDependencies,
): unknown;
export function createClosedApplicationProductionBinding(
  operation: ClosedApplicationOperation,
): ClosedProductionBinding;
export function validateClosedApplicationPrefetchRequest(
  bytes: Buffer,
  at?: number,
): {
  migrationIntent: ClosedApplicationOperation;
  expiresAt: string;
  schema: string;
  confirmation: string;
};
export function readClosedApplicationPrefetchProof(
  operation: ClosedApplicationOperation,
  deps?: ClosedRuntimeDependencies,
  expected?: unknown,
): {
  intent: Record<string, unknown>;
  receipt: Record<string, unknown>;
  reference: Record<string, unknown>;
};
export interface ClosedPrefetchEffects {
  time(): number;
  prefetchUnused(): unknown;
  assertSource(operation: ClosedApplicationOperation): unknown;
  authority(operation: ClosedApplicationOperation): unknown;
  prefetchIntent(): Buffer | null | Promise<Buffer | null>;
  prefetchReceipt(): Buffer | null | Promise<Buffer | null>;
  imageInventory(): string[] | Promise<string[]>;
  writePrefetchIntent(bytes: Buffer): unknown;
  writePrefetchReceipt(bytes: Buffer): unknown;
  pullMigrator(): unknown;
  image(): string | Promise<string>;
  prefetchImagePresent(): boolean | Promise<boolean>;
  assertPrefetchOwner(): unknown;
  hostPreflight(operation: ClosedApplicationOperation): Promise<unknown>;
}
export function runClosedApplicationPrefetchAdapter(
  mode: string,
  bytes: Buffer,
  effects: ClosedPrefetchEffects,
): Promise<unknown>;
export function runManualClosedApplicationPrefetch(
  mode: string,
  kind: string,
  path: string,
): Promise<unknown>;
export function attestClosedApplicationMigratorPrefetchForBackup(backup: unknown): Promise<unknown>;
export function readClosedApplicationBackupDatabaseState(backup: unknown): unknown;
export function runClosedApplicationMigration(
  mode: string,
  kind: string,
  path: string,
): Promise<unknown>;
