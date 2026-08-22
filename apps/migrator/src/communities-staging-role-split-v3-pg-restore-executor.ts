/**
 * Unwired V3 RESTORE_PENDING executor bridge.
 *
 * It consumes only an already-held durable capability: no filesystem lease or
 * cluster DDL lease is acquired, released, or closed here.  A caller must
 * retain the archive and the two root-owned descriptors for its whole lifetime.
 */
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding,
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3ExecutionAuthorizationSha256,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  communitiesStagingRoleSplitV3RestoreAuthorizationSha256,
  parseCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3CloneCreationAuthorization,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3ExecutionAuthorization,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
} from '@phub/database';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
  type CommunitiesStagingRoleSplitDdlFenceLease,
} from './communities-staging-role-split-ddl-fence.js';
import type {
  CommunitiesStagingRoleSplitV3DurableRestoreExecutor,
  CommunitiesStagingRoleSplitV3DurableRestoreExecutorInput,
  CommunitiesStagingRoleSplitV3DurableRestoreExecutorResult,
} from './communities-staging-role-split-v3-durable-host.js';
import {
  assertCommunitiesStagingRoleSplitImmutableArchiveDescriptor,
  runCommunitiesStagingRoleSplitPgRestore,
  type CommunitiesStagingRoleSplitPgRestorePreflightObservation,
  type CommunitiesStagingRoleSplitPgRestoreTarget,
} from './communities-staging-role-split-pg-restore-runner.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_DISCARDED_OUTPUT_BYTES = 8 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024 * 1024;

export class CommunitiesStagingRoleSplitV3PgRestoreExecutorError extends Error {
  constructor(
    readonly code:
      | 'AUTHORIZATION_INVALID'
      | 'BINDING_INVALID'
      | 'PENDING_INVALID'
      | 'FENCE_LOST'
      | 'ARCHIVE_CUSTODY_INVALID'
      | 'RESTORE_OUTCOME_AMBIGUOUS'
      | 'CAPABILITY_ALREADY_USED',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_PG_RESTORE_EXECUTOR_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3PgRestoreExecutorError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3PgRestoreExecutorError['code']): never {
  throw new CommunitiesStagingRoleSplitV3PgRestoreExecutorError(code);
}
function freeze<T>(value: T): T {
  return Object.freeze(structuredClone(value));
}
function positiveDecimal(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}
async function archiveObservation(
  archiveFile: FileHandle,
  expectedBytes: string,
): Promise<CommunitiesStagingRoleSplitV3DurableRestoreExecutorResult['archiveObservation']> {
  const expected = Number(expectedBytes);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_ARCHIVE_BYTES)
    fail('ARCHIVE_CUSTODY_INVALID');
  let stat: Awaited<ReturnType<FileHandle['stat']>>;
  try {
    await assertCommunitiesStagingRoleSplitImmutableArchiveDescriptor(archiveFile, expected);
    stat = await archiveFile.stat();
  } catch {
    fail('ARCHIVE_CUSTODY_INVALID');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    for (;;) {
      const { bytesRead } = await archiveFile.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > expected) fail('ARCHIVE_CUSTODY_INVALID');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitV3PgRestoreExecutorError) throw error;
    fail('ARCHIVE_CUSTODY_INVALID');
  }
  if (offset !== expected) fail('ARCHIVE_CUSTODY_INVALID');
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    bytes: String(stat.size),
    preSha256: hash.digest('hex'),
  };
}
async function descriptorIdentity(
  handle: FileHandle,
): Promise<{ readonly dev: number; readonly ino: number }> {
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('PENDING_INVALID');
    return Object.freeze({ dev: stat.dev, ino: stat.ino });
  } catch (error) {
    if (error instanceof CommunitiesStagingRoleSplitV3PgRestoreExecutorError) throw error;
    fail('PENDING_INVALID');
  }
}

