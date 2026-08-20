import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import {
  assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding,
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding,
  assertCommunitiesStagingRoleSplitV3State,
  canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope,
  canonicalCommunitiesStagingRoleSplitV3State,
  communitiesStagingRoleSplitRestoreMarkerRequestSha256,
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
  type CommunitiesStagingRoleSplitV3State,
} from '@phub/database';

import type { CommunitiesStagingRoleSplitV3ExecutableLease } from './communities-staging-role-split-v3-executable-composition.js';

export type CommunitiesStagingRoleSplitV3StateCasResult = 'advanced' | 'conflict' | 'ambiguous';

export interface CommunitiesStagingRoleSplitV3DurableStateStore {
  readonly subjectSha256: string;
  compareAndSwap(input: {
    readonly lease: CommunitiesStagingRoleSplitV3ExecutableLease;
    readonly current: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
    readonly next: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  }): Promise<CommunitiesStagingRoleSplitV3StateCasResult>;
}

export interface CommunitiesStagingRoleSplitV3ArchiveCustody {
  readonly subjectSha256: string;
  openArchive(input: {
    readonly requestSha256: string;
    readonly expectedSha256: string;
    readonly expectedBytes: string;
  }): Promise<FileHandle>;
}

export interface CommunitiesStagingRoleSplitV3RestoreRunner {
  readonly subjectSha256: string;
  run(input: {
    readonly archiveFile: FileHandle;
    readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
    readonly cloneDatabaseOid: string;
    readonly v3PreparationEnvelopeBytes: string;
  }): Promise<void>;
}

export interface CommunitiesStagingRoleSplitV3HeldFence {
  readonly subjectSha256: string;
  assertHeld(lease: CommunitiesStagingRoleSplitV3ExecutableLease): Promise<void>;
}

export interface CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorConfig {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly cloneCreationAuthorization: CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
  readonly preparationEnvelope: CommunitiesStagingRoleSplitV3PreparationEnvelope;
  readonly restoreAuthorization: CommunitiesStagingRoleSplitV3RestoreAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly durableRestoreAuthorization: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
  readonly expectedDurableRestoreAuthorizationSha256: string;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly expectedExecutionAuthorizationSha256: string;
  readonly ownedEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly restorePendingEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly restoredEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly stateStore: CommunitiesStagingRoleSplitV3DurableStateStore;
  readonly archiveCustody: CommunitiesStagingRoleSplitV3ArchiveCustody;
  readonly runner: CommunitiesStagingRoleSplitV3RestoreRunner;
  readonly fence: CommunitiesStagingRoleSplitV3HeldFence;
}

