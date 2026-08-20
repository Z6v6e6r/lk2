/**
 * Review-only adapter for the future descriptor-pinned pg_restore seam.
 *
 * It deliberately has no connection, filesystem, executable, archive, password,
 * marker, evidence or cleanup provider. It validates immutable bindings only and
 * always denies execution before an active runner can be reached.
 */
import {
  assertCommunitiesStagingRoleSplitHostAuthorization,
  assertCommunitiesStagingRoleSplitV3RestoreAuthorization,
  assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding,
  assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding,
  assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings,
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  parseCommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitSourceWriteDenialAttestation,
  type CommunitiesStagingRoleSplitRestoreExecutionEvidence,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesSourceConnectAclObservation,
  type CommunitiesSourceMembershipObservation,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
} from '@phub/database';
import type { FileHandle } from 'node:fs/promises';

import type {
  CommunitiesStagingRoleSplitPgRestorePreflightObservation,
  CommunitiesStagingRoleSplitPgRestoreResult,
  CommunitiesStagingRoleSplitPgRestoreTarget,
} from './communities-staging-role-split-pg-restore-runner.js';

export class CommunitiesStagingRoleSplitRunnerAdapterError extends Error {
  constructor(readonly code: 'EXECUTION_NOT_AUTHORIZED') {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_RUNNER_ADAPTER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitRunnerAdapterError';
  }
}

function executionNotAuthorized(): Promise<never> {
  return Promise.reject(
    new CommunitiesStagingRoleSplitRunnerAdapterError('EXECUTION_NOT_AUTHORIZED'),
  );
}

export const COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY =
  'phub.communities.role-split.restore.v1' as const;
const MAX_V3_PREPARATION_ENVELOPE_BYTES = 1024 * 1024;

/** Review-only future fence contract. The disabled adapter never receives or invokes it. */
export interface CommunitiesStagingRoleSplitDdlFence {
  acquire(input: {
    readonly requestSha256: string;
    readonly systemIdentifier: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly requestSha256: string;
    readonly systemIdentifier: string;
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }>;
  assertHeld(lease: {
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }): Promise<void>;
  release(lease: {
    readonly backendPid: string;
    readonly fencingToken: string;
    readonly advisoryKey: typeof COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY;
  }): Promise<void>;
}

export type CommunitiesStagingRoleSplitDdlFenceLease = Awaited<
  ReturnType<CommunitiesStagingRoleSplitDdlFence['acquire']>
>;

export interface CommunitiesStagingRoleSplitRestoreArchiveInput {
  /** Intentionally opaque to the disabled adapter: it must not inspect this descriptor. */
  readonly archiveFile: FileHandle;
  readonly cloneDatabaseOid: string;
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
}

export interface CommunitiesStagingRoleSplitRunnerAdapterConfig {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly descriptor: CommunitiesStagingRoleSplitRestoreExecutionDescriptor;
  readonly sourceWriteDenialAttestation: CommunitiesStagingRoleSplitSourceWriteDenialAttestation;
  readonly connectAclObservation: CommunitiesSourceConnectAclObservation;
  readonly membershipObservation: CommunitiesSourceMembershipObservation;
  readonly restoreExecutionEvidence: CommunitiesStagingRoleSplitRestoreExecutionEvidence;
  readonly creationReceiptSha256: string;
}

/**
 * Pure, synchronous binding check for review and tests. It has no runtime collaborators and does
 * not inspect the archive; restoreArchive still denies after this check succeeds.
 */
export function assertCommunitiesStagingRoleSplitRunnerAdapterBinding(
  config: CommunitiesStagingRoleSplitRunnerAdapterConfig,
  input: Pick<CommunitiesStagingRoleSplitRestoreArchiveInput, 'cloneDatabaseOid' | 'request'>,
): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(config.descriptor);
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(config.request);
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    assertCommunitiesStagingRoleSplitRestoreExecutionEvidenceBindings({
      request: config.request,
      attestation: config.sourceWriteDenialAttestation,
      descriptor: config.descriptor,
      evidence: config.restoreExecutionEvidence,
      connectAclObservation: config.connectAclObservation,
      membershipObservation: config.membershipObservation,
      creationReceiptSha256: config.creationReceiptSha256,
      cloneDatabaseOid: input.cloneDatabaseOid,
      systemIdentifier: config.request.systemIdentifier,
      restoreRunId: config.request.restoreRunId,
      restoreRunAttempt: config.request.restoreRunAttempt,
    });
    assertCommunitiesStagingRoleSplitSourceWriteDenialAttestationBinding({
      request: config.request,
      descriptor: config.descriptor,
      attestation: config.sourceWriteDenialAttestation,
      connectAclObservation: config.connectAclObservation,
      membershipObservation: config.membershipObservation,
    });
    const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(config.request);
    if (
      config.descriptor.markerRequestSha256 !== requestSha256 ||
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) !== requestSha256 ||
      config.descriptor.creationReceiptSha256 !== config.creationReceiptSha256 ||
      input.request.restoreDatabase !== config.request.restoreDatabase ||
      input.request.expectedCloneDatabaseOwner !== config.descriptor.identity.restoreRole.name ||
      input.request.expectedCloneDatabaseOwnerOid !== config.descriptor.identity.restoreRole.oid ||
      input.cloneDatabaseOid !== config.descriptor.cloneDatabaseOid
    ) {
      throw new CommunitiesStagingRoleSplitRunnerAdapterError('EXECUTION_NOT_AUTHORIZED');
    }
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitRunnerAdapterError) throw error;
    throw new CommunitiesStagingRoleSplitRunnerAdapterError('EXECUTION_NOT_AUTHORIZED');
  }
}

