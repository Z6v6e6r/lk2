/**
 * Backup-renewal eligibility for a successful but unadmitted pre-105 backup (ADR-0026 phase 1).
 *
 * The controller cannot renew a successful backup that was never admitted to the migration: its
 * canonical directory name is occupied and its global request lease is held until the final
 * reconciliation. The conservative path in the incident review is a metadata-only retirement of the
 * old backup (keeping its canonical bytes and receipts), a new source identity under which the new
 * canonical backup path is created, and only then a release of the old lease.
 *
 * This module evaluates that path from read-only evidence. It never retires, releases, deletes or
 * requests anything; the controller mutation remains a separately reviewed operation.
 */
import {
  evaluateCapacityProvisioning,
  GIB,
  type CapacityProvisioning,
} from './timeweb-restore-capacity.js';

export type RenewalOutcome = 'SUCCESS' | 'RECONCILED' | 'ABORTED' | 'FAILED';

export interface BackupRenewalInput {
  readonly current: {
    /** `controllerSha-controllerSourceCiRunId-1` of the installed successful backup. */
    readonly releaseId: string;
    readonly sourceSha: string;
    readonly sourceCiRunId: string;
    readonly operationSha256: string;
    readonly receiptSha256: string;
    readonly outcome: RenewalOutcome;
    readonly admittedToMigration: boolean;
    readonly leaseHeld: boolean;
    readonly completedAt: string;
  };
  readonly target: {
    readonly controllerSha: string;
    readonly sourceSha: string;
    readonly sourceCiRunId: string;
  };
  readonly evidence: {
    readonly canonicalDirPresent: boolean;
    readonly canonicalBytesPreserved: boolean;
    readonly receiptVerified: boolean;
    readonly restoreProofVerified: boolean;
    readonly sevenCcPreserved: boolean;
  };
  readonly capacity: {
    readonly databaseBytes: number;
    readonly requiredDiskBytes: number;
    readonly freeDiskBytes: number;
  };
  readonly operations: {
    readonly activeMigrations: number;
    readonly activeUpgrades: number;
    readonly activeReconciles: number;
  };
}

export type RenewalCheckCode =
  | 'CURRENT_SUCCESSFUL'
  | 'NOT_ADMITTED_TO_MIGRATION'
  | 'EVIDENCE_INTACT'
  | 'NEW_RELEASE_IDENTITY'
  | 'NO_ACTIVE_OPERATION'
  | 'CAPACITY_READY';

export interface RenewalCheck {
  readonly code: RenewalCheckCode;
  readonly ok: boolean;
  readonly detail: string;
}

export interface BackupRenewalPlan {
  readonly status: 'GO' | 'NO_GO';
  readonly checks: readonly RenewalCheck[];
  readonly newReleaseId: string;
  readonly actions: readonly string[];
  readonly capacity: CapacityProvisioning;
}

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN = /^[1-9][0-9]{0,19}$/u;

export function releaseIdentity(controllerSha: string, sourceCiRunId: string): string {
  return `${controllerSha}-${sourceCiRunId}-1`;
}

/**
 * Evaluate the conservative renewal path. Every check must pass; a GO plan still requires the
 * reviewed controller mode and an independent specialist review before any live transition.
 */
export function evaluateBackupRenewal(input: BackupRenewalInput): BackupRenewalPlan {
  const newReleaseId = releaseIdentity(input.target.controllerSha, input.target.sourceCiRunId);
  const capacity = evaluateCapacityProvisioning(
    input.capacity.databaseBytes,
    input.capacity.freeDiskBytes,
    input.capacity.requiredDiskBytes,
  );

  const checks: RenewalCheck[] = [
    {
      code: 'CURRENT_SUCCESSFUL',
      ok: input.current.outcome === 'SUCCESS' || input.current.outcome === 'RECONCILED',
      detail: `outcome=${input.current.outcome}`,
    },
    {
      code: 'NOT_ADMITTED_TO_MIGRATION',
      ok: !input.current.admittedToMigration,
      detail: `admittedToMigration=${input.current.admittedToMigration}`,
    },
    {
      code: 'EVIDENCE_INTACT',
      ok:
        input.evidence.canonicalDirPresent &&
        input.evidence.canonicalBytesPreserved &&
        input.evidence.receiptVerified &&
        input.evidence.restoreProofVerified &&
        input.evidence.sevenCcPreserved &&
        SHA256.test(input.current.operationSha256) &&
        SHA256.test(input.current.receiptSha256),
      detail: `canonicalDir=${input.evidence.canonicalDirPresent} bytes=${input.evidence.canonicalBytesPreserved} receipt=${input.evidence.receiptVerified} restoreProof=${input.evidence.restoreProofVerified} sevenCc=${input.evidence.sevenCcPreserved}`,
    },
    {
      code: 'NEW_RELEASE_IDENTITY',
      ok:
        SHA1.test(input.target.controllerSha) &&
        SHA1.test(input.target.sourceSha) &&
        RUN.test(input.target.sourceCiRunId) &&
        SHA1.test(input.current.sourceSha) &&
        RUN.test(input.current.sourceCiRunId) &&
        newReleaseId !== input.current.releaseId &&
        newReleaseId.startsWith(`${input.target.controllerSha}-`),
      detail: `current=${input.current.releaseId} new=${newReleaseId}`,
    },
    {
      code: 'NO_ACTIVE_OPERATION',
      ok:
        input.operations.activeMigrations === 0 &&
        input.operations.activeUpgrades === 0 &&
        input.operations.activeReconciles === 0,
      detail: `migrations=${input.operations.activeMigrations} upgrades=${input.operations.activeUpgrades} reconciles=${input.operations.activeReconciles}`,
    },
    {
      code: 'CAPACITY_READY',
      ok: capacity.ready,
      detail: capacity.detail,
    },
  ];

  const status = checks.every((check) => check.ok) ? 'GO' : 'NO_GO';
  const actions =
    status === 'GO'
      ? [
          'retire-current-metadata-only',
          'retain-canonical-bytes-and-receipts',
          `create-new-backup-request-under-${newReleaseId}`,
          ...(input.current.leaseHeld ? ['release-old-lease-after-retirement-receipt'] : []),
          'require-independent-specialist-review-before-live',
        ]
      : [];

  return { status, checks, newReleaseId, actions, capacity };
}

/** Human-readable one-line summary for operator packets. */
export function renewalSummary(plan: BackupRenewalPlan): string {
  const failed = plan.checks.filter((check) => !check.ok).map((check) => check.code);
  return `BACKUP_RENEWAL ${plan.status} new=${plan.newReleaseId} ${failed.length === 0 ? 'checks=all' : `blocked=${failed.join(',')}`} capacity=${(plan.capacity.shortfallBytes / GIB).toFixed(2)}GiB-short`;
}
