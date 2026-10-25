/**
 * Pure release-readiness evaluation for the delivery lanes (ADR-0026).
 *
 * The operator (or an agent preparing a package) supplies the exact inputs and read-only host
 * evidence collected by the canonical probes. This module performs no I/O, so it can be reused by a
 * CLI and by tests, and it prints GO/NO-GO by category instead of failing later during a mutation.
 */
import {
  evaluateCapacityProvisioning,
  type CapacityProvisioning,
  type Profile,
} from './timeweb-restore-capacity.js';
import { decideApprovalExtension, type ApprovalWindowInput } from './release-approval-window.js';

export type ReadinessStatus = 'GO' | 'NO_GO';

export interface ReadinessCategory {
  readonly category: string;
  readonly status: ReadinessStatus;
  readonly code: string;
  readonly detail: string;
}

export interface ReleaseReadinessInput {
  readonly source: {
    readonly sha: string;
    readonly mainSha: string;
    readonly ci: {
      readonly runId: string;
      readonly attempt: number;
      readonly conclusion: string;
    };
  };
  readonly publication: {
    readonly runId: string;
    readonly attempt: number;
    readonly conclusion: string;
    readonly sourceSha: string;
    readonly manifestSha256: string;
    readonly artifactDigest: string;
  };
  readonly capacity: {
    readonly databaseBytes: number;
    /** Required free bytes from the canonical host capacity readback. */
    readonly requiredDiskBytes: number;
    readonly freeDiskBytes: number;
    readonly profile: Profile;
  };
  readonly ledger: { readonly current: number; readonly target: number };
  readonly approval?: ApprovalWindowInput;
  readonly locks?: { readonly activeOperations: number; readonly activeLease: boolean };
  readonly rollback?: { readonly previousApiDigest: string; readonly previousWebDigest: string };
}

export interface ReleaseReadinessReport {
  readonly status: ReadinessStatus;
  readonly categories: readonly ReadinessCategory[];
  readonly capacity: CapacityProvisioning;
}

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

function category(name: string, ok: boolean, code: string, detail: string): ReadinessCategory {
  return { category: name, status: ok ? 'GO' : 'NO_GO', code, detail };
}

/**
 * Evaluate one release package. Every category must be explicitly satisfied; missing inputs are a
 * NO_GO, never an implicit pass.
 */
