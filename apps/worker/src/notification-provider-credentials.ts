import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** Private, bounded credential files shared only by the APNs and Yandex SMTP workers. */
export async function readNotificationCredentialFile(path: string): Promise<unknown> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw new Error('NOTIFICATION_CREDENTIAL_PATH_INVALID');
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.uid !== process.getuid?.() ||
    before.size < 1 ||
    before.size > 16_384
  )
    throw new Error('NOTIFICATION_CREDENTIAL_METADATA_INVALID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await file.stat();
    if (
      held.ino !== before.ino ||
      held.dev !== before.dev ||
      held.size !== before.size ||
      held.mtimeMs !== before.mtimeMs
    )
      throw new Error('NOTIFICATION_CREDENTIAL_CHANGED');
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      bytesRead > 16_384 ||
      after.size !== held.size ||
      after.mtimeMs !== held.mtimeMs
    )
      throw new Error('NOTIFICATION_CREDENTIAL_CHANGED');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
