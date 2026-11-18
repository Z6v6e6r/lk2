/** Test-only pinned real consumer and owner chain; synthetic ports are listed in SOURCE.md. */
import { createHash } from 'node:crypto';

import { createOwnerWorld as createWorld } from './residency-owner-world.js';

export type { OwnerHarness } from './residency-owner-world.js';

export {
  verifyOwnerSnapshot,
  verifyConsumerSnapshot,
} from './residency-server-fixtures.test-helper.js';

export const createOwnerWorld = (
  init: { readonly now?: number; readonly priceMinor?: number } = {},
) => createWorld({ ...init, sha256: (v: string) => createHash('sha256').update(v).digest('hex') });
