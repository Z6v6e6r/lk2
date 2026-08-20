/**
 * Review-only adapter for the future descriptor-pinned pg_restore seam.
 *
 * It deliberately has no connection, filesystem, executable, archive, password,
 * marker, evidence or cleanup provider. It validates immutable bindings only and
 * always denies execution before an active runner can be reached.
 */
import {
  assertCommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  assertCommunitiesStagingRoleSplitRestoreMarkerRequest,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  type CommunitiesStagingRoleSplitRestoreExecutionDescriptor,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import type { FileHandle } from 'node:fs/promises';

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
