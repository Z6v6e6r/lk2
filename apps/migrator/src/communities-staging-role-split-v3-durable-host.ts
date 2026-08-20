/**
 * Unwired V3 durable-restore preparation boundary.
 *
 * It may persist the reviewed OWNED -> RESTORE_PENDING boundary and retain an
 * opaque, same-invocation capability.  It deliberately has no restore runner,
 * consumption method, RESTORED transition, command entrypoint or cleanup API.
 */
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import {
  assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding,
  canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256,
  communitiesStagingRoleSplitV3DurableStateEnvelopeSha256,
  parseCommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitHostAuthorization,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
  type CommunitiesStagingRoleSplitV3DurableRestoreAuthorization,
  type CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  type CommunitiesStagingRoleSplitV3PreparationEnvelope,
  type CommunitiesStagingRoleSplitV3RestoreAuthorization,
} from '@phub/database';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY,
  type CommunitiesStagingRoleSplitDdlFence,
  type CommunitiesStagingRoleSplitDdlFenceLease,
} from './communities-staging-role-split-ddl-fence.js';

const MODE_0700 = 0o700;
const MODE_0600 = 0o600;
const MAX_STATE_BYTES = 128 * 1024;
const STATE_BASENAME = 'v3-durable-state.json';
const LEASE_BASENAME = 'ceremony.lock';
const V2_ARTIFACT_BASENAMES = ['ceremony-state.json', 'marker-evidence.json'];
const sha256Pattern = /^[a-f0-9]{64}$/u;

