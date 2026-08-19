import { constants, type Stats } from 'node:fs';
import { open, lstat, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

type EvidenceHandle = Pick<FileHandle, 'stat' | 'read' | 'close'>;

export type RootOwnedEvidenceIo = {
  readonly open: (path: string, flags: number) => Promise<EvidenceHandle>;
  readonly lstat: (path: string) => Promise<Stats>;
};

const defaultIo: RootOwnedEvidenceIo = { open, lstat };

function invalid(): Error {
  return new Error('INPUT_CUSTODY_INVALID');
}

function acceptable(metadata: Stats, maximumBytes: number): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.uid === 0 &&
    metadata.nlink === 1 &&
    (metadata.mode & 0o022) === 0 &&
    metadata.size >= 1 &&
    metadata.size <= maximumBytes
  );
}

function sameMetadata(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

export async function readRootOwnedEvidence(
  path: string,
  maximumBytes: number,
  io: RootOwnedEvidenceIo = defaultIo,
): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  if (
    !isAbsolute(path) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    typeof noFollow !== 'number' ||
    typeof nonBlock !== 'number'
  )
    throw invalid();

  let handle: EvidenceHandle;
  let result: Buffer | undefined;
  let failed = false;
  try {
    handle = await io.open(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    throw invalid();
  }
  try {
    const before = await handle.stat();
    if (!acceptable(before, maximumBytes)) throw invalid();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) throw invalid();
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await io.lstat(path);
    if (
      offset < 1 ||
      offset > maximumBytes ||
      offset !== before.size ||
      !acceptable(after, maximumBytes) ||
      !sameMetadata(before, after) ||
      !sameMetadata(after, pathAfter)
    )
      throw invalid();
    result = buffer.subarray(0, offset);
  } catch {
    failed = true;
  }
  try {
    await handle.close();
  } catch {
    failed = true;
  }
  if (failed || !result) throw invalid();
  return result;
}