export function evaluateReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadinessReport {
  const categories: ReadinessCategory[] = [];

  const sourceOk =
    SHA1.test(input.source.sha) &&
    SHA1.test(input.source.mainSha) &&
    input.source.sha === input.source.mainSha &&
    /^[1-9][0-9]{0,19}$/u.test(input.source.ci.runId) &&
    input.source.ci.attempt === 1 &&
    input.source.ci.conclusion === 'success';
  categories.push(
    category(
      'SOURCE',
      sourceOk,
      sourceOk ? 'CURRENT_MAIN_CI' : 'SOURCE_NOT_CURRENT_MAIN_CI',
      sourceOk
        ? `sha=${input.source.sha} ci=${input.source.ci.runId} attempt=1`
        : 'source must equal current main with a successful first-attempt push CI',
    ),
  );

  const publicationOk =
    /^[1-9][0-9]{0,19}$/u.test(input.publication.runId) &&
    input.publication.attempt === 1 &&
    input.publication.conclusion === 'success' &&
    input.publication.sourceSha === input.source.sha &&
    /^[0-9a-f]{64}$/u.test(input.publication.manifestSha256) &&
    SHA256.test(input.publication.artifactDigest);
  categories.push(
    category(
      'PUBLICATION',
      publicationOk,
      publicationOk ? 'CANONICAL_PUBLICATION' : 'PUBLICATION_INVALID',
      publicationOk
        ? `run=${input.publication.runId} manifest=${input.publication.manifestSha256.slice(0, 12)}`
        : 'publication must be a successful first-attempt canonical publication for this source',
    ),
  );

  const capacity =
    POSITIVE(input.capacity.databaseBytes) &&
    POSITIVE(input.capacity.requiredDiskBytes) &&
    Number.isSafeInteger(input.capacity.freeDiskBytes) &&
    input.capacity.freeDiskBytes >= 0
      ? evaluateCapacityProvisioning(
          input.capacity.databaseBytes,
          input.capacity.freeDiskBytes,
          input.capacity.requiredDiskBytes,
        )
      : {
          databaseBytes: input.capacity.databaseBytes,
          freeDisk: input.capacity.freeDiskBytes,
          requiredDiskBytes: 0,
          provisioningTargetBytes: 0,
          shortfallBytes: 0,
          provisioningShortfallBytes: 0,
          ready: false,
          detail: 'capacity evidence is missing or malformed',
        };
  categories.push(
    category(
      'CAPACITY',
      capacity.ready,
      capacity.ready ? 'CAPACITY_READY' : 'CAPACITY_PROVISIONING_REQUIRED',
      capacity.detail,
    ),
  );

  const ledgerOk =
    Number.isSafeInteger(input.ledger.current) &&
    Number.isSafeInteger(input.ledger.target) &&
    input.ledger.current >= 0 &&
    input.ledger.target > input.ledger.current;
  categories.push(
    category(
      'LEDGER',
      ledgerOk,
      ledgerOk ? 'LEDGER_PATH_KNOWN' : 'LEDGER_PATH_INVALID',
      ledgerOk
        ? `current=${input.ledger.current} target=${input.ledger.target}`
        : 'ledger must have a positive forward path',
    ),
  );

  if (input.approval) {
    const decision = decideApprovalExtension(input.approval);
    const stillValid =
      Date.parse(input.approval.expiresAt) > Date.parse(input.approval.now) &&
      input.approval.approvedRequestSha256 === input.approval.currentRequestSha256;
    const approvalOk = stillValid || decision.extend;
    categories.push(
      category(
        'APPROVAL',
        approvalOk,
        stillValid ? 'APPROVAL_VALID' : decision.extend ? 'APPROVAL_EXTENDED' : decision.reason,
        stillValid
          ? `expiresAt=${input.approval.expiresAt}`
          : decision.extend
            ? `expiresAt=${decision.expiresAt}`
            : `approval cannot cover this request: ${decision.reason}`,
      ),
    );
  } else {
    categories.push(
      category('APPROVAL', false, 'APPROVAL_MISSING', 'no approval record was provided'),
    );
  }

  if (input.locks) {
    const locksOk = input.locks.activeOperations === 0 && input.locks.activeLease === false;
    categories.push(
      category(
        'LOCKS',
        locksOk,
        locksOk ? 'NO_ACTIVE_OPERATION' : 'ACTIVE_OPERATION',
        `operations=${input.locks.activeOperations} lease=${input.locks.activeLease}`,
      ),
    );
  } else {
    categories.push(
      category('LOCKS', false, 'LOCK_EVIDENCE_MISSING', 'no lock evidence was provided'),
    );
  }

  if (input.rollback) {
    const rollbackOk =
      SHA256.test(input.rollback.previousApiDigest) &&
      SHA256.test(input.rollback.previousWebDigest) &&
      input.rollback.previousApiDigest !== input.rollback.previousWebDigest;
    categories.push(
      category(
        'ROLLBACK',
        rollbackOk,
        rollbackOk ? 'ROLLBACK_INPUTS_PRESENT' : 'ROLLBACK_INPUTS_INVALID',
        rollbackOk ? 'previous API/Web digests recorded' : 'previous digests are malformed',
      ),
    );
  } else {
    categories.push(
      category('ROLLBACK', false, 'ROLLBACK_INPUTS_MISSING', 'no previous digests were provided'),
    );
  }

  return {
    status: categories.every((entry) => entry.status === 'GO') ? 'GO' : 'NO_GO',
    categories,
    capacity,
  };
}
