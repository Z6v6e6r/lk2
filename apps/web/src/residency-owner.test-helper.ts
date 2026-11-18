/**
 * Test-only harness: the real LK1 residency lifecycle owner (lk#443 @ adc9c644, imported
 * byte-identical under contracts/imported) behind a synthetic LK2 consumer transport, driven
 * through the real `@phub/api-sdk` client. See residency-owner-world.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createOwnerWorld as createWorld } from './residency-owner-world.js';

export type { OwnerHarness } from './residency-owner-world.js';

const SNAPSHOT = resolve(process.cwd(), 'contracts/imported/lk1-residency-lifecycle/adc9c644');
/** Fails if the imported owner files differ from the recorded SHA-256 of the reviewed commit. */
export function verifyOwnerSnapshot(): readonly string[] {
  const lines = readFileSync(resolve(SNAPSHOT, 'SOURCE.sha256'), 'utf8').trim().split('\n');
  return lines.map((line) => {
    const [digest, name] = line.split(/\s+/);
    const actual = createHash('sha256')
      .update(readFileSync(resolve(SNAPSHOT, name!)))
      .digest('hex');
    if (actual !== digest) throw new Error('OWNER_SNAPSHOT_CHANGED:' + name);
    return name!;
  });
}

export const createOwnerWorld = (
  init: { readonly now?: number; readonly priceMinor?: number } = {},
) => createWorld({ ...init, sha256: (v: string) => createHash('sha256').update(v).digest('hex') });