export class CommunitiesStagingRoleSplitRunnerAdapter {
  constructor(private readonly config: CommunitiesStagingRoleSplitRunnerAdapterConfig) {}

  restoreArchive(input: CommunitiesStagingRoleSplitRestoreArchiveInput): Promise<never> {
    try {
      assertCommunitiesStagingRoleSplitRunnerAdapterBinding(this.config, input);
    } catch {
      return executionNotAuthorized();
    }
    return executionNotAuthorized();
  }
}

export class CommunitiesStagingRoleSplitReviewedRunnerAdapterError extends Error {
  constructor(
    readonly code:
      | 'AUTHORIZATION_INVALID'
      | 'BINDING_INVALID'
      | 'FENCE_UNAVAILABLE'
      | 'FENCE_LOST'
      | 'FENCE_RELEASE_FAILED'
      | 'RESTORE_OUTCOME_AMBIGUOUS'
      | 'V3_DURABLE_EXECUTION_CAPABILITY_REQUIRED'
      | 'V3_EXECUTION_EVIDENCE_REQUIRED',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_REVIEWED_RUNNER_ADAPTER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitReviewedRunnerAdapterError';
  }
}

export interface CommunitiesStagingRoleSplitReviewedRunnerAdapterConfig {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly creationReceiptSha256: string;
  readonly authorization: CommunitiesStagingRoleSplitHostAuthorization;
  /** Independently retained SHA-256; it must not be derived from authorization in the caller. */
  readonly expectedAuthorizationSha256: string;
  readonly componentSha256: {
    readonly canonicalHostAdapter: string;
  };
  readonly target: CommunitiesStagingRoleSplitPgRestoreTarget;
  readonly expectedPgRestoreSha256: string;
  readonly preflightTimeoutMs: number;
  readonly restoreTimeoutMs: number;
  readonly fenceTimeoutMs: number;
  readonly connectionFactory: {
    readonly subjectSha256: string;
    readonly preflight: (
      target: CommunitiesStagingRoleSplitPgRestoreTarget,
      signal: AbortSignal,
    ) => Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation>;
  };
  readonly fence: CommunitiesStagingRoleSplitDdlFence & { readonly subjectSha256: string };
  /**
   * Lease already owned by the canonical host adapter. When present, this adapter
   * only verifies it and must never acquire or release the cluster fence itself.
   */
  readonly externalFenceLease?: CommunitiesStagingRoleSplitDdlFenceLease;
  readonly passwordFile: FileHandle;
  readonly executableFile: FileHandle;
  readonly v3Restore?: {
    readonly authorization: CommunitiesStagingRoleSplitV3RestoreAuthorization;
    /** Independently retained digest; never derive it from authorization in the caller. */
    readonly expectedAuthorizationSha256: string;
  };
}

export interface CommunitiesStagingRoleSplitReviewedRestoreArchiveInput extends CommunitiesStagingRoleSplitRestoreArchiveInput {
  /** Exact canonical bytes read by the pinned durable host after RESTORE_PENDING fsync/readback. */
  readonly v3PreparationEnvelopeBytes?: string;
}

function reviewedFail(code: CommunitiesStagingRoleSplitReviewedRunnerAdapterError['code']): never {
  throw new CommunitiesStagingRoleSplitReviewedRunnerAdapterError(code);
}

function exactSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function assertReviewedConfig(
  config: CommunitiesStagingRoleSplitReviewedRunnerAdapterConfig,
): void {
  try {
    assertCommunitiesStagingRoleSplitRestoreMarkerRequest(config.request);
    assertCommunitiesStagingRoleSplitHostAuthorization(config.authorization);
  } catch {
    reviewedFail('AUTHORIZATION_INVALID');
  }
  const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(config.request);
  if (
    !exactSha256(config.expectedAuthorizationSha256) ||
    communitiesStagingRoleSplitHostAuthorizationSha256(config.authorization) !==
      config.expectedAuthorizationSha256 ||
    config.authorization.markerRequestSha256 !== requestSha256 ||
    config.authorization.creationReceiptSha256 !== config.creationReceiptSha256
  )
    reviewedFail('AUTHORIZATION_INVALID');
  if (
    !exactSha256(config.creationReceiptSha256) ||
    !exactSha256(config.expectedPgRestoreSha256) ||
    config.authorization.execution.canonicalHostAdapterSha256 !==
      config.componentSha256.canonicalHostAdapter ||
    config.authorization.execution.cloneOnlyConnectionFactorySha256 !==
      config.connectionFactory.subjectSha256 ||
    config.authorization.execution.ddlFenceSha256 !== config.fence.subjectSha256 ||
    config.authorization.execution.pgRestoreSha256 !== config.expectedPgRestoreSha256 ||
    config.authorization.execution.cloneDatabaseOid !== config.target.databaseOid ||
    config.authorization.execution.connection.host !== config.target.host ||
    config.authorization.execution.connection.port !== config.target.port ||
    config.authorization.execution.connection.sslMode !== config.target.sslMode ||
    config.authorization.execution.restoreLogin.name !== config.target.restoreRole ||
    config.authorization.execution.restoreLogin.oid !== config.target.restoreRoleOid ||
    config.target.database !== config.request.restoreDatabase ||
    config.target.sourceDatabase !== config.request.sourceDatabase ||
    config.target.systemIdentifier !== config.request.systemIdentifier ||
    config.target.postgresMajor !== '16' ||
    config.target.restoreRole !== config.request.expectedCloneDatabaseOwner ||
    config.target.restoreRoleOid !== config.request.expectedCloneDatabaseOwnerOid ||
    config.target.connectionUser !== config.target.restoreRole ||
    config.target.connectionUserOid !== config.target.restoreRoleOid ||
    ![config.preflightTimeoutMs, config.fenceTimeoutMs].every(
      (value) => Number.isSafeInteger(value) && value >= 1 && value <= 60_000,
    ) ||
    !Number.isSafeInteger(config.restoreTimeoutMs) ||
    config.restoreTimeoutMs < 1 ||
    config.restoreTimeoutMs > 30 * 60_000
  )
    reviewedFail('BINDING_INVALID');
  if (config.v3Restore !== undefined) {
    try {
      assertCommunitiesStagingRoleSplitV3RestoreAuthorization(config.v3Restore.authorization);
    } catch {
      reviewedFail('AUTHORIZATION_INVALID');
    }
    if (
      !exactSha256(config.v3Restore.expectedAuthorizationSha256) ||
      communitiesStagingRoleSplitV3RestoreAuthorizationSha256(config.v3Restore.authorization) !==
        config.v3Restore.expectedAuthorizationSha256
    )
      reviewedFail('AUTHORIZATION_INVALID');
  }
}

export class CommunitiesStagingRoleSplitReviewedRunnerAdapter {
  constructor(private readonly config: CommunitiesStagingRoleSplitReviewedRunnerAdapterConfig) {
    assertReviewedConfig(config);
  }

  restoreArchive(
    input: CommunitiesStagingRoleSplitReviewedRestoreArchiveInput,
  ): Promise<CommunitiesStagingRoleSplitPgRestoreResult> {
    try {
      return Promise.resolve(this.restoreArchiveWithV3(input));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('RESTORE_REJECTED'));
    }
  }

  private restoreArchiveWithV3(
    input: CommunitiesStagingRoleSplitReviewedRestoreArchiveInput,
  ): CommunitiesStagingRoleSplitPgRestoreResult {
    if (this.config.v3Restore === undefined || input.v3PreparationEnvelopeBytes === undefined)
      reviewedFail('V3_EXECUTION_EVIDENCE_REQUIRED');
    if (
      Buffer.byteLength(input.v3PreparationEnvelopeBytes, 'utf8') >
      MAX_V3_PREPARATION_ENVELOPE_BYTES
    )
      reviewedFail('BINDING_INVALID');

    let envelope;
    try {
      envelope = parseCommunitiesStagingRoleSplitV3PreparationEnvelope(
        input.v3PreparationEnvelopeBytes,
      );
      assertCommunitiesStagingRoleSplitV3RestoreAuthorizationBinding({
        request: this.config.request,
        preparationEnvelope: envelope,
        hostAuthorization: this.config.authorization,
        restoreAuthorization: this.config.v3Restore.authorization,
      });
      if (
        communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) !==
          communitiesStagingRoleSplitRestoreMarkerRequestSha256(this.config.request) ||
        input.cloneDatabaseOid !== this.config.target.databaseOid ||
        envelope.state.phase !== 'RESTORE_PENDING'
      )
        reviewedFail('BINDING_INVALID');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitReviewedRunnerAdapterError) throw error;
      reviewedFail('BINDING_INVALID');
    }

    // RESTORE_PENDING is a durable ambiguity boundary. Canonical bytes and authorization are
    // deliberately insufficient to distinguish a fresh OWNED -> RESTORE_PENDING CAS from a
    // replay after restart or response loss. Execution therefore stays unavailable until a
    // separately reviewed durable V3 host can supply an atomic, one-shot capability and bind the
    // exact opened archive inode, byte count and pre/post SHA-256 to that capability.
    reviewedFail('V3_DURABLE_EXECUTION_CAPABILITY_REQUIRED');
  }
}
