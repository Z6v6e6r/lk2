/** Test-only pinned real consumer and owner chain; synthetic ports are listed in SOURCE.md. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createOwnerWorld as createWorld } from './residency-owner-world.js';

export type { OwnerHarness } from './residency-owner-world.js';

function verifySnapshot(directory: string): readonly string[] {
  const snapshot = resolve(process.cwd(), 'contracts/imported', directory);
  const lines = readFileSync(resolve(snapshot, 'SOURCE.sha256'), 'utf8').trim().split('\n');
  return lines.map((line) => {
    const [digest, name] = line.split(/\s+/);
    const actual = createHash('sha256')
      .update(readFileSync(resolve(snapshot, name!)))
      .digest('hex');
    if (actual !== digest) throw new Error('RESIDENCY_SNAPSHOT_CHANGED:' + name);
    return name!;
  });
}
export const verifyOwnerSnapshot = () => verifySnapshot('lk1-residency-lifecycle/93692e64');
export const verifyConsumerSnapshot = () => verifySnapshot('lk2-residency-consumer/965efa79');

export const createOwnerWorld = (
  init: { readonly now?: number; readonly priceMinor?: number } = {},
) => createWorld({ ...init, sha256: (v: string) => createHash('sha256').update(v).digest('hex') });
