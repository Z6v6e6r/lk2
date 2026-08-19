import { isAbsolute } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

import {
  compareCommunitiesStagingRoleSplitInventories,
  CommunitiesStagingRoleSplitInventoryError,
} from './communities-staging-role-split-inventory.js';

async function readReport(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error('INPUT_INVALID');
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 1 ||
    metadata.size > 1024 * 1024
  )
    throw new Error('INPUT_INVALID');
  return JSON.parse((await readFile(path, 'utf8')).trim());
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== '--before' ||
    arguments_[2] !== '--after' ||
    !arguments_[1] ||
    !arguments_[3] ||
    arguments_[1] === arguments_[3]
  )
    throw new Error('INPUT_INVALID');
  const comparison = compareCommunitiesStagingRoleSplitInventories(
    await readReport(arguments_[1]),
    await readReport(arguments_[3]),
  );
  process.stdout.write(`${JSON.stringify(comparison)}\n`);
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof CommunitiesStagingRoleSplitInventoryError
      ? error.code
      : 'COMMUNITIES_STAGING_ROLE_SPLIT_INVENTORY_COMPARISON_INPUT_INVALID';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