export interface CommunitiesStagingRoleSplitV3PgRestoreExecutorConfig {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly cloneCreationAuthorization: CommunitiesStagingRoleSplitV3CloneCreationAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly restoreAuthorization: CommunitiesStagingRoleSplitV3RestoreAuthorization;
  readonly durableRestoreAuthorization: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
  readonly executionAuthorization: CommunitiesStagingRoleSplitV3ExecutionAuthorization;
  readonly expectedExecutionAuthorizationSha256: string;
  readonly restorePendingEnvelope: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  readonly target: CommunitiesStagingRoleSplitPgRestoreTarget;
  readonly connectionFactory: {
    readonly subjectSha256: string;
    readonly preflight: (
      target: CommunitiesStagingRoleSplitPgRestoreTarget,
      signal: AbortSignal,
    ) => Promise<CommunitiesStagingRoleSplitPgRestorePreflightObservation>;
  };
  readonly fence: Pick<CommunitiesStagingRoleSplitDdlFence, 'assertHeld'> & {
    readonly subjectSha256: string;
  };
  readonly expectedPgRestoreSha256: string;
  readonly passwordFile: FileHandle;
  readonly executableFile: FileHandle;
  readonly preflightTimeoutMs: number;
  readonly restoreTimeoutMs: number;
  readonly subjectSha256: string;
}

/** Descriptor-only bridge; deliberately absent from executable composition and installation paths. */
export class CommunitiesStagingRoleSplitV3PgRestoreExecutor implements CommunitiesStagingRoleSplitV3DurableRestoreExecutor {
  readonly subjectSha256: string;
  private readonly config: CommunitiesStagingRoleSplitV3PgRestoreExecutorConfig;
  private readonly assertHeld: (lease: CommunitiesStagingRoleSplitDdlFenceLease) => Promise<void>;
  private readonly preflight: CommunitiesStagingRoleSplitV3PgRestoreExecutorConfig['connectionFactory']['preflight'];
  private used = false;