export class CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError extends Error {
  constructor(
    readonly code:
      | 'AUTHORIZATION_INVALID'
      | 'BINDING_INVALID'
      | 'FENCE_LOST'
      | 'ARCHIVE_CUSTODY_INVALID'
      | 'STATE_WRITE_CONFLICT'
      | 'STATE_WRITE_AMBIGUOUS'
      | 'RESTORE_OUTCOME_AMBIGUOUS'
      | 'ARCHIVE_CHANGED'
      | 'ARCHIVE_CLOSE_FAILED',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_RESTORE_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError['code']): never {
  throw new CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError(code);
}

function exactSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function sameState(
  left: CommunitiesStagingRoleSplitV3State,
  right: CommunitiesStagingRoleSplitV3State,
): boolean {
  return (
    canonicalCommunitiesStagingRoleSplitV3State(left) ===
    canonicalCommunitiesStagingRoleSplitV3State(right)
  );
}

function assertConfig(config: CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorConfig): void {
  try {
    assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
      request: config.request,
      preparationEnvelope: config.preparationEnvelope,
      restoreAuthorization: config.restoreAuthorization,
      hostAuthorization: config.hostAuthorization,
      ownedEnvelope: config.ownedEnvelope,
      restorePendingEnvelope: config.restorePendingEnvelope,
      restoredEnvelope: config.restoredEnvelope,
      componentSubjects: {
        durableHostSha256: config.executionAuthorization.components.executableCompositionSha256,
        stateStoreSha256: config.stateStore.subjectSha256,
        archiveCustodySha256: config.archiveCustody.subjectSha256,
      },
      authorization: config.durableRestoreAuthorization,
    });
    assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding({
      request: config.request,
      cloneCreationAuthorization: config.cloneCreationAuthorization,
      hostAuthorization: config.hostAuthorization,
      durableRestoreAuthorization: config.durableRestoreAuthorization,
      authorization: config.executionAuthorization,
    });
  } catch {
    fail('AUTHORIZATION_INVALID');
  }
  if (
    !exactSha256(config.expectedDurableRestoreAuthorizationSha256) ||
    !exactSha256(config.expectedExecutionAuthorizationSha256) ||
    communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(
      config.durableRestoreAuthorization,
    ) !== config.expectedDurableRestoreAuthorizationSha256 ||
    communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(config.executionAuthorization) !==
      config.expectedExecutionAuthorizationSha256 ||
    config.stateStore.subjectSha256 !== config.executionAuthorization.components.stateStoreSha256 ||
    config.archiveCustody.subjectSha256 !==
      config.executionAuthorization.components.archiveCustodySha256 ||
    config.runner.subjectSha256 !== config.executionAuthorization.components.runnerAdapterSha256 ||
    config.fence.subjectSha256 !== config.executionAuthorization.components.ddlFenceSha256
  )
    fail('BINDING_INVALID');
}

type ArchiveIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly bytes: bigint;
  readonly sha256: string;
};

async function archiveIdentity(file: FileHandle): Promise<ArchiveIdentity> {
  let stat;
  try {
    stat = await file.stat({ bigint: true });
  } catch {
    fail('ARCHIVE_CUSTODY_INVALID');
  }
  if (
    (stat.mode & BigInt(constants.S_IFMT)) !== BigInt(constants.S_IFREG) ||
    stat.nlink !== 1n ||
    stat.size < 1n ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    fail('ARCHIVE_CUSTODY_INVALID');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < Number(stat.size)) {
    const length = Math.min(buffer.length, Number(stat.size) - position);
    let bytesRead: number;
    try {
      ({ bytesRead } = await file.read(buffer, 0, length, position));
    } catch {
      fail('ARCHIVE_CUSTODY_INVALID');
    }
    if (bytesRead < 1) fail('ARCHIVE_CUSTODY_INVALID');
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    bytes: stat.size,
    sha256: digest.digest('hex'),
  };
}

