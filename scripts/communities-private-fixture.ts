import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

function outsideRepository(path: string): boolean {
  const workspaceRelative = relative(process.cwd(), path);
  return (
    workspaceRelative === '..' ||
    workspaceRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: typeof left): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export async function readPrivateFixture(
  input: string,
  label: string,
  maxBytes = 1024 * 1024,
): Promise<string> {
  if (!isAbsolute(input)) throw new Error(`${label} must be an absolute path`);
  const path = resolve(input);
  if (!outsideRepository(path)) throw new Error(`${label} must stay outside the repository`);
  const before = await lstat(path);
  const expectedUid = process.getuid?.();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o077) !== 0 ||
    (expectedUid !== undefined && before.uid !== expectedUid) ||
    before.size > maxBytes
  ) {
    throw new Error(`${label} must be a private, owned, regular file within its byte limit`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error(`${label} changed before it could be opened safely`);
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== opened.size || !sameFile(opened, after)) {
      throw new Error(`${label} changed while it was being read`);
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function requirePinnedOrigin(actual: URL, expected: string, label: string): void {
  const pinned = new URL(expected);
  if (
    pinned.origin !== expected ||
    actual.origin !== pinned.origin ||
    actual.username ||
    actual.password
  ) {
    throw new Error(`${label} must exactly match the independently pinned fixture origin`);
  }
}
