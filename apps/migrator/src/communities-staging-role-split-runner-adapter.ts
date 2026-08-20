/**
 * Review-only adapter for the future descriptor-pinned pg_restore seam.
 *
 * It deliberately has no connection, filesystem, executable, archive, password,
 * marker, evidence or cleanup provider. It validates immutable bindings only and
 * always denies execution before an active runner can be reached.
 */
import {
  assertCommunitiesStagingRoleSplitHostAuthorization,
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitHostAuthorizationSha256,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import type { FileHandle } from 'node:fs/promises';

import {
  runCommunitiesStagingRoleSplitPgRestore,
  type CommunitiesStagingRoleSplitPgRestorePreflightObservation,
  type CommunitiesStagingRoleSplitPgRestoreResult,
  type CommunitiesStagingRoleSplitPgRestoreTarget,
  type CommunitiesStagingRoleSplitPgRestoreRunnerConfig,
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
  readonly creationReceiptSha256: string;
}

export class CommunitiesStagingRoleSplitRunnerAdapter {
  constructor(private readonly config: CommunitiesStagingRoleSplitRunnerAdapterConfig) {}

  restoreArchive(input: CommunitiesStagingRoleSplitRestoreArchiveInput): Promise<never> {
    try {
      assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor(this.config.descriptor);
      assertCommunitiesStagingRoleSplitRestoreMarkerRequest(this.config.request);
      assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
      const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(
        this.config.request,
      );
      const callbackRequestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(
        input.request,
      );
      if (
        this.config.descriptor.markerRequestSha256 !== requestSha256 ||
        callbackRequestSha256 !== requestSha256 ||
        this.config.descriptor.creationReceiptSha256 !== this.config.creationReceiptSha256 ||
        input.request.restoreDatabase !== this.config.request.restoreDatabase ||
        input.request.expectedCloneDatabaseOwner !==
          this.config.descriptor.identity.restoreRole.name ||
        input.request.expectedCloneDatabaseOwnerOid !==
          this.config.descriptor.identity.restoreRole.oid ||
        input.cloneDatabaseOid !== this.config.descriptor.cloneDatabaseOid ||
        this.config.descriptor.authorizes.execution !== false ||
        this.config.descriptor.authorizes.cloneCreation !== false ||
        this.config.descriptor.authorizes.restore !== false ||
        this.config.descriptor.authorizes.markerWrite !== false ||
        this.config.descriptor.authorizes.evidencePublication !== false ||
        this.config.descriptor.authorizes.automaticCleanup !== false
      )
        return executionNotAuthorized();
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
      | 'RESTORE_OUTCOME_AMBIGUOUS',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_REVIEWED_RUNNER_ADAPTER_${code}`);
    this.name = 'CommunitiesStagingRoleSplitReviewedRunnerAdapterError';
  }
}

type RunRestore = typeof runCommunitiesStagingRoleSplitPgRestore;

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
  /** Test seam only. Production callers omit it and use the descriptor-pinned runner. */
  readonly runRestore?: RunRestore;
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
}

function assertFenceLease(lease: CommunitiesStagingRoleSplitDdlFenceLease): void {
  if (
    !exactSha256(lease.requestSha256) ||
    !/^[0-9]{10,32}$/u.test(lease.systemIdentifier) ||
    !/^[1-9][0-9]*$/u.test(lease.backendPid) ||
    !exactSha256(lease.fencingToken) ||
    lease.advisoryKey !== COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY
  )
    reviewedFail('FENCE_LOST');
}

export class CommunitiesStagingRoleSplitReviewedRunnerAdapter {
  constructor(private readonly config: CommunitiesStagingRoleSplitReviewedRunnerAdapterConfig) {
    assertReviewedConfig(config);
  }

  async restoreArchive(
    input: CommunitiesStagingRoleSplitRestoreArchiveInput,
  ): Promise<CommunitiesStagingRoleSplitPgRestoreResult> {
    try {
      assertCommunitiesStagingRoleSplitRestoreMarkerRequest(input.request);
    } catch {
      reviewedFail('BINDING_INVALID');
    }
    if (
      communitiesStagingRoleSplitRestoreMarkerRequestSha256(input.request) !==
        this.config.authorization.markerRequestSha256 ||
      input.cloneDatabaseOid !== this.config.target.databaseOid
    )
      reviewedFail('BINDING_INVALID');

    let lease: CommunitiesStagingRoleSplitDdlFenceLease;
    const ownsFenceLease = this.config.externalFenceLease === undefined;
    try {
      lease =
        this.config.externalFenceLease ??
        (await this.config.fence.acquire({
          requestSha256: this.config.authorization.markerRequestSha256,
          systemIdentifier: this.config.request.systemIdentifier,
          timeoutMs: this.config.fenceTimeoutMs,
          signal: AbortSignal.timeout(this.config.fenceTimeoutMs),
        }));
      assertFenceLease(lease);
      if (
        lease.requestSha256 !== this.config.authorization.markerRequestSha256 ||
        lease.systemIdentifier !== this.config.request.systemIdentifier
      )
        reviewedFail('FENCE_UNAVAILABLE');
      await this.config.fence.assertHeld(lease);
    } catch {
      reviewedFail('FENCE_UNAVAILABLE');
    }

    let primaryError: CommunitiesStagingRoleSplitReviewedRunnerAdapterError | null = null;
    let result: CommunitiesStagingRoleSplitPgRestoreResult | null = null;
    try {
      const runnerConfig: CommunitiesStagingRoleSplitPgRestoreRunnerConfig = {
        target: this.config.target,
        preflight: this.config.connectionFactory.preflight,
        expectedPgRestoreSha256: this.config.expectedPgRestoreSha256,
        timeoutMs: this.config.restoreTimeoutMs,
        preflightTimeoutMs: this.config.preflightTimeoutMs,
      };
      result = await (this.config.runRestore ?? runCommunitiesStagingRoleSplitPgRestore)(
        runnerConfig,
        {
          archiveFile: input.archiveFile,
          passwordFile: this.config.passwordFile,
          executableFile: this.config.executableFile,
        },
      );
      try {
        await this.config.fence.assertHeld(lease);
      } catch {
        reviewedFail('RESTORE_OUTCOME_AMBIGUOUS');
      }
    } catch (error) {
      primaryError =
        error instanceof CommunitiesStagingRoleSplitReviewedRunnerAdapterError
          ? error
          : new CommunitiesStagingRoleSplitReviewedRunnerAdapterError('RESTORE_OUTCOME_AMBIGUOUS');
    }

    let releaseError: CommunitiesStagingRoleSplitReviewedRunnerAdapterError | null = null;
    if (ownsFenceLease) {
      try {
        await this.config.fence.release(lease);
      } catch {
        releaseError = new CommunitiesStagingRoleSplitReviewedRunnerAdapterError(
          'FENCE_RELEASE_FAILED',
        );
      }
    }
    if (primaryError !== null) {
      if (releaseError !== null) primaryError.cause = releaseError;
      throw primaryError;
    }
    if (releaseError !== null) throw releaseError;
    if (result === null) reviewedFail('RESTORE_OUTCOME_AMBIGUOUS');
    return result;
  }
}
