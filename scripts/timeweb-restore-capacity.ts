/**
 * Restore-capacity decision shared by the beta preflight and the restore planner (ADR 0025 step 4).
 *
 * The pre-rollout full backup on beta failed after the database grew past the tmpfs formula
 * (3 × pg_database_size + reserve on a 12 GB host). The decision is pure and read-only so the
 * planner can print the exact operation schema before any file or container is touched.
 */
export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

export type RestorePhase = 'pre99' | 'post101';
export type RestoreMode = 'namespace' | 'disk' | 'none';
export type Profile = 'beta' | 'production';

export const PRE99_DISK_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_V1';
export const PRE99_NAMESPACE_SCHEMA =
  'PHUB_TIMEWEB_BACKUP_OPERATION_MIGRATION_PRE99_DISK_NAMESPACE_V2';
export const POST101_DISK_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_V1';
export const POST101_NAMESPACE_SCHEMA =
  'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_NAMESPACE_V2';

export interface CapacityVerdict {
  readonly databaseBytes: number;
  readonly availableMemory: number;
  readonly freeDisk: number;
  readonly tmpfsBytes: number;
  readonly model: RestoreMode;
  readonly detail: string;
}

export interface RestorePlan {
  readonly storageMode: Exclude<RestoreMode, 'none'>;
  readonly schema: string;
  readonly verdict: CapacityVerdict;
}

export function evaluateCapacity(
  databaseBytes: number,
  availableMemory: number,
  freeDisk: number,
): CapacityVerdict {
  // Mirrors control-timeweb-database-backup.py:capacity() for the namespace restore mode.
  const tmpfsBytes = Math.max(512 * MIB, databaseBytes * 3 + 256 * MIB);
  const namespace =
    availableMemory >= tmpfsBytes + 2 * GIB && freeDisk >= databaseBytes * 2 + 5 * GIB;
  const disk = freeDisk >= databaseBytes * 2 + 5 * GIB;
  const model = namespace ? 'namespace' : disk ? 'disk' : 'none';
  const detail = [
    `db=${(databaseBytes / GIB).toFixed(2)}GiB`,
    `memAvailable=${(availableMemory / GIB).toFixed(2)}GiB`,
    `tmpfs=${(tmpfsBytes / GIB).toFixed(2)}GiB`,
    `freeDisk=${(freeDisk / GIB).toFixed(2)}GiB`,
    `model=${model}`,
  ].join(' ');
  return { databaseBytes, availableMemory, freeDisk, tmpfsBytes, model, detail };
}

export function restoreSchema(phase: RestorePhase, model: Exclude<RestoreMode, 'none'>): string {
  if (phase === 'pre99') return model === 'disk' ? PRE99_DISK_SCHEMA : PRE99_NAMESPACE_SCHEMA;
  return model === 'disk' ? POST101_DISK_SCHEMA : POST101_NAMESPACE_SCHEMA;
}

/**
 * Namespace (tmpfs) stays the first choice for small databases: it is faster and leaves no LUKS
 * image behind. Disk restore is selected automatically as soon as the tmpfs formula does not fit
 * the host. Beta defaults to the same rule; production keeps the same safety gate but records the
 * selected schema explicitly in the operation.
 */
export function selectRestorePlan(
  phase: RestorePhase,
  databaseBytes: number,
  availableMemory: number,
  freeDisk: number,
  profile: Profile = 'beta',
): RestorePlan {
  const verdict = evaluateCapacity(databaseBytes, availableMemory, freeDisk);
  if (verdict.model === 'none') {
    throw new Error(`NO_RESTORE_CAPACITY phase=${phase} profile=${profile}: ${verdict.detail}`);
  }
  return { storageMode: verdict.model, schema: restoreSchema(phase, verdict.model), verdict };
}
