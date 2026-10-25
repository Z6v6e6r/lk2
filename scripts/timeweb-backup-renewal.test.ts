import { describe, expect, it } from 'vitest';

import {
  evaluateBackupRenewal,
  releaseIdentity,
  renewalSummary,
  type BackupRenewalInput,
} from './timeweb-backup-renewal.js';

const sha40 = (char: string): string => char.repeat(40);
const sha256 = (char: string): string => char.repeat(64);

function fixture(): BackupRenewalInput {
  const controllerSha = sha40('a');
  const sourceCiRunId = '35708208109';
  return {
    current: {
      releaseId: releaseIdentity(controllerSha, sourceCiRunId),
      sourceSha: sha40('b'),
      sourceCiRunId,
      operationSha256: sha256('c'),
      receiptSha256: sha256('d'),
      outcome: 'RECONCILED',
      admittedToMigration: false,
      leaseHeld: true,
      completedAt: '2026-10-24T21:06:37.000Z',
    },
    target: {
      controllerSha: sha40('e'),
      sourceSha: sha40('f'),
      sourceCiRunId: '40175752367',
    },
    evidence: {
      canonicalDirPresent: true,
      canonicalBytesPreserved: true,
      receiptVerified: true,
      restoreProofVerified: true,
      sevenCcPreserved: true,
    },
    capacity: {
      databaseBytes: 11_176_434_711,
      requiredDiskBytes: 47_453_667_687,
      freeDiskBytes: 60_000_000_000,
    },
    operations: { activeMigrations: 0, activeUpgrades: 0, activeReconciles: 0 },
  };
}

describe('conservative backup renewal plan', () => {
  it('plans a metadata-only retirement under a new source identity when all checks pass', () => {
    const plan = evaluateBackupRenewal(fixture());
    expect(plan.status).toBe('GO');
    expect(plan.newReleaseId).toBe(releaseIdentity(sha40('e'), '40175752367'));
    expect(plan.actions).toContain('retire-current-metadata-only');
    expect(plan.actions).toContain('retain-canonical-bytes-and-receipts');
    expect(plan.actions).toContain('release-old-lease-after-retirement-receipt');
    expect(plan.actions).toContain('require-independent-specialist-review-before-live');
  });

  it('refuses renewal of an already admitted backup', () => {
    const plan = evaluateBackupRenewal({
      ...fixture(),
      current: { ...fixture().current, admittedToMigration: true },
    });
    expect(plan.status).toBe('NO_GO');
    expect(plan.checks.find((check) => check.code === 'NOT_ADMITTED_TO_MIGRATION')).toMatchObject({
      ok: false,
    });
  });

  it('refuses a target identity that does not create a new canonical path', () => {
    const input = fixture();
    const plan = evaluateBackupRenewal({
      ...input,
      target: {
        controllerSha: sha40('a'),
        sourceSha: input.current.sourceSha,
        sourceCiRunId: input.current.sourceCiRunId,
      },
    });
    expect(plan.status).toBe('NO_GO');
    expect(plan.checks.find((check) => check.code === 'NEW_RELEASE_IDENTITY')).toMatchObject({
      ok: false,
    });
  });

  it('refuses while any owned operation is active', () => {
    const plan = evaluateBackupRenewal({
      ...fixture(),
      operations: { activeMigrations: 1, activeUpgrades: 0, activeReconciles: 0 },
    });
    expect(plan.status).toBe('NO_GO');
    expect(plan.checks.find((check) => check.code === 'NO_ACTIVE_OPERATION')).toMatchObject({
      ok: false,
    });
  });

  it('reports the exact capacity shortfall before any retirement', () => {
    const plan = evaluateBackupRenewal({
      ...fixture(),
      capacity: {
        databaseBytes: 11_176_434_711,
        requiredDiskBytes: 47_453_667_687,
        freeDiskBytes: 42_928_771_072,
      },
    });
    expect(plan.status).toBe('NO_GO');
    const capacity = plan.checks.find((check) => check.code === 'CAPACITY_READY');
    expect(capacity?.ok).toBe(false);
    expect(capacity?.detail).toContain('action=resize-or-cleanup');
    expect(plan.capacity.shortfallBytes).toBe(47_453_667_687 - 42_928_771_072);
    expect(renewalSummary(plan)).toContain('BACKUP_RENEWAL NO_GO');
  });

  it('refuses when any custody evidence is missing', () => {
    const input = fixture();
    const plan = evaluateBackupRenewal({
      ...input,
      evidence: { ...input.evidence, restoreProofVerified: false },
    });
    expect(plan.status).toBe('NO_GO');
    expect(plan.checks.find((check) => check.code === 'EVIDENCE_INTACT')).toMatchObject({
      ok: false,
    });
  });
});