  constructor(config: CommunitiesStagingRoleSplitV3PgRestoreExecutorConfig) {
    this.config = Object.freeze({
      ...config,
      request: freeze(config.request),
      cloneCreationAuthorization: freeze(config.cloneCreationAuthorization),
      hostAuthorization: freeze(config.hostAuthorization),
      restoreAuthorization: freeze(config.restoreAuthorization),
      durableRestoreAuthorization: freeze(config.durableRestoreAuthorization),
      executionAuthorization: freeze(config.executionAuthorization),
      restorePendingEnvelope: freeze(config.restorePendingEnvelope),
      target: freeze(config.target),
      connectionFactory: Object.freeze({
        subjectSha256: config.connectionFactory.subjectSha256,
        preflight: config.connectionFactory.preflight.bind(config.connectionFactory),
      }),
      fence: Object.freeze({
        subjectSha256: config.fence.subjectSha256,
        assertHeld: config.fence.assertHeld.bind(config.fence),
      }),
    });
    this.subjectSha256 = config.subjectSha256;
    this.assertHeld = this.config.fence.assertHeld;
    this.preflight = this.config.connectionFactory.preflight;
    try {
      assertCommunitiesStagingRoleSplitV3ExecutionAuthorizationBinding({
        request: this.config.request,
        cloneCreationAuthorization: this.config.cloneCreationAuthorization,
        hostAuthorization: this.config.hostAuthorization,
        durableRestoreAuthorization: this.config.durableRestoreAuthorization,
        authorization: this.config.executionAuthorization,
      });
    } catch {
      fail('AUTHORIZATION_INVALID');
    }
    const authorization = this.config.executionAuthorization;
    const pending = this.config.restorePendingEnvelope;
    if (
      !SHA256.test(this.subjectSha256) ||
      !SHA256.test(this.config.expectedExecutionAuthorizationSha256) ||
      !SHA256.test(this.config.expectedPgRestoreSha256) ||
      this.config.expectedExecutionAuthorizationSha256 !==
        communitiesStagingRoleSplitV3ExecutionAuthorizationSha256(authorization) ||
      communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(pending) !==
        this.config.durableRestoreAuthorization.restorePendingEnvelopeSha256 ||
      communitiesStagingRoleSplitV3RestoreAuthorizationSha256(this.config.restoreAuthorization) !==
        this.config.durableRestoreAuthorization.v3RestoreAuthorizationSha256 ||
      this.config.restoreAuthorization.markerRequestSha256 !== authorization.markerRequestSha256 ||
      this.config.restoreAuthorization.creationReceiptSha256 !==
        authorization.creationReceiptSha256 ||
      this.config.restoreAuthorization.restoreExecutionEvidenceSha256 !==
        authorization.restoreExecutionEvidenceSha256 ||
      this.config.restoreAuthorization.cloneDatabaseOid !== authorization.cloneDatabaseOid ||
      this.config.restoreAuthorization.systemIdentifier !== authorization.systemIdentifier ||
      this.subjectSha256 !== authorization.components.runnerAdapterSha256 ||
      this.config.connectionFactory.subjectSha256 !==
        authorization.components.cloneOnlyConnectionFactorySha256 ||
      this.config.fence.subjectSha256 !== authorization.components.ddlFenceSha256 ||
      pending.phase !== 'RESTORE_PENDING' ||
      pending.requestSha256 !== authorization.markerRequestSha256 ||
      pending.creationReceiptSha256 !== authorization.creationReceiptSha256 ||
      pending.restoreExecutionEvidenceSha256 !== authorization.restoreExecutionEvidenceSha256 ||
      pending.cloneDatabaseOid !== authorization.cloneDatabaseOid ||
      pending.state.phase !== 'RESTORE_PENDING' ||
      pending.state.requestSha256 !== authorization.markerRequestSha256 ||
      pending.state.cloneDatabaseOid !== authorization.cloneDatabaseOid ||
      pending.state.restoreExecutionEvidenceSha256 !==
        authorization.restoreExecutionEvidenceSha256 ||
      this.config.target.database !== this.config.request.restoreDatabase ||
      this.config.target.databaseOid !== authorization.cloneDatabaseOid ||
      this.config.target.sourceDatabase !== this.config.request.sourceDatabase ||
      this.config.target.systemIdentifier !== authorization.systemIdentifier ||
      this.config.target.postgresMajor !== '16' ||
      this.config.target.host !== this.config.hostAuthorization.execution.connection.host ||
      this.config.target.port !== this.config.hostAuthorization.execution.connection.port ||
      this.config.target.sslMode !== this.config.hostAuthorization.execution.connection.sslMode ||
      this.config.target.connectionUser !==
        this.config.hostAuthorization.execution.restoreLogin.name ||
      this.config.target.connectionUserOid !==
        this.config.hostAuthorization.execution.restoreLogin.oid ||
      this.config.target.restoreRole !==
        this.config.hostAuthorization.execution.restoreLogin.name ||
      this.config.target.restoreRoleOid !==
        this.config.hostAuthorization.execution.restoreLogin.oid ||
      this.config.expectedPgRestoreSha256 !==
        this.config.hostAuthorization.execution.pgRestoreSha256 ||
      !Number.isSafeInteger(this.config.preflightTimeoutMs) ||
      this.config.preflightTimeoutMs < 1 ||
      this.config.preflightTimeoutMs > 60_000 ||
      !Number.isSafeInteger(this.config.restoreTimeoutMs) ||
      this.config.restoreTimeoutMs < 1 ||
      this.config.restoreTimeoutMs > 30 * 60_000
    )
      fail('BINDING_INVALID');
  }