export class CommunitiesStagingRoleSplitV3DurableHostError extends Error {
  constructor(
    readonly code:
      | 'AUTHORIZATION_INVALID'
      | 'BINDING_INVALID'
      | 'FENCE_UNAVAILABLE'
      | 'FENCE_LOST'
      | 'FENCE_RELEASE_FAILED'
      | 'STATE_DIRECTORY_UNSAFE'
      | 'V2_ARTIFACT_PRESENT'
      | 'LEASE_UNAVAILABLE'
      | 'LEASE_LOST'
      | 'LEASE_RELEASE_FAILED'
      | 'STATE_FILE_UNSAFE'
      | 'STATE_CORRUPT'
      | 'STATE_CAS_MISMATCH'
      | 'STATE_WRITE_FAILED'
      | 'ARCHIVE_CUSTODY_INVALID'
      | 'CLEANUP_INCOMPLETE'
      | 'CAPABILITY_INVALID',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_V3_DURABLE_HOST_${code}`);
    this.name = 'CommunitiesStagingRoleSplitV3DurableHostError';
  }
}

function fail(code: CommunitiesStagingRoleSplitV3DurableHostError['code']): never {
  throw new CommunitiesStagingRoleSplitV3DurableHostError(code);
}
function currentUid(): number {
  if (process.getuid === undefined) fail('STATE_DIRECTORY_UNSAFE');
  return process.getuid();
}
function sameStat(
  left: { ino: number; dev: number },
  right: { ino: number; dev: number },
): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}
function regular0600(stat: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === currentUid() &&
    (stat.mode & 0o777) === MODE_0600
  );
}

export interface CommunitiesStagingRoleSplitV3DurableStateLease {
  readonly requestSha256: string;
  readonly creationReceiptSha256: string;
  readonly fencingToken: string;
}

/** Exact-byte, single-directory state store; V2 artifacts and lock namespace are refused. */
export class CommunitiesStagingRoleSplitV3DurableStateStore {
  private readonly statePath: string;
  private readonly leasePath: string;

  constructor(
    readonly subjectSha256: string,
    private readonly stateDirectory: string,
    readonly requestSha256: string,
    readonly creationReceiptSha256: string,
  ) {
    if (
      !sha256Pattern.test(subjectSha256) ||
      !sha256Pattern.test(requestSha256) ||
      !sha256Pattern.test(creationReceiptSha256) ||
      !isAbsolute(stateDirectory)
    )
      fail('BINDING_INVALID');
    this.statePath = join(stateDirectory, STATE_BASENAME);
    this.leasePath = join(stateDirectory, LEASE_BASENAME);
  }

  private async assertDirectory(): Promise<void> {
    try {
      const stat = await lstat(this.stateDirectory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== currentUid() ||
        (stat.mode & 0o777) !== MODE_0700
      )
        fail('STATE_DIRECTORY_UNSAFE');
      for (const name of V2_ARTIFACT_BASENAMES) {
        try {
          await lstat(join(this.stateDirectory, name));
          fail('V2_ARTIFACT_PRESENT');
        } catch (error) {
          if (error instanceof CommunitiesStagingRoleSplitV3DurableHostError) throw error;
          if ((error as { code?: string }).code !== 'ENOENT') fail('STATE_DIRECTORY_UNSAFE');
        }
      }
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitV3DurableHostError) throw error;
      fail('STATE_DIRECTORY_UNSAFE');
    }
  }

  private async fsyncDirectory(): Promise<void> {
    try {
      const directory = await open(this.stateDirectory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      fail('STATE_WRITE_FAILED');
    }
  }

  private async readExact(path: string): Promise<string | null> {
    try {
      const first = await lstat(path);
      if (!regular0600(first) || first.size > MAX_STATE_BYTES) fail('STATE_FILE_UNSAFE');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!sameStat(first, opened) || opened.size > MAX_STATE_BYTES) fail('STATE_FILE_UNSAFE');
        const value = await handle.readFile({ encoding: 'utf8' });
        const after = await lstat(path);
        if (!sameStat(first, after)) fail('STATE_FILE_UNSAFE');
        return value;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      if (error instanceof CommunitiesStagingRoleSplitV3DurableHostError) throw error;
      fail('STATE_FILE_UNSAFE');
    }
  }

  private parse(value: string): CommunitiesStagingRoleSplitV3DurableStateEnvelope {
    if (Buffer.byteLength(value, 'utf8') > MAX_STATE_BYTES) fail('STATE_CORRUPT');
    try {
      return parseCommunitiesStagingRoleSplitV3DurableStateEnvelope(value);
    } catch {
      fail('STATE_CORRUPT');
    }
  }
  private async assertLease(lease: CommunitiesStagingRoleSplitV3DurableStateLease): Promise<void> {
    if (
      lease.requestSha256 !== this.requestSha256 ||
      lease.creationReceiptSha256 !== this.creationReceiptSha256 ||
      !sha256Pattern.test(lease.fencingToken)
    )
      fail('LEASE_LOST');
    const content = await this.readExact(this.leasePath);
    if (
      content !== `${lease.requestSha256}\n${this.creationReceiptSha256}\n${lease.fencingToken}\n`
    )
      fail('LEASE_LOST');
  }
  async acquire(): Promise<CommunitiesStagingRoleSplitV3DurableStateLease> {
    await this.assertDirectory();
    const lease = {
      requestSha256: this.requestSha256,
      creationReceiptSha256: this.creationReceiptSha256,
      fencingToken: randomBytes(32).toString('hex'),
    } as const;
    try {
      const handle = await open(
        this.leasePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        MODE_0600,
      );
      try {
        await handle.writeFile(
          `${lease.requestSha256}\n${this.creationReceiptSha256}\n${lease.fencingToken}\n`,
          'utf8',
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fsyncDirectory();
      return lease;
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') fail('LEASE_UNAVAILABLE');
      fail('LEASE_UNAVAILABLE');
    }
  }
  async release(lease: CommunitiesStagingRoleSplitV3DurableStateLease): Promise<void> {
    await this.assertLease(lease);
    try {
      await unlink(this.leasePath);
      await this.fsyncDirectory();
    } catch {
      fail('LEASE_RELEASE_FAILED');
    }
  }
  async read(lease: CommunitiesStagingRoleSplitV3DurableStateLease): Promise<string | null> {
    await this.assertLease(lease);
    const content = await this.readExact(this.statePath);
    if (content !== null) this.parse(content);
    return content;
  }
  async writeCas(
    lease: CommunitiesStagingRoleSplitV3DurableStateLease,
    expected: string | null,
    next: CommunitiesStagingRoleSplitV3DurableStateEnvelope,
  ): Promise<string> {
    await this.assertLease(lease);
    const canonical = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(next);
    if (
      next.requestSha256 !== this.requestSha256 ||
      next.creationReceiptSha256 !== this.creationReceiptSha256
    )
      fail('STATE_CAS_MISMATCH');
    if (Buffer.byteLength(canonical, 'utf8') > MAX_STATE_BYTES) fail('STATE_WRITE_FAILED');
    const current = await this.readExact(this.statePath);
    if (current !== expected) fail('STATE_CAS_MISMATCH');
    const currentEnvelope = current === null ? null : this.parse(current);
    if (
      currentEnvelope !== null &&
      (currentEnvelope.requestSha256 !== next.requestSha256 ||
        currentEnvelope.creationReceiptSha256 !== next.creationReceiptSha256 ||
        currentEnvelope.restoreExecutionEvidenceSha256 !== next.restoreExecutionEvidenceSha256 ||
        currentEnvelope.cloneDatabaseOid !== next.cloneDatabaseOid)
    )
      fail('STATE_CAS_MISMATCH');
    const currentPhase = currentEnvelope?.phase ?? null;
    const allowed =
      (currentPhase === null && next.phase === 'OWNED') ||
      (currentPhase === 'OWNED' && next.phase === 'RESTORE_PENDING') ||
      (currentPhase === 'RESTORE_PENDING' && next.phase === 'RESTORED');
    if (!allowed) fail('STATE_CAS_MISMATCH');
    const temporary = join(
      this.stateDirectory,
      `.${STATE_BASENAME}.${randomBytes(16).toString('hex')}.tmp`,
    );
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        MODE_0600,
      );
      try {
        await handle.writeFile(canonical, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await this.readExact(this.statePath)) !== expected) fail('STATE_CAS_MISMATCH');
      await rename(temporary, this.statePath);
      await this.fsyncDirectory();
      if ((await this.readExact(this.statePath)) !== canonical) fail('STATE_WRITE_FAILED');
      return canonical;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof CommunitiesStagingRoleSplitV3DurableHostError) throw error;
      fail('STATE_WRITE_FAILED');
    }
  }
}

export interface CommunitiesStagingRoleSplitV3ArchiveCustody {
  readonly subjectSha256: string;
  acquire(input: {
    readonly requestSha256: string;
    readonly restorePendingEnvelopeSha256: string;
  }): Promise<{
    readonly observation: {
      readonly device: string;
      readonly inode: string;
      readonly bytes: string;
      readonly preSha256: string;
    };
    close(): Promise<void>;
  }>;
}
export interface CommunitiesStagingRoleSplitV3DurableHostConfig {
  readonly request: CommunitiesStagingRoleSplitRestoreMarkerRequest;
  readonly preparationEnvelope: CommunitiesStagingRoleSplitV3PreparationEnvelope;
  readonly restoreAuthorization: CommunitiesStagingRoleSplitV3RestoreAuthorization;
  readonly hostAuthorization: CommunitiesStagingRoleSplitHostAuthorization;
  readonly authorization: CommunitiesStagingRoleSplitV3DurableRestoreAuthorization;
  readonly expectedAuthorizationSha256: string;
  readonly stateStore: CommunitiesStagingRoleSplitV3DurableStateStore;
  readonly archiveCustody: CommunitiesStagingRoleSplitV3ArchiveCustody;
  readonly fence: CommunitiesStagingRoleSplitDdlFence & { readonly subjectSha256: string };
  readonly durableHostSha256: string;
  readonly fenceTimeoutMs: number;
  readonly envelopes: {
    readonly owned: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
    readonly restorePending: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
    readonly restored: CommunitiesStagingRoleSplitV3DurableStateEnvelope;
  };
}
export interface CommunitiesStagingRoleSplitV3DurablePreparationCapability {
  readonly capability: 'V3_DURABLE_PREPARATION_CAPABILITY';
  readonly claims: {
    readonly requestSha256: string;
    readonly creationReceiptSha256: string;
    readonly restoreExecutionEvidenceSha256: string;
    readonly durableAuthorizationSha256: string;
    readonly ownedEnvelopeSha256: string;
    readonly restorePendingEnvelopeSha256: string;
    readonly cloneDatabaseOid: string;
    readonly systemIdentifier: string;
    readonly archive: {
      readonly device: string;
      readonly inode: string;
      readonly bytes: string;
      readonly preSha256: string;
    };
    readonly ddlFencingTokenSha256: string;
    readonly fsFencingTokenSha256: string;
  };
}
type CapabilityRecord = {
  readonly fsLease: CommunitiesStagingRoleSplitV3DurableStateLease;
  readonly ddlLease: CommunitiesStagingRoleSplitDdlFenceLease;
  readonly archive: Awaited<ReturnType<CommunitiesStagingRoleSplitV3ArchiveCustody['acquire']>>;
  used: boolean;
};
const tokenSha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export class CommunitiesStagingRoleSplitV3DurableHost {
  private readonly capabilities = new WeakMap<object, CapabilityRecord>();
  constructor(private readonly config: CommunitiesStagingRoleSplitV3DurableHostConfig) {
    try {
      assertCommunitiesStagingRoleSplitV3DurableRestoreAuthorizationBinding({
        request: config.request,
        preparationEnvelope: config.preparationEnvelope,
        restoreAuthorization: config.restoreAuthorization,
        hostAuthorization: config.hostAuthorization,
        ownedEnvelope: config.envelopes.owned,
        restorePendingEnvelope: config.envelopes.restorePending,
        restoredEnvelope: config.envelopes.restored,
        componentSubjects: {
          durableHostSha256: config.durableHostSha256,
          stateStoreSha256: config.stateStore.subjectSha256,
          archiveCustodySha256: config.archiveCustody.subjectSha256,
        },
        authorization: config.authorization,
      });
    } catch {
      fail('AUTHORIZATION_INVALID');
    }
    if (
      !sha256Pattern.test(config.expectedAuthorizationSha256) ||
      !sha256Pattern.test(config.fence.subjectSha256) ||
      config.fence.subjectSha256 !== config.hostAuthorization.execution.ddlFenceSha256 ||
      config.authorization.markerRequestSha256 !== config.stateStore.requestSha256 ||
      config.authorization.creationReceiptSha256 !== config.stateStore.creationReceiptSha256 ||
      config.expectedAuthorizationSha256 !==
        communitiesStagingRoleSplitV3DurableRestoreAuthorizationSha256(config.authorization) ||
      !Number.isSafeInteger(config.fenceTimeoutMs) ||
      config.fenceTimeoutMs < 1 ||
      config.fenceTimeoutMs > 60_000
    )
      fail('BINDING_INVALID');
  }

  private async assertFenceHeld(lease: CommunitiesStagingRoleSplitDdlFenceLease): Promise<void> {
    await this.config.fence.assertHeld(lease).catch(() => fail('FENCE_LOST'));
  }

  async prepare(): Promise<CommunitiesStagingRoleSplitV3DurablePreparationCapability> {
    let ddlLease: CommunitiesStagingRoleSplitDdlFenceLease | undefined;
    let fsLease: CommunitiesStagingRoleSplitV3DurableStateLease | undefined;
    let archive:
      Awaited<ReturnType<CommunitiesStagingRoleSplitV3ArchiveCustody['acquire']>> | undefined;
    try {
      ddlLease = await this.config.fence.acquire({
        requestSha256: this.config.authorization.markerRequestSha256,
        systemIdentifier: this.config.authorization.systemIdentifier,
        timeoutMs: this.config.fenceTimeoutMs,
        signal: AbortSignal.timeout(this.config.fenceTimeoutMs),
      });
      if (
        ddlLease.advisoryKey !== COMMUNITIES_STAGING_ROLE_SPLIT_DDL_FENCE_ADVISORY_KEY ||
        ddlLease.requestSha256 !== this.config.authorization.markerRequestSha256 ||
        ddlLease.systemIdentifier !== this.config.authorization.systemIdentifier
      )
        fail('FENCE_UNAVAILABLE');
      await this.assertFenceHeld(ddlLease);
      fsLease = await this.config.stateStore.acquire();
      const owned = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(
        this.config.envelopes.owned,
      );
      const pendingExpected = canonicalCommunitiesStagingRoleSplitV3DurableStateEnvelope(
        this.config.envelopes.restorePending,
      );
      const entry = await this.config.stateStore.read(fsLease);
      if (entry === null) {
        try {
          await this.config.stateStore.writeCas(fsLease, null, this.config.envelopes.owned);
        } catch (error) {
          // A response can be lost after rename/fsync.  Only this invocation started from absent
          // and attempted the exact OWNED CAS, so only exact authoritative OWNED bytes may resume.
          if ((await this.config.stateStore.read(fsLease)) !== owned) throw error;
        }
        if ((await this.config.stateStore.read(fsLease)) !== owned) fail('STATE_WRITE_FAILED');
      } else if (entry !== owned) {
        fail('STATE_CAS_MISMATCH');
      }
      await this.assertFenceHeld(ddlLease);
      archive = await this.config.archiveCustody.acquire({
        requestSha256: this.config.authorization.markerRequestSha256,
        restorePendingEnvelopeSha256: communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
          this.config.envelopes.restorePending,
        ),
      });
      if (
        archive.observation.bytes !== this.config.request.backupBytes ||
        archive.observation.preSha256 !== this.config.request.backupSha256 ||
        !/^[0-9]+$/u.test(archive.observation.device) ||
        !/^[1-9][0-9]*$/u.test(archive.observation.inode)
      )
        fail('ARCHIVE_CUSTODY_INVALID');
      await this.assertFenceHeld(ddlLease);
      let pending: string;
      try {
        pending = await this.config.stateStore.writeCas(
          fsLease,
          owned,
          this.config.envelopes.restorePending,
        );
      } catch (error) {
        await this.assertFenceHeld(ddlLease);
        if ((await this.config.stateStore.read(fsLease)) !== pendingExpected) throw error;
        pending = pendingExpected;
      }
      if (pending !== pendingExpected || (await this.config.stateStore.read(fsLease)) !== pending)
        fail('STATE_WRITE_FAILED');
      const capability: CommunitiesStagingRoleSplitV3DurablePreparationCapability = Object.freeze({
        capability: 'V3_DURABLE_PREPARATION_CAPABILITY',
        claims: Object.freeze({
          requestSha256: this.config.authorization.markerRequestSha256,
          creationReceiptSha256: this.config.authorization.creationReceiptSha256,
          restoreExecutionEvidenceSha256: this.config.authorization.restoreExecutionEvidenceSha256,
          durableAuthorizationSha256: this.config.expectedAuthorizationSha256,
          ownedEnvelopeSha256: communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
            this.config.envelopes.owned,
          ),
          restorePendingEnvelopeSha256: communitiesStagingRoleSplitV3DurableStateEnvelopeSha256(
            this.config.envelopes.restorePending,
          ),
          cloneDatabaseOid: this.config.authorization.cloneDatabaseOid,
          systemIdentifier: this.config.authorization.systemIdentifier,
          archive: Object.freeze({ ...archive.observation }),
          ddlFencingTokenSha256: tokenSha256(ddlLease.fencingToken),
          fsFencingTokenSha256: tokenSha256(fsLease.fencingToken),
        }),
      });
      await this.assertFenceHeld(ddlLease);
      this.capabilities.set(capability, { fsLease, ddlLease, archive, used: false });
      return capability;
    } catch (error) {
      let cleanupFailed = false;
      if (archive !== undefined)
        await archive.close().catch(() => {
          cleanupFailed = true;
        });
      if (fsLease !== undefined)
        await this.config.stateStore.release(fsLease).catch(() => {
          cleanupFailed = true;
        });
      if (ddlLease !== undefined)
        await this.config.fence.release(ddlLease).catch(() => {
          cleanupFailed = true;
        });
      if (cleanupFailed) fail('CLEANUP_INCOMPLETE');
      if (error instanceof CommunitiesStagingRoleSplitV3DurableHostError) throw error;
      fail('FENCE_UNAVAILABLE');
    }
  }
  async abandon(
    capability: CommunitiesStagingRoleSplitV3DurablePreparationCapability,
  ): Promise<void> {
    const record = this.capabilities.get(capability);
    if (record === undefined || record.used) fail('CAPABILITY_INVALID');
    record.used = true;
    this.capabilities.delete(capability);
    let primary: unknown = null;
    try {
      await record.archive.close();
    } catch (error) {
      primary = error;
    }
    try {
      await this.config.stateStore.release(record.fsLease);
    } catch (error) {
      if (primary === null) primary = error;
    }
    try {
      await this.config.fence.release(record.ddlLease);
    } catch (error) {
      if (primary === null) primary = error;
    }
    if (primary instanceof Error) throw primary;
    if (primary !== null) fail('FENCE_RELEASE_FAILED');
  }
}