function sameArchive(left: ArchiveIdentity, right: ArchiveIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

export class CommunitiesStagingRoleSplitV3DurableRestoreCoordinator {
  private readonly consumed = new Set<string>();

  constructor(
    private readonly config: CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorConfig,
  ) {
    assertConfig(config);
  }

  async restoreOwned(input: {
    readonly lease: CommunitiesStagingRoleSplitV3ExecutableLease;
    readonly current: CommunitiesStagingRoleSplitV3State;
    readonly pending: CommunitiesStagingRoleSplitV3State;
    readonly restored: CommunitiesStagingRoleSplitV3State;
  }): Promise<void> {
    try {
      assertCommunitiesStagingRoleSplitV3State(input.current);
      assertCommunitiesStagingRoleSplitV3State(input.pending);
      assertCommunitiesStagingRoleSplitV3State(input.restored);
    } catch {
      fail('BINDING_INVALID');
    }
    const requestSha256 = communitiesStagingRoleSplitRestoreMarkerRequestSha256(
      this.config.request,
    );
    const capabilityKey = `${requestSha256}\0${this.config.executionAuthorization.cloneDatabaseOid}`;
    if (
      input.lease.requestSha256 !== requestSha256 ||
      !exactSha256(input.lease.fencingToken) ||
      input.current.phase !== 'OWNED' ||
      input.pending.phase !== 'RESTORE_PENDING' ||
      input.restored.phase !== 'RESTORED' ||
      !sameState(input.current, this.config.ownedEnvelope.state) ||
      !sameState(input.pending, this.config.restorePendingEnvelope.state) ||
      !sameState(input.restored, this.config.restoredEnvelope.state) ||
      this.consumed.has(capabilityKey)
    )
      fail('BINDING_INVALID');

    await this.config.fence.assertHeld(input.lease).catch(() => fail('FENCE_LOST'));
    let file: FileHandle;
    try {
      file = await this.config.archiveCustody.openArchive({
        requestSha256,
        expectedSha256: this.config.request.backupSha256,
        expectedBytes: this.config.request.backupBytes,
      });
    } catch {
      fail('ARCHIVE_CUSTODY_INVALID');
    }

    let primary: unknown = null;
    try {
      const before = await archiveIdentity(file);
      if (
        before.sha256 !== this.config.request.backupSha256 ||
        before.bytes.toString(10) !== this.config.request.backupBytes
      )
        fail('ARCHIVE_CUSTODY_INVALID');
      await this.config.fence.assertHeld(input.lease).catch(() => fail('FENCE_LOST'));
      let pendingResult: CommunitiesStagingRoleSplitV3StateCasResult;
      try {
        pendingResult = await this.config.stateStore.compareAndSwap({
          lease: input.lease,
          current: this.config.ownedEnvelope,
          next: this.config.restorePendingEnvelope,
        });
      } catch {
        fail('STATE_WRITE_AMBIGUOUS');
      }
      if (pendingResult === 'ambiguous') fail('STATE_WRITE_AMBIGUOUS');
      if (pendingResult !== 'advanced') fail('STATE_WRITE_CONFLICT');

      // This in-memory edge is intentionally created only after the successful durable CAS and
      // consumed before the child process can be reached. No serialized envelope can recreate it.
      this.consumed.add(capabilityKey);
      await this.config.fence.assertHeld(input.lease).catch(() => fail('FENCE_LOST'));
      try {
        await this.config.runner.run({
          archiveFile: file,
          request: this.config.request,
          cloneDatabaseOid: this.config.executionAuthorization.cloneDatabaseOid,
          v3PreparationEnvelopeBytes: canonicalCommunitiesStagingRoleSplitV3PreparationEnvelope(
            this.config.preparationEnvelope,
          ),
        });
      } catch {
        fail('RESTORE_OUTCOME_AMBIGUOUS');
      }
      const after = await archiveIdentity(file);
      if (!sameArchive(before, after)) fail('ARCHIVE_CHANGED');
      await this.config.fence.assertHeld(input.lease).catch(() => fail('FENCE_LOST'));
      let restoredResult: CommunitiesStagingRoleSplitV3StateCasResult;
      try {
        restoredResult = await this.config.stateStore.compareAndSwap({
          lease: input.lease,
          current: this.config.restorePendingEnvelope,
          next: this.config.restoredEnvelope,
        });
      } catch {
        fail('STATE_WRITE_AMBIGUOUS');
      }
      if (restoredResult !== 'advanced') fail('STATE_WRITE_AMBIGUOUS');
      await this.config.fence.assertHeld(input.lease).catch(() => fail('FENCE_LOST'));
    } catch (error) {
      primary =
        error instanceof CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError
          ? error
          : new CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError(
              'RESTORE_OUTCOME_AMBIGUOUS',
            );
    }
    try {
      await file.close();
    } catch {
      if (primary === null)
        primary = new CommunitiesStagingRoleSplitV3DurableRestoreCoordinatorError(
          'ARCHIVE_CLOSE_FAILED',
        );
    }
    if (primary instanceof Error) throw primary;
    if (primary !== null) fail('RESTORE_OUTCOME_AMBIGUOUS');
  }
}
