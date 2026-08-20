import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  CommunitiesStagingRoleSplitAttestedEvidence,
  CommunitiesStagingRoleSplitMarkerCeremonyObservation,
} from '@phub/database';
import { canonicalCommunitiesStagingRoleSplitAttestedEvidence } from '@phub/database';

import type { CommunitiesStagingRoleSplitCanonicalEvidenceSink } from './communities-staging-role-split-canonical-host-adapter.js';
import { readRootOwnedEvidence } from './root-owned-evidence.js';

const EVIDENCE_FILENAME = 'marker-evidence.json';
const MAX_EVIDENCE_BYTES = 64 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export class CommunitiesStagingRoleSplitFileEvidenceSinkError extends Error {
  constructor(
    readonly code:
      'CONFIG_INVALID' | 'DIRECTORY_UNSAFE' | 'EVIDENCE_CONFLICT' | 'EVIDENCE_WRITE_AMBIGUOUS',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_FILE_EVIDENCE_SINK_${code}`);
    this.name = 'CommunitiesStagingRoleSplitFileEvidenceSinkError';
  }
}

function fail(code: CommunitiesStagingRoleSplitFileEvidenceSinkError['code']): never {
  throw new CommunitiesStagingRoleSplitFileEvidenceSinkError(code);
}

export function canonicalCommunitiesStagingRoleSplitMarkerEvidence(
  evidence: CommunitiesStagingRoleSplitAttestedEvidence,
): Buffer {
  const bytes = Buffer.from(canonicalCommunitiesStagingRoleSplitAttestedEvidence(evidence), 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) fail('CONFIG_INVALID');
  return bytes;
}

function currentUid(): number {
  if (process.getuid === undefined) fail('DIRECTORY_UNSAFE');
  return process.getuid();
}

type DirectoryIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

export function assertCommunitiesStagingRoleSplitPinnedEvidenceDirectory(input: {
  readonly initialPath: DirectoryIdentity;
  readonly initialHandle: DirectoryIdentity;
  readonly finalHandle: DirectoryIdentity;
  readonly finalPath: DirectoryIdentity;
  readonly effectiveUid: number;
}): void {
  const { initialPath, initialHandle, finalHandle, finalPath } = input;
  if (
    input.effectiveUid !== 0 ||
    !initialPath.isDirectory() ||
    initialPath.isSymbolicLink() ||
    !initialHandle.isDirectory() ||
    initialHandle.isSymbolicLink() ||
    initialHandle.uid !== 0 ||
    (initialHandle.mode & 0o777) !== 0o700 ||
    initialPath.dev !== initialHandle.dev ||
    initialPath.ino !== initialHandle.ino ||
    finalHandle.dev !== initialHandle.dev ||
    finalHandle.ino !== initialHandle.ino ||
    finalHandle.uid !== initialHandle.uid ||
    finalHandle.mode !== initialHandle.mode ||
    finalPath.dev !== initialHandle.dev ||
    finalPath.ino !== initialHandle.ino
  )
    fail('DIRECTORY_UNSAFE');
}

export class CommunitiesStagingRoleSplitFileEvidenceSink implements CommunitiesStagingRoleSplitCanonicalEvidenceSink {
  constructor(
    readonly subjectSha256: string,
    private readonly directory: string,
  ) {
    if (
      !sha256Pattern.test(subjectSha256) ||
      !isAbsolute(directory) ||
      resolve(directory) !== directory
    )
      fail('CONFIG_INVALID');
  }

  private async withPinnedDirectory<T>(
    operation: (descriptorRoot: string, sync: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    let handle: FileHandle | undefined;
    try {
      if (process.platform !== 'linux') fail('DIRECTORY_UNSAFE');
      const pathMetadata = await lstat(this.directory);
      handle = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const openedHandle = handle;
      const metadata = await openedHandle.stat();
      assertCommunitiesStagingRoleSplitPinnedEvidenceDirectory({
        initialPath: pathMetadata,
        initialHandle: metadata,
        finalHandle: metadata,
        finalPath: pathMetadata,
        effectiveUid: currentUid(),
      });
      const result = await operation(`/proc/self/fd/${openedHandle.fd}`, () => openedHandle.sync());
      const finalHandleMetadata = await openedHandle.stat();
      const finalPathMetadata = await lstat(this.directory);
      assertCommunitiesStagingRoleSplitPinnedEvidenceDirectory({
        initialPath: pathMetadata,
        initialHandle: metadata,
        finalHandle: finalHandleMetadata,
        finalPath: finalPathMetadata,
        effectiveUid: currentUid(),
      });
      return result;
    } catch (error) {
      if (error instanceof CommunitiesStagingRoleSplitFileEvidenceSinkError) throw error;
      fail('DIRECTORY_UNSAFE');
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
    return fail('DIRECTORY_UNSAFE');
  }

  private async observePinned(
    descriptorRoot: string,
    expected: Buffer,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation> {
    const evidencePath = join(descriptorRoot, EVIDENCE_FILENAME);
    try {
      await lstat(evidencePath);
    } catch (error) {
      if ((error as { readonly code?: string }).code === 'ENOENT') return 'absent';
      return 'unknown';
    }
    try {
      const actual = await readRootOwnedEvidence(evidencePath, MAX_EVIDENCE_BYTES);
      return actual.equals(expected) ? 'exact' : 'different';
    } catch {
      return 'unknown';
    }
  }

  async observe(
    evidence: CommunitiesStagingRoleSplitAttestedEvidence,
  ): Promise<CommunitiesStagingRoleSplitMarkerCeremonyObservation> {
    const expected = canonicalCommunitiesStagingRoleSplitMarkerEvidence(evidence);
    return this.withPinnedDirectory((descriptorRoot) =>
      this.observePinned(descriptorRoot, expected),
    );
  }

  async publish(evidence: CommunitiesStagingRoleSplitAttestedEvidence): Promise<void> {
    const expected = canonicalCommunitiesStagingRoleSplitMarkerEvidence(evidence);
    await this.withPinnedDirectory(async (descriptorRoot, syncDirectory) => {
      const evidencePath = join(descriptorRoot, EVIDENCE_FILENAME);
      const existing = await this.observePinned(descriptorRoot, expected);
      if (existing === 'exact') return;
      if (existing !== 'absent') fail('EVIDENCE_CONFLICT');
      const temporaryPath = join(
        descriptorRoot,
        `.${EVIDENCE_FILENAME}.${randomBytes(16).toString('hex')}.tmp`,
      );
      let temporaryCreated = false;
      let installed = false;
      try {
        const temporary = await open(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o400,
        );
        temporaryCreated = true;
        try {
          await temporary.writeFile(expected);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        await link(temporaryPath, evidencePath);
        installed = true;
        await unlink(temporaryPath);
        temporaryCreated = false;
        await syncDirectory();
      } catch (error) {
        if ((error as { readonly code?: string }).code === 'EEXIST') {
          const observed = await this.observePinned(descriptorRoot, expected);
          if (observed === 'exact') return;
          fail('EVIDENCE_CONFLICT');
        }
        fail('EVIDENCE_WRITE_AMBIGUOUS');
      } finally {
        if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
      }
      if (!installed || (await this.observePinned(descriptorRoot, expected)) !== 'exact')
        fail('EVIDENCE_WRITE_AMBIGUOUS');
    });
  }
}