  async restore(
    input: CommunitiesStagingRoleSplitV3DurableRestoreExecutorInput & {
      readonly archiveFile: FileHandle;
    },
  ): Promise<CommunitiesStagingRoleSplitV3DurableRestoreExecutorResult> {
    if (this.used) fail('CAPABILITY_ALREADY_USED');
    this.used = true;
    const externalFenceLease: CommunitiesStagingRoleSplitDdlFenceLease = Object.freeze({
      ...input.externalFenceLease,
    });
    const pendingBytes = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(
      this.config.restorePendingEnvelope,
    );
    try {
      const parsed = parseCommunitiesStagingRoleSplitV3DurableStateEnvelope(
        input.restorePendingEnvelopeBytes,
      );
      if (
        input.restorePendingEnvelopeBytes !== pendingBytes ||
        communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(parsed) !==
          communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
            this.config.restorePendingEnvelope,
          ) ||
        !isDeepStrictEqual(input.request, this.config.request) ||
        input.cloneDatabaseOid !== this.config.executionAuthorization.cloneDatabaseOid ||
        externalFenceLease.requestSha256 !==
          this.config.executionAuthorization.markerRequestSha256 ||
        externalFenceLease.systemIdentifier !==
          this.config.executionAuthorization.systemIdentifier ||
        externalFenceLease.advisoryKey !== COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY ||
        !positiveDecimal(externalFenceLease.backendPid) ||
        !SHA256.test(externalFenceLease.fencingToken) ||
        input.archiveFile.fd === this.config.passwordFile.fd ||
        input.archiveFile.fd === this.config.executableFile.fd ||
        this.config.passwordFile.fd === this.config.executableFile.fd
      )
        fail('PENDING_INVALID');
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3PgRestoreExecutorError) throw error;
      fail('PENDING_INVALID');
    }
    const [archiveIdentity, passwordIdentity, executableIdentity] = await Promise.all([
      descriptorIdentity(input.archiveFile),
      descriptorIdentity(this.config.passwordFile),
      descriptorIdentity(this.config.executableFile),
    ]);
    if (
      (archiveIdentity.dev === passwordIdentity.dev &&
        archiveIdentity.ino === passwordIdentity.ino) ||
      (archiveIdentity.dev === executableIdentity.dev &&
        archiveIdentity.ino === executableIdentity.ino) ||
      (passwordIdentity.dev === executableIdentity.dev &&
        passwordIdentity.ino === executableIdentity.ino)
    )
      fail('PENDING_INVALID');
    await this.assertHeld(externalFenceLease).catch(() => fail('FENCE_LOST'));
    const before = await archiveObservation(input.archiveFile, this.config.request.backupBytes);
    if (before.preSha256 !== this.config.request.backupSha256) fail('ARCHIVE_CUSTODY_INVALID');
    let dispatched = false;
    try {
      await this.assertHeld(externalFenceLease).catch(() => fail('FENCE_LOST'));
      dispatched = true;
      const result = await runCommunitiesStagingRoleSplitPgRestore(
        {
          target: this.config.target,
          preflight: this.preflight,
          expectedPgRestoreSha256: this.config.expectedPgRestoreSha256,
          timeoutMs: this.config.restoreTimeoutMs,
          preflightTimeoutMs: this.config.preflightTimeoutMs,
        },
        {
          archiveFile: input.archiveFile,
          passwordFile: this.config.passwordFile,
          executableFile: this.config.executableFile,
        },
      );
      await this.assertHeld(externalFenceLease).catch(() => fail('FENCE_LOST'));
      const after = await archiveObservation(input.archiveFile, this.config.request.backupBytes);
      if (
        after.device !== before.device ||
        after.inode !== before.inode ||
        after.bytes !== before.bytes ||
        after.preSha256 !== before.preSha256 ||
        !Number.isSafeInteger(result.discardedOutputBytes) ||
        result.discardedOutputBytes < 0 ||
        result.discardedOutputBytes > MAX_DISCARDED_OUTPUT_BYTES
      )
        fail('RESTORE_OUTCOME_AMBIGUOUS');
      return Object.freeze({
        discardedOutputBytes: result.discardedOutputBytes,
        archiveObservation: after,
      });
    } catch (error) {
      if (!dispatched) throw error;
      fail('RESTORE_OUTCOME_AMBIGUOUS');
    }
  }
}
